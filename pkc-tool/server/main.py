"""Canary by Heuricity — Central Detection Server.

FastAPI app providing:
- WebSocket push for real-time signals to Electron clients
- REST API for signals, users, auth
- Background detection engine
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional

import jwt
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Query, Body, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

import config
import db
from models import (
    AlertLevel,
    Signal,
    SignalType,
    SiteState,
    SiteStatus,
    TokenResponse,
    UserCreate,
    UserLogin,
    UserOut,
    UserRole,
    WSMessage,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("pkc-server")

# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        self.active: dict[int, list[WebSocket]] = {}  # user_id → [ws, ...]

    async def connect(self, ws: WebSocket, user_id: int):
        await ws.accept()
        self.active.setdefault(user_id, []).append(ws)
        log.info(f"WS connected: user={user_id} (total={self.total})")

    def disconnect(self, ws: WebSocket, user_id: int):
        if user_id in self.active:
            self.active[user_id] = [w for w in self.active[user_id] if w is not ws]
            if not self.active[user_id]:
                del self.active[user_id]
        log.info(f"WS disconnected: user={user_id} (total={self.total})")

    @property
    def total(self) -> int:
        return sum(len(v) for v in self.active.values())

    async def broadcast(self, message: WSMessage):
        data = message.model_dump_json()
        disconnected = []
        for user_id, sockets in self.active.items():
            for ws in sockets:
                try:
                    await ws.send_text(data)
                except Exception:
                    disconnected.append((user_id, ws))
        for user_id, ws in disconnected:
            self.disconnect(ws, user_id)

    async def send_to_user(self, user_id: int, message: WSMessage):
        if user_id not in self.active:
            return
        data = message.model_dump_json()
        for ws in self.active[user_id]:
            try:
                await ws.send_text(data)
            except Exception:
                self.disconnect(ws, user_id)


manager = ConnectionManager()

# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

security = HTTPBearer()


def create_token(user_id: int, role: str) -> str:
    payload = {
        "sub": str(user_id),
        "role": role,
        "exp": datetime.utcnow() + timedelta(hours=config.JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=[config.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


async def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    payload = decode_token(creds.credentials)
    user = await db.get_user_by_id(int(payload["sub"]))
    if not user:
        raise HTTPException(401, "User not found")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != UserRole.ADMIN:
        raise HTTPException(403, "Admin required")
    return user


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await db.init_db(config.DB_PATH)
    log.info(f"Database initialised at {config.DB_PATH}")

    # Ensure admin user exists
    admin = await db.get_user_by_username("admin")
    if not admin:
        admin_pass = secrets.token_urlsafe(16)
        await db.create_user("admin", admin_pass, role="admin")
        log.info(f"Created admin user — password: {admin_pass}")
        log.info("⚠️  Save this password! It won't be shown again.")

    # Start detection engine
    from detection.engine import DetectionEngine
    from detection.predictor import DropPredictor
    engine = DetectionEngine(manager)
    engine_task = asyncio.create_task(engine.run())
    app.state.engine = engine
    app.state.predictor = DropPredictor()

    yield

    # Shutdown
    engine_task.cancel()
    await db.close_db()
    log.info("Server shut down")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Canary API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

@app.post("/api/auth/register", response_model=TokenResponse)
async def register(body: UserCreate):
    # Validate invite code
    existing = await db.get_user_by_username(body.username)
    if existing:
        raise HTTPException(400, "Username taken")

    # Create user first to get ID, then mark invite used
    user = await db.create_user(body.username, body.password)
    used = await db.use_invite_code(body.invite_code, user["id"])
    if not used:
        # Rollback — delete user (simple approach)
        d = await db.get_db()
        await d.execute("DELETE FROM users WHERE id = ?", (user["id"],))
        await d.commit()
        raise HTTPException(400, "Invalid or used invite code")

    token = create_token(user["id"], user["role"])
    return TokenResponse(
        access_token=token,
        user=UserOut(
            id=user["id"],
            username=user["username"],
            role=user["role"],
            created_at=user["created_at"],
        ),
    )


@app.post("/api/auth/login", response_model=TokenResponse)
async def login(body: UserLogin):
    user = await db.verify_password(body.username, body.password)
    if not user:
        raise HTTPException(401, "Invalid credentials")
    token = create_token(user["id"], user["role"])
    return TokenResponse(
        access_token=token,
        user=UserOut(
            id=user["id"],
            username=user["username"],
            role=user["role"],
            created_at=user["created_at"],
        ),
    )


# ---------------------------------------------------------------------------
# Invite codes (admin only)
# ---------------------------------------------------------------------------

@app.post("/api/invites")
async def create_invite(admin: dict = Depends(require_admin)):
    code = secrets.token_urlsafe(8)
    await db.create_invite_code(code, admin["id"])
    return {"code": code}


@app.get("/api/invites")
async def list_invites(admin: dict = Depends(require_admin)):
    codes = await db.list_invite_codes()
    return codes


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

@app.get("/api/signals")
async def get_signals(
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
    signal_type: str | None = Query(None),
    user: dict = Depends(get_current_user),
):
    return await db.get_signals(limit, offset, signal_type=signal_type)


# ---------------------------------------------------------------------------
# Site status
# ---------------------------------------------------------------------------

@app.get("/api/status")
async def get_status(user: dict = Depends(get_current_user)):
    return await db.get_site_status()


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------

@app.get("/api/products")
async def get_products(
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    return await db.get_products(limit, offset)


@app.get("/api/products/{product_id}")
async def get_product(product_id: str, user: dict = Depends(get_current_user)):
    product = await db.get_product_by_id(product_id)
    if not product:
        raise HTTPException(404, "Product not found")
    return product


# ---------------------------------------------------------------------------
# Drop events (history)
# ---------------------------------------------------------------------------

@app.get("/api/drops")
async def get_drops(
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    return await db.get_drop_events(limit, offset)


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

@app.get("/api/prediction")
async def get_prediction(user: dict = Depends(get_current_user)):
    predictor = app.state.predictor
    prediction = await predictor.predict()

    # Add LLM-generated narrative if available
    from llm_service import generate_prediction_narrative, is_configured
    if is_configured() and not prediction.get("narrative"):
        try:
            narrative = await generate_prediction_narrative(prediction)
            prediction["narrative"] = narrative
        except Exception:
            pass

    return prediction


# ---------------------------------------------------------------------------
# Partners (admin-managed)
# ---------------------------------------------------------------------------

@app.post("/api/partners")
async def create_partner(
    name: str = Body(...),
    owner_discord_id: str = Body(...),
    owner_email: str = Body(""),
    admin: dict = Depends(require_admin),
):
    """Create a new partner (admin only). Generates a unique invite code."""
    import secrets
    invite_code = secrets.token_urlsafe(8)
    partner = await db.create_partner(
        name=name,
        owner_discord_id=owner_discord_id,
        owner_email=owner_email,
        invite_code=invite_code,
    )
    return partner


@app.get("/api/partners")
async def list_partners(
    status: str | None = Query(None),
    admin: dict = Depends(require_admin),
):
    return await db.get_partners(status=status)


@app.get("/api/partners/{partner_id}")
async def get_partner(partner_id: int, admin: dict = Depends(require_admin)):
    p = await db.get_partner_by_id(partner_id)
    if not p:
        raise HTTPException(404, "Partner not found")
    subs = await db.count_active_subs_for_partner(partner_id)
    guilds = await db.get_guilds_for_partner(partner_id)
    p["subscription_counts"] = subs
    p["guilds"] = guilds
    return p


@app.patch("/api/partners/{partner_id}/status")
async def update_partner_status(
    partner_id: int,
    status: str = Body(..., embed=True),
    admin: dict = Depends(require_admin),
):
    if status not in ("pending", "approved", "suspended"):
        raise HTTPException(400, "Invalid status")
    await db.update_partner_status(partner_id, status)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Partner lookup (public — used by subscribe flow)
# ---------------------------------------------------------------------------

@app.get("/api/partner-by-code/{invite_code}")
async def get_partner_by_code(invite_code: str):
    """Public endpoint to look up a partner by invite code (for subscribe page)."""
    partner = await db.get_partner_by_invite(invite_code)
    if not partner or partner["status"] != "approved":
        raise HTTPException(404, "Partner not found")
    # Return only public fields
    return {
        "id": partner["id"],
        "name": partner["name"],
        "invite_code": partner["invite_code"],
    }


# ---------------------------------------------------------------------------
# Subscriptions
# ---------------------------------------------------------------------------

@app.get("/api/subscriptions")
async def list_subscriptions(
    guild_id: str | None = Query(None),
    partner_id: int | None = Query(None),
    admin: dict = Depends(require_admin),
):
    if guild_id:
        return await db.get_subscriptions_for_guild(guild_id)
    elif partner_id:
        return await db.get_subscriptions_for_partner(partner_id)
    raise HTTPException(400, "Provide guild_id or partner_id")


@app.get("/api/subscriptions/check")
async def check_subscription(
    user_discord_id: str = Query(...),
    guild_id: str = Query(...),
):
    """Public check: does this user have an active sub in this guild?"""
    sub = await db.get_active_subscription(user_discord_id, guild_id)
    if sub:
        return {"active": True, "tier": sub["tier"], "expires_at": sub.get("expires_at")}
    return {"active": False}


# ---------------------------------------------------------------------------
# Discord OAuth2 (user auth for subscribe flow)
# ---------------------------------------------------------------------------

DISCORD_API = "https://discord.com/api/v10"
DISCORD_OAUTH_URL = "https://discord.com/api/oauth2/authorize"


@app.get("/api/auth/discord/desktop")
async def discord_oauth_desktop_start():
    """Start Discord OAuth for the Electron desktop app.

    Uses a separate redirect URI that returns a JWT token instead of
    creating a Stripe checkout session.
    """
    if not config.DISCORD_CLIENT_ID or not config.DISCORD_CLIENT_SECRET:
        raise HTTPException(500, "Discord OAuth not configured")

    import urllib.parse
    import base64
    state = base64.urlsafe_b64encode(b'{"source":"desktop"}').decode()

    # Desktop callback uses same base but different path
    desktop_redirect = config.DISCORD_REDIRECT_URI.replace(
        "/api/auth/discord/callback",
        "/api/auth/discord/desktop/callback"
    )

    params = {
        "client_id": config.DISCORD_CLIENT_ID,
        "redirect_uri": desktop_redirect,
        "response_type": "code",
        "scope": "identify",
        "state": state,
    }
    url = f"{DISCORD_OAUTH_URL}?{urllib.parse.urlencode(params)}"

    from fastapi.responses import RedirectResponse
    return RedirectResponse(url)


@app.get("/api/auth/discord/desktop/callback")
async def discord_oauth_desktop_callback(
    code: str = Query(...),
    state: str = Query(""),
):
    """Discord OAuth callback for the desktop app.

    Exchanges code for Discord user info, creates or finds a local user,
    and redirects to a canary://auth URL with the JWT token so the
    Electron app can capture it.
    """
    if not config.DISCORD_CLIENT_ID or not config.DISCORD_CLIENT_SECRET:
        raise HTTPException(500, "Discord OAuth not configured")

    desktop_redirect = config.DISCORD_REDIRECT_URI.replace(
        "/api/auth/discord/callback",
        "/api/auth/discord/desktop/callback"
    )

    import httpx
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            f"{DISCORD_API}/oauth2/token",
            data={
                "client_id": config.DISCORD_CLIENT_ID,
                "client_secret": config.DISCORD_CLIENT_SECRET,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": desktop_redirect,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if token_resp.status_code != 200:
            raise HTTPException(400, "Discord OAuth failed")
        token_data = token_resp.json()

        user_resp = await client.get(
            f"{DISCORD_API}/users/@me",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )
        if user_resp.status_code != 200:
            raise HTTPException(400, "Could not fetch Discord user")
        discord_user = user_resp.json()

    discord_id = discord_user["id"]
    username = discord_user.get("username", "unknown")

    # Find or create user
    user = await db.get_user_by_username(f"discord_{discord_id}")
    if not user:
        import secrets as _secrets
        user = await db.create_user(f"discord_{discord_id}", _secrets.token_urlsafe(32))

    # Create JWT
    token = create_token(user["id"], user.get("role", "user"))

    # Redirect with token params — Electron BrowserWindow will intercept this
    import urllib.parse
    params = urllib.parse.urlencode({
        "token": token,
        "username": username,
        "user_id": str(user["id"]),
        "discord_id": discord_id,
    })

    from fastapi.responses import HTMLResponse
    # Return a simple HTML page that shows success and has the token in the URL
    # The Electron app's did-navigate handler will capture the token from the URL
    return HTMLResponse(f"""<!DOCTYPE html>
