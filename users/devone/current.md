---
slug: devone
version: 0
---

## What this is for
Seeing what has been spent recently, and how much of this month has gone on
eating out. devone is the hand-written reference implementation — it predates
the spec loop, so there is no spec version behind it.

## Screens
One screen, `morning`, titled "Spending". It carries both panels below; there
is no tab strip, because the platform draws none for a single screen.

## Panels
**Eating out this month.** A single money figure: everything categorised as
eating out, for the current month in the friend's own time zone. When no
transactions exist at all it says "Nothing logged yet" rather than showing a
zero — a confident zero reads as a claim about their life rather than about
their data.

**Recent transactions.** A list, most recent first, each row showing the day,
the merchant and the amount. Empty state is "No transactions yet."

## What can be entered
Nothing. Every row is synced; this dashboard has no entry widget and no write
path.

## Deliberately not included
Any control that writes. This folder is the worked reference for a read-only
dashboard — the write-path example lives elsewhere.
