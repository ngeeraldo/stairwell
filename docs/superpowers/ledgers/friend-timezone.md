# The friend's day, not the server's — decisions ledger

Plan: `docs/superpowers/plans/2026-08-14-friend-timezone.md`
Branch: `friend-timezone`, cut from `main` after the onboarding build shipped.

This one is not written from a spec. It is written from a row.

devtwo's dashboard was tapped once on the deployed product, on the evening of
2026-08-13 in New York, and the row is stored as `2026-08-14`. The dashboard
duly reports the 13th as missed and the streak as starting tomorrow. The bug
was found by reading a metric row, noticing it carried no `device_class`
(therefore pre-deploy, therefore the original checkpoint tap), and then asking
the droplet what time it thought it was: `timedatectl` says UTC.

`walks.day` is a `TEXT PRIMARY KEY` in a per-user encrypted database that
nothing migrates. The row is wrong permanently. One row on a dev account is
what this cost to find; three friends and a month of streaks is what it would
have cost in a fortnight.

---

## Rulings

### T1. The zone travels in a cookie, not in the account

The client is the only party that knows its own zone, and this codebase already
has exactly one mechanism for telling the server something only the client
knows: the root layout's inline script, which writes `stairwell_dc` for
`device_class` (onboarding ledger D4). `stairwell_tz` is written beside it, by
the same script, read by `readTimeZone()` beside `readDeviceClass()`.

Rejected: storing a zone on the account. It would need a UI to set it, it would
be wrong the moment somebody travels, and it would be a schema change to the
platform database for a fact the browser volunteers for free.

Rejected: guessing from an IP or an `Accept-Language` header. Both are guesses
about the thing `Intl.DateTimeFormat().resolvedOptions().timeZone` simply
knows.

### T2. The first render of a session falls back to UTC, and that is inherent

The server builds the very first page of a session before the script that
writes the cookie has run. `readTimeZone()` returns `undefined`, `dayKey`
degrades to UTC, and for that one render the day may be off by one west of
Greenwich.

Not fixed, because the fixes are worse: a redirect-after-detect costs everybody
a round trip on every first load, and a client-side re-render of the day makes
the number move under the reader. What that first render can do is *nothing
that writes* — it is a page load, and the write path is a POST that happens
strictly after the script has run. See residual 1.

### T3. Existing rows keep the keys they were written with

Nothing migrates devtwo's `2026-08-14`. Not a policy about this row in
particular: the per-user databases have no migration story at all (step-6a
ledger, residual 2), and `walks.day` is the primary key, so "fixing" it is an
INSERT plus a DELETE against data the friend created. The row stays wrong and
is a known artefact.

### T4. Dashboards are HANDED their day; nothing under `users/` asks a clock

`DashboardProps` gains `today: string` and `timeZone: string | undefined`,
resolved once per request by `app/[user]/page.tsx`.

Fixing devtwo fixes today; this is what fixes tomorrow. There will be three
bespoke dashboards and then more, each written fresh against a spec by somebody
who has not read this file, and every one of them will need "what day is it".
The rule has to hold at sites that do not exist yet, which no assertion inside
one user's own tests can reach — so `tests/users/noLocalDay.test.ts` sweeps
every user folder and both scaffold templates, in the shape
`tests/spec/sandbox.test.ts` established.

**Amended before the build, because the first draft of the sweep contradicted
T5.** The draft banned `users/*/queries.ts` from importing `lib/time/dayKey` at
all, while T5 required exactly that call. The ban was aimed at the wrong thing:
**the bug is asking a clock what day it is, not running the formatter over a
stored timestamp.** Converting stored instants to the friend's day is something
every finance dashboard will legitimately do. So the sweep forbids:

1. `Date.now()` anywhere under `users/`.
2. Zero-argument `new Date()` anywhere under `users/` — the same clock read
   wearing a different hat, and a hole the first draft left wide open.
   `new Date(row.at)` and `new Date(y, m, d)` stay legal.
3. Importing `lib/time/dayKey` **in `dashboard.tsx` only**.

Rules 1 and 2 compose with rule 3 to close the dodge: `queries.ts` may hold the
formatter, but it has nothing to feed it except stored data.

### T5. devone's month is fixed by filtering, not by a zone→instant helper

Converting "start of this month in zone Z" to epoch milliseconds is the
genuinely hard direction — it needs the zone's offset at a local midnight that,
on a spring-forward date, does not exist. It is avoidable: widen the SQL window
by two days either side, and filter precisely in JS on
`dayKey(t.at, tz).slice(0, 7)`. Correct at any offset, no new helper, and
irrelevant to performance at pilot scale.

devone is in scope at all only because it is the file people read when they
write the next dashboard.

### T6. One name, everywhere: `dayKey`

