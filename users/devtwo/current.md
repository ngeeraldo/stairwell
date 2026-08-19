---
slug: devtwo
version: 0
---

## What this is for
Checking whether today's walk has happened, and whether the habit is holding.
devtwo is hand-written and predates the spec loop, so there is no spec version
behind it.

## Screens
One screen, `morning`, titled "Daily walk". It carries all four panels below.

## Panels
**Walked today?** Reads WALKED or NOT YET for the current day, with the day
shown beneath. When the day is not yet marked it offers the tap control; once
marked it says so instead of offering the control again.

**Current streak.** Consecutive days ending today OR yesterday, with a grace day
that is spec-confirmed: if today has not been marked yet but yesterday was, the
streak still counts rather than resetting to zero. The grace day exists to avoid
punishing the user for the day not having happened yet — a streak that broke at
00:01 would read as "you failed today" when most of today has not occurred. The
label agrees in number — "day in a row" at one, "days in a row" otherwise.

**Last 30 days.** A percentage, with the count it came from underneath.

**Last 14 days at a glance.** One row per day, each marked walked or missed.
Hidden entirely — replaced by "Nothing logged yet" — until something has been
logged. A day before the friend started is not a day they failed, and the
first version of this panel told a friend on their first morning that they
had missed each of the previous fourteen days.

## What can be entered
One tap, marking today walked. It posts to a platform route, never writing
from the dashboard itself, and marks the current day only.

## Deliberately not included
Un-marking a day. There is no control to undo a tap, and no way to mark a day
other than today.
