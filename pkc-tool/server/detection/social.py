"""Social Monitor — polls Reddit RSS feeds for Pokemon TCG community content.

Monitors r/PokemonTCG, r/PKMNTCGDeals, and other subreddits for posts
about drops, restocks, new releases, and Pokemon Center news.

Uses Reddit's public RSS/JSON feeds (no API key required).
Filters for relevance using keyword matching.
Emits SOCIAL-type signals for high-relevance posts.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Optional

import httpx

import db
from models import AlertLevel, Signal, SignalType, SiteState

log = logging.getLogger("pkc-detect.social")

USER_AGENT = "Canary/1.0 (Pokemon Center drop monitor)"

# Subreddits to monitor (using Reddit's public JSON API)
SUBREDDITS = [
    "PokemonTCG",
    "PKMNTCGDeals",
    "pokemoncardcollectors",
]

# Keywords that indicate a post is relevant to drops/restocks
# Scored by relevance (higher = more relevant)
KEYWORD_SCORES = {
    # High relevance — directly about drops
    "pokemon center drop": 10,
    "pokemoncenter drop": 10,
    "pokemon center restock": 10,
    "pokemoncenter restock": 10,
    "pokemon center queue": 10,
    "pkc drop": 10,
    "pkc restock": 10,
    "pkc queue": 10,
    "pokemon center uk": 8,
    "pokemoncenter.com": 8,
    # Medium relevance — about drops generally
    "drop live": 7,
    "queue live": 7,
    "just dropped": 7,
    "in stock": 6,
    "back in stock": 7,
    "sold out": 5,
    "pre-order": 5,
    "preorder": 5,
    # Lower relevance — general TCG news
    "elite trainer box": 4,
    "booster bundle": 4,
    "premium collection": 4,
    "ultra premium": 5,
    "special collection": 4,
    "etb restock": 6,
    # Product names that indicate high-value drops
    "prismatic evolutions": 6,
    "charizard": 4,
    "pikachu": 3,
    "surging sparks": 4,
    "journey together": 4,
    "destined rivals": 4,
}

# Minimum score to emit a signal
MIN_SIGNAL_SCORE = 6

# Maximum age of posts to consider (hours)
MAX_POST_AGE_HOURS = 24


class SocialMonitor:
    """Polls Reddit for Pokemon TCG community content."""

    def __init__(self):
        self.seen_post_ids: set[str] = set()
        self._initialized = False
        self.client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self.client is None or self.client.is_closed:
            self.client = httpx.AsyncClient(
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
                timeout=15.0,
            )
        return self.client

    async def poll(self) -> list[Signal]:
        """Poll all subreddits and return relevant signals."""
        signals = []

        for subreddit in SUBREDDITS:
            try:
                new_signals = await self._poll_subreddit(subreddit)
                signals.extend(new_signals)
            except Exception as e:
                log.debug(f"Error polling r/{subreddit}: {e}")

        return signals

    async def _poll_subreddit(self, subreddit: str) -> list[Signal]:
        """Poll a single subreddit's hot/new posts."""
        signals = []
        client = await self._get_client()

        for sort in ["new", "hot"]:
            try:
                url = f"https://www.reddit.com/r/{subreddit}/{sort}.json?limit=25"
                resp = await client.get(url)

                if resp.status_code == 429:
                    log.debug(f"Reddit rate limited on r/{subreddit}/{sort}")
                    continue
                if resp.status_code != 200:
                    continue

                data = resp.json()
                posts = data.get("data", {}).get("children", [])

                for post_wrapper in posts:
                    post = post_wrapper.get("data", {})
                    post_id = post.get("id", "")

                    # Skip already seen
                    if post_id in self.seen_post_ids:
                        continue

                    # Skip old posts
                    created_utc = post.get("created_utc", 0)
                    if created_utc:
                        post_age = datetime.utcnow() - datetime.utcfromtimestamp(created_utc)
                        if post_age > timedelta(hours=MAX_POST_AGE_HOURS):
                            continue

                    # Score the post
                    title = post.get("title", "")
                    selftext = post.get("selftext", "")[:500]
                    combined = f"{title} {selftext}".lower()

                    score = _score_post(combined)
                    if score >= MIN_SIGNAL_SCORE:
                        self.seen_post_ids.add(post_id)

                        permalink = f"https://reddit.com{post.get('permalink', '')}"
                        upvotes = post.get("ups", 0)
                        author = post.get("author", "unknown")

                        signal = self._create_signal(
                            title=title,
                            subreddit=subreddit,
                            permalink=permalink,
                            upvotes=upvotes,
                            author=author,
                            score=score,
                        )
                        signals.append(signal)

            except Exception as e:
                log.debug(f"Error parsing r/{subreddit}/{sort}: {e}")

        # Cap seen_post_ids to prevent unbounded growth
        if len(self.seen_post_ids) > 5000:
            # Keep only the most recent 2500
            self.seen_post_ids = set(list(self.seen_post_ids)[-2500:])

        return signals

    def _create_signal(
        self,
        title: str,
        subreddit: str,
        permalink: str,
        upvotes: int,
        author: str,
        score: int,
    ) -> Signal:
        # High-score posts (likely actual drop/restock reports) get WARNING
        if score >= 8:
            alert_level = AlertLevel.WARNING
        else:
            alert_level = AlertLevel.INFO

        detail = (
            f"**r/{subreddit}** — {upvotes} upvotes by u/{author}\n"
            f"{title}"
        )

        return Signal(
            signal_type=SignalType.SOCIAL,
            alert_level=alert_level,
            site_state=SiteState.UNKNOWN,  # Social posts don't directly indicate site state
            title=f"💬 Community: {_truncate(title, 80)}",
            detail=detail,
            detected_urls=[permalink],
        )

    async def close(self):
        if self.client and not self.client.is_closed:
            await self.client.aclose()


def _score_post(text: str) -> int:
    """Score a post's relevance based on keyword matching."""
    total = 0
    matched = set()
    for keyword, points in KEYWORD_SCORES.items():
        if keyword in text and keyword not in matched:
            total += points
            matched.add(keyword)
    return total


def _truncate(text: str, max_len: int) -> str:
    """Truncate text to max_len, adding ellipsis if needed."""
    if len(text) <= max_len:
        return text
    return text[:max_len - 1] + "…"
