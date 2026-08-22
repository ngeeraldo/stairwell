#!/usr/bin/env python3
"""Synthetic data for run12's Spending Breakdown dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1].

Runs the migrations in order and stamps user_version, so a synthetic database
is built by the same files lib/db/migrate.ts applies to an encrypted one — one
description of the shape rather than two that can drift.

NO PLAID ROW IS INVENTED HERE, and that is a rule rather than an economy
(docs/runbook-ai.md §2.3). Every plaid_* row comes from
modules/plaid/seed_plaid.py, which replays modules/plaid/fixtures/sandbox.json
— a recorded, scrubbed Plaid Sandbox response — into the shared envelope. A
generator here would be a second author's GUESS at Plaid's field shape, and
nothing would notice when it drifted: the panel would pass every test on the
way to breaking for a real person. A recording cannot drift from the shape it
was copied from.

RUN12'S OWN THREE TABLES ARE SEEDED HERE, and only those. 004 added the buckets
the friend names, the transactions he re-files, and the categories he ticks out
of the pie — the first tables in this folder that hold anything he entered
himself, and therefore the first this file has anything to say about. They are
filled by reading back what the Plaid seeder just wrote, rather than by naming
transaction ids this file could not know: the ids are Plaid's, they change with
the recording, and a hard-coded one would silently stop matching.

Every name below carries the loud TEST marker (CLAUDE.md > Data safety). These
are the only free-text values this folder has ever stored, so they are the only
place in it where the marker has anywhere to go — a count and a day key cannot
carry one and still be what they are.

`today` IS HANDED TO THE SEEDER rather than left to its own clock. A caller
that reads its own clock and a seeder that reads its own clock can disagree
about the calendar — modules/tests/plaid.test.ts caught exactly that, seven
hours apart on the same machine. This repo has one rule for it
(docs/superpowers/ledgers/friend-timezone.md): the day is handed in wherever a
caller knows it. Here the caller is a dev script on Nico's laptop, so its own
local day is the right answer and the honest place to read it.

WHAT THE RESULT LOOKS LIKE, AND WHY THAT IS THE USEFUL SHAPE
------------------------------------------------------------
The seeder splits the recording across TWO banks — one live, one deliberately
disconnected with real history under it — and slides the newest transaction
onto today so the 30-day window is populated whenever this is run. Between them
that gives the Spending screen most of what is worth looking at at once: a live
source with a last-updated time, several categories at different sizes, a
category that nets to nothing because the recording refunds a flight, one
bucket of his own on a real wedge, and one category explicitly unticked.

TWO PATHS THIS DATA CANNOT REACH, and both are worth knowing before reviewing
a screen and concluding something is missing:

  * `is_internal` NEVER FIRES. Every transfer in the recording — both
    TRANSFER_OUT rows, the TRANSFER_IN, and the credit-card payment — sits on a
    savings, CD or money-market account, and 003's account allow-list excludes
    those before the flag is ever consulted. So the "N transfers left out"
    caption does not render here, and neither does the "not counted (transfer)"
    marker in the list. In production a card payment from the connected
    checking account WILL be in scope, which is what the flag is for. This is
    docs/dashboard-build-rules.md §9.7's trap in its own direction: do not
    conclude from synthetic data that a path is dead.
  * THE FOLD into "Other" does not fire, because the recording produces six
    spending categories and the pie draws eight before folding.

Both are proven in users/run12/tests/queries.test.ts against hand-built rows
instead, which is the right place for them: inventing eight more categories of
Plaid-shaped transactions to exercise a fold is exactly the generator this file
exists to avoid.

The EMPTY state — what a friend's own database holds the morning the dashboard
ships — is built from the migrations alone by `npm run synthetic -- --empty`,
so nothing here needs a mode for it and nothing here should grow one.
"""

import os
import sqlite3
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")
sys.path.insert(0, os.path.join(HERE, "..", "..", "modules", "plaid"))

from seed_plaid import seed_plaid  # noqa: E402  (path set immediately above)


def apply_migrations(db):
    """Build the shape the way a real database gets it: 001..n, in order.

    There is no schema.sql. Migrations own a dashboard's shape (2026-08-15
    migrations design, D6), so a synthetic database is built by the same files
    that build an encrypted one.

    The ORDER is load-bearing here and not merely tidy: 002 ALTERs tables 001
    creates, and 003's views select the `item_id` column 002 adds. Sorted
    filenames are what guarantees it, which is why the numeric prefix is part
    of the filename convention rather than a comment.
    """
    names = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    for name in names:
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as handle:
            db.executescript(handle.read())
    if names:
        db.execute(f"PRAGMA user_version = {int(names[-1][:3])}")


