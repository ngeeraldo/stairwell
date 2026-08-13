#!/usr/bin/env python3
"""Synthetic walk history for devtwo's dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1] and executes schema.sql before inserting, so the table
shape has exactly one source.

This fills synthetic.db, which is what the dashboard shows BEFORE the first
real tap — under the SYNTHETIC DATA banner. It never touches devtwo.db, which
is encrypted and holds the real taps.

Days are relative to the wall clock so "last 14 days" is never empty, and the
gaps are fixed rather than random so the sample screen looks the same on two
runs of the same day.
"""

import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")

# Days back from today that were NOT walked. Everything else in the window was.
# Fixed, not random: a sample screen that reshuffles between runs is harder to
# talk about than one that does not.
MISSED = {2, 6, 7, 13, 19, 24}
WINDOW = 30
DAY_SECONDS = 86_400


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    with open(SCHEMA, encoding="utf-8") as handle:
        schema = handle.read()

    now = time.time()
    rows = []
    for back in range(WINDOW):
        if back in MISSED:
            continue
        stamp = time.localtime(now - back * DAY_SECONDS)
        # TEST in the note column keeps the loud-fake sweep honest; the day
        # itself cannot carry a marker without ceasing to be a day.
        rows.append((time.strftime("%Y-%m-%d", stamp), int((now - back * DAY_SECONDS) * 1000)))

    db = sqlite3.connect(target)
    try:
        db.executescript(schema)
        db.execute("DELETE FROM walks")
        db.executemany("INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)", rows)
        db.execute(
            "INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)",
            ("1970-01-01 SAMPLE TEST", 0),
        )
        db.commit()
    finally:
        db.close()

    print(f"devtwo: {len(rows)} synthetic walks -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
