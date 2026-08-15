#!/usr/bin/env python3
"""Synthetic data generator for run4's dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1].

EMPTY FOR NOW, and correctly so: no migrations have been written yet, so there
is no shape to fill. This still runs, and still creates the file — `npm run
synthetic` calls it for every user folder, and lib/db/userData.ts opens
synthetic.db with fileMustExist in dev, so the file has to be there even when
there is nothing in it.

Once ./migrations/001_initial.sql exists, apply_migrations below builds the
shape from it and you add the inserts. Every value you add must be loudly fake
(CLAUDE.md > Data safety) — a screen full of them must read as obviously
synthetic at a glance, e.g. "COFFEE PALACE TEST". users/devone/seed.py is the
worked example.
"""

import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")


def apply_migrations(db):
    """Build the shape the way a real database gets it: 001..n, in order.

    There is no schema.sql. Migrations own a dashboard's shape (2026-08-15
    migrations design, D6), so a synthetic database is built by the same files
    lib/db/migrate.ts applies to an encrypted one — one description of the
    shape rather than two that can drift.

    Stamps user_version to match, so a synthetic database reports the same
    version a migrated real one does.

    A folder with no migrations yet is not an error: it produces an empty
    database, which is exactly what the friend's real one looks like too.
    """
    if not os.path.isdir(MIGRATIONS):
        return
    names = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    for name in names:
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as handle:
            db.executescript(handle.read())
    if names:
        db.execute(f"PRAGMA user_version = {int(names[-1][:3])}")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        # INSERTS GO HERE, once there is a shape to insert into.
        db.commit()
    finally:
        db.close()

    print(f"run4: no shape yet, empty database -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
