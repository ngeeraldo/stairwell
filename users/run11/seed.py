#!/usr/bin/env python3
"""Synthetic generator for run11's dashboard — forecast, walk log, spending.

    python3 seed.py <target.db>

Writes ONLY to argv[1].

WHAT THIS IMITATES, and it is THREE DIFFERENT THINGS as of spec v3:

  * the FORECAST tables, written in production by
    app/api/users/[user]/forecast/route.ts from a public forecast for zip
    77006. Nothing there is typed in by hand.
  * the WALK LOG and the SETTINGS row, which are nothing but hand entry: in
    production every one of those rows exists because the friend pressed
    something (app/api/users/[user]/walk-log/route.ts and .../no-go-temp).
  * the PLAID ENVELOPE and the three spending tables on top of it. The envelope
    is not written here at all — see the next section — and the tables above it
    are hand entry again, from
    app/api/users/[user]/spending-category/route.ts.

All of them are filled the same way the routes fill them — a local day key
resolved at write time, never recomputed from the instant at read time — so a
synthetic database is the same shape of thing a real one is.

THE PLAID TABLES ARE NOT INVENTED HERE. modules/plaid/seed_plaid.py replays a
recorded, scrubbed Sandbox response, so the field shape under every
json_extract() in users/run11/queries.ts is Plaid's real one rather than a
second author's guess at it (docs/runbook-ai.md §2.3). This file writes no
plaid_* row of its own, and must not grow one: a generator drifts from the
contract it imitates and nothing notices, which is the whole reason the
recording exists.

`today` is HANDED to that seeder rather than left to its own clock. A caller
that reads one clock and a seeder that reads another can disagree about the
calendar — modules/tests/plaid.test.ts caught exactly that, seven hours apart
on one machine — and this repo has one rule for it
(docs/superpowers/ledgers/friend-timezone.md).

THE LOUD-FAKE MARKER, which spec v3 changes the answer to. Through v2 this
file produced only day keys, epochs and numbers: neither migration declared a
free-text column at all, and a temperature cannot contain the word TEST and
still be a temperature, so tests/users/conventions.test.ts did not ask for the
marker (CLAUDE.md > Data safety). 004 adds the first free-text column on this
dashboard — a category name the friend TYPES — so the marker is now both asked
for and meetable, and every category name below carries it. The Plaid seeder's
merchant names carry it too. Do NOT invent a junk row for the columns that
still have nowhere to put one; the loudness elsewhere is carried by the
SYNTHETIC DATA banner.

THE PROFILE IS A HOUSTON AUGUST DAY, and it is shaped so that every branch of
the dashboard is reachable by looking at the screen rather than only by reading
a test:

  * rain before dawn through mid-morning — so the rain verdict is real, and so
    the early-morning window a cool day would offer is genuinely closed;
  * a 16:00 hour with a rain CHANCE but zero millimetres — the other half of
    "any precipitation expected", which an amount-only check would miss;
  * feels-like peaking near 102°F over the working afternoon — so the verdict
    during the work break this dashboard was asked for is the interesting one;
  * an evening that drops back under 90°F at 18:00 while sunset is 19:56 — so
    "Next good window" has a real answer today, bounded by darkness at the far
    end rather than by heat;
  * a clear, cooler tomorrow morning — so the "no window left today, here is
    tomorrow" branch has somewhere to point when the screen is opened at night.

Days are relative to the wall clock, like users/run10/seed.py, so "today" here
is the same day the dashboard is handed and the panels are never empty. The
FETCH INSTANT is the real current local time: the panel prints it as "as of",
and a fixed hour would print a time that had not happened yet.

THE WALK LOG PROFILE is shaped the same way, so every branch of the second
screen is reachable by looking at it rather than only by reading a test:

  * TODAY IS DELIBERATELY NOT MARKED, and yesterday is — so the screen shows
    the one edge spec v2 asked to have decided, "Through yesterday — today
    isn't marked yet", instead of the easy case. Tapping today's square on the
    dev screen turns a five-day streak into a six-day one, which is also the
    cheapest way to see the whole write path work end to end;
  * a run of five consecutive days ending yesterday, then gaps of one and two
    days — so the calendar has holes in it and the streak is visibly a RUN
    rather than a count of marks;
  * eighteen marked days inside the last thirty, which is 60% and is the exact
    "18 of the last 30 days" framing that prompted the panel;
  * marks reaching back about six weeks, so the window is a full thirty days
    (the percentage panel reads "of the last 30 days" rather than "since you
    started") and the calendar's back arrow has an earlier month to show.

THE SETTING IS SEEDED AWAY FROM ITS DEFAULT, at 93°F rather than 90. A seeded
90 would render identically whether the dashboard read the stored row or fell
back to the constant, so the one thing this row exists to prove would be
invisible. At 93 the shade band is 88-93 and the evening hour at 89°F reads as
"short one, shade" instead of "Go" — a wiring mistake shows up on the screen.

THE SPENDING PROFILE is shaped the same way, so every branch of the third
screen is reachable by looking at it. The transactions themselves come from the
recording and are what they are; what this file chooses is the RE-FILING on top
of them, and it is chosen to make each edge visible:

  * TWO custom categories, and ONE OF THEM IS DELIBERATELY EMPTY. A bucket he
    created and has not filed anything into yet must appear in the re-file
    menu and must NOT draw a slice — spec v3 says a custom category appears
    "as slices once anything is filed there" — and an empty one is the only
    way to see that on a screen;
  * two transactions re-filed OUT of Plaid's own category and into the other
    custom one, leaving a third behind in it, so the pie visibly disagrees
    with Plaid's categorisation and the override is proved to be what the
    slice is drawn from;
  * the overrides are looked up BY MERCHANT rather than by transaction id. An
    opaque Plaid id hardcoded here would be unreadable and would break
    silently the day the fixture is re-recorded.

NO TICK CHOICES ARE SEEDED, and that is the interesting decision here. The
legend's boxes read from category_visibility, which holds only choices the
friend has actually pressed; everything else falls back to the read-time
default (ticked if the category consumed money, unticked if it did not). Seeding
a row would put a choice in his mouth AND hide the two things the dev screen
most needs to show:

  * a category that NETS TO ZERO. The recording holds a $500 airline charge and
    a $500 airline refund, so Travel nets to nothing, defaults to UNTICKED, and
    sits in the legend at $0 with an empty box while both rows stay in the list
    below. That is the default rule visible on screen rather than only in a
    test;
  * a category that DOMINATES for the wrong reason. The Sandbox card carries an
    "AUTOMATIC PAYMENT" that Plaid Sandbox signs as an outflow, so Loan
    payments lands as the largest slice. It is the exact effect spec v3's own
    open question warns about, and it is left ticked so the raw first-load
    state is what the review actually sees.

Unticking that slice on the dev screen is also the cheapest way to watch the
whole write path work end to end — the same call the walk log makes by leaving
today's square deliberately unmarked.


The EMPTY state — what run11's own database holds before their first refresh
and before they have marked anything — is built from the migrations alone by
`npm run synthetic -- --empty`, so nothing here needs a mode for it and nothing
here should grow one.
"""

