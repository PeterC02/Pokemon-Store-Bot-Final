"""Product Catalog Monitor — polls the PKC search API for new/changed products.

The search API at /tpci-ecommweb-api/search returns product listings
without triggering Imperva (as long as we don't add Content-Type header
or locale params). This lets us detect:
- New products added to the store
- Price changes on existing products
- Products going in/out of stock
- Products with future availability dates (staged for drop)

IMPORTANT: Do NOT add Content-Type header or locale= param to GET requests
— that triggers Imperva hard-block (errorCode 15).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Optional

import httpx

import db
from models import AlertLevel, Signal, SignalType, SiteState

log = logging.getLogger("pkc-detect.catalog")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# PKC search API — returns JSON product listings
SEARCH_API = "https://www.pokemoncenter.com/tpci-ecommweb-api/search"

# Categories to monitor for drops (TCG, plush, figures, etc.)
SEARCH_QUERIES = [
    "",                    # All recent products
    "elite trainer box",
    "booster bundle",
    "special collection",
    "premium collection",
    "ultra premium",
]

# How many results to fetch per query
PAGE_SIZE = 48


def extract_products(data: dict) -> list[dict]:
    """Extract normalized product info from search API response."""
    products = []
    hits = data.get("hits", data.get("results", []))
    if isinstance(hits, list):
        for item in hits:
            product = {
                "id": item.get("objectID", item.get("id", "")),
                "name": item.get("name", item.get("title", "Unknown")),
                "url": item.get("url", ""),
                "price": item.get("price", {}).get("regularPrice", item.get("price", None)),
                "sale_price": item.get("price", {}).get("salePrice", None),
                "image": item.get("image", item.get("imageUrl", "")),
                "available": item.get("available", item.get("inStock", None)),
                "release_date": item.get("releaseDate", item.get("availabilityDate", None)),
                "categories": item.get("categories", []),
            }
            # Normalize URL to full path
            if product["url"] and not product["url"].startswith("http"):
                product["url"] = f"https://www.pokemoncenter.com{product['url']}"
            products.append(product)
    return products


class CatalogMonitor:
    """Polls the PKC search API and detects new/changed products."""

    def __init__(self):
        self.known_products: dict[str, dict] = {}  # id → product
        self._initialized = False
        self.client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self.client is None or self.client.is_closed:
            self.client = httpx.AsyncClient(
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                    # NO Content-Type header — triggers Imperva!
                },
                follow_redirects=True,
                timeout=15.0,
            )
        return self.client

    async def poll(self) -> list[Signal]:
        """Poll the search API. Returns a list of signals (may be empty).
        
        Skips polling when the site is in challenge/queue state since the
        search API is blocked behind Imperva during those periods.
        """
        signals = []

        try:
            # Check current site state — skip if challenge gate or queue is active
            status = await db.get_site_status()
            site_state = status.get("state", "unknown") if status else "unknown"
            if site_state in ("challenge", "queue", "maintenance"):
                log.debug(f"Catalog poll skipped — site in {site_state} state")
                return signals

            client = await self._get_client()
            all_products: dict[str, dict] = {}

            for query in SEARCH_QUERIES:
                try:
                    params = {"hitsPerPage": PAGE_SIZE}
                    if query:
                        params["q"] = query

                    resp = await client.get(SEARCH_API, params=params)

                    # Check for DataDome captcha challenge
                    if resp.status_code == 403 or "captcha-delivery.com" in resp.text:
                        log.debug(f"Search API captcha for query '{query}' — skipping")
                        continue

                    # Check for Imperva block
                    if "errorCode" in resp.text and "15" in resp.text:
                        log.debug(f"Search API Imperva block for query '{query}' — skipping")
                        continue

                    if resp.status_code != 200:
                        continue

                    data = resp.json()
                    products = extract_products(data)
                    for p in products:
                        if p["id"]:
                            all_products[p["id"]] = p

                except Exception as e:
                    log.debug(f"Search query '{query}' failed: {e}")
                    continue

            if not all_products:
                return signals

            # First poll — store baseline
            if not self._initialized:
                self.known_products = all_products
                self._initialized = True
                log.info(f"Catalog baseline: {len(all_products)} products")
                return signals

            # Diff — find new products
            new_ids = set(all_products.keys()) - set(self.known_products.keys())
            if new_ids:
                new_products = [all_products[pid] for pid in new_ids]
                signals.append(self._new_products_signal(new_products))

            # Check for price changes on known products
            for pid, product in all_products.items():
                if pid in self.known_products:
                    old = self.known_products[pid]
                    # Price drop
                    if old.get("price") and product.get("price"):
                        if product["price"] != old["price"]:
                            signals.append(self._price_change_signal(old, product))
                    # Availability change (out of stock → in stock = restock)
                    if old.get("available") is False and product.get("available") is True:
                        signals.append(self._restock_signal(product))

            # Update snapshot
            self.known_products = all_products
            return signals

        except Exception as e:
            log.error(f"Catalog poll error: {e}")
            return signals

    def _new_products_signal(self, products: list[dict]) -> Signal:
        names = [p["name"] for p in products[:5]]
        urls = [p["url"] for p in products if p["url"]][:5]
        names_str = ", ".join(names)

        # Check if any look like TCG drops (high value)
        tcg_keywords = ["elite trainer", "booster", "collection", "premium", "charizard", "pikachu"]
        is_tcg = any(
            any(kw in p["name"].lower() for kw in tcg_keywords)
            for p in products
        )

        return Signal(
            signal_type=SignalType.SEARCH_API,
            alert_level=AlertLevel.WARNING if is_tcg else AlertLevel.INFO,
            site_state=SiteState.NORMAL,
            title=f"🆕 {len(products)} New Product(s) Detected",
            detail=f"Products: {names_str}",
            detected_urls=urls,
        )

    def _price_change_signal(self, old: dict, new: dict) -> Signal:
        return Signal(
            signal_type=SignalType.SEARCH_API,
            alert_level=AlertLevel.INFO,
            site_state=SiteState.NORMAL,
            title=f"💰 Price Change: {new['name']}",
            detail=f"£{old.get('price', '?')} → £{new.get('price', '?')}",
            detected_urls=[new["url"]] if new.get("url") else [],
        )

    def _restock_signal(self, product: dict) -> Signal:
        return Signal(
            signal_type=SignalType.SEARCH_API,
            alert_level=AlertLevel.WARNING,
            site_state=SiteState.NORMAL,
            title=f"📦 Restock: {product['name']}",
            detail=f"Previously out of stock, now available",
            detected_urls=[product["url"]] if product.get("url") else [],
        )

    async def close(self):
        if self.client and not self.client.is_closed:
            await self.client.aclose()
