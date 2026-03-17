"""Signal 1: Sitemap Diff.

Polls the PKC sitemap periodically and diffs against a stored snapshot.
New URLs = new products staged in CMS, potentially days before a drop.

Note: Sitemaps are behind Imperva when the challenge gate is active,
so this only works during normal site operation — which is exactly
when we want it (detecting products staged BEFORE the queue goes up).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Optional

import httpx

from models import AlertLevel, Signal, SignalType, SiteState

log = logging.getLogger("pkc-detect.sitemap")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# Regex to extract <loc> entries from sitemap XML
LOC_PATTERN = re.compile(r"<loc>\s*(https?://[^<]+)\s*</loc>")

# Pattern for product URLs
PRODUCT_URL_PATTERN = re.compile(r"/product/\d+-\d+/")


def parse_sitemap_urls(xml_text: str) -> set[str]:
    """Extract all <loc> URLs from sitemap XML."""
    return set(LOC_PATTERN.findall(xml_text))


def filter_product_urls(urls: set[str]) -> set[str]:
    """Filter to only product-page URLs."""
    return {u for u in urls if PRODUCT_URL_PATTERN.search(u)}


class SitemapMonitor:
    """Polls the PKC sitemap and detects new product URLs."""

    def __init__(self, sitemap_url: str):
        self.sitemap_url = sitemap_url
        self.known_urls: Optional[set[str]] = None
        self.known_product_urls: Optional[set[str]] = None
        self.client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self.client is None or self.client.is_closed:
            self.client = httpx.AsyncClient(
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
                timeout=15.0,
            )
        return self.client

    async def poll(self) -> Optional[Signal]:
        """Poll the sitemap once. Returns a Signal if new products found, else None."""
        try:
            client = await self._get_client()
            resp = await client.get(self.sitemap_url)

            # If we get an Imperva challenge page, sitemap is blocked — skip silently
            if "_Incapsula_Resource" in resp.text or "edet=" in resp.text:
                log.debug("Sitemap blocked by Imperva — challenge gate active, skipping")
                return None

            # Check if we got valid XML
            if "<loc>" not in resp.text:
                log.debug(f"Sitemap response doesn't contain <loc> tags (status={resp.status_code})")
                return None

            current_urls = parse_sitemap_urls(resp.text)
            current_products = filter_product_urls(current_urls)

            # First poll — just store baseline
            if self.known_urls is None:
                self.known_urls = current_urls
                self.known_product_urls = current_products
                log.info(f"Sitemap baseline: {len(current_urls)} URLs, {len(current_products)} products")
                return None

            # Diff — find new URLs
            new_urls = current_urls - self.known_urls
            new_products = current_products - self.known_product_urls

            # Update stored snapshot
            self.known_urls = current_urls
            self.known_product_urls = current_products

            if not new_urls:
                return None

            # New URLs detected
            if new_products:
                log.info(f"New product URLs detected: {new_products}")
                return Signal(
                    signal_type=SignalType.SITEMAP,
                    alert_level=AlertLevel.WARNING,
                    site_state=SiteState.NORMAL,
                    title=f"🆕 {len(new_products)} New Product URL(s) in Sitemap",
                    detail=f"New products staged — possible upcoming drop",
                    detected_urls=sorted(new_products),
                )
            else:
                # Non-product pages added (categories, etc) — lower priority
                log.info(f"New non-product URLs: {len(new_urls)}")
                return Signal(
                    signal_type=SignalType.SITEMAP,
                    alert_level=AlertLevel.INFO,
                    site_state=SiteState.NORMAL,
                    title=f"📄 {len(new_urls)} New Page(s) in Sitemap",
                    detail="Non-product pages added",
                    detected_urls=sorted(new_urls)[:10],  # Cap at 10 for readability
                )

        except httpx.TimeoutException:
            log.warning("Sitemap poll timed out")
            return None
        except Exception as e:
            log.error(f"Sitemap poll error: {e}")
            return None

    async def close(self):
        if self.client and not self.client.is_closed:
            await self.client.aclose()