import os
import sqlite3
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")

# The shared Plaid seeder, which fills the envelope 003 vendored. Imported
# rather than reimplemented: it replays modules/plaid/fixtures/sandbox.json, a
# real Sandbox response, so this dashboard is built against Plaid's actual
# field shape (docs/runbook-ai.md §2.3, docs/dashboard-build-rules.md §9.7).
sys.path.insert(0, os.path.join(HERE, "..", "..", "modules", "plaid"))
from seed_plaid import seed_plaid  # noqa: E402  (path set immediately above)


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


# Apparent temperature (feels-like, °F) by local hour, 0..23.
#
# TODAY crosses every threshold in users/run11/queries.ts in both directions:
# below 85 overnight, through the 85-90 "short one, shade" band twice, and well
# above 90 across the whole afternoon. Index 18 is 89 rather than a rounder 90
# on purpose — it is what opens the evening window at 18:00 instead of 19:00,
# and a window only sixteen minutes wide would have made the panel's "good
# until" reading impossible to judge on a screen.
FEELS_TODAY = [
    79, 78, 78, 77, 77, 78, 80, 83, 86, 90, 94, 97,
    99, 101, 102, 101, 99, 96, 89, 88, 84, 82, 81, 80,
]

# TOMORROW is clear and a few degrees cooler in the morning, so the first
# window after sunrise is a real one. This is what the dashboard points at when
# it is opened after dark and has nothing left to offer today.
FEELS_TOMORROW = [
    77, 77, 76, 76, 76, 77, 78, 81, 84, 88, 92, 96,
    99, 100, 101, 100, 98, 95, 91, 87, 84, 82, 80, 79,
]

