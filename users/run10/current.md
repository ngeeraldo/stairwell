---
slug: run10
version: 1
---

## What this is for
Counting how many times they pee in a day, and seeing whether that is high or
low for them. They log it in the moment, from whichever device is at hand —
phone or computer — so the tap has to be the easiest thing on the screen. The
week underneath is the part they look at when they are glancing rather than
logging: today's number only means something next to the last seven days.

## Screens
One screen, so the platform draws no tab strip.

- `pee_tracker` — "Pee Tracker", order 1. Everything below, stacked in one
  column at every width: the count with its log button, then the last seven
  days with the average.

The single column is deliberate rather than a default, and so is the narrow
container (672px, where the house default is 1200px). The spec fixes the
vertical order — tap button on top, week below — and asks for a screen that
works equally well on phone and computer, which is one layout at both widths
rather than two. A third panel would be the moment to revisit that; the
reasoning is about these two.

## Panels
Written from `queries.ts`. The edges are the part that matters.

**Today's count** — `countOn(db, today)`. Counts rows whose stored `day`
equals the day the page was handed. `day` is decided at WRITE time from the
friend's timezone and stored on the row; it is never recomputed from the
timestamp at read time, so the count and the log button can never disagree
about which day it is.

That column is also where the midnight reset actually lives. Nothing resets
anything: a new day has no rows carrying its key yet, so the count starts at
zero on its own. There is no rollover offset anywhere in this dashboard.

A zero here renders as a confident `0`, not as an empty state — "you have not
been yet today" is true and useful, and the row either exists or it does not,
so this zero never stands in for "we do not know". Only the caption changes:
an account that has never logged anything is invited to log its first; an
account with history and nothing today is told nothing is logged yet.

**Last 7 days** — `dailyTrend(db, today)`. Up to seven days ending today,
oldest first, each with a count and a label ("Today", otherwise a weekday
abbreviation).

CLIPPED AT THE FIRST EVER LOGGED DAY, which is the edge that matters: in the
first week it returns fewer than seven entries rather than padding with zeros.
A day before the dashboard existed is not a day they logged nothing. A zero
INSIDE the logged range is different and does render — that is a day they had
the tracker and did not use it.

The chart is a Recharts bar chart and is only mounted when the data can be
charted: at least two points, every count finite, and at least one above zero.
Otherwise the panel renders an empty state as plain elements and no chart
component is constructed at all. Three empty states, because they mean
different things: nothing ever logged, one day so far, and a full window in
which nothing was logged.

**The daily average** — `dailyAverage(trend)`, which takes the trend array
rather than the database. It is the mean of exactly the bars being drawn, to
one decimal, and it is shown beside the panel's title AND as a dashed
reference line across those bars. Taking the array rather than re-querying is
what makes it impossible for the line to sit somewhere the bars contradict.

TODAY IS INCLUDED, because today is one of the bars — the spec asks for the
average across the seven days on the chart, not for a baseline to read today
against. The consequence is real and was accepted: it reads low in the morning
while today is still partial. (run9's dashboard excludes today, from a spec
that asked the other question. Do not reconcile the two without re-reading
both specs.)

The denominator is ELAPSED days, not days that happen to have rows, so a
skipped day pulls the average down instead of vanishing from it. It is the
clipped length rather than a fixed seven, and the panel says so underneath
whenever it is averaging fewer than seven days. It is shown only when the
chart is: on day one it would print today's count back as an average, and on a
window with nothing in it a zero over copy that already says nothing was
logged.

**Degradation.** Today's count is read outside the panel's error handling and
the week is read inside it. If the history reads fail, the count and the log
button survive and the week panel says it could not load — logging is the
product, and a failure computing the chart must not take it away. With no rows
today and no readable history the caption never claims a first tap, since that
would be a guess about an account that may have months of data.

## What can be entered
One control: **Log a pee**. It is `lib/ui/WriteAction.tsx` (the platform's
default write control), POSTs to `/api/users/run10/pee-log`, and writes one row
to `pee_logs` stamped with the current instant and the friend's day. No
deduplication — every tap is a distinct occurrence, which is the whole shape of
this dashboard.

WriteAction renders a real `<form method="post">`, so the no-JS path is a
native post the route answers with a 303. With JavaScript it intercepts the
submit, POSTs by fetch with an `X-Stairwell-Write: 1` header, and calls
`router.refresh()`; the route answers that header with a bare 204 and the
count, the bars and the average patch in together, in place. There is no
navigation and no full reload on the JS path, and a new control here must not
reintroduce one: a redirect followed by fetch renders the whole dashboard again
and files a second permanent `dashboard_open` row.

`/api/users/run10/pee-log` is run10's own route, not shared with any other
friend's. It accepts `action=add` and refuses everything else with a 400,
including the `remove` the route template ships.

The instant on every row is stored and displayed nowhere.

## Deliberately not included
**A rollover at any hour other than midnight.** This was offered explicitly in
the interview — a 5am flip, so a 3am trip would count toward the day that was
ending — and turned down: they do not expect to log night trips at all. The
count runs midnight to midnight in their own timezone. A genuine refusal, not
an omission; do not propose an early-morning rollover again without them
raising it.

**Any special handling of night-time taps.** The same decision from the other
side. A tap at 3am simply lands on the day it happens; nothing detects it,
warns about it, or asks where it should go.

**The times themselves.** NOT a refusal — never asked for either way. The
instant is recorded on every row and shown nowhere in v1, so surfacing it
later is a panel and no migration. Worth knowing before treating its absence
as a gap: the data is there.

**Anything that reaches them outside the app.** No reminders, no notifications,
no nudge when today is running high. Nothing in this system can reach a friend
who is not in the app: their data key exists only while they are unlocked, so
no scheduled job can open their database at all. This is a platform
constraint, not a preference, and it cannot be built for a later version
either.
