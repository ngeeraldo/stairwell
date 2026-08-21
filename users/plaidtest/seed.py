#!/usr/bin/env python3
"""Synthetic Plaid data for the plaidtest scratch dashboard.

    python3 seed.py <target.db>

Runs the migrations in order and stamps user_version, so a synthetic database
is built by the same files lib/db/migrate.ts applies to an encrypted one.

THIS FOLDER INVENTS NO DATA OF ITS OWN. Every row comes from
modules/plaid/seed_plaid.py, which replays a recorded, scrubbed Plaid Sandbox
response into the shared envelope. That is the point of the module: a finance
dashboard is built against Plaid's real field shape rather than against a
second author's guess at it, so a panel that works here works for a friend.

Note what is NOT seeded: plaid_items. A synthetic database holds no access
token - not even a fake one - so this dashboard renders the NOT-CONNECTED
state, which is also the state a real friend sees before they connect. Pressing
Connect in dev writes a real Sandbox token here; `npm run synthetic` clears it.
"""

import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")
sys.path.insert(0, os.path.join(HERE, "..", "..", "modules", "plaid"))

from seed_plaid import seed_plaid  # noqa: E402


def apply_migrations(db):
    """Build the shape the way a real database gets it: 001..n, in order."""
    names = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    for name in names:
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as handle:
            db.executescript(handle.read())
    if names:
        db.execute(f"PRAGMA user_version = {int(names[-1][:3])}")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python3 seed.py <target.db>", file=sys.stderr)
        return 1

    db = sqlite3.connect(sys.argv[1])
    try:
        apply_migrations(db)
        counts = seed_plaid(db)
        db.commit()
        for table, n in counts.items():
            print(f"  {table}: {n}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