# (millimetres, chance of any precipitation as a percent) by local hour.
#
# The 16:00 entry is the deliberate one: zero millimetres with a 35% chance is
# a forecast that says it might rain and no amount-only check would notice.
# users/run11/queries.ts treats either signal as rain, and this is the row that
# proves the second half is wired up.
PRECIP_TODAY = {
    5: (0.4, 55),
    6: (1.2, 80),
    7: (0.8, 70),
    8: (0.2, 45),
    16: (0.0, 35),
}
PRECIP_TOMORROW = {}

# Sunrise and sunset as local (hour, minute) — late-August Houston.
SUN_TODAY = ((6, 53), (19, 56))
SUN_TOMORROW = ((6, 54), (19, 55))

# The dry hours still get a non-zero chance: a forecast that reports exactly 0%
# for twenty hours reads as missing data rather than as a clear day, and it
# would hide an off-by-one in the rain threshold behind a column of zeroes.
DRY = (0.0, 10)

# Days BEFORE today that count as walked. 0 would be today and is deliberately
# absent — see the module docstring.
#
# Offsets 1-5 are the current run. 7-8, 10-12, 14, 16-17, 19-21 and 25-26 are
# eighteen marked days inside the last thirty (offsets 0-29), which is the 60%
# the percentage panel reads. 33 onwards sit outside that window and exist so
# the window is a FULL thirty days rather than one bounded by the first mark,
# and so the calendar's previous month is not empty.
WALKED_DAYS_AGO = [
    1, 2, 3, 4, 5,
    7, 8,
    10, 11, 12,
    14,
    16, 17,
    19, 20, 21,
    25, 26,
    33, 34, 36,
    40, 41, 45,
]

# The no-go feels-like the synthetic friend has set. NOT 90 — see the docstring.
NO_GO_F = 93

# The buckets the synthetic friend has made for himself. Loudly fake, because
# this is the first free-text column on this dashboard and free text is the only
# place a real person's data could hide in a committed generator
# (tests/users/conventions.test.ts, CLAUDE.md > Data safety).
#
# EATING OUT TEST has transactions filed into it below. DOG STUFF TEST has
# none, on purpose: a category he created and has not used yet must offer
# itself in the re-file menu and must draw no slice.
CUSTOM_CATEGORIES = ["EATING OUT TEST", "DOG STUFF TEST"]

# Which merchants have been re-filed, and into what. Merchant NAMES rather than
# transaction ids: an opaque Plaid id pasted here would be unreadable, and it
# would stop matching the day the fixture is re-recorded, silently, with the
# override simply never joining.
#
# Both of these are FOOD_AND_DRINK in the recording, and one FOOD_AND_DRINK
# transaction (the coffee) is deliberately left alone — so the dev screen shows
# a Plaid category that has been partly emptied into a bucket of his own, which
# is what "the pie reflects the re-filing" looks like when it is working.
REFILED = {
    "KFC TEST": "EATING OUT TEST",
    "MCDONALD'S TEST": "EATING OUT TEST",
}