<html><head><title>Canary — Signed In</title>
<style>body{{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
.card{{text-align:center;padding:2rem}}.ok{{color:#facc15;font-size:2rem}}p{{color:#888;font-size:14px}}</style>
<script>window.location.href = "/api/auth/discord/desktop/done?{params}";</script>
</head><body><div class="card"><div class="ok">✓</div><h2>Signed in as {username}</h2><p>Returning to Canary...</p></div></body></html>""")


@app.get("/api/auth/discord/desktop/done")
async def discord_oauth_desktop_done(
    token: str = Query(""),
    username: str = Query(""),
    user_id: str = Query(""),
    discord_id: str = Query(""),
):
    """Final landing page for desktop OAuth — Electron intercepts the URL params."""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(f"""<!DOCTYPE html>
<html><head><title>Canary — Ready</title>
<style>body{{font-family:system-ui;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
.card{{text-align:center;padding:2rem}}.ok{{color:#facc15;font-size:2rem}}p{{color:#888;font-size:14px}}</style>
</head><body><div class="card"><div class="ok">✓</div><h2>Welcome, {username}</h2><p>You can close this window now.</p></div></body></html>""")


@app.get("/api/auth/discord")
async def discord_oauth_start(
    tier: str = Query("bot"),
    billing: str = Query("monthly"),
    guild_id: str = Query(""),
    ref: str = Query(""),
):
    """Redirect user to Discord OAuth. State carries subscription intent."""
    if not config.DISCORD_CLIENT_ID or not config.DISCORD_CLIENT_SECRET:
        raise HTTPException(500, "Discord OAuth not configured")

    import urllib.parse
    state_data = json.dumps({"tier": tier, "billing": billing, "guild_id": guild_id, "ref": ref})
    import base64
    state = base64.urlsafe_b64encode(state_data.encode()).decode()

    params = {
        "client_id": config.DISCORD_CLIENT_ID,
        "redirect_uri": config.DISCORD_REDIRECT_URI,
        "response_type": "code",
        "scope": "identify guilds",
        "state": state,
    }
    url = f"{DISCORD_OAUTH_URL}?{urllib.parse.urlencode(params)}"

    from fastapi.responses import RedirectResponse
    return RedirectResponse(url)


@app.get("/api/auth/discord/callback")
async def discord_oauth_callback(
    code: str = Query(...),
    state: str = Query(""),
):
    """Discord OAuth callback → exchange code for user info → redirect to Stripe Checkout."""
    if not config.DISCORD_CLIENT_ID or not config.DISCORD_CLIENT_SECRET:
        raise HTTPException(500, "Discord OAuth not configured")

    import base64
    try:
        state_data = json.loads(base64.urlsafe_b64decode(state).decode())
    except Exception:
        state_data = {}

    tier = state_data.get("tier", "bot")
    billing = state_data.get("billing", "monthly")
    guild_id = state_data.get("guild_id", "")
    ref = state_data.get("ref", "")

    # Exchange code for access token
    import httpx
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            f"{DISCORD_API}/oauth2/token",
            data={
                "client_id": config.DISCORD_CLIENT_ID,
                "client_secret": config.DISCORD_CLIENT_SECRET,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": config.DISCORD_REDIRECT_URI,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if token_resp.status_code != 200:
            raise HTTPException(400, "Discord OAuth failed")
        token_data = token_resp.json()

        # Fetch user info
        user_resp = await client.get(
            f"{DISCORD_API}/users/@me",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )
        if user_resp.status_code != 200:
            raise HTTPException(400, "Could not fetch Discord user")
        discord_user = user_resp.json()

    user_discord_id = discord_user["id"]
    username = discord_user.get("username", "unknown")

    # Resolve partner from ref code
    partner_id = 0
    if ref:
        partner = await db.get_partner_by_invite(ref)
        if partner and partner["status"] == "approved":
            partner_id = partner["id"]
            # If no guild_id specified, try to find the partner's first guild
            if not guild_id:
                guilds = await db.get_guilds_for_partner(partner_id)
                if guilds:
                    guild_id = guilds[0]["guild_id"]

    # Create Stripe Checkout session
    if not config.STRIPE_SECRET_KEY:
        raise HTTPException(500, "Stripe not configured")

    import stripe as stripe_lib
    stripe_lib.api_key = config.STRIPE_SECRET_KEY

    price_key = f"{tier}_{billing}"
    price_amount = config.PRICES.get(price_key)
    if not price_amount:
        raise HTTPException(400, f"Invalid tier/billing: {tier}/{billing}")

    interval = "month" if billing == "monthly" else "year"
    tier_label = "Canary Discord Bot" if tier == "bot" else "Canary Desktop + Bot"

    session = stripe_lib.checkout.Session.create(
        payment_method_types=["card"],
        mode="subscription",
        customer_email=None,
        line_items=[{
            "price_data": {
                "currency": "gbp",
                "unit_amount": price_amount,
                "recurring": {"interval": interval},
                "product_data": {"name": tier_label},
            },
            "quantity": 1,
        }],
        metadata={
            "user_discord_id": user_discord_id,
            "discord_username": username,
            "partner_id": str(partner_id),
            "guild_id": guild_id,
            "tier": tier,
            "billing_period": billing,
        },
        success_url=f"{config.DISCORD_REDIRECT_URI.rsplit('/api', 1)[0]}/subscribe/success?session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{config.DISCORD_REDIRECT_URI.rsplit('/api', 1)[0]}/subscribe?cancelled=true",
    )

    from fastapi.responses import RedirectResponse
    return RedirectResponse(session.url, status_code=303)


# ---------------------------------------------------------------------------
# Stripe webhook
# ---------------------------------------------------------------------------

@app.post("/api/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events for subscription lifecycle."""
    import stripe as stripe_lib

    if not config.STRIPE_WEBHOOK_SECRET or not config.STRIPE_SECRET_KEY:
        raise HTTPException(500, "Stripe not configured")

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")

    try:
        stripe_lib.api_key = config.STRIPE_SECRET_KEY
        event = stripe_lib.Webhook.construct_event(payload, sig, config.STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        raise HTTPException(400, f"Invalid webhook: {e}")

    event_type = event["type"]
    data = event["data"]["object"]
    log.info(f"Stripe webhook: {event_type}")

    if event_type == "checkout.session.completed":
        # New subscription created via Checkout
        meta = data.get("metadata", {})
        user_discord_id = meta.get("user_discord_id", "")
        partner_id = int(meta.get("partner_id", "0"))
        guild_id = meta.get("guild_id", "")
        tier = meta.get("tier", "bot")
        billing_period = meta.get("billing_period", "monthly")

        if user_discord_id and partner_id and guild_id:
            sub = await db.create_subscription(
                user_discord_id=user_discord_id,
                partner_id=partner_id,
                guild_id=guild_id,
                tier=tier,
                billing_period=billing_period,
                stripe_subscription_id=data.get("subscription", ""),
                stripe_customer_id=data.get("customer", ""),
            )
            log.info(f"New subscription #{sub['id']} for {user_discord_id} in guild {guild_id}")

            # Grant subscriber role in Discord
            try:
                from discord_bot import grant_subscriber_role
                await grant_subscriber_role(guild_id, user_discord_id)
            except Exception as e:
                log.warning(f"Role grant failed for {user_discord_id}: {e}")

    elif event_type == "customer.subscription.deleted":
        # Subscription cancelled
        stripe_sub_id = data.get("id", "")
        sub = await db.get_subscription_by_stripe(stripe_sub_id)
        if sub:
            await db.update_subscription_status(sub["id"], "cancelled")
            log.info(f"Subscription #{sub['id']} cancelled")

            # Revoke subscriber role in Discord
            try:
                from discord_bot import revoke_subscriber_role
                await revoke_subscriber_role(sub["guild_id"], sub["user_discord_id"])
            except Exception as e:
                log.warning(f"Role revoke failed: {e}")

    elif event_type == "invoice.payment_failed":
        # Payment failed — mark past_due
        stripe_sub_id = data.get("subscription", "")
        if stripe_sub_id:
            sub = await db.get_subscription_by_stripe(stripe_sub_id)
            if sub:
                await db.update_subscription_status(sub["id"], "past_due")
                log.info(f"Subscription #{sub['id']} past_due")

                # Revoke role on payment failure
                try:
                    from discord_bot import revoke_subscriber_role
                    await revoke_subscriber_role(sub["guild_id"], sub["user_discord_id"])
                except Exception as e:
                    log.warning(f"Role revoke on past_due failed: {e}")

    elif event_type == "invoice.paid":
        # Payment succeeded — ensure active
        stripe_sub_id = data.get("subscription", "")
        if stripe_sub_id:
            sub = await db.get_subscription_by_stripe(stripe_sub_id)
            if sub and sub["status"] != "active":
                await db.update_subscription_status(sub["id"], "active")
                log.info(f"Subscription #{sub['id']} reactivated")

                # Re-grant role on payment success
                try:
                    from discord_bot import grant_subscriber_role
                    await grant_subscriber_role(sub["guild_id"], sub["user_discord_id"])
                except Exception as e:
                    log.warning(f"Role re-grant failed: {e}")

    return {"received": True}


# ---------------------------------------------------------------------------
# Internal bot endpoints (admin-only)
# ---------------------------------------------------------------------------

@app.get("/api/internal/alert-channels")
async def get_alert_channels(admin: dict = Depends(require_admin)):
    """Return all guilds with completed setup for alert broadcasting."""
    return await db.get_all_alert_channels()


@app.post("/api/internal/guild-setup")
async def guild_setup(
    guild_id: str = Body(...),
    guild_name: str = Body(""),
    alert_channel_id: str = Body(...),
    subscriber_role_id: str = Body(...),
    owner_discord_id: str = Body(...),
    admin: dict = Depends(require_admin),
):
    """Called by /setup command to configure a guild."""
    # Find the partner by owner's Discord ID
    partner = await db.get_partner_by_discord(owner_discord_id)
    if not partner:
        raise HTTPException(404, "No partner found for this Discord user")
    if partner["status"] != "approved":
        raise HTTPException(403, "Partner not approved yet")

    guild = await db.upsert_partner_guild(
        partner_id=partner["id"],
        guild_id=guild_id,
        guild_name=guild_name,
        alert_channel_id=alert_channel_id,
        subscriber_role_id=subscriber_role_id,
    )
    return guild


# ---------------------------------------------------------------------------
# Connected clients info (admin)
# ---------------------------------------------------------------------------

@app.get("/api/clients")
async def get_clients(admin: dict = Depends(require_admin)):
    return {
        "total_connections": manager.total,
        "users_connected": len(manager.active),
        "user_ids": list(manager.active.keys()),
    }


# ---------------------------------------------------------------------------
# Health check (no auth)
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "connections": manager.total}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    # Authenticate via query param
    try:
        payload = decode_token(token)
    except HTTPException:
        await ws.close(code=4001, reason="Invalid token")
        return

    user_id = payload["sub"]
    await manager.connect(ws, user_id)

    try:
        # Send current status immediately
        status = await db.get_site_status()
        await ws.send_text(
            WSMessage(type="status", data=status).model_dump_json()
        )

        # Keep alive — listen for pings
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text(WSMessage(type="pong", data={}).model_dump_json())
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws, user_id)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=True)
