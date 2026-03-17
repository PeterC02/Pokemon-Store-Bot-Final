"""Signal 3: Homepage Response Fingerprint.

Polls the PKC homepage every few seconds and classifies the response:
- NORMAL:      Large HTML with __NEXT_DATA__ → site is open
- CHALLENGE:   Small HTML with _Incapsula_Resource, edet=12 → Imperva gate active
- QUEUE:       edet=47, WaitingRoom, wrid= → Queue is live
- MAINTENANCE: Error page or unexpected content
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Optional

import httpx

import db
from models import AlertLevel, Signal, SignalType, SiteState

log = logging.getLogger("pkc-detect.homepage")

# Chrome-like user agent to avoid trivial blocks
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# Thresholds
MIN_NORMAL_SIZE = 5000  # Normal PKC HTML is 50-200KB; challenge pages are ~1-3KB


def classify_response(status_code: int, body: str, content_length: int) -> tuple[SiteState, str]:
    """Classify a PKC homepage response into a site state.

    Returns (state, detail_string).
    """
    if status_code >= 500:
        return SiteState.MAINTENANCE, f"HTTP {status_code}"

    # Queue page markers (edet=47 or WaitingRoom)
    if "edet=47" in body or "WaitingRoom" in body or "wrid=" in body:
        # Try to extract estimated wait time
        wait_match = re.search(r"Estimated wait time:\s*(\S+)", body)
        detail = f"wait={wait_match.group(1)}" if wait_match else ""
        return SiteState.QUEUE, detail

    # Imperva challenge page markers (edet=12, small HTML, iframe to _Incapsula_Resource)
    if "_Incapsula_Resource" in body or "edet=12" in body:
        # Extract incident ID if present
        inc_match = re.search(r"incident_id=(\d+-\d+)", body)
        detail = f"incident={inc_match.group(1)}" if inc_match else ""
        return SiteState.CHALLENGE, detail

    # Normal site — expect __NEXT_DATA__ and a large page
    if "__NEXT_DATA__" in body and content_length > MIN_NORMAL_SIZE:
        # Try to extract buildId
        build_match = re.search(r'"buildId"\s*:\s*"([^"]+)"', body)
        detail = f"buildId={build_match.group(1)}" if build_match else ""
        return SiteState.NORMAL, detail

    # Fallback — something unexpected
    if content_length < MIN_NORMAL_SIZE:
        return SiteState.CHALLENGE, f"small_page size={content_length}"

    return SiteState.UNKNOWN, f"status={status_code} size={content_length}"


# Minimum time between signals of the same type to avoid spam
SIGNAL_COOLDOWNS = {
    SiteState.CHALLENGE: timedelta(minutes=30),
    SiteState.NORMAL: timedelta(minutes=10),
    SiteState.MAINTENANCE: timedelta(minutes=10),
    SiteState.QUEUE: timedelta(seconds=0),  # Always alert immediately for queue
    SiteState.UNKNOWN: timedelta(minutes=5),
}


class HomepageMonitor:
    """Polls the PKC homepage and emits signals on state transitions."""

    def __init__(self, url: str):
        self.url = url
        self.previous_state: Optional[SiteState] = None
        self.previous_build_id: Optional[str] = None
        self.last_signal_time: dict[SiteState, datetime] = {}
        self._initialized = False
        self.client: Optional[httpx.AsyncClient] = None

    async def _restore_state(self):
        """Restore last known state from DB so server restarts don't re-fire."""
        if self._initialized:
            return
        self._initialized = True
        try:
            status = await db.get_site_status()
            if status and status.get("state"):
                state_str = status["state"]
                try:
                    self.previous_state = SiteState(state_str)
                    log.info(f"Restored previous state from DB: {self.previous_state}")
                except ValueError:
                    pass
            if status and status.get("current_build_id"):
                self.previous_build_id = status["current_build_id"]
        except Exception as e:
            log.warning(f"Could not restore state from DB: {e}")

    async def _get_client(self) -> httpx.AsyncClient:
        if self.client is None or self.client.is_closed:
            self.client = httpx.AsyncClient(
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
                timeout=10.0,
            )
        return self.client

    def _check_cooldown(self, state: SiteState) -> bool:
        """Return True if we should suppress this signal (still in cooldown)."""
        cooldown = SIGNAL_COOLDOWNS.get(state, timedelta(minutes=5))
        last = self.last_signal_time.get(state)
        if last and (datetime.utcnow() - last) < cooldown:
            return True  # Suppress
        return False

    def _record_signal(self, state: SiteState):
        self.last_signal_time[state] = datetime.utcnow()

    async def poll(self) -> Optional[Signal]:
        """Poll the homepage once. Returns a Signal if state changed, else None."""
        await self._restore_state()

        try:
            client = await self._get_client()
            resp = await client.get(self.url)
            body = resp.text
            content_length = len(body)

            state, detail = classify_response(resp.status_code, body, content_length)

            # Determine if this is a state change
            changed = state != self.previous_state
            old_state = self.previous_state
            self.previous_state = state

            # Check for build ID change (separate signal, only during NORMAL state)
            build_id_signal = None
            if state == SiteState.NORMAL and "buildId=" in detail:
                current_build = detail.split("buildId=")[1].split()[0] if "buildId=" in detail else None
                if current_build and self.previous_build_id and current_build != self.previous_build_id:
                    build_id_signal = Signal(
                        signal_type=SignalType.BUILD_ID,
                        alert_level=AlertLevel.WARNING,
                        site_state=state,
                        title="🔄 Next.js Build ID Changed",
                        detail=f"old={self.previous_build_id} new={current_build}. Site may be preparing for a drop.",
                    )
                self.previous_build_id = current_build

            if not changed:
                return build_id_signal  # May be None or a build ID change signal

            # State changed — check cooldown before emitting
            if self._check_cooldown(state):
                log.debug(f"State change {old_state} → {state} suppressed (cooldown)")
                return build_id_signal

            # Emit signal
            signal = self._create_signal(state, detail)
            self._record_signal(state)
            log.info(f"State change: {old_state} → {state} ({detail})")
            return signal

        except httpx.TimeoutException:
            log.warning("Homepage poll timed out")
            return None
        except Exception as e:
            log.error(f"Homepage poll error: {e}")
            return None

    def _create_signal(self, state: SiteState, detail: str) -> Signal:
        if state == SiteState.QUEUE:
            return Signal(
                signal_type=SignalType.HOMEPAGE,
                alert_level=AlertLevel.CRITICAL,
                site_state=state,
                title="🔴 QUEUE IS LIVE — AUTO-LAUNCHING",
                detail=detail,
            )
        elif state == SiteState.CHALLENGE:
            return Signal(
                signal_type=SignalType.HOMEPAGE,
                alert_level=AlertLevel.WARNING,
                site_state=state,
                title="🟡 Imperva Challenge Gate Activated",
                detail=detail,
            )
        elif state == SiteState.NORMAL:
            return Signal(
                signal_type=SignalType.HOMEPAGE,
                alert_level=AlertLevel.INFO,
                site_state=state,
                title="🟢 Site is Normal",
                detail=detail,
            )
        elif state == SiteState.MAINTENANCE:
            return Signal(
                signal_type=SignalType.HOMEPAGE,
                alert_level=AlertLevel.WARNING,
                site_state=state,
                title="🟠 Site Maintenance",
                detail=detail,
            )
        else:
            return Signal(
                signal_type=SignalType.HOMEPAGE,
                alert_level=AlertLevel.INFO,
                site_state=state,
                title="❓ Unknown State",
                detail=detail,
            )

    async def close(self):
        if self.client and not self.client.is_closed:
            await self.client.aclose()