An earlier draft of the plan said `zonedDayKey` in one paragraph and `dayKey`
in the tasks. The existing export keeps its identity — Task 1 changed its
signature, not its name — so the walk route, the tests and the sweep's rules
all talk about the same function.

---

## Built

- `lib/time/dayKey.ts` — `dayKey(at, timeZone)` via
  `Intl.DateTimeFormat('en-CA', { timeZone })`, which yields zero-padded
  `YYYY-MM-DD` directly; `isValidTimeZone`; degrades to UTC, never throws.
- `app/layout.tsx` — the inline script writes `stairwell_tz` beside
  `stairwell_dc`, URL-encoded because an IANA name contains a slash.
- `lib/metrics/deviceClass.ts` — `TIME_ZONE_COOKIE`, `readTimeZone()`.
- `app/api/users/[user]/walk/route.ts` — stores the day in the friend's zone.
- `lib/dashboard/contract.ts`, `app/[user]/page.tsx` — `{ slug, db, today,
  timeZone }`, resolved once per request.
- `users/devtwo` — consumes `today`; `dayKeyOf` unexported, surviving as a
  private helper for `shift()`, which constructs and formats in ONE zone and is
  therefore pure calendar arithmetic that never reads a clock.
- `users/devone` — `monthWindow` + a precise JS filter;
  `recentTransactions(db, timeZone)` attaches the day, because `dashboard.tsx`
  may not import the formatter at all.
- `platform/templates/dashboard/*` — the scaffold hands `today` through, so a
  new dashboard starts correct rather than inheriting the bug from the file it
  was copied from.
- `tests/users/noLocalDay.test.ts` — the sweep.
- `tests/routing/layoutScript.test.tsx` — new, see below.

## What the drills caught

**A guarded line with nothing guarding it.** Deleting the timezone line from
the layout script reddened not one test. Every other test mocks `next/headers`
and sets the cookies directly, so the whole read path stayed green over a
server that would never receive a zone again — and every tap would quietly go
back to being filed on the droplet's day. `tests/routing/layoutScript.test.tsx`
exists because of that drill.

**A sweep that stopped sweeping.** Removing `queries.ts.tmpl` from the tree left
the sweep green: its vacuity guard asserted "at least one template", and
`dashboard.tsx.tmpl` satisfied it while the other went uncovered. The scaffold
is exactly where a new dashboard inherits its habits, so it now asserts every
shipped file by name.

**A sweep that forbade its own explanation.** The first run flagged the comment
in `users/devtwo/queries.ts` describing the bug — the one place that
documentation belongs. The sweep now strips comments before matching: it asks
whether the code CALLS a clock, and a comment is not a call.

**Two tests that were agreeing with the bug.** `tests/time/dayKey.test.ts` said
in its own comment that at UTC "neither instant can diverge — the two equality
checks above are the only assertions this test can make in that environment."
The droplet is UTC. `users/devone/tests/dashboard.test.ts` built its expected
string from the fixture's own local calendar components so it would "pass in
every timezone", and admitted it could not redden on a UTC host. Both were
faithful to what the code did; what the code did was the bug. Both are now one
instant in two zones producing two different days — an assertion no
clock-reading implementation can satisfy, and one that means the same thing on
every machine that runs it.

---

## Residual risks

1. **The first render of a session falls back to UTC.** Inherent, per T2: the
   server builds the first page before the script that writes the cookie has
   run. Bounded — it costs one render, at most one day of skew, on a page that
   writes nothing. `tests/routing/dashboardRegion.test.ts` pins the fallback so
   it is a known behaviour rather than an accident.

2. **Existing rows keep the keys they were written with.** Per T3. devtwo's
   `2026-08-14` stays. If a friend's data ever needs a day corrected, that is a
   deliberate one-off against their encrypted database, made with their
   password, not a migration.

3. **There is no zone override.** The cookie always wins and is re-detected on
   every page load, so a friend who travels moves to the new zone with no way
   to say otherwise, and a friend on a laptop set to the wrong zone gets the
   wrong day with no recourse but to fix the laptop. That is the right default
   for a morning-ritual tracker and it is not obviously right for everyone. If
   a "pin my zone" need appears, the insertion point is `readTimeZone`:
   override entry first, cookie as the fallback. Not built now, and named here
   so whoever needs it does not have to rediscover where it goes.

4. **The two-day widening in `monthWindow` is a constant, not a derivation.**
   It covers UTC offsets from −12 to +14 with room to spare, which is every
   offset that exists. It would stop being enough only if IANA shipped an
   offset beyond ±48 hours, which is not a thing. Recorded because a constant
   with a reason is a constant somebody can safely leave alone, and
   `users/devone/tests/queries.test.ts` asserts the widening directly so
   "tidying" it into an exact month range fails rather than silently dropping a
   friend's boundary transactions.
