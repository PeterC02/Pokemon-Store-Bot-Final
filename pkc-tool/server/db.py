"""SQLite database — signals, users, invite codes, drop history."""

from __future__ import annotations

import json

import aiosqlite
import bcrypt
from pathlib import Path
from datetime import datetime
from typing import Optional

from models import UserRole

_db: Optional[aiosqlite.Connection] = None


async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is None:
        raise RuntimeError("Database not initialised — call init_db() first")
    return _db


async def init_db(db_path: str) -> None:
    global _db
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    _db = await aiosqlite.connect(db_path)
    _db.row_factory = aiosqlite.Row
    await _db.executescript(_SCHEMA)
    await _db.commit()


async def close_db() -> None:
    global _db
    if _db:
        await _db.close()
        _db = None


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    UNIQUE NOT NULL,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'user',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invite_codes (
    code        TEXT    PRIMARY KEY,
    created_by  INTEGER NOT NULL,
    used_by     INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by)    REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type     TEXT    NOT NULL,
    alert_level     TEXT    NOT NULL,
    site_state      TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    detail          TEXT    NOT NULL DEFAULT '',
    detected_urls   TEXT    NOT NULL DEFAULT '[]',
    timestamp       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_status (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    state           TEXT    NOT NULL DEFAULT 'unknown',
    last_checked    TEXT,
    last_changed    TEXT,
    current_build_id TEXT,
    detail          TEXT    NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO site_status (id) VALUES (1);

CREATE TABLE IF NOT EXISTS products (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    url             TEXT    NOT NULL DEFAULT '',
    price           REAL,
    sale_price      REAL,
    image           TEXT    NOT NULL DEFAULT '',
    available       INTEGER DEFAULT 1,
    release_date    TEXT,
    categories      TEXT    NOT NULL DEFAULT '[]',
    first_seen      TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drop_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT    NOT NULL,
    started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    duration_secs   INTEGER,
    queue_detected  INTEGER DEFAULT 0,
    products        TEXT    NOT NULL DEFAULT '[]',
    detail          TEXT    NOT NULL DEFAULT ''
);

-- Partners (application-based, manual review)
CREATE TABLE IF NOT EXISTS partners (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    name                    TEXT    NOT NULL,
    owner_discord_id        TEXT    NOT NULL,
    owner_email             TEXT    NOT NULL DEFAULT '',
    invite_code             TEXT    UNIQUE NOT NULL,
    revenue_share           REAL    NOT NULL DEFAULT 0.50,
    stripe_connect_id       TEXT,
    status                  TEXT    NOT NULL DEFAULT 'pending',  -- pending, approved, suspended
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Guild configs per partner (one bot instance, many guilds)
CREATE TABLE IF NOT EXISTS partner_guilds (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id          INTEGER NOT NULL,
    guild_id            TEXT    NOT NULL UNIQUE,
    guild_name          TEXT    NOT NULL DEFAULT '',
    alert_channel_id    TEXT,
    subscriber_role_id  TEXT,
    setup_complete      INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (partner_id) REFERENCES partners(id)
);

-- User subscriptions (linked via Discord ID)
CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_discord_id         TEXT    NOT NULL,
    partner_id              INTEGER NOT NULL,
    guild_id                TEXT    NOT NULL,
    tier                    TEXT    NOT NULL DEFAULT 'bot',  -- bot, desktop
    billing_period          TEXT    NOT NULL DEFAULT 'monthly',  -- monthly, annual
    stripe_subscription_id  TEXT,
    stripe_customer_id      TEXT,
    status                  TEXT    NOT NULL DEFAULT 'active',  -- active, cancelled, past_due, expired
    started_at              TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at              TEXT,
    FOREIGN KEY (partner_id) REFERENCES partners(id)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_drop_events_started ON drop_events(started_at);
CREATE INDEX IF NOT EXISTS idx_products_last_seen ON products(last_seen);
CREATE INDEX IF NOT EXISTS idx_subscriptions_discord ON subscriptions(user_discord_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_guild ON subscriptions(guild_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_partner_guilds_guild ON partner_guilds(guild_id);
"""


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

async def create_user(username: str, password: str, role: str = "user") -> dict:
    db = await get_db()
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    cursor = await db.execute(
        "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
        (username, hashed, role),
    )
    await db.commit()
    return await get_user_by_id(cursor.lastrowid)


async def get_user_by_id(user_id: int) -> Optional[dict]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_user_by_username(username: str) -> Optional[dict]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM users WHERE username = ?", (username,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def verify_password(username: str, password: str) -> Optional[dict]:
    user = await get_user_by_username(username)
    if not user:
        return None
    if bcrypt.checkpw(password.encode(), user["password"].encode()):
        return user
    return None


# ---------------------------------------------------------------------------
# Invite codes
# ---------------------------------------------------------------------------

async def create_invite_code(code: str, created_by: int) -> None:
    db = await get_db()
    await db.execute(
        "INSERT INTO invite_codes (code, created_by) VALUES (?, ?)",
        (code, created_by),
    )
    await db.commit()


async def use_invite_code(code: str, user_id: int) -> bool:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM invite_codes WHERE code = ? AND used_by IS NULL", (code,)
    )
    row = await cursor.fetchone()
    if not row:
        return False
    await db.execute(
        "UPDATE invite_codes SET used_by = ? WHERE code = ?", (user_id, code)
    )
    await db.commit()
    return True


async def list_invite_codes(created_by: Optional[int] = None) -> list[dict]:
    db = await get_db()
    if created_by is not None:
        cursor = await db.execute(
            "SELECT * FROM invite_codes WHERE created_by = ? ORDER BY created_at DESC",
            (created_by,),
        )
    else:
        cursor = await db.execute("SELECT * FROM invite_codes ORDER BY created_at DESC")
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

async def insert_signal(
    signal_type: str,
    alert_level: str,
    site_state: str,
    title: str,
    detail: str = "",
    detected_urls: str = "[]",
) -> int:
    db = await get_db()
    cursor = await db.execute(
        """INSERT INTO signals (signal_type, alert_level, site_state, title, detail, detected_urls)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (signal_type, alert_level, site_state, title, detail, detected_urls),
    )
    await db.commit()
    return cursor.lastrowid


async def get_signals(
    limit: int = 100,
    offset: int = 0,
    signal_type: str | None = None,
) -> list[dict]:
    db = await get_db()
    if signal_type:
        cursor = await db.execute(
            "SELECT * FROM signals WHERE signal_type = ? ORDER BY id DESC LIMIT ? OFFSET ?",
            (signal_type, limit, offset),
        )
    else:
        cursor = await db.execute(
            "SELECT * FROM signals ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Site status (singleton row)
# ---------------------------------------------------------------------------

async def get_site_status() -> dict:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM site_status WHERE id = 1")
    row = await cursor.fetchone()
    return dict(row) if row else {}


async def update_site_status(**kwargs) -> None:
    db = await get_db()
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values())
    await db.execute(f"UPDATE site_status SET {sets} WHERE id = 1", vals)
    await db.commit()


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------

async def upsert_product(product: dict) -> bool:
    """Insert or update a product. Returns True if it was newly inserted."""
    db = await get_db()
    cursor = await db.execute("SELECT id FROM products WHERE id = ?", (product["id"],))
    existing = await cursor.fetchone()
    if existing:
        await db.execute(
            """UPDATE products SET name=?, url=?, price=?, sale_price=?, image=?,
               available=?, release_date=?, categories=?, last_seen=datetime('now')
               WHERE id=?""",
            (product["name"], product.get("url", ""), product.get("price"),
             product.get("sale_price"), product.get("image", ""),
             1 if product.get("available") else 0, product.get("release_date"),
             json.dumps(product.get("categories", [])), product["id"]),
        )
        await db.commit()
        return False
    else:
        await db.execute(
            """INSERT INTO products (id, name, url, price, sale_price, image,
               available, release_date, categories)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (product["id"], product["name"], product.get("url", ""),
             product.get("price"), product.get("sale_price"),
             product.get("image", ""),
             1 if product.get("available") else 0,
             product.get("release_date"),
             json.dumps(product.get("categories", []))),
        )
        await db.commit()
        return True


async def get_products(limit: int = 50, offset: int = 0) -> list[dict]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM products ORDER BY first_seen DESC LIMIT ? OFFSET ?",
        (limit, offset),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_product_by_id(product_id: str) -> Optional[dict]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Drop events
# ---------------------------------------------------------------------------

async def start_drop_event(event_type: str, detail: str = "") -> int:
    db = await get_db()
    cursor = await db.execute(
        "INSERT INTO drop_events (event_type, detail) VALUES (?, ?)",
        (event_type, detail),
    )
    await db.commit()
    return cursor.lastrowid


async def end_drop_event(event_id: int, products: list[str] = None) -> None:
    db = await get_db()
    await db.execute(
        """UPDATE drop_events SET ended_at=datetime('now'),
           duration_secs=CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER),
           products=?
           WHERE id=?""",
        (json.dumps(products or []), event_id),
    )
    await db.commit()


async def get_drop_events(limit: int = 50, offset: int = 0) -> list[dict]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM drop_events ORDER BY id DESC LIMIT ? OFFSET ?",
        (limit, offset),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Data Retention
# ---------------------------------------------------------------------------

async def cleanup_old_data(
    signal_days: int = 30,
    social_days: int = 7,
) -> dict:
    """Delete old signals to prevent unbounded DB growth.

    - Signals: keep last `signal_days` days (default 30)
    - Social signals: keep last `social_days` days (default 7)
    - Products and drop_events: kept indefinitely

    Returns dict with counts of deleted rows.
    """
    db = await get_db()
    deleted = {}

    # Delete old social signals (shorter retention)
    cursor = await db.execute(
        """DELETE FROM signals
           WHERE signal_type = 'social'
           AND timestamp < datetime('now', ?)""",
        (f"-{social_days} days",),
    )
    await db.commit()
    deleted["social_signals"] = cursor.rowcount

    # Delete old non-social signals
    cursor = await db.execute(
        """DELETE FROM signals
           WHERE signal_type != 'social'
           AND timestamp < datetime('now', ?)""",
        (f"-{signal_days} days",),
    )
    await db.commit()
    deleted["old_signals"] = cursor.rowcount

    return deleted


# ---------------------------------------------------------------------------
# Partners
# ---------------------------------------------------------------------------

async def create_partner(
    name: str,
    owner_discord_id: str,
    owner_email: str,
    invite_code: str,
    revenue_share: float = 0.50,
) -> dict:
    conn = await get_db()
    cursor = await conn.execute(
        """INSERT INTO partners (name, owner_discord_id, owner_email, invite_code, revenue_share)
           VALUES (?, ?, ?, ?, ?)""",
        (name, owner_discord_id, owner_email, invite_code, revenue_share),
    )
    await conn.commit()
    return await get_partner_by_id(cursor.lastrowid)


async def get_partner_by_id(partner_id: int) -> dict | None:
    conn = await get_db()
    cursor = await conn.execute("SELECT * FROM partners WHERE id = ?", (partner_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_partner_by_invite(invite_code: str) -> dict | None:
    conn = await get_db()
    cursor = await conn.execute("SELECT * FROM partners WHERE invite_code = ?", (invite_code,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_partner_by_discord(owner_discord_id: str) -> dict | None:
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM partners WHERE owner_discord_id = ?", (owner_discord_id,)
    )
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_partners(status: str | None = None, limit: int = 100) -> list[dict]:
    conn = await get_db()
    if status:
        cursor = await conn.execute(
            "SELECT * FROM partners WHERE status = ? ORDER BY id DESC LIMIT ?",
            (status, limit),
        )
    else:
        cursor = await conn.execute(
            "SELECT * FROM partners ORDER BY id DESC LIMIT ?", (limit,)
        )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def update_partner_status(partner_id: int, status: str) -> None:
    conn = await get_db()
    await conn.execute(
        "UPDATE partners SET status = ? WHERE id = ?", (status, partner_id)
    )
    await conn.commit()


async def update_partner_stripe(partner_id: int, stripe_connect_id: str) -> None:
    conn = await get_db()
    await conn.execute(
        "UPDATE partners SET stripe_connect_id = ? WHERE id = ?",
        (stripe_connect_id, partner_id),
    )
    await conn.commit()


# ---------------------------------------------------------------------------
# Partner Guilds
# ---------------------------------------------------------------------------

async def upsert_partner_guild(
    partner_id: int,
    guild_id: str,
    guild_name: str = "",
    alert_channel_id: str | None = None,
    subscriber_role_id: str | None = None,
) -> dict:
    conn = await get_db()
    await conn.execute(
        """INSERT INTO partner_guilds (partner_id, guild_id, guild_name, alert_channel_id, subscriber_role_id, setup_complete)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET
             guild_name = excluded.guild_name,
             alert_channel_id = COALESCE(excluded.alert_channel_id, partner_guilds.alert_channel_id),
             subscriber_role_id = COALESCE(excluded.subscriber_role_id, partner_guilds.subscriber_role_id),
             setup_complete = CASE
               WHEN excluded.alert_channel_id IS NOT NULL AND excluded.subscriber_role_id IS NOT NULL THEN 1
               ELSE partner_guilds.setup_complete
             END""",
        (partner_id, guild_id, guild_name, alert_channel_id, subscriber_role_id,
         1 if alert_channel_id and subscriber_role_id else 0),
    )
    await conn.commit()
    return await get_guild_config(guild_id)


async def get_guild_config(guild_id: str) -> dict | None:
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM partner_guilds WHERE guild_id = ?", (guild_id,)
    )
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_guilds_for_partner(partner_id: int) -> list[dict]:
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM partner_guilds WHERE partner_id = ?", (partner_id,)
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_all_alert_channels() -> list[dict]:
    """Get all guilds with setup_complete=1 for broadcasting alerts."""
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM partner_guilds WHERE setup_complete = 1"
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Subscriptions
# ---------------------------------------------------------------------------

async def create_subscription(
    user_discord_id: str,
    partner_id: int,
    guild_id: str,
    tier: str = "bot",
    billing_period: str = "monthly",
    stripe_subscription_id: str | None = None,
    stripe_customer_id: str | None = None,
) -> dict:
    conn = await get_db()
    cursor = await conn.execute(
        """INSERT INTO subscriptions
           (user_discord_id, partner_id, guild_id, tier, billing_period,
            stripe_subscription_id, stripe_customer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (user_discord_id, partner_id, guild_id, tier, billing_period,
         stripe_subscription_id, stripe_customer_id),
    )
    await conn.commit()
    return await get_subscription_by_id(cursor.lastrowid)


async def get_subscription_by_id(sub_id: int) -> dict | None:
    conn = await get_db()
    cursor = await conn.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_subscription_by_stripe(stripe_sub_id: str) -> dict | None:
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?",
        (stripe_sub_id,),
    )
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_active_subscription(user_discord_id: str, guild_id: str) -> dict | None:
    """Check if a user has an active subscription in a specific guild."""
    conn = await get_db()
    cursor = await conn.execute(
        """SELECT * FROM subscriptions
           WHERE user_discord_id = ? AND guild_id = ? AND status = 'active'
           ORDER BY id DESC LIMIT 1""",
        (user_discord_id, guild_id),
    )
    row = await cursor.fetchone()
    return dict(row) if row else None


async def get_subscriptions_for_guild(guild_id: str, status: str = "active") -> list[dict]:
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM subscriptions WHERE guild_id = ? AND status = ? ORDER BY id DESC",
        (guild_id, status),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_subscriptions_for_partner(partner_id: int) -> list[dict]:
    conn = await get_db()
    cursor = await conn.execute(
        "SELECT * FROM subscriptions WHERE partner_id = ? ORDER BY id DESC",
        (partner_id,),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def update_subscription_status(sub_id: int, status: str) -> None:
    conn = await get_db()
    await conn.execute(
        "UPDATE subscriptions SET status = ? WHERE id = ?", (status, sub_id)
    )
    await conn.commit()


async def update_subscription_stripe(
    sub_id: int,
    stripe_subscription_id: str,
    stripe_customer_id: str | None = None,
) -> None:
    conn = await get_db()
    if stripe_customer_id:
        await conn.execute(
            "UPDATE subscriptions SET stripe_subscription_id = ?, stripe_customer_id = ? WHERE id = ?",
            (stripe_subscription_id, stripe_customer_id, sub_id),
        )
    else:
        await conn.execute(
            "UPDATE subscriptions SET stripe_subscription_id = ? WHERE id = ?",
            (stripe_subscription_id, sub_id),
        )
    await conn.commit()


async def count_active_subs_for_partner(partner_id: int) -> dict:
    """Get subscription counts for a partner's dashboard."""
    conn = await get_db()
    cursor = await conn.execute(
        """SELECT tier, COUNT(*) as count FROM subscriptions
           WHERE partner_id = ? AND status = 'active'
           GROUP BY tier""",
        (partner_id,),
    )
    rows = await cursor.fetchall()
    result = {"bot": 0, "desktop": 0, "total": 0}
    for r in rows:
        result[r["tier"]] = r["count"]
        result["total"] += r["count"]
    return result
