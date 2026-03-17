"""Drop Prediction Engine — analyzes historical patterns to predict next drops.

Uses drop_events and signals tables to find patterns in:
- Day of week (e.g. PKC often drops on Thursdays/Fridays)
- Time of day (e.g. typically 3-4pm GMT)
- Lead-up signals (build ID changes X hours before, sitemap adds Y hours before)
- Frequency (average gap between drops)

Outputs a prediction with confidence score and reasoning.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta
from typing import Optional

import db

log = logging.getLogger("pkc-detect.predictor")

# Known PKC drop patterns (hardcoded priors based on community knowledge)
# These act as Bayesian priors that get updated with observed data
KNOWN_PRIORS = {
    "peak_days": [3, 4],        # Thursday=3, Friday=4 (0=Monday)
    "peak_hours": [14, 15, 16], # 2-4pm GMT
    "avg_gap_days": 14,         # ~every 2 weeks
    "build_lead_hours": 4,      # Build ID changes ~4h before drop
    "sitemap_lead_hours": 24,   # New sitemap URLs ~24h before drop
}


class DropPredictor:
    """Predicts the next likely drop window based on historical data."""

    def __init__(self):
        self._last_prediction: Optional[dict] = None
        self._last_computed: Optional[datetime] = None

    async def predict(self) -> dict:
        """Generate a drop prediction.

        Returns dict with:
            next_window_start: datetime
            next_window_end: datetime  
            confidence: float (0-1)
            reasoning: list[str]
            signals: list[str]  — current active signals that affect prediction
        """
        now = datetime.utcnow()

        # Cache for 30 minutes
        if (self._last_prediction and self._last_computed and
                (now - self._last_computed) < timedelta(minutes=30)):
            return self._last_prediction

        reasoning = []
        signals = []
        confidence = 0.0

        # 1. Analyze historical drop events
        drop_history = await self._get_drop_history()
        day_scores, hour_scores, avg_gap = self._analyze_patterns(drop_history)

        # 2. Check current active indicators
        current_indicators = await self._check_indicators()

        # 3. Calculate next predicted window
        prediction = self._compute_prediction(
            now, day_scores, hour_scores, avg_gap, current_indicators,
            reasoning, signals
        )

        # Add confidence from indicators
        confidence = prediction["confidence"]

        result = {
            "next_window_start": prediction["start"].isoformat(),
            "next_window_end": prediction["end"].isoformat(),
            "confidence": round(confidence, 2),
            "confidence_label": self._confidence_label(confidence),
            "reasoning": reasoning,
            "signals": signals,
            "day_of_week": prediction["start"].strftime("%A"),
            "time_range": f"{prediction['start'].strftime('%H:%M')} - {prediction['end'].strftime('%H:%M')} GMT",
            "computed_at": now.isoformat(),
        }

        self._last_prediction = result
        self._last_computed = now
        return result

    async def _get_drop_history(self) -> list[dict]:
        """Fetch all historical drop events."""
        try:
            return await db.get_drop_events(limit=200)
        except Exception:
            return []

    def _analyze_patterns(self, events: list[dict]) -> tuple[dict, dict, float]:
        """Analyze drop events to find day/hour patterns.

        Returns (day_scores, hour_scores, avg_gap_days).
        """
        if not events:
            # No history — use priors only
            day_scores = {d: 0.3 for d in range(7)}
            for d in KNOWN_PRIORS["peak_days"]:
                day_scores[d] = 0.7
            hour_scores = {h: 0.1 for h in range(24)}
            for h in KNOWN_PRIORS["peak_hours"]:
                hour_scores[h] = 0.6
            return day_scores, hour_scores, float(KNOWN_PRIORS["avg_gap_days"])

        # Count drops per day of week and hour
        day_counter = Counter()
        hour_counter = Counter()
        timestamps = []

        for event in events:
            try:
                started = datetime.fromisoformat(event["started_at"])
                day_counter[started.weekday()] += 1
                hour_counter[started.hour] += 1
                timestamps.append(started)
            except (ValueError, KeyError):
                continue

        total = sum(day_counter.values()) or 1

        # Blend observed data with priors (Bayesian-ish)
        day_scores = {}
        for d in range(7):
            observed = day_counter.get(d, 0) / total
            prior = 0.7 if d in KNOWN_PRIORS["peak_days"] else 0.1
            # Weight: 70% observed if we have data, 30% prior
            weight = min(total / 10, 0.7)  # Caps at 70% observed weight
            day_scores[d] = weight * observed + (1 - weight) * prior

        hour_scores = {}
        for h in range(24):
            observed = hour_counter.get(h, 0) / total
            prior = 0.6 if h in KNOWN_PRIORS["peak_hours"] else 0.05
            weight = min(total / 10, 0.7)
            hour_scores[h] = weight * observed + (1 - weight) * prior

        # Average gap between drops
        if len(timestamps) >= 2:
            timestamps.sort()
            gaps = [(timestamps[i+1] - timestamps[i]).total_seconds() / 86400
                    for i in range(len(timestamps) - 1)]
            avg_gap = sum(gaps) / len(gaps)
        else:
            avg_gap = float(KNOWN_PRIORS["avg_gap_days"])

        return day_scores, hour_scores, avg_gap

    async def _check_indicators(self) -> dict:
        """Check current signals that might indicate an imminent drop."""
        indicators = {
            "build_id_changed": False,
            "new_sitemap_products": False,
            "challenge_gate_active": False,
            "hours_since_last_drop": None,
        }

        try:
            # Check recent signals (last 48 hours)
            recent_signals = await db.get_signals(limit=50)
            cutoff = datetime.utcnow() - timedelta(hours=48)

            for sig in recent_signals:
                try:
                    ts = datetime.fromisoformat(sig["timestamp"])
                    if ts < cutoff:
                        continue
                except (ValueError, KeyError):
                    continue

                if sig.get("signal_type") == "build_id":
                    indicators["build_id_changed"] = True
                if sig.get("signal_type") == "sitemap" and "product" in sig.get("title", "").lower():
                    indicators["new_sitemap_products"] = True

            # Current site state
            status = await db.get_site_status()
            if status and status.get("state") == "challenge":
                indicators["challenge_gate_active"] = True

            # Time since last drop
            drops = await db.get_drop_events(limit=1)
            if drops:
                last_drop = datetime.fromisoformat(drops[0]["started_at"])
                indicators["hours_since_last_drop"] = (
                    datetime.utcnow() - last_drop
                ).total_seconds() / 3600

        except Exception as e:
            log.warning(f"Error checking indicators: {e}")

        return indicators

    def _compute_prediction(
        self,
        now: datetime,
        day_scores: dict,
        hour_scores: dict,
        avg_gap: float,
        indicators: dict,
        reasoning: list,
        signals: list,
    ) -> dict:
        """Compute the prediction window and confidence."""
        confidence = 0.2  # Base confidence

        # Find best day within the next 14 days
        best_day = None
        best_day_score = 0
        for offset in range(1, 15):
            candidate = now + timedelta(days=offset)
            weekday = candidate.weekday()
            score = day_scores.get(weekday, 0.1)
            if score > best_day_score:
                best_day_score = score
                best_day = candidate

        if not best_day:
            best_day = now + timedelta(days=KNOWN_PRIORS["avg_gap_days"])

        # Find best hour
        best_hour = max(hour_scores, key=hour_scores.get)
        best_hour_score = hour_scores[best_hour]

        # Build prediction window
        start = best_day.replace(hour=best_hour, minute=0, second=0, microsecond=0)
        end = start + timedelta(hours=2)  # 2-hour window

        reasoning.append(
            f"Historical pattern: drops most common on "
            f"{start.strftime('%A')}s around {start.strftime('%H:%M')} GMT"
        )

        # Adjust confidence based on indicators
        if indicators.get("build_id_changed"):
            confidence += 0.20
            signals.append("🔄 Build ID changed in last 48h — deployment detected")
            reasoning.append("Build ID change often precedes drops by 2-6 hours")
            # Move prediction closer if build ID just changed
            start = min(start, now + timedelta(hours=4))
            end = start + timedelta(hours=4)

        if indicators.get("new_sitemap_products"):
            confidence += 0.25
            signals.append("🆕 New product URLs found in sitemap")
            reasoning.append("New sitemap products typically appear 12-48h before drop")
            start = min(start, now + timedelta(hours=12))
            end = start + timedelta(hours=24)

        if indicators.get("challenge_gate_active"):
            confidence += 0.15
            signals.append("🟡 Challenge gate is currently active")
            reasoning.append("Challenge gate sometimes activates before a drop")

        # Gap-based adjustment
        hours_since = indicators.get("hours_since_last_drop")
        if hours_since is not None:
            days_since = hours_since / 24
            if days_since > avg_gap * 1.2:
                confidence += 0.10
                reasoning.append(
                    f"It's been {days_since:.0f} days since last drop "
                    f"(avg gap: {avg_gap:.0f} days) — overdue"
                )
            elif days_since < avg_gap * 0.5:
                confidence -= 0.10
                reasoning.append(
                    f"Only {days_since:.0f} days since last drop "
                    f"(avg gap: {avg_gap:.0f} days) — too soon"
                )

        # Day/hour score contribution
        confidence += best_day_score * 0.1
        confidence += best_hour_score * 0.1

        # Clamp
        confidence = max(0.05, min(0.95, confidence))

        # If no real data, be honest
        if not indicators.get("build_id_changed") and not indicators.get("new_sitemap_products"):
            if not any(indicators.values()):
                reasoning.append("No strong signals detected — prediction based on historical patterns only")

        return {
            "start": start,
            "end": end,
            "confidence": confidence,
        }

    @staticmethod
    def _confidence_label(confidence: float) -> str:
        if confidence >= 0.8:
            return "Very Likely"
        elif confidence >= 0.6:
            return "Likely"
        elif confidence >= 0.4:
            return "Possible"
        elif confidence >= 0.2:
            return "Unlikely"
        else:
            return "Low Confidence"
