"""Server configuration — loaded from environment variables."""

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass  # python-dotenv not installed — rely on system env vars

# --- Paths ---
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.getenv("DB_PATH", str(BASE_DIR / "data" / "pkc.db"))

# --- Auth ---
JWT_SECRET = os.getenv("JWT_SECRET", "")
if not JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET environment variable is not set. "
        "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(32))\""
    )
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 720  # 30 days

# --- Detection ---
PKC_BASE_URL = os.getenv("PKC_BASE_URL", "https://www.pokemoncenter.com")
PKC_HOMEPAGE = f"{PKC_BASE_URL}/en-gb"
PKC_SITEMAP_URL = f"{PKC_BASE_URL}/sitemaps/pages.xml"
HOMEPAGE_POLL_INTERVAL = float(os.getenv("HOMEPAGE_POLL_INTERVAL", "5"))  # seconds
SITEMAP_POLL_INTERVAL = float(os.getenv("SITEMAP_POLL_INTERVAL", "60"))  # seconds

# --- Discord ---
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
DISCORD_CHANNEL_ID = os.getenv("DISCORD_CHANNEL_ID", "0")
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "")
DISCORD_REDIRECT_URI = os.getenv("DISCORD_REDIRECT_URI", "")

# --- Stripe ---
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_CONNECT_CLIENT_ID = os.getenv("STRIPE_CONNECT_CLIENT_ID", "")

# --- LLM ---
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "anthropic")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# --- Server ---
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# --- CORS ---
_cors_raw = os.getenv("CORS_ORIGINS", "")
CORS_ORIGINS: list[str] = (
    [o.strip() for o in _cors_raw.split(",") if o.strip()]
    if _cors_raw
    else ["http://localhost:3000"]  # dev only
)

# --- Pricing (pence / GBP) ---
PRICES = {
    "bot_monthly": 1000,       # £10
    "bot_annual": 10000,       # £100
    "desktop_monthly": 5000,   # £50
    "desktop_annual": 50000,   # £500
}
