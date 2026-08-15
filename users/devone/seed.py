#!/usr/bin/env python3
"""Synthetic data generator for devone's dashboard.

    python3 seed.py <target.db>

Writes ONLY to the target given as argv[1] (the contract
tests/support/synthetic.ts:regenerateUser assumes, and
tests/support/noCross.test.ts pins in both directions).

Executes ../devone/schema.sql before inserting anything, so table shapes have
exactly one source and this file cannot declare one of its own.

Amounts and which days get a row come from a fixed seed, so two runs on the
same day produce identical numbers. TIMESTAMPS are deliberately relative to
the wall clock: a panel reading "this month" must have data in it whenever the
generator last ran, and a fixed epoch would leave every panel empty within
weeks. Nothing asserts against this output — users/devone/tests/* build their
own fixtures at exact timestamps.
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

# Loudly fake, every one of them (CLAUDE.md > Data safety): merchant, category,
# min cents, max cents.
MERCHANTS = [
    ("COFFEE PALACE TEST", "eating out", 350, 900),
    ("BURRITO BARN TEST", "eating out", 900, 2200),
    ("GROCERY WORLD TEST", "groceries", 1500, 9000),
    ("RENT PAYMENT TEST", "housing", 120000, 120000),
]

DAYS = 90
DAY_MS = 86_400_000


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    rng = random.Random(20260812)
    now = int(time.time() * 1000)

    rows = []
    for back in range(DAYS):
        for merchant, category, low, high in MERCHANTS:
            if category == "housing" and back % 30 != 0:
                continue
            if category != "housing" and rng.random() < 0.35:
                continue
            rows.append(
                (
                    merchant,
                    category,
                    rng.randint(low, high),
                    now - back * DAY_MS + rng.randrange(DAY_MS),
                )
            )

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        # Idempotent: regenerating replaces the data rather than doubling it.
        db.execute("DELETE FROM transactions")
        db.executemany(
            "INSERT INTO transactions (merchant, category, amount_cents, at)"
            " VALUES (?, ?, ?, ?)",
            rows,
        )
        db.commit()
    finally:
        db.close()

    print(f"devone: {len(rows)} synthetic transactions -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