# The buckets the friend has made for himself. Loudly fake, and deliberately
# NOT a copy of a Plaid category name: the whole point of a custom bucket is
# that it is a word of his own, and a seed whose buckets all look like Plaid
# keys would never show the reviewer what a mixed menu reads like.
CUSTOM_CATEGORIES = ["EATING OUT TEST", "GUILT FREE TEST"]


def seed_annotations(db):
    """Fill run12's own three tables: buckets, re-filings, and one tick.

    Reads the transactions BACK OUT of the database the Plaid seeder just
    filled, rather than naming ids. The ids belong to the recording and move
    with it, so a literal here would quietly stop matching the day the fixture
    is re-recorded — and a re-filing that matches nothing is invisible rather
    than broken, which is the worst way for seed data to fail.

    It picks from `spending_transactions`, which is 004's view, so it can only
    ever re-file a row the screen actually shows. Ordered by transaction_id so
    the same rows are chosen on every run: a seed that shuffled would make two
    reviewers looking at "the same" synthetic database see different screens.
    """
    now = 1_700_000_000_000

    for name in CUSTOM_CATEGORIES:
        db.execute(
            "INSERT OR IGNORE INTO custom_categories (name, created_at) VALUES (?, ?)",
            (name, now),
        )

    # ONE RE-FILING, and WHICH one is chosen deliberately rather than
    # arbitrarily. It moves a FOOD_AND_DRINK charge into "EATING OUT TEST",
    # because that is the move a real person would actually make and it reads
    # correctly on screen: a bucket named for the thing it holds.
    #
    # The first draft took whichever transaction sorted first and landed on the
    # largest row in the recording — a $2,079 "eating out" wedge at 55% of the
    # pie. Every test still passed; the screen just looked broken, and a
    # reviewer would reasonably have read it as a categorisation bug rather than
    # as seed data. Synthetic data has to be plausible as well as loud.
    #
    # If the recording ever stops containing a FOOD_AND_DRINK row, this seeds
    # nothing. That is not an error: the panel renders either way, and a seeder
    # that raised here would break `npm run synthetic` for every other folder
    # over data this one does not control.
    refiled = 0
    for (transaction_id,) in db.execute(
        "SELECT transaction_id FROM spending_transactions "
        "WHERE plaid_category = 'FOOD_AND_DRINK' AND amount > 0 "
        "ORDER BY amount, transaction_id LIMIT 1"
    ).fetchall():
        db.execute(
            "INSERT OR REPLACE INTO transaction_category_overrides "
            "(transaction_id, category, set_at) VALUES (?, ?, ?)",
            (transaction_id, CUSTOM_CATEGORIES[0], now),
        )
        refiled += 1

    # ONE EXPLICIT UNTICK, so the reviewer sees that state without pressing
    # anything: an empty box, a greyed row that keeps its amount, and the
    # "percentages are of the ticked categories only" caveat underneath.
    #
    # It has to be a category with REAL MONEY in it. A category that nets to
    # zero is already unticked by default (`resolveVisibility`), so unticking
    # one would store a row that changes nothing and demonstrate nothing — which
    # is exactly what the first draft did, by picking the alphabetically last
    # category and landing on the refunded flight.
    #
    # The SMALLEST such category, so the pie the reviewer sees is still mostly
    # the pie the data describes.
    ticked = db.execute(
        "SELECT category FROM spending_transactions WHERE is_internal = 0 "
        "GROUP BY category HAVING ROUND(SUM(amount), 2) > 0 "
        "ORDER BY SUM(amount), category LIMIT 1"
    ).fetchall()
    for (category,) in ticked:
        db.execute(
            "INSERT OR REPLACE INTO category_visibility (category, included, set_at) "
            "VALUES (?, 0, ?)",
            (category, now),
        )

    return {
        "custom_categories": len(CUSTOM_CATEGORIES),
        "transaction_category_overrides": refiled,
        "category_visibility": len(ticked),
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python3 seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    db = sqlite3.connect(target)
    try:
        apply_migrations(db)
        counts = seed_plaid(db, today=date.today())
        annotations = seed_annotations(db)
        db.commit()
    finally:
        db.close()

    summary = ", ".join(f"{n} {table.removeprefix('plaid_')}" for table, n in counts.items())
    print(
        f"run12: {summary}, "
        f"{annotations['custom_categories']} custom categories, "
        f"{annotations['transaction_category_overrides']} re-filed, "
        f"{annotations['category_visibility']} ticked -> {target}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
