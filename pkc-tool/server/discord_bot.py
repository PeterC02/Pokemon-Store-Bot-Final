"""Canary by Heuricity — Discord Bot.

Runs alongside the FastAPI server. Connects to the detection server's
internal API to provide:
- Slash commands: /status, /predict, /drops, /products
- Auto-posting alerts to a configured channel when signals fire
- Rich embeds with product images, predictions, and site status

Environment variables:
    DISCORD_BOT_TOKEN   — Bot token from Discord Developer Portal
    DISCORD_CHANNEL_ID  — Channel ID for auto-posting alerts
    SERVER_INTERNAL_URL — Internal URL for the detection server (default: http://localhost:8000)
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional

import discord
from discord import app_commands
from discord.ext import tasks

from detection.formatter import format_signal

log = logging.getLogger("pkc-bot")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
ALERT_CHANNEL_ID = int(os.getenv("DISCORD_CHANNEL_ID", "0"))
SERVER_URL = os.getenv("SERVER_INTERNAL_URL", "http://localhost:8000")

# ---------------------------------------------------------------------------
# Bot setup
# ---------------------------------------------------------------------------


class CanaryBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.members = True  # Needed for role management
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self._last_signal_id: int = 0

    async def setup_hook(self):
        """Register slash commands and start background tasks."""
        self.tree.add_command(cmd_status)
        self.tree.add_command(cmd_predict)
        self.tree.add_command(cmd_drops)
        self.tree.add_command(cmd_products)
        self.tree.add_command(cmd_signals)
        self.tree.add_command(cmd_trending)
        self.tree.add_command(cmd_setup)
        self.tree.add_command(cmd_subscribe)
        await self.tree.sync()
        log.info("Slash commands synced")

        # Start alert polling loop
        self.poll_alerts.start()

    async def on_ready(self):
        log.info(f"Canary bot ready: {self.user} (guilds: {len(self.guilds)})")

        # Seed last signal ID
        try:
            await _ensure_admin_token()
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{SERVER_URL}/api/signals?limit=1",
                                        headers=_admin_headers())
                if resp.status_code == 200:
                    data = resp.json()
                    if data:
                        self._last_signal_id = data[0].get("id", 0)
                        log.info(f"Seeded last signal ID: {self._last_signal_id}")
        except Exception as e:
            log.warning(f"Could not seed signal ID: {e}")

    @tasks.loop(seconds=10)
    async def poll_alerts(self):
        """Poll for new signals and broadcast to all configured guild channels."""
        try:
            await _ensure_admin_token()
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{SERVER_URL}/api/signals?limit=10",
                    headers=_admin_headers(),
                )
                if resp.status_code != 200:
                    return
                signals = resp.json()

            new_signals = [s for s in signals if s.get("id", 0) > self._last_signal_id]
            if not new_signals:
                return

            new_signals.sort(key=lambda s: s.get("id", 0))

            # Get all configured alert channels from DB
            alert_channels = await _get_alert_channels()

            # Fallback: if no guilds configured in DB, use legacy ALERT_CHANNEL_ID
            if not alert_channels and ALERT_CHANNEL_ID:
                ch = self.get_channel(ALERT_CHANNEL_ID)
                if ch:
                    alert_channels = [{"channel": ch, "role_id": None}]

            for sig in new_signals:
                embed = _signal_to_embed(sig)
                content = ""
                if sig.get("alert_level") == "critical":
                    content = "🚨 **DROP ALERT**"

                for ch_info in alert_channels:
                    try:
                        channel = ch_info.get("channel")
                        role_id = ch_info.get("role_id")
                        # Ping subscriber role for critical alerts
                        ping = ""
                        if sig.get("alert_level") == "critical" and role_id:
                            ping = f"<@&{role_id}> "
                        msg = f"{ping}{content}".strip() if (ping or content) else None
                        await channel.send(content=msg, embed=embed)
                    except Exception as e:
                        log.debug(f"Failed to send to channel: {e}")

                self._last_signal_id = sig.get("id", self._last_signal_id)

        except Exception as e:
            log.error(f"Alert poll error: {e}")

    @poll_alerts.before_loop
    async def before_poll(self):
        await self.wait_until_ready()


async def _get_alert_channels() -> list[dict]:
    """Get all configured alert channels from the DB via internal API."""
    try:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{SERVER_URL}/api/internal/alert-channels",
                headers=_admin_headers(),
            )
            if resp.status_code != 200:
                return []
            guild_configs = resp.json()

        channels = []
        for gc in guild_configs:
            ch_id = gc.get("alert_channel_id")
            if ch_id:
                channel = bot.get_channel(int(ch_id))
                if channel:
                    channels.append({
                        "channel": channel,
                        "role_id": gc.get("subscriber_role_id"),
                        "guild_id": gc.get("guild_id"),
                    })
        return channels
    except Exception as e:
        log.debug(f"Could not fetch alert channels: {e}")
        return []


async def _check_subscription(interaction: discord.Interaction) -> bool:
    """Check if the user has an active subscription in this guild.

    Returns True if the command should proceed, False if blocked.
    If the guild has no partner config (not set up for subscriptions), allow all.
    """
    if not interaction.guild:
        return False

    guild_id = str(interaction.guild.id)
    user_id = str(interaction.user.id)

    try:
        import httpx
        await _ensure_admin_token()
        async with httpx.AsyncClient() as client:
            # First check if this guild is configured for subscriptions
            guild_resp = await client.get(
                f"{SERVER_URL}/api/internal/alert-channels",
                headers=_admin_headers(),
            )
            if guild_resp.status_code == 200:
                guild_configs = guild_resp.json()
                configured_guilds = [g["guild_id"] for g in guild_configs]
                if guild_id not in configured_guilds:
                    # Guild not set up for subscriptions — allow all (free mode)
                    return True

            # Guild IS configured — check if user has active sub
            resp = await client.get(
                f"{SERVER_URL}/api/subscriptions/check",
                params={"user_discord_id": user_id, "guild_id": guild_id},
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("active", False)
    except Exception as e:
        log.debug(f"Subscription check error: {e}")

    # On error, default to BLOCKING access (fail closed)
    return False


# ---------------------------------------------------------------------------
# Helper: admin auth headers (server-side, no user auth needed)
# ---------------------------------------------------------------------------

_admin_token: Optional[str] = None


def _admin_headers() -> dict:
    """Get auth headers. For internal calls we login as admin."""
    global _admin_token
    if _admin_token:
        return {"Authorization": f"Bearer {_admin_token}"}
    # Will be set after first login
    return {}


async def _ensure_admin_token():
    """Login as admin to get a token for API calls."""
    global _admin_token
    if _admin_token:
        return

    import httpx
    admin_pass = os.getenv("ADMIN_PASSWORD", "")
    if not admin_pass:
        log.warning("ADMIN_PASSWORD not set — bot API calls will fail")
        return

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{SERVER_URL}/api/auth/login",
                json={"username": "admin", "password": admin_pass},
            )
            if resp.status_code == 200:
                _admin_token = resp.json()["access_token"]
                log.info("Admin token acquired")
            else:
                log.error(f"Admin login failed: {resp.status_code}")
    except Exception as e:
        log.error(f"Admin login error: {e}")


# ---------------------------------------------------------------------------
# Embed builders
# ---------------------------------------------------------------------------

COLORS = {
    "info": 0x2ECC71,
    "warning": 0xF39C12,
    "critical": 0xE74C3C,
}

STATE_ICONS = {
    "normal": "🟢 Normal — Site Open",
    "challenge": "🟡 Challenge Gate Active",
    "queue": "🔴 Queue is LIVE",
    "maintenance": "🟠 Maintenance",
    "unknown": "⚪ Unknown",
}


def _signal_to_embed(sig: dict) -> discord.Embed:
    """Convert a signal dict to a rich Discord embed using the MessageFormatter."""
    user_msg = format_signal(sig)

    embed = discord.Embed(
        title=f"{user_msg.emoji} {user_msg.headline}".strip(),
        description=user_msg.body,
        color=user_msg.embed_color,
        timestamp=datetime.fromisoformat(sig["timestamp"]) if sig.get("timestamp") else None,
    )
    embed.set_footer(text="Canary by Heuricity")

    # Action hint
    if user_msg.action_hint:
        embed.add_field(name="\U0001f4a1 What to do", value=user_msg.action_hint, inline=False)

    # Product links
    if user_msg.product_urls:
        links = []
        names = user_msg.product_names or []
        for i, url in enumerate(user_msg.product_urls[:5]):
            name = names[i] if i < len(names) else url.split("/")[-1].replace("-", " ").title()
            links.append(f"🔗 [{name}]({url})")
        if len(user_msg.product_urls) > 5:
            links.append(f"_...and {len(user_msg.product_urls) - 5} more_")
        embed.add_field(name="Products", value="\n".join(links), inline=False)

    if user_msg.image_url:
        embed.set_thumbnail(url=user_msg.image_url)

    return embed


def _prediction_embed(pred: dict) -> discord.Embed:
    """Build a rich embed for a drop prediction."""
    conf = pred.get("confidence", 0)
    if conf >= 0.6:
        color = 0xE74C3C  # Red — likely
    elif conf >= 0.4:
        color = 0xF39C12  # Amber — possible
    else:
        color = 0x3498DB  # Blue — low

    embed = discord.Embed(
        title="🔮 Drop Prediction",
        color=color,
    )

    embed.add_field(
        name="Predicted Window",
        value=f"**{pred.get('day_of_week', '?')}** {pred.get('time_range', '?')}",
        inline=False,
    )
    embed.add_field(
        name="Confidence",
        value=f"**{int(conf * 100)}%** — {pred.get('confidence_label', '?')}",
        inline=True,
    )

    # Reasoning
    reasons = pred.get("reasoning", [])
    if reasons:
        embed.add_field(
            name="Analysis",
            value="\n".join(f"• {r}" for r in reasons[:4]),
            inline=False,
        )

    # Active signals
    sigs = pred.get("signals", [])
    if sigs:
        embed.add_field(
            name="Active Indicators",
            value="\n".join(sigs[:4]),
            inline=False,
        )

    embed.set_footer(text=f"Computed at {pred.get('computed_at', '?')[:16]} UTC • Canary by Heuricity")
    return embed


def _status_embed(status: dict) -> discord.Embed:
    """Build a status overview embed."""
    state = status.get("state", "unknown")
    state_text = STATE_ICONS.get(state, state)

    if state == "queue":
        color = 0xE74C3C
    elif state == "challenge":
        color = 0xF39C12
    elif state == "normal":
        color = 0x2ECC71
    else:
        color = 0x95A5A6

    embed = discord.Embed(
        title="📊 PKC Site Status",
        description=f"**{state_text}**",
        color=color,
    )

    if status.get("last_checked"):
        embed.add_field(name="Last Checked", value=f"<t:{_ts(status['last_checked'])}:R>", inline=True)
    if status.get("last_changed"):
        embed.add_field(name="Last Changed", value=f"<t:{_ts(status['last_changed'])}:R>", inline=True)
    if status.get("detail"):
        embed.add_field(name="Detail", value=status["detail"], inline=False)

    embed.set_footer(text="Canary by Heuricity")
    return embed


def _ts(iso_str: str) -> int:
    """Convert ISO datetime string to Unix timestamp for Discord."""
    try:
        dt = datetime.fromisoformat(iso_str)
        return int(dt.timestamp())
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Slash commands
# ---------------------------------------------------------------------------

@app_commands.command(name="status", description="Check current Pokemon Center site status (free)")
async def cmd_status(interaction: discord.Interaction):
    await interaction.response.defer()
    await _ensure_admin_token()

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{SERVER_URL}/api/status", headers=_admin_headers())
            if resp.status_code != 200:
                await interaction.followup.send("❌ Could not fetch status")
                return
            status = resp.json()
        await interaction.followup.send(embed=_status_embed(status))
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}")


@app_commands.command(name="predict", description="Get the next predicted drop window")
async def cmd_predict(interaction: discord.Interaction):
    await interaction.response.defer()
    if not await _check_subscription(interaction):
        await interaction.followup.send("\u274c This command requires an active Canary subscription. Use `/subscribe` to get access.")
        return
    await _ensure_admin_token()

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{SERVER_URL}/api/prediction", headers=_admin_headers())
            if resp.status_code != 200:
                await interaction.followup.send("❌ Could not fetch prediction")
                return
            pred = resp.json()
        await interaction.followup.send(embed=_prediction_embed(pred))
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}")


@app_commands.command(name="drops", description="View recent drop history")
async def cmd_drops(interaction: discord.Interaction):
    await interaction.response.defer()
    if not await _check_subscription(interaction):
        await interaction.followup.send("\u274c This command requires an active Canary subscription. Use `/subscribe` to get access.")
        return
    await _ensure_admin_token()

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{SERVER_URL}/api/drops?limit=10", headers=_admin_headers())
            if resp.status_code != 200:
                await interaction.followup.send("❌ Could not fetch drop history")
                return
            drops = resp.json()

        if not drops:
            embed = discord.Embed(
                title="📅 Drop History",
                description="No drop events recorded yet. The system will track queue events automatically.",
                color=0x3498DB,
            )
            embed.set_footer(text="Canary by Heuricity")
            await interaction.followup.send(embed=embed)
            return

        embed = discord.Embed(title="📅 Recent Drop Events", color=0x3498DB)
        for drop in drops[:10]:
            started = drop.get("started_at", "?")[:16]
            duration = drop.get("duration_secs")
            dur_str = f" ({duration // 60}m)" if duration else " (ongoing)"
            embed.add_field(
                name=f"{drop.get('event_type', 'drop').title()} — {started} UTC",
                value=f"Duration: {dur_str}\n{drop.get('detail', '')}",
                inline=False,
            )
        embed.set_footer(text="Canary by Heuricity")
        await interaction.followup.send(embed=embed)
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}")


@app_commands.command(name="products", description="View recently detected products")
async def cmd_products(interaction: discord.Interaction):
    await interaction.response.defer()
    if not await _check_subscription(interaction):
        await interaction.followup.send("\u274c This command requires an active Canary subscription. Use `/subscribe` to get access.")
        return
    await _ensure_admin_token()

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{SERVER_URL}/api/products?limit=10", headers=_admin_headers())
            if resp.status_code != 200:
                await interaction.followup.send("❌ Could not fetch products")
                return
            products = resp.json()

        if not products:
            embed = discord.Embed(
                title="🛍️ Product Catalog",
                description="No products detected yet. Products are tracked when the site is in normal state.",
                color=0x3498DB,
            )
            embed.set_footer(text="Canary by Heuricity")
            await interaction.followup.send(embed=embed)
            return

        embed = discord.Embed(title="🛍️ Recently Detected Products", color=0x9B59B6)
        for prod in products[:10]:
            price = f"£{prod['price']}" if prod.get("price") else "Price TBD"
            avail = "✅ In Stock" if prod.get("available") else "❌ Out of Stock"
            url = prod.get("url", "")
            name = prod.get("name", "Unknown")
            value = f"{price} — {avail}"
            if url:
                value += f"\n🔗 [View]({url})"
            embed.add_field(name=name, value=value, inline=False)
        embed.set_footer(text="Canary by Heuricity")
        await interaction.followup.send(embed=embed)
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}")


@app_commands.command(name="signals", description="View recent detection signals")
async def cmd_signals(interaction: discord.Interaction):
    await interaction.response.defer()
    if not await _check_subscription(interaction):
        await interaction.followup.send("\u274c This command requires an active Canary subscription. Use `/subscribe` to get access.")
        return
    await _ensure_admin_token()

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{SERVER_URL}/api/signals?limit=5", headers=_admin_headers())
            if resp.status_code != 200:
                await interaction.followup.send("❌ Could not fetch signals")
                return
            signals = resp.json()

        if not signals:
            await interaction.followup.send("No signals yet.")
            return

        embed = discord.Embed(title="📡 Recent Signals", color=0x3498DB)
        for sig in signals:
            ts = sig.get("timestamp", "?")[:16]
            level = sig.get("alert_level", "info").upper()
            embed.add_field(
                name=f"[{level}] {sig.get('title', '?')}",
                value=f"{sig.get('detail', 'No detail')}\n_{ts} UTC_",
                inline=False,
            )
        embed.set_footer(text="Canary by Heuricity")
        await interaction.followup.send(embed=embed)
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}")


@app_commands.command(name="trending", description="See what the Pokemon TCG community is talking about")
async def cmd_trending(interaction: discord.Interaction):
    await interaction.response.defer()
    if not await _check_subscription(interaction):
        await interaction.followup.send("\u274c This command requires an active Canary subscription. Use `/subscribe` to get access.")
        return
    await _ensure_admin_token()

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{SERVER_URL}/api/signals?limit=10&signal_type=social",
                headers=_admin_headers(),
            )
            if resp.status_code != 200:
                await interaction.followup.send("❌ Could not fetch community posts")
                return
            social = resp.json()

        if not social:
            embed = discord.Embed(
                title="💬 Community Buzz",
                description="No community posts detected recently. We monitor Reddit and other sources for Pokemon TCG news.",
                color=0x9B59B6,
            )
            embed.set_footer(text="Canary by Heuricity")
            await interaction.followup.send(embed=embed)
            return

        embed = discord.Embed(
            title="💬 Community Buzz",
            description="Trending Pokemon TCG discussions from Reddit",
            color=0x9B59B6,
        )
        for sig in social[:5]:
            title = sig.get("title", "?").replace("💬 Community: ", "", 1)
            detail = sig.get("detail", "")
            urls_raw = sig.get("detected_urls", "[]")
            if isinstance(urls_raw, str):
                import json
                try:
                    urls = json.loads(urls_raw)
                except Exception:
                    urls = []
            else:
                urls = urls_raw
            link = f"\n[🔗 View on Reddit]({urls[0]})" if urls else ""
            embed.add_field(
                name=title[:80],
                value=f"{detail[:150]}{link}",
                inline=False,
            )
        embed.set_footer(text="Canary by Heuricity")
        await interaction.followup.send(embed=embed)
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}")


@app_commands.command(name="setup", description="[Partner] Configure Canary alerts for this server")
@app_commands.describe(
    channel="The channel where Canary should post alerts",
    role="The subscriber role that Canary will manage",
)
async def cmd_setup(
    interaction: discord.Interaction,
    channel: discord.TextChannel,
    role: discord.Role,
):
    """Partner command: configure alert channel and subscriber role for this guild."""
    await interaction.response.defer(ephemeral=True)
    await _ensure_admin_token()

    if not interaction.guild:
        await interaction.followup.send("❌ This command must be used in a server.", ephemeral=True)
        return

    # Check if user has Manage Server permission (partner/admin check)
    if not interaction.user.guild_permissions.manage_guild:
        await interaction.followup.send("❌ You need **Manage Server** permission to run this.", ephemeral=True)
        return

    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{SERVER_URL}/api/internal/guild-setup",
                headers=_admin_headers(),
                json={
                    "guild_id": str(interaction.guild.id),
                    "guild_name": interaction.guild.name,
                    "alert_channel_id": str(channel.id),
                    "subscriber_role_id": str(role.id),
                    "owner_discord_id": str(interaction.user.id),
                },
            )

        if resp.status_code == 200:
            embed = discord.Embed(
                title="✅ Canary Setup Complete",
                description=f"Alerts → {channel.mention}\nSubscriber role → {role.mention}",
                color=0x2ECC71,
            )
            embed.add_field(
                name="What's next?",
                value=(
                    "1. Share your subscribe link with members\n"
                    "2. Canary will auto-post alerts to the configured channel\n"
                    "3. Subscribers get the role automatically on payment"
                ),
                inline=False,
            )
            embed.set_footer(text="Canary by Heuricity")
            await interaction.followup.send(embed=embed, ephemeral=True)
        elif resp.status_code == 404:
            await interaction.followup.send(
                "❌ You aren't registered as a Canary partner. "
                "Apply at canary.heuricity.com/partners",
                ephemeral=True,
            )
        elif resp.status_code == 403:
            await interaction.followup.send(
                "❌ Your partner application is still pending review.",
                ephemeral=True,
            )
        else:
            await interaction.followup.send(f"❌ Setup failed: {resp.text}", ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"❌ Error: {e}", ephemeral=True)


@app_commands.command(name="subscribe", description="Get a link to subscribe to Canary")
async def cmd_subscribe(interaction: discord.Interaction):
    """Free command: show users how to subscribe."""
    embed = discord.Embed(
        title="🐤 Subscribe to Canary",
        description=(
            "Get early warnings for Pokemon Center drops, predictions, "
            "product tracking, and community buzz."
        ),
        color=0xFFD700,  # Canary yellow
    )
    embed.add_field(
        name="📱 Discord Bot — £10/mo",
        value=(
            "• Real-time drop alerts & queue notifications\n"
            "• Drop predictions with confidence scores\n"
            "• Product catalog tracking\n"
            "• Community trending content\n"
            "• Annual: £100/yr (2 months free)"
        ),
        inline=False,
    )
    embed.add_field(
        name="🖥️ Desktop App — £50/mo",
        value=(
            "• Everything in Discord Bot +\n"
            "• Auto-queue entry with browser panels\n"
            "• Proxy support & Imperva bypass\n"
            "• Multi-profile management\n"
            "• Annual: £500/yr (2 months free)"
        ),
        inline=False,
    )
    embed.add_field(
        name="How to subscribe",
        value="Visit **canary.heuricity.com** to get started.",
        inline=False,
    )
    embed.set_footer(text="Canary by Heuricity")
    await interaction.response.send_message(embed=embed)


# ---------------------------------------------------------------------------
# Role management helpers
# ---------------------------------------------------------------------------

async def grant_subscriber_role(guild_id: str, user_discord_id: str) -> bool:
    """Add the subscriber role to a user in a guild. Called after payment."""
    try:
        guild = bot.get_guild(int(guild_id))
        if not guild:
            log.warning(f"Guild {guild_id} not found for role grant")
            return False

        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{SERVER_URL}/api/internal/alert-channels",
                headers=_admin_headers(),
            )
            if resp.status_code != 200:
                return False
            guild_configs = resp.json()

        config = next((g for g in guild_configs if g.get("guild_id") == guild_id), None)
        if not config or not config.get("subscriber_role_id"):
            return False

        role = guild.get_role(int(config["subscriber_role_id"]))
        if not role:
            return False

        member = guild.get_member(int(user_discord_id))
        if not member:
            try:
                member = await guild.fetch_member(int(user_discord_id))
            except Exception:
                return False

        await member.add_roles(role, reason="Canary subscription activated")
        log.info(f"Granted subscriber role to {user_discord_id} in guild {guild_id}")
        return True
    except Exception as e:
        log.warning(f"Role grant error: {e}")
        return False


async def revoke_subscriber_role(guild_id: str, user_discord_id: str) -> bool:
    """Remove the subscriber role from a user. Called on cancellation/failure."""
    try:
        guild = bot.get_guild(int(guild_id))
        if not guild:
            return False

        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{SERVER_URL}/api/internal/alert-channels",
                headers=_admin_headers(),
            )
            if resp.status_code != 200:
                return False
            guild_configs = resp.json()

        config = next((g for g in guild_configs if g.get("guild_id") == guild_id), None)
        if not config or not config.get("subscriber_role_id"):
            return False

        role = guild.get_role(int(config["subscriber_role_id"]))
        if not role:
            return False

        member = guild.get_member(int(user_discord_id))
        if not member:
            try:
                member = await guild.fetch_member(int(user_discord_id))
            except Exception:
                return False

        await member.remove_roles(role, reason="Canary subscription ended")
        log.info(f"Revoked subscriber role from {user_discord_id} in guild {guild_id}")
        return True
    except Exception as e:
        log.warning(f"Role revoke error: {e}")
        return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

bot = CanaryBot()


def run_bot():
    """Start the Discord bot. Call from main or run standalone."""
    if not BOT_TOKEN:
        log.error("DISCORD_BOT_TOKEN not set — bot will not start")
        return
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    log.info("Starting Canary Discord bot...")
    bot.run(BOT_TOKEN)


if __name__ == "__main__":
    run_bot()
