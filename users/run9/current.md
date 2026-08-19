---
slug: run9
version: 1
---

## What this is for
Knowing how many times he has been to the bathroom today, and whether that is
high or low for him. He logs it as it happens, from a phone or a computer,
and checks the trend from either. The point of the whole screen is the
comparison: today's number only means something next to the last week.

## Screens
One screen, so the platform draws no tab strip.

- `pee_tracker` — "Pee Tracker", order 1. Everything below, stacked in one
  column at every width: the count and its controls, then the 7-day trend,
  then the weekly average.

The single column is deliberate rather than a default: the spec asks for a
screen that works identically on phone and computer, which outranks the house
rule of giving desktop more columns.

## Panels
Written from `queries.ts`. The edges are the part that matters.

**Today's count** — `countOn(db, today)`. Counts rows whose stored `day`
equals the day the page was handed. `day` is decided at WRITE time from the
friend's timezone and stored on the row; it is never recomputed from the
timestamp at read time, so the count and the log button can never disagree
about which day it is.

A zero here renders as a confident `0`, not as an empty state — "you have not
been yet today" is true and useful, and the row either exists or it does not,
so this zero never stands in for "we do not know". Only the caption changes:
an account that has never logged anything is invited to log its first; an
account with history and nothing today is told nothing is logged yet.

**Fix today's count** — inside the count panel, directly under the log button.
`−1` is disabled at zero. That is the affordance only; the bound is enforced
in the route's statement, so a replayed form cannot go negative either.

**Daily trend** — `dailyTrend(db, today)`. Up to seven days ending today,
oldest first, each with a count and a label ("Today", otherwise a weekday
abbreviation).

CLIPPED AT THE FIRST EVER LOGGED DAY, which is the edge that matters: in the
first week it returns fewer than seven entries rather than padding with
zeros. A day before the dashboard existed is not a day he logged nothing. A
zero INSIDE the logged range is different and does render — that is a day he
had the tracker and did not use it.

The chart is a Recharts bar chart and is only mounted when the data can be
charted: at least two points, every count finite, and at least one above
zero. Otherwise the panel renders an empty state as plain elements and no
chart component is constructed at all. Three empty states, because they mean
different things: nothing ever logged, one day so far, and a full window in
which nothing was logged.

**Weekly average** — `weeklyAverage(db, today)`. The average per day over the
completed days before today, clipped at the first logged day, to one decimal.

TODAY IS EXCLUDED. It is a baseline to read today against, and one that
included the partial day being measured would fall every morning and rise
through the afternoon. The denominator is ELAPSED days, not days that happen
to have rows, so a skipped day pulls the average down instead of vanishing
from it. It is `null` — and the panel says so — until one complete day has
passed, so day one shows no baseline rather than a baseline of one partial
day. The number is also drawn onto the trend chart as a dashed reference
line, which is what makes the two panels read together.

## What can be entered
Three controls, all plain form POSTs to `/api/users/[user]/pee`, all writing
to `pee_logs`:

- **Log one** — writes one row, stamped with the current instant and the
  friend's day. No deduplication: every tap is a distinct occurrence, unlike
  devtwo's day-keyed walk.
- **+1** — identical to Log one. The spec says nudging up is the same as a
  normal tap, so it is one operation and not two that happen to agree.
- **−1** — deletes the single most recent row of today, by id. Bounded to
  today and to one row inside the statement itself, so it cannot reach
  yesterday and cannot go below zero.

The instant on every row is stored and displayed nowhere.

## Deliberately not included
**The times themselves.** Asked about showing when each one happened, he said
he did not know that he needed it right now, and the agreement was to store
the times quietly so the question stays answerable later. The column is
populated on every row. Do not propose adding the timestamps back as if they
were missing — they are recorded and withheld on purpose. A future version
that surfaces them needs no migration.

**A week-over-week trend.** In the interview he asked for "a daily trend and a
weekly trend", and the spec resolved the second to a single weekly average,
which is what shipped. Not a refusal — a resolution — and worth knowing,
because a repeat request for a "weekly trend" may mean a second chart
comparing whole weeks rather than this number. Ask before assuming he forgot.

**Anything that reaches him outside the app.** No reminders, no notifications,
no nudge when today is running high. Nothing in this system can reach a
friend who is not in the app: his data key exists only while he is unlocked,
so no scheduled job can open his database at all. This is a platform
constraint, not a preference, and it cannot be built for a later version
either.
