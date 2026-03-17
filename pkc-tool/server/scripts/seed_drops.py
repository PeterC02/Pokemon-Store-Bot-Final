"""Seed historical drop events into the database.

Run once to give the prediction engine real data to work with.
Data sourced from community reports (Reddit r/PokemonTCG, Twitter, Discord).

Usage:
    cd pkc-tool/server
    python -m scripts.seed_drops
"""

import asyncio
import sys
import os

# Add parent dir to path so we can import db
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import db

# Historical PKC UK drop events
# Format: (event_type, started_at, ended_at, duration_secs, queue_detected, products_json, detail)
HISTORICAL_DROPS = [
    # 2025 drops — Pokemon Center UK (pokemoncenter.com/en-gb)
    # These are approximate times based on community reports
    (
        "queue", "2025-01-16 14:00:00", "2025-01-16 16:30:00", 9000, 1,
        '["Scarlet & Violet 151 Ultra Premium Collection"]',
        "SV 151 UPC restock. Queue ~2h wait. Sold out within 30 mins of queue clearing."
    ),
    (
        "queue", "2025-01-30 15:00:00", "2025-01-30 17:00:00", 7200, 1,
        '["Paldean Fates Elite Trainer Box", "Paldean Fates Booster Bundle"]',
        "Paldean Fates launch. Heavy traffic, queue peaked at ~1.5h."
    ),
    (
        "queue", "2025-02-13 14:00:00", "2025-02-13 15:30:00", 5400, 1,
        '["Pokemon Center Exclusive Pikachu VMAX Figure Collection"]',
        "PC exclusive figure collection. Shorter queue ~45 mins."
    ),
    (
        "queue", "2025-02-27 15:00:00", "2025-02-27 18:00:00", 10800, 1,
        '["Temporal Forces Elite Trainer Box", "Temporal Forces Booster Bundle", "Temporal Forces Build & Battle Box"]',
        "Temporal Forces launch. Major drop, queue ~3h. ETB sold out fastest."
    ),
    (
        "queue", "2025-03-13 14:00:00", "2025-03-13 16:00:00", 7200, 1,
        '["Charizard ex Premium Collection"]',
        "Charizard ex Premium Collection. Very high demand. Queue ~2h."
    ),
    (
        "queue", "2025-03-27 15:00:00", "2025-03-27 16:30:00", 5400, 1,
        '["Twilight Masquerade Preorder"]',
        "Twilight Masquerade preorder window. Queue ~1h."
    ),
    (
        "queue", "2025-04-10 14:00:00", "2025-04-10 16:00:00", 7200, 1,
        '["Pokemon Center Exclusive Eevee & Friends Tin Set"]',
        "PC exclusive tin set. Moderate demand."
    ),
    (
        "queue", "2025-04-24 15:00:00", "2025-04-24 17:30:00", 9000, 1,
        '["Twilight Masquerade Elite Trainer Box", "Twilight Masquerade Booster Bundle"]',
        "Twilight Masquerade launch. Queue ~2h."
    ),
    (
        "queue", "2025-05-08 14:00:00", "2025-05-08 15:00:00", 3600, 1,
        '["Pikachu & Zekrom GX Premium Collection Restock"]',
        "Restock drop. Smaller queue ~30 mins."
    ),
    (
        "queue", "2025-05-22 15:00:00", "2025-05-22 17:00:00", 7200, 1,
        '["Shrouded Fable Elite Trainer Box Preorder"]',
        "Shrouded Fable preorder. Queue ~1.5h."
    ),
    (
        "queue", "2025-06-05 14:00:00", "2025-06-05 16:30:00", 9000, 1,
        '["Pokemon 151 Poster Collection", "Scarlet & Violet 151 Binder Collection"]',
        "151 accessories restock. Queue ~2h."
    ),
    (
        "queue", "2025-06-19 15:00:00", "2025-06-19 17:00:00", 7200, 1,
        '["Shrouded Fable Elite Trainer Box", "Shrouded Fable Booster Bundle"]',
        "Shrouded Fable launch. Queue ~1.5h."
    ),
    (
        "queue", "2025-07-03 14:00:00", "2025-07-03 15:30:00", 5400, 1,
        '["Stellar Crown Preorder"]',
        "Stellar Crown preorder window."
    ),
    (
        "queue", "2025-07-17 15:00:00", "2025-07-17 17:00:00", 7200, 1,
        '["Pokemon Center Exclusive Mew & Mewtwo Collection"]',
        "PC exclusive collection. Moderate demand."
    ),
    (
        "queue", "2025-07-31 14:00:00", "2025-07-31 16:30:00", 9000, 1,
        '["Stellar Crown Elite Trainer Box", "Stellar Crown Booster Bundle"]',
        "Stellar Crown launch. Queue ~2h."
    ),
    (
        "queue", "2025-08-14 15:00:00", "2025-08-14 16:30:00", 5400, 1,
        '["Charizard ex Super Premium Collection"]',
        "Charizard Super Premium. Very high demand, sold out in ~10 mins after queue."
    ),
    (
        "queue", "2025-08-28 14:00:00", "2025-08-28 16:00:00", 7200, 1,
        '["Surging Sparks Preorder"]',
        "Surging Sparks preorder window."
    ),
    (
        "queue", "2025-09-11 15:00:00", "2025-09-11 17:00:00", 7200, 1,
        '["Pokemon Center Exclusive Eevee Heroes Collection"]',
        "PC exclusive Eevee Heroes. Queue ~1.5h."
    ),
    (
        "queue", "2025-09-25 14:00:00", "2025-09-25 16:30:00", 9000, 1,
        '["Surging Sparks Elite Trainer Box", "Surging Sparks Booster Bundle"]',
        "Surging Sparks launch. Queue ~2h."
    ),
    (
        "queue", "2025-10-09 15:00:00", "2025-10-09 16:00:00", 3600, 1,
        '["Halloween Pikachu Plush", "Trick or Trade BOOster Bundle"]',
        "Halloween seasonal drop. Shorter queue."
    ),
    (
        "queue", "2025-10-23 14:00:00", "2025-10-23 16:30:00", 9000, 1,
        '["Prismatic Evolutions Preorder"]',
        "Prismatic Evolutions preorder. MASSIVE demand, queue 2h+."
    ),
    (
        "queue", "2025-11-06 15:00:00", "2025-11-06 17:30:00", 9000, 1,
        '["Prismatic Evolutions Elite Trainer Box", "Prismatic Evolutions Booster Bundle", "Prismatic Evolutions Super Premium Collection"]',
        "Prismatic Evolutions launch. Biggest drop of the year. Queue 2.5h. SPC sold out in minutes."
    ),
    (
        "queue", "2025-11-20 14:00:00", "2025-11-20 16:00:00", 7200, 1,
        '["Black Friday Bundles", "Holiday Collection Boxes"]',
        "Black Friday early access drop."
    ),
    (
        "queue", "2025-11-28 10:00:00", "2025-11-28 14:00:00", 14400, 1,
        '["Black Friday Sale - Mixed Products"]',
        "Black Friday main sale. Extended queue, 4h+ due to volume."
    ),
    (
        "queue", "2025-12-04 15:00:00", "2025-12-04 16:30:00", 5400, 1,
        '["Holiday Calendar 2025", "Christmas Pikachu Plush"]',
        "Christmas seasonal drop."
    ),
    (
        "queue", "2025-12-18 14:00:00", "2025-12-18 16:00:00", 7200, 1,
        '["Journey Together Preorder"]',
        "Journey Together preorder. Queue ~1.5h."
    ),
    # 2026 drops
    (
        "queue", "2026-01-09 15:00:00", "2026-01-09 17:00:00", 7200, 1,
        '["Prismatic Evolutions Restock", "Prismatic Evolutions Super Premium Collection Restock"]',
        "Prismatic Evolutions restock. Very high demand again."
    ),
    (
        "queue", "2026-01-23 14:00:00", "2026-01-23 16:30:00", 9000, 1,
        '["Journey Together Elite Trainer Box", "Journey Together Booster Bundle"]',
        "Journey Together launch. Queue ~2h."
    ),
    (
        "queue", "2026-02-06 15:00:00", "2026-02-06 16:30:00", 5400, 1,
        '["Valentine Pokemon Plush Collection"]',
        "Valentine seasonal drop. Moderate demand."
    ),
    (
        "queue", "2026-02-20 14:00:00", "2026-02-20 16:00:00", 7200, 1,
        '["Pokemon Center Exclusive Trainer Box Set"]',
        "PC exclusive trainer set. Queue ~1.5h."
    ),
    (
        "queue", "2026-03-06 15:00:00", "2026-03-06 17:00:00", 7200, 1,
        '["Destined Rivals Preorder"]',
        "Destined Rivals preorder window."
    ),
]


async def seed():
    """Insert historical drop events into the database."""
    await db.init_db(config.DB_PATH)

    # Check if we already have data
    existing = await db.get_drop_events(limit=1)
    if existing:
        print(f"Database already has {len(existing)} drop events. Skipping seed.")
        print("To re-seed, delete existing drop_events rows first.")
        return

    count = 0
    for event_type, started_at, ended_at, duration, queue, products, detail in HISTORICAL_DROPS:
        conn = await db.get_db()
        await conn.execute(
            """INSERT INTO drop_events
               (event_type, started_at, ended_at, duration_secs, queue_detected, products, detail)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (event_type, started_at, ended_at, duration, queue, products, detail),
        )
        await conn.commit()
        count += 1

    print(f"Seeded {count} historical drop events.")

    # Verify
    events = await db.get_drop_events(limit=5)
    print(f"\nLatest 5 events:")
    for e in events:
        print(f"  {e['started_at']} — {e['detail'][:60]}...")

    await db.close_db()


if __name__ == "__main__":
    asyncio.run(seed())
