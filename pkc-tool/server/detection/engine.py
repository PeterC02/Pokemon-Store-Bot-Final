"""Detection Engine — orchestrates all signals and pushes alerts.

Runs as an async background task. Each signal monitor polls on its own
interval. When a signal fires, the engine:
1. Persists it to the DB
2. Updates site status
3. Broadcasts to all connected WebSocket clients
4. Fires Discord webhook (if configured)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Optional

import httpx

import config
import db
from models import AlertLevel, Signal, SiteState, WSMessage

from detection.catalog import CatalogMonitor
from detection.formatter import format_signal, UserMessage
from detection.homepage import HomepageMonitor
from detection.sitemap import SitemapMonitor
from detection.social import SocialMonitor

log = logging.getLogger("pkc-detect.engine")


# Catalog poll interval — less aggressive than homepage since search API has DataDome
CATALOG_POLL_INTERVAL = float(os.getenv("CATALOG_POLL_INTERVAL", "120"))  # 2 minutes
SOCIAL_POLL_INTERVAL = float(os.getenv("SOCIAL_POLL_INTERVAL", "300"))  # 5 minutes


class DetectionEngine:
    def __init__(self, ws_manager):
        self.ws_manager = ws_manager
        self.homepage = HomepageMonitor(config.PKC_HOMEPAGE)
        self.sitemap = SitemapMonitor(config.PKC_SITEMAP_URL)
        self.catalog = CatalogMonitor()
        self.social = SocialMonitor()
        self._running = False
        self._current_drop_event_id: Optional[int] = None
        self._last_site_state: Optional[str] = None

    async def run(self):
        """Main loop — runs all monitors concurrently."""
        self._running = True
        log.info("Detection engine starting")
        log.info(f"  Homepage poll: {config.PKC_HOMEPAGE} every {config.HOMEPAGE_POLL_INTERVAL}s")
        log.info(f"  Sitemap poll:  {config.PKC_SITEMAP_URL} every {config.SITEMAP_POLL_INTERVAL}s")

        try:
            await asyncio.gather(
                self._run_homepage(),
                self._run_sitemap(),
                self._run_catalog(),
                self._run_social(),
                self._run_cleanup(),
                self._run_scheduled_posts(),
            )
        except asyncio.CancelledError:
            log.info("Detection engine stopped")
            await self.homepage.close()
            await self.sitemap.close()
            await self.catalog.close()
            await self.social.close()

    async def _run_homepage(self):
        """Homepage polling loop."""
        while self._running:
            try:
                signal = await self.homepage.poll()
                if signal:
                    await self._handle_signal(signal)
                    # Also update site_status table
                    await db.update_site_status(
                        state=signal.site_state.value,
                        last_checked=datetime.utcnow().isoformat(),
                        last_changed=datetime.utcnow().isoformat(),
                        detail=signal.detail,
                    )
                else:
                    # No state change — just update last_checked
                    await db.update_site_status(
                        last_checked=datetime.utcnow().isoformat(),
                    )
            except Exception as e:
                log.error(f"Homepage loop error: {e}")

            await asyncio.sleep(config.HOMEPAGE_POLL_INTERVAL)

    async def _run_sitemap(self):
        """Sitemap polling loop."""
        while self._running:
            try:
                signal = await self.sitemap.poll()
                if signal:
                    await self._handle_signal(signal)
            except Exception as e:
                log.error(f"Sitemap loop error: {e}")

            await asyncio.sleep(config.SITEMAP_POLL_INTERVAL)

    async def _run_catalog(self):
        """Product catalog polling loop."""
        # Wait a bit before first poll to let homepage establish state
        await asyncio.sleep(10)
        while self._running:
            try:
                signals = await self.catalog.poll()
                for signal in signals:
                    await self._handle_signal(signal)
                    # Persist new products to DB
                    for url in signal.detected_urls:
                        for pid, product in self.catalog.known_products.items():
                            if product.get("url") == url:
                                await db.upsert_product(product)
            except Exception as e:
                log.error(f"Catalog loop error: {e}")

            await asyncio.sleep(CATALOG_POLL_INTERVAL)

    async def _run_social(self):
        """Reddit/social polling loop."""
        # Wait before first poll
        await asyncio.sleep(15)
        while self._running:
            try:
                signals = await self.social.poll()
                for signal in signals:
                    await self._handle_signal(signal)
            except Exception as e:
                log.error(f"Social loop error: {e}")

            await asyncio.sleep(SOCIAL_POLL_INTERVAL)

    async def _run_cleanup(self):
        """Periodic data retention cleanup — runs every 6 hours."""
        await asyncio.sleep(60)  # Wait 1 min after startup
        while self._running:
            try:
                deleted = await db.cleanup_old_data(signal_days=30, social_days=7)
                total = sum(deleted.values())
                if total > 0:
                    log.info(f"Data cleanup: removed {deleted}")
            except Exception as e:
                log.error(f"Cleanup error: {e}")
            await asyncio.sleep(6 * 3600)  # Every 6 hours

    async def _run_scheduled_posts(self):
        """Post daily prediction (9am GMT) and weekly recap (Sunday 6pm GMT)."""
        await asyncio.sleep(30)  # Wait after startup
        last_daily_date = None
        last_weekly_date = None

        while self._running:
            try:
                now = datetime.utcnow()
                today = now.date()

                # Daily prediction post at 9:00 GMT
                if now.hour == 9 and last_daily_date != today:
                    last_daily_date = today
                    await self._post_daily_prediction()

                # Weekly recap on Sunday at 18:00 GMT
                if now.weekday() == 6 and now.hour == 18 and last_weekly_date != today:
                    last_weekly_date = today
                    await self._post_weekly_recap()

            except Exception as e:
                log.error(f"Scheduled post error: {e}")

            await asyncio.sleep(300)  # Check every 5 minutes

    async def _post_daily_prediction(self):
        """Generate and post the daily prediction to Discord."""
        if not config.DISCORD_WEBHOOK_URL:
            return

        try:
            from detection.predictor import DropPredictor
            from llm_service import generate_prediction_narrative

            predictor = DropPredictor()
            prediction = await predictor.predict()
            narrative = await generate_prediction_narrative(prediction)

            conf = prediction.get("confidence", 0)
            if conf >= 0.6:
                color = 0xE74C3C
            elif conf >= 0.4:
                color = 0xF39C12
            else:
                color = 0x3498DB

            embed = {
                "title": "🔮 Daily Drop Prediction",
                "description": narrative,
                "color": color,
                "fields": [
                    {
                        "name": "Predicted Window",
                        "value": f"**{prediction.get('day_of_week', '?')}** {prediction.get('time_range', '?')}",
                        "inline": True,
                    },
                    {
                        "name": "Confidence",
                        "value": f"**{int(conf * 100)}%** — {prediction.get('confidence_label', '?')}",
                        "inline": True,
                    },
                ],
                "footer": {"text": "Canary by Heuricity • Daily Prediction"},
                "timestamp": datetime.utcnow().isoformat(),
            }

            async with httpx.AsyncClient() as client:
                await client.post(
                    config.DISCORD_WEBHOOK_URL,
                    json={"embeds": [embed]},
                    timeout=5.0,
                )
            log.info("Posted daily prediction to Discord")
        except Exception as e:
            log.warning(f"Daily prediction post error: {e}")

    async def _post_weekly_recap(self):
        """Generate and post the weekly recap to Discord."""
        if not config.DISCORD_WEBHOOK_URL:
            return

        try:
            from llm_service import generate_weekly_recap
            from detection.predictor import DropPredictor

            # Gather this week's data
            from datetime import timedelta
            week_ago = (datetime.utcnow() - timedelta(days=7)).isoformat()

            all_drops = await db.get_drop_events(limit=200)
            week_drops = [d for d in all_drops
                          if d.get("started_at", "") >= week_ago]

            all_signals = await db.get_signals(limit=500)
            week_signals = [s for s in all_signals
                            if s.get("timestamp", "") >= week_ago]

            predictor = DropPredictor()
            prediction = await predictor.predict()

            context = {
                "drop_events": week_drops,
                "signals": week_signals[:50],  # Cap for prompt size
                "prediction": prediction,
            }

            recap_text = await generate_weekly_recap(context)

            embed = {
                "title": "📋 Weekly Recap",
                "description": recap_text,
                "color": 0x9B59B6,
                "footer": {"text": "Canary by Heuricity • Weekly Recap"},
                "timestamp": datetime.utcnow().isoformat(),
            }

            async with httpx.AsyncClient() as client:
                await client.post(
                    config.DISCORD_WEBHOOK_URL,
                    json={"embeds": [embed]},
                    timeout=5.0,
                )
            log.info("Posted weekly recap to Discord")
        except Exception as e:
            log.warning(f"Weekly recap post error: {e}")

    async def _handle_signal(self, signal: Signal):
        """Process a signal: persist, format, broadcast, track drop events, webhook."""
        # 1. Persist raw signal to DB
        signal_id = await db.insert_signal(
            signal_type=signal.signal_type.value,
            alert_level=signal.alert_level.value,
            site_state=signal.site_state.value,
            title=signal.title,
            detail=signal.detail,
            detected_urls=json.dumps(signal.detected_urls),
        )
        signal.id = signal_id
        log.info(f"Signal #{signal_id}: [{signal.alert_level.value}] {signal.title}")

        # 2. Format into user-facing message
        user_msg = format_signal(signal.model_dump(mode="json"))

        # 3. Track drop events (queue start/end)
        await self._track_drop_event(signal)

        # 4. Broadcast to all WS clients (include both raw + formatted)
        signal_data = signal.model_dump(mode="json")
        signal_data["formatted"] = {
            "headline": f"{user_msg.emoji} {user_msg.headline}".strip(),
            "body": user_msg.body,
            "action_hint": user_msg.action_hint,
            "embed_color": user_msg.embed_color,
            "product_names": user_msg.product_names,
        }
        msg = WSMessage(type="signal", data=signal_data)
        await self.ws_manager.broadcast(msg)

        # Also push updated status
        status = await db.get_site_status()
        await self.ws_manager.broadcast(
            WSMessage(type="status", data=status)
        )

        # 5. Discord webhook (uses formatted message)
        if config.DISCORD_WEBHOOK_URL:
            await self._send_discord(signal, user_msg)

    async def _track_drop_event(self, signal: Signal):
        """Auto-track drop events: create on queue start, close on queue end."""
        new_state = signal.site_state.value
        old_state = self._last_site_state
        self._last_site_state = new_state

        # Queue just went live — start a drop event
        if new_state == "queue" and old_state != "queue":
            if not self._current_drop_event_id:
                self._current_drop_event_id = await db.start_drop_event(
                    event_type="queue",
                    detail=signal.detail,
                )
                log.info(f"Drop event #{self._current_drop_event_id} started (queue live)")

        # Queue just ended — close the drop event and generate post-mortem
        if old_state == "queue" and new_state != "queue":
            if self._current_drop_event_id:
                await db.end_drop_event(self._current_drop_event_id)
                log.info(f"Drop event #{self._current_drop_event_id} ended (queue over)")
                await self._generate_postmortem(self._current_drop_event_id)
                self._current_drop_event_id = None

    async def _generate_postmortem(self, event_id: int):
        """Generate and post a drop post-mortem after a drop ends."""
        try:
            from llm_service import generate_drop_postmortem, is_configured

            # Fetch the completed drop event
            events = await db.get_drop_events(limit=200)
            event = next((e for e in events if e.get("id") == event_id), None)
            if not event:
                return

            context = {"event": event}
            postmortem_text = await generate_drop_postmortem(context)

            # Post to Discord webhook if configured
            if config.DISCORD_WEBHOOK_URL and postmortem_text:
                embed = {
                    "title": "📊 Drop Post-Mortem",
                    "description": postmortem_text,
                    "color": 0x3498DB,
                    "timestamp": datetime.utcnow().isoformat(),
                    "footer": {"text": "Canary by Heuricity"},
                }
                try:
                    async with httpx.AsyncClient() as client:
                        await client.post(
                            config.DISCORD_WEBHOOK_URL,
                            json={"embeds": [embed]},
                            timeout=5.0,
                        )
                except Exception as e:
                    log.warning(f"Post-mortem webhook error: {e}")

            log.info(f"Generated post-mortem for drop event #{event_id}")
        except Exception as e:
            log.warning(f"Post-mortem generation error: {e}")

    async def _send_discord(self, signal: Signal, user_msg: UserMessage):
        """Send a rich Discord embed using the formatted user message."""
        embed = {
            "title": f"{user_msg.emoji} {user_msg.headline}".strip(),
            "description": user_msg.body,
            "color": user_msg.embed_color,
            "timestamp": signal.timestamp.isoformat(),
            "footer": {"text": "Canary by Heuricity"},
            "fields": [],
        }

        # Action hint
        if user_msg.action_hint:
            embed["fields"].append({
                "name": "💡 What to do",
                "value": user_msg.action_hint,
                "inline": False,
            })

        # Product links
        if user_msg.product_urls:
            links = []
            names = user_msg.product_names or []
            for i, url in enumerate(user_msg.product_urls[:5]):
                name = names[i] if i < len(names) else url.split("/")[-1].replace("-", " ").title()
                links.append(f"🔗 [{name}]({url})")
            if len(user_msg.product_urls) > 5:
                links.append(f"_...and {len(user_msg.product_urls) - 5} more_")
            embed["fields"].append({
                "name": "Products",
                "value": "\n".join(links),
                "inline": False,
            })

        # Product image thumbnail (first product if available)
        if user_msg.image_url:
            embed["thumbnail"] = {"url": user_msg.image_url}

        # Content ping for critical alerts
        content = ""
        if signal.alert_level == AlertLevel.CRITICAL:
            content = "||@everyone|| 🚨 **DROP ALERT**"

        payload = {"content": content, "embeds": [embed]} if content else {"embeds": [embed]}

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    config.DISCORD_WEBHOOK_URL,
                    json=payload,
                    timeout=5.0,
                )
                if resp.status_code not in (200, 204):
                    log.warning(f"Discord webhook returned {resp.status_code}: {resp.text}")
        except Exception as e:
            log.warning(f"Discord webhook error: {e}")
