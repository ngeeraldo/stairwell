#!/usr/bin/env python3
"""Synthetic bathroom-count history for run8's dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1]. It never touches run8.db, which is encrypted and holds
the real taps — this fills synthetic.db, which is what dev serves for reads AND
writes, under the SYNTHETIC DATA banner.

── No loudly-fake marker in here, and that is correct ──────────────────────────

Every other seed.py in this repo carries a value containing the literal string
TEST. This one cannot: every column is an integer or a 'YYYY-MM-DD' day key,
and neither can hold the word and stay the thing it is. 001_initial.sql's GLOB
on `day` makes that structural rather than a matter of restraint.

That is not a gap. The marker guards seed.py against holding data copied from a
real person (CLAUDE.md > Testing), and a threat like that needs free text to
hide in — an integer is not traceable to anyone. tests/users/conventions.test.ts
asks for the marker only where a seed produces free text. Do NOT add a junk row
to satisfy a check that is not asking; devtwo has one and it is a wart, not a
precedent.

── Days are relative to the wall clock ─────────────────────────────────────────

So "this week" is never empty. A script may read a clock — the rule that
forbids it (tests/users/noLocalDay.test.ts) governs dashboard.tsx and
queries.ts, where a server-side "today" would disagree with the friend's own
calendar. Nothing here reaches a friend's database.

Fixed, never random: a sample screen that reshuffles between runs is harder to
talk about than one that does not.
"""

import datetime as dt
import os
import sqlite3
import sys
import time

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


# Net count per day. WEEKS[n][weekday] is n weeks back from the current week,
# weekday 0 = MONDAY — the week start run8 confirmed, and the order the mockup's
# axis labels run in (Mon…Sun).
#
# Six weeks because the weekly-average toggle shows "as many weeks as we have"
# (confirmed answer), and a toggle that reveals two points is not a trend. Six
# is also enough for the averages to differ from each other without any day
# looking made up.
WEEKS = [
    [8, 7, 9, 6, 8, 11, 7],
    [7, 9, 6, 8, 7, 10, 6],
    [9, 6, 8, 7, 9, 8, 7],
    [6, 8, 7, 9, 6, 9, 8],
    [8, 7, 10, 6, 8, 7, 9],
    [7, 9, 8, 7, 10, 6, 8],
]

# Today is deliberately mid-count rather than a finished day's total.
#
# The confirmed mockup shows today at 5 with both buttons live, and the first
# thing anyone opening this dashboard should want to do is press plus. A today
# that already reads like a complete day invites nobody to touch it. devtwo
# learned the same lesson from the other side: its seed marked today as walked,
# so the sample screen rendered with no tap control at all, disagreeing with the
# preview the friend had approved.
TODAY_COUNT = 5

# (weeks_back, weekday) pairs that got an accidental tap and a correction.
#
# Not decoration. Mis-taps are the reason the minus button exists at all — it
# was the friend's own stated concern — so a synthetic database with no
# subtraction in it never exercises the path the ledger was designed around,
# and every query and screenshot would be reviewed against data that only ever
# counts up. The net for these days is unchanged: +1 then -1.
MISTAPS = {(0, 1), (1, 4), (3, 2)}

# Waking hours. Taps are spread across the day so the timestamps read like a
# day rather than a burst, even though nothing displays them yet.
FIRST_HOUR = 7
LAST_HOUR = 22
MINUTE_MS = 60_000


def stamp(day, hour, minute):
    """Epoch milliseconds for a local wall-clock time on `day`.

    Local, matching the day key beside it: these two columns must agree about
    which day they mean, which is the whole reason the day is stored rather
    than derived (001_initial.sql).
    """
    when = dt.datetime.combine(day, dt.time(hour, minute))
    return int(time.mktime(when.timetuple()) * 1000)


def events_for(day, count, mistap, last_hour):
    """One (day, at, delta) tuple per tap, plus a correction pair if mis-tapped."""
    span = max(last_hour - FIRST_HOUR, 1)
    iso = day.isoformat()
    times = [
        stamp(day, FIRST_HOUR + (i * span) // max(count, 1), (i * 17) % 60)
        for i in range(count)
    ]
    rows = [(iso, at, 1) for at in times]
    if mistap and times:
        # Right after the last real tap, which is what an accidental double-tap
        # actually looks like — noticed and undone a minute later.
        last = max(times)
        rows.append((iso, last + MINUTE_MS, 1))
        rows.append((iso, last + 2 * MINUTE_MS, -1))
    return rows


def build_rows(today, now_hour):
    rows = []
    monday = today - dt.timedelta(days=today.weekday())
    for weeks_back, counts in enumerate(WEEKS):
        week_start = monday - dt.timedelta(weeks=weeks_back)
        for weekday, count in enumerate(counts):
            day = week_start + dt.timedelta(days=weekday)
            # A day that has not happened yet is not a day with zero trips.
            # The current week is partial by definition, and a dashboard that
            # drew the rest of it as empty bars would be reporting failure for
            # days the friend has not lived through — the exact mistake
            # devtwo's first build made from the other direction.
            if day > today:
                continue
            if day == today:
                # Clamped so no tap is stamped in the future. Only `day` is
                # read today, but a timestamp later than "now" is the kind of
                # detail that wastes an afternoon when someone finally reads it.
                rows.extend(
                    events_for(day, TODAY_COUNT, (weeks_back, weekday) in MISTAPS,
                               max(FIRST_HOUR + 1, min(now_hour, LAST_HOUR)))
                )
            else:
                rows.extend(
                    events_for(day, count, (weeks_back, weekday) in MISTAPS, LAST_HOUR)
                )
    return rows


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    rows = build_rows(dt.date.today(), time.localtime().tm_hour)

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        # No DELETE first: 001 creates the table without IF NOT EXISTS, so a
        # run against a database that already has one throws above this line.
        # `npm run synthetic` deletes the file before calling us.
        db.executemany(
            "INSERT INTO pee_events (day, at, delta) VALUES (?, ?, ?)", rows
        )
        db.commit()
    finally:
        db.close()

    days = len({row[0] for row in rows})
    print(f"run8: {len(rows)} synthetic taps across {days} days -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
