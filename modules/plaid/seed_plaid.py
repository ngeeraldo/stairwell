#!/usr/bin/env python3
"""Fill the shared Plaid envelope from the recorded Sandbox fixture.

Imported by a finance friend's own seed.py:

    import sys, os
    sys.path.insert(0, os.path.join(HERE, "..", "..", "modules", "plaid"))
    from seed_plaid import seed_plaid
    seed_plaid(db)

Or run standalone against a database that already has the envelope:

    python3 seed_plaid.py <target.db> [YYYY-MM-DD]

The optional day is what "today" means for the date shift. It exists because a
caller that reads its own clock and a seeder that reads its own clock can
disagree about the calendar - modules/tests/plaid.test.ts caught exactly that,
computing a UTC day while this file computed a local one, seven hours apart on
the same machine. This repo has one rule for that (docs/superpowers/ledgers/
friend-timezone.md): the day is HANDED IN, never asked of a clock, wherever a
caller knows it.

WHY A RECORDING RATHER THAN A GENERATOR
---------------------------------------
Every other seed.py in this repo invents its rows. This one replays
modules/plaid/fixtures/sandbox.json, which scripts/record-plaid-fixture.ts
recorded from a real Plaid Sandbox response and scrubbed.

The difference matters because a dashboard is BUILT against synthetic data and
SHIPPED against real data. A generator is a second author's guess at Plaid's
field shape, and nothing notices when it drifts - the panel just breaks for a
real friend, having passed every test on the way there. A recording cannot
drift from a shape it was copied from.

The fixture is safe to commit twice over: Sandbox transactions are fabricated
by Plaid and belong to nobody, and every human-readable name in it carries the
loud TEST marker (CLAUDE.md > Data safety).

DATES ARE SHIFTED ONTO TODAY, AND THAT IS NOT COSMETIC
------------------------------------------------------
The fixture froze on the day it was recorded. Replayed unchanged six months
later, every transaction is ancient, "this month" renders empty, and a builder
reasonably concludes their panel is broken. users/devtwo/seed.py already draws
this line for the same reason.

So the NEWEST transaction is slid onto today and every other date moves by the
same offset, preserving the gaps between them - including the future ones.
Plaid's recurring streams carry `predicted_next_date` a month ahead, and a
seeder that clamped dates to the past would silently delete the only forward-
looking value in the payload.

The shift is applied to the stored COLUMN and to the JSON PAYLOAD together. If
they disagreed, `WHERE date = ?` and `json_extract(payload,'$.date')` would
return different rows from the same table - a bug that would look like a
mystery rather than a mistake.
"""

import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "sandbox.json")

# Plaid writes every date as a bare YYYY-MM-DD. Matching the SHAPE rather than
# naming the fields is deliberate: `date`, `authorized_date`, `first_date`,
# `last_date`, `predicted_next_date` and `institution_price_as_of` are the ones
# in today's payload, and a field list would silently stop covering a new one.
# Nothing else in a Plaid payload has this shape - ids are opaque strings and
# timestamps carry a T.
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _shift_value(value, offset_days):
    """Recursively slide every YYYY-MM-DD in a payload by offset_days."""
    if isinstance(value, str):
        if ISO_DATE.match(value):
            moved = date.fromisoformat(value) + timedelta(days=offset_days)
            return moved.isoformat()
        return value
    if isinstance(value, list):
        return [_shift_value(v, offset_days) for v in value]
    if isinstance(value, dict):
        return {k: _shift_value(v, offset_days) for k, v in value.items()}
    return value


def _offset_days(fixture, today):
    """Days to add so the NEWEST transaction lands on today.

    Anchored on transactions rather than on the newest date anywhere, because
    recurring streams predict a month into the future: anchoring on those would
    push every real transaction a month into the past and leave the dashboard
    looking like the friend stopped spending.
    """
    dates = [t["date"] for t in fixture["transactions"] if ISO_DATE.match(t.get("date", ""))]
    if not dates:
        return 0
    return (today - date.fromisoformat(max(dates))).days


