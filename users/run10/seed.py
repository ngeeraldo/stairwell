#!/usr/bin/env python3
"""Synthetic pee-log history for run10's dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1], and runs ./migrations/ before inserting anything, so
the table shape has exactly one source.

This fills synthetic.db, which is what the dashboard shows in dev under the
SYNTHETIC DATA banner. It never touches run10.db, which is encrypted and holds
the real taps.

NO LOUD-FAKE MARKER, and that is the rule being met rather than dodged. Every
value this generates is a day key or a number — `pee_logs` has no free-text
column at all — and a count cannot contain the word TEST and still be a count.
tests/users/conventions.test.ts asks for the marker only where a seed produces
free text, because free text is the only place a real person's data could hide
in a committed generator (CLAUDE.md > Data safety). Do NOT invent a junk row to
satisfy it; the loudness is carried by the banner.

Days are relative to the wall clock so "the last 7 days" is never empty, and
the counts are a fixed list rather than random so the sample screen looks the
same on two runs of the same day.

The EMPTY state — what run10's own database holds on the morning this ships —
is built from the migrations alone by `npm run synthetic -- --empty`, so
nothing here needs a mode for it and nothing here should grow one.
"""

import os
import sqlite3
import sys
from datetime import date, datetime, timedelta

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
    """
    if not os.path.isdir(MIGRATIONS):
        return
    names = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    for name in names:
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as handle:
            db.executescript(handle.read())
    if names:
        db.execute(f"PRAGMA user_version = {int(names[-1][:3])}")


# Logs per day, index = days back from today. Fixed, not random: a sample
# screen that reshuffles between runs is harder to talk about than one that
# does not.
#
# Three entries are deliberate, and the panels are built against them rather
# than around them:
#
#   index 0 (today) is 3 — a PARTIAL day, deliberately below the week's
#   average. Today is the count run10 is still adding to, and the average is
#   computed across the seven charted days INCLUDING today, so a sample where
#   today already sat at the average would hide whether the two read honestly
#   against each other mid-morning.
#
#   index 2 is 0 — a day with NO ROWS AT ALL, inside the 7-day window. The
#   chart has to draw that day as a gap in the series rather than omit it and
#   shift the other six along. Nothing else in the sample forces that case,
#   and it is the one a friend produces the first time they forget to log.
#
#   index 5 is 11 — the tallest bar, so the y-axis is not flat and the
#   average line sits visibly below at least one day and above others.
#
# Fourteen days for a seven-day window, on purpose: a query whose window
# happens to equal the whole table cannot be caught reading past its edge.
COUNTS = [3, 7, 0, 6, 8, 11, 6, 5, 7, 9, 4, 8, 6, 7]

# The hour each of a day's logs lands on, in order — the first `count` of them
# are used, so the largest day above needs at most this many. Spread across
# waking hours because the timestamps are real data even though v1 displays
# none of them; a column of identical stamps would be a worse answer to a
# question somebody asks in v2 than no column at all.
LOG_HOURS = [7, 8, 9, 11, 12, 14, 15, 17, 18, 20, 22]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    # Oldest first, so ids ascend with time the way they do on a real run of
    # taps. Nothing in v1 depends on it — every read groups by `day` — but a
    # fixture whose ids disagree with its clock invites a later query that
    # accidentally relies on one meaning the other.
    today = date.today()
    rows = []
    for back in reversed(range(len(COUNTS))):
        day = today - timedelta(days=back)
        for i in range(COUNTS[back]):
            # A NAIVE local datetime, formatted as a local day and converted
            # to an instant by the same local zone: `day` and `at` therefore
            # agree about the calendar, which is exactly the property the
            # friend-timezone ledger is about. In dev the browser and this
            # script share a host, so the day the dashboard is handed matches
            # the day seeded here.
            stamp = datetime(day.year, day.month, day.day, LOG_HOURS[i], (i * 7) % 60)
            rows.append((day.isoformat(), int(stamp.timestamp() * 1000)))

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        # Idempotent: regenerating replaces the data rather than doubling it.
        db.execute("DELETE FROM pee_logs")
        db.executemany("INSERT INTO pee_logs (day, at) VALUES (?, ?)", rows)
        db.commit()
    finally:
        db.close()

    print(f"run10: {len(rows)} synthetic logs across {len(COUNTS)} days -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
