"""MessageFormatter — translates raw detection signals into user-facing messages.

Every signal type gets a human-readable template that a Pokemon TCG collector
(not a developer) can understand. Produces a UserMessage with:
- headline: short, attention-grabbing title
- body: 1-3 sentence explanation with context
- action_hint: what the user should do right now
- embed_color: hex color for Discord/app embeds
- emoji: leading emoji for the headline
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class UserMessage:
    """A user-facing message produced from a raw signal."""
    headline: str
    body: str
    action_hint: str = ""
    embed_color: int = 0x95A5A6  # Default grey
    emoji: str = ""
    product_names: list[str] = field(default_factory=list)
    product_urls: list[str] = field(default_factory=list)
    image_url: Optional[str] = None


def format_signal(signal: dict) -> UserMessage:
    """Convert a raw signal dict into a human-readable UserMessage.

    Args:
        signal: dict with keys signal_type, alert_level, site_state,
                title, detail, detected_urls, timestamp
    """
    sig_type = signal.get("signal_type", "")
    site_state = signal.get("site_state", "")
    detail = signal.get("detail", "")
    urls = signal.get("detected_urls", [])
    if isinstance(urls, str):
        import json
        try:
            urls = json.loads(urls)
        except Exception:
            urls = []

    # Extract product names from URLs when available
    product_names = [_name_from_url(u) for u in urls if u]

    # Route to the appropriate template
    if sig_type == "homepage":
        return _format_homepage(site_state, detail, product_names, urls)
    elif sig_type == "sitemap":
        return _format_sitemap(detail, product_names, urls)
    elif sig_type == "search_api":
        return _format_catalog(signal.get("title", ""), detail, product_names, urls)
    elif sig_type == "build_id":
        return _format_build_id(detail)
    elif sig_type == "social":
        return _format_social(signal.get("title", ""), detail, urls)
    else:
        return _format_generic(signal)


# ---------------------------------------------------------------------------
# Homepage state transitions
# ---------------------------------------------------------------------------

def _format_homepage(state: str, detail: str, names: list, urls: list) -> UserMessage:
    if state == "queue":
        wait_info = ""
        if "wait=" in detail:
            wait_time = detail.split("wait=")[1].split()[0]
            wait_info = f" Estimated wait: {wait_time}."
        return UserMessage(
            emoji="🚨",
            headline="THE QUEUE IS LIVE",
            body=(
                "Pokemon Center is dropping right now! The waiting room queue "
                "has been activated." + wait_info
            ),
            action_hint="Get in line immediately — open Pokemon Center in your browser now.",
            embed_color=0xE74C3C,  # Red
        )

    elif state == "challenge":
        return UserMessage(
            emoji="🟡",
            headline="Security Gate Activated",
            body=(
                "Pokemon Center has turned on its security checkpoint. "
                "This often happens 1-2 hours before a drop goes live, but it can also "
                "be routine maintenance. We're monitoring closely."
            ),
            action_hint="Stay alert — have Pokemon Center open and ready to refresh.",
            embed_color=0xF39C12,  # Amber
        )

    elif state == "normal":
        return UserMessage(
            emoji="🟢",
            headline="Site is Back to Normal",
            body=(
                "Pokemon Center's security checkpoint has been lifted. "
                "The site is operating normally. If a drop just ended, the queue "
                "has cleared."
            ),
            action_hint="You can browse Pokemon Center normally now.",
            embed_color=0x2ECC71,  # Green
        )

    elif state == "maintenance":
        return UserMessage(
            emoji="🟠",
            headline="Site Maintenance Detected",
            body=(
                "Pokemon Center appears to be experiencing issues or undergoing "
                "maintenance. This could be a sign of preparation for a drop, "
                "or it could be unrelated downtime."
            ),
            action_hint="Check back in 15-30 minutes.",
            embed_color=0xE67E22,  # Orange
        )

    else:
        return UserMessage(
            emoji="❓",
            headline="Unusual Site Behaviour",
            body=(
                "Pokemon Center is responding in an unexpected way. "
                "We're investigating."
            ),
            action_hint="No action needed — we'll update you when we know more.",
            embed_color=0x95A5A6,  # Grey
        )


# ---------------------------------------------------------------------------
# Sitemap changes
# ---------------------------------------------------------------------------

def _format_sitemap(detail: str, names: list, urls: list) -> UserMessage:
    count = len(urls)
    is_products = "product" in detail.lower() or any("/product/" in u for u in urls)

    if is_products:
        names_str = _join_names(names, max_show=5)
        return UserMessage(
            emoji="🆕",
            headline=f"{count} New Product{'s' if count != 1 else ''} Detected in Catalog",
            body=(
                f"New products just appeared on Pokemon Center's internal catalog: "
                f"{names_str}. "
                f"Products typically appear in the catalog 12-48 hours before they "
                f"go on sale."
            ),
            action_hint="These could drop soon — we'll alert you when the queue goes live.",
            embed_color=0xF39C12,  # Amber
            product_names=names,
            product_urls=urls,
        )
    else:
        return UserMessage(
            emoji="📄",
            headline=f"{count} New Page{'s' if count != 1 else ''} Added to Site",
            body=(
                "New non-product pages were added to Pokemon Center. "
                "This is usually routine content updates."
            ),
            action_hint="No action needed.",
            embed_color=0x3498DB,  # Blue
            product_urls=urls,
        )


# ---------------------------------------------------------------------------
# Catalog / Search API
# ---------------------------------------------------------------------------

def _format_catalog(title: str, detail: str, names: list, urls: list) -> UserMessage:
    title_lower = title.lower()

    if "restock" in title_lower:
        name = names[0] if names else "A product"
        return UserMessage(
            emoji="📦",
            headline=f"Restock: {name}",
            body=(
                f"{name} is back in stock on Pokemon Center! "
                f"This was previously sold out."
            ),
            action_hint="Act fast — restocks can sell out quickly.",
            embed_color=0x2ECC71,  # Green
            product_names=names,
            product_urls=urls,
        )

    elif "price" in title_lower:
        return UserMessage(
            emoji="💰",
            headline="Price Change Detected",
            body=detail or "A product's price has changed on Pokemon Center.",
            action_hint="Check the product page for current pricing.",
            embed_color=0x3498DB,  # Blue
            product_names=names,
            product_urls=urls,
        )

    else:
        # New products from catalog API
        count = len(names) or len(urls)
        names_str = _join_names(names, max_show=5)
        return UserMessage(
            emoji="🆕",
            headline=f"{count} New Product{'s' if count != 1 else ''} Found",
            body=(
                f"Our catalog scanner detected new products: {names_str}. "
                f"These are now being tracked."
            ),
            action_hint="We'll notify you if these become available for purchase.",
            embed_color=0xF39C12,  # Amber
            product_names=names,
            product_urls=urls,
        )


# ---------------------------------------------------------------------------
# Build ID changes
# ---------------------------------------------------------------------------

def _format_build_id(detail: str) -> UserMessage:
    return UserMessage(
        emoji="🔄",
        headline="Website Update Deployed",
        body=(
            "Pokemon Center just pushed a website update. "
            "Historically, site deployments happen a few hours before a drop — "
            "but they also happen for routine updates. We're watching for follow-up signals."
        ),
        action_hint="No action yet — we'll escalate if more signals appear.",
        embed_color=0xF39C12,  # Amber
    )


# ---------------------------------------------------------------------------
# Social / community content
# ---------------------------------------------------------------------------

def _format_social(title: str, detail: str, urls: list) -> UserMessage:
    return UserMessage(
        emoji="💬",
        headline=title or "Community Buzz",
        body=detail or "New activity from the Pokemon TCG community.",
        action_hint="",
        embed_color=0x9B59B6,  # Purple
        product_urls=urls,
    )


# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------

def _format_generic(signal: dict) -> UserMessage:
    return UserMessage(
        emoji="📡",
        headline=signal.get("title", "Detection Signal"),
        body=signal.get("detail", ""),
        action_hint="",
        embed_color=0x95A5A6,  # Grey
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _name_from_url(url: str) -> str:
    """Extract a human-readable product name from a PKC URL.

    e.g. /product/12345-charizard-ex-premium-collection/ → Charizard Ex Premium Collection
    """
    if not url:
        return "Unknown Product"

    # Get the last path segment
    path = url.rstrip("/").split("/")[-1]

    # Remove leading product ID (digits and first dash)
    # Pattern: "12345-product-name" or just "product-name"
    parts = path.split("-")
    if parts and parts[0].isdigit():
        parts = parts[1:]

    if not parts:
        return "Unknown Product"

    # Title case and join
    name = " ".join(parts).title()

    # Clean up common abbreviations
    name = name.replace(" Ex ", " ex ")
    name = name.replace(" Vmax ", " VMAX ")
    name = name.replace(" Vstar ", " VSTAR ")
    name = name.replace(" Gx ", " GX ")
    name = name.replace(" V ", " V ")
    name = name.replace(" Etb ", " ETB ")
    name = name.replace(" Tcg ", " TCG ")

    return name


def _join_names(names: list[str], max_show: int = 5) -> str:
    """Join product names into a readable string."""
    if not names:
        return "unnamed products"

    shown = names[:max_show]
    remaining = len(names) - max_show

    result = ", ".join(f"**{n}**" for n in shown)
    if remaining > 0:
        result += f" and {remaining} more"

    return result