def seed_plaid(db, today=None):
    """Fill every plaid_* table from the fixture. Returns a row count per table.

    Writes ONLY to the connection it is handed, and assumes the envelope
    already exists - a friend's migrations create it, exactly as they create
    every other table (there is no schema.sql anywhere in this repo).
    """
    today = today or date.today()
    with open(FIXTURE, encoding="utf-8") as handle:
        fixture = json.load(handle)

    offset = _offset_days(fixture, today)
    shifted = _shift_value(fixture, offset)
    counts = {}

    def insert(table, sql, rows):
        db.executemany(sql, rows)
        counts[table] = len(rows)

    # ONE plaid_items row, with a loudly fake token.
    #
    # This file used to seed none, on the reasoning that a synthetic database
    # must never hold a bank credential even a fake one. That protected nothing
    # - the string below reaches no bank and never could - and it cost
    # something real: a dashboard decides connected-vs-not by whether an item
    # EXISTS, so without this row every seeded finance dashboard rendered "no
    # bank connected" and hid all of its own data. Reviewing panels, or
    # screenshotting them, meant connecting a real Sandbox bank first.
    #
    # Both states stay reachable, which is the point:
    #   npm run synthetic            connected, with data - the normal review
    #   npm run synthetic -- --empty not connected - a friend's first session
    #
    # Pressing Refresh against this token fails with an auth error and records
    # it in plaid_refreshes, so the panel says "couldn't reach your bank". That
    # is an honest state and a useful one to be able to look at.
    insert(
        "plaid_items",
        "INSERT OR REPLACE INTO plaid_items "
        "(item_id, access_token, institution_id, cursor, available_products, payload, connected_at) "
        "VALUES (?,?,?,NULL,?,'{}',?)",
        [(
            "item-SYNTHETIC-TEST",
            # Loudly fake, and shaped nothing like a real token, so it can
            # never be mistaken for one in a dump or a screenshot.
            "access-SYNTHETIC-NOT-A-REAL-TOKEN-TEST",
            "ins_SYNTHETIC_TEST",
            json.dumps(["investments", "recurring_transactions", "transactions_refresh"]),
            int(datetime(2026, 1, 1).timestamp() * 1000),
        )],
    )

    insert(
        "plaid_accounts",
        "INSERT OR REPLACE INTO plaid_accounts (account_id, item_id, payload) VALUES (?,?,?)",
        [(a["account_id"], "synthetic-item", json.dumps(a)) for a in shifted["accounts"]],
    )

    insert(
        "plaid_transactions",
        "INSERT OR REPLACE INTO plaid_transactions "
        "(transaction_id, account_id, date, payload) VALUES (?,?,?,?)",
        [
            (t["transaction_id"], t["account_id"], t["date"], json.dumps(t))
            for t in shifted["transactions"]
        ],
    )

    streams = [("inflow", s) for s in shifted["recurring_inflow"]]
    streams += [("outflow", s) for s in shifted["recurring_outflow"]]
    insert(
        "plaid_recurring_streams",
        "INSERT OR REPLACE INTO plaid_recurring_streams "
        "(stream_id, account_id, direction, payload) VALUES (?,?,?,?)",
        [(s["stream_id"], s["account_id"], d, json.dumps(s)) for d, s in streams],
    )

    insert(
        "plaid_securities",
        "INSERT OR REPLACE INTO plaid_securities (security_id, payload) VALUES (?,?)",
        [(s["security_id"], json.dumps(s)) for s in shifted["securities"]],
    )

    insert(
        "plaid_holdings",
        "INSERT OR REPLACE INTO plaid_holdings "
        "(account_id, security_id, payload) VALUES (?,?,?)",
        [(h["account_id"], h["security_id"], json.dumps(h)) for h in shifted["holdings"]],
    )

    insert(
        "plaid_investment_transactions",
        "INSERT OR REPLACE INTO plaid_investment_transactions "
        "(investment_transaction_id, account_id, security_id, date, payload) VALUES (?,?,?,?,?)",
        [
            (
                t["investment_transaction_id"],
                t["account_id"],
                t.get("security_id"),
                t["date"],
                json.dumps(t),
            )
            for t in shifted["investment_transactions"]
        ],
    )

    # No plaid_refreshes row either. A refresh is something that HAPPENED, and
    # none has. Inventing one would make a panel claim it reached a bank.

    db.commit()
    return counts


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit("usage: python3 seed_plaid.py <target.db> [YYYY-MM-DD]")
    when = date.fromisoformat(sys.argv[2]) if len(sys.argv) == 3 else None
    connection = sqlite3.connect(sys.argv[1])
    try:
        for table, n in seed_plaid(connection, today=when).items():
            print(f"  {table}: {n}")
    finally:
        connection.close()