def hours_for(day, feels, precip, fetched_at):
    """One row per local hour of `day`, as the route would write them."""
    rows = []
    for hour in range(24):
        stamp = datetime(day.year, day.month, day.day, hour, 0)
        millimetres, chance = precip.get(hour, DRY)
        rows.append(
            (
                # A NAIVE local datetime converted to an instant by the same
                # local zone that produced the day key and the minute below, so
                # all three agree about the calendar — the property the
                # friend-timezone ledger is about.
                int(stamp.timestamp() * 1000),
                day.isoformat(),
                hour * 60,
                millimetres,
                chance,
                float(feels[hour]),
                fetched_at,
            )
        )
    return rows


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    today = date.today()
    tomorrow = today + timedelta(days=1)

    # The moment this forecast was fetched. Real local time, truncated to the
    # minute: the dashboard renders it as "as of 3:42 PM", and a stored second
    # would be a precision the panel never shows and cannot justify.
    now = datetime.now().replace(second=0, microsecond=0)
    fetched_at = int(now.timestamp() * 1000)
    fetch_minute = now.hour * 60 + now.minute

    hour_rows = hours_for(today, FEELS_TODAY, PRECIP_TODAY, fetched_at) + hours_for(
        tomorrow, FEELS_TOMORROW, PRECIP_TOMORROW, fetched_at
    )

    day_rows = []
    for day, ((rise_h, rise_m), (set_h, set_m)) in (
        (today, SUN_TODAY),
        (tomorrow, SUN_TOMORROW),
    ):
        day_rows.append(
            (day.isoformat(), rise_h * 60 + rise_m, set_h * 60 + set_m, fetched_at)
        )

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        # Idempotent: regenerating replaces the forecast rather than doubling
        # it, which is also exactly what a real refresh does — a forecast is a
        # snapshot, not a history.
        db.execute("DELETE FROM forecast_hours")
        db.execute("DELETE FROM forecast_days")
        db.execute("DELETE FROM forecast_fetches")
        db.executemany(
            """INSERT INTO forecast_hours
                 (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            hour_rows,
        )
        db.executemany(
            """INSERT INTO forecast_days
                 (day, sunrise_minute, sunset_minute, fetched_at)
               VALUES (?, ?, ?, ?)""",
            day_rows,
        )
        # ONE successful attempt, and no failed one. The panel's error state is
        # a real branch and is covered by users/run11/tests — but seeding a
        # failure here would make the dev screen show the degraded panel every
        # time, which is the one thing a sample screen must not do.
        db.execute(
            "INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, 1)",
            (fetched_at, today.isoformat(), fetch_minute),
        )

        # The hand-entered half. Cleared and rewritten for the same reason the
        # forecast is: regenerating replaces the sample rather than doubling
        # it. Unlike the forecast, this is NOT what the real route does — a
        # friend's walk log is a history and nothing ever clears it. This is a
        # sample being regenerated, not a refresh being imitated.
        db.execute("DELETE FROM walk_log")
        db.execute("DELETE FROM walk_settings")
        db.executemany(
            "INSERT INTO walk_log (day, at) VALUES (?, ?)",
            [
                # `at` is the instant of the MARK. Stamped at the local
                # midday of the day itself rather than at `fetched_at`, so the
                # sample reads as marks made day by day rather than as
                # twenty-four rows entered in one second.
                (
                    (today - timedelta(days=ago)).isoformat(),
                    int(
                        datetime(
                            *(today - timedelta(days=ago)).timetuple()[:3], 12, 0
                        ).timestamp()
                        * 1000
                    ),
                )
                for ago in WALKED_DAYS_AGO
            ],
        )
        db.execute(
            "INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, ?, ?)",
            (NO_GO_F, fetched_at),
        )

        # ─── THE SPENDING SCREEN ────────────────────────────────────────────
        #
        # The envelope first, from the recording. `today` is handed in so this
        # file and the seeder agree about the calendar; the seeder slides the
        # NEWEST transaction onto that day, which is what keeps "the last 30
        # days" from rendering empty months after the fixture was recorded.
        plaid_counts = seed_plaid(db, today=today)

        # Then the friend's own two tables, which are hand entry exactly like
        # the walk log above: in production every row here exists because he
        # pressed something in the transaction list.
        #
        # Cleared and rewritten so regenerating replaces the sample rather than
        # doubling it. As with the walk log, this is NOT what the real route
        # does — nothing in production ever clears a friend's re-filing.
        db.execute("DELETE FROM transaction_category_overrides")
        db.execute("DELETE FROM custom_categories")
        db.executemany(
            "INSERT INTO custom_categories (name, created_at) VALUES (?, ?)",
            [(name, fetched_at) for name in CUSTOM_CATEGORIES],
        )

        # Resolved against what the seeder actually wrote, rather than assumed.
        # If a merchant in REFILED is not in the recording this inserts nothing
        # for it, and the count printed below says so — a silent zero here
        # would look exactly like a broken override join in the dashboard.
        overrides = []
        for merchant, category in REFILED.items():
            for (transaction_id,) in db.execute(
                "SELECT transaction_id FROM plaid_transactions "
                "WHERE json_extract(payload, '$.merchant_name') = ?",
                (merchant,),
            ).fetchall():
                overrides.append((transaction_id, category, fetched_at))
        db.executemany(
            "INSERT INTO transaction_category_overrides "
            "(transaction_id, category, set_at) VALUES (?, ?, ?)",
            overrides,
        )

        db.commit()
    finally:
        db.close()

    print(
        f"run11: {len(hour_rows)} synthetic forecast hours across {len(day_rows)} days, "
        f"{len(WALKED_DAYS_AGO)} walked days, no-go {NO_GO_F}F, "
        f"{plaid_counts.get('plaid_transactions', 0)} plaid transactions, "
        f"{len(CUSTOM_CATEGORIES)} custom categories, {len(overrides)} re-filed -> {target}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
