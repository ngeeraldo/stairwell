#!/usr/bin/env python3
"""Synthetic data generator for run3's dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1]. Executes schema.sql before inserting anything.

Every value here is loudly fake (CLAUDE.md > Data safety) — a screen full of
these must read as obviously synthetic at a glance.
"""

import os
import random
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")


def apply_migrations(db):
    """Build the shape the way a real database gets it: 001..n, in order.

    There is no schema.sql any more. Migrations own a dashboard shape
    (2026-08-15 migrations design, D6), so a synthetic database is built by
    the same files lib/db/migrate.ts applies to an encrypted one - one
    description of the shape rather than two that can drift.

    Stamps user_version to match, so a synthetic database reports the same
    version a migrated real one does and the runner treats dev as an ordinary
    no-op rather than a special case.
    """
    names = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    for name in names:
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as handle:
            db.executescript(handle.read())
    if names:
        db.execute(f"PRAGMA user_version = {int(names[-1][:3])}")

MERCHANTS = [
    ("COFFEE PALACE TEST", "eating out", 350, 900),
    ("GROCERY WORLD TEST", "groceries", 1500, 9000),
]

DAYS = 90
DAY_MS = 86_400_000


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    rng = random.Random(1)
    now = int(time.time() * 1000)

    rows = [
        (
            merchant,
            category,
            rng.randint(low, high),
            now - back * DAY_MS + rng.randrange(DAY_MS),
        )
        for back in range(DAYS)
        for merchant, category, low, high in MERCHANTS
        if rng.random() >= 0.35
    ]

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        db.execute("DELETE FROM transactions")
        db.executemany(
            "INSERT INTO transactions (merchant, category, amount_cents, at)"
            " VALUES (?, ?, ?, ?)",
            rows,
        )
        db.commit()
    finally:
        db.close()

    print(f"run3: {len(rows)} synthetic transactions -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
