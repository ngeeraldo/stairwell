# The Friend's Day, Not the Server's — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A day means the day the friend is living, not the day the droplet is having.

**Architecture:** The friend's IANA timezone reaches the server the same way `device_class` already does — a cookie written by the inline script in the root layout. `dayKey` takes that zone and formats with `Intl.DateTimeFormat`, needing no dependency and no schema change. Every dashboard is then *handed* its day rather than deriving one, which is what stops this recurring once there are three friends and three bespoke dashboards.

**Spec:** This message, plus the evidence: the droplet is UTC (`timedatectl`), and `devtwo`'s only tap — made on the evening of 13 Aug — is stored as `2026-08-14`.

## Global Constraints

- **No schema change and no migration.** `walks.day` stays a `YYYY-MM-DD` primary key. Step-6a residual 2 stands: there is no migration story for a real `<slug>.db`, and this must not need one.
- **No new dependency.** `Intl.DateTimeFormat` is in Node and does all of it.
- **The cookie is untrusted input.** An unrecognised timezone falls back to UTC, exactly as an unrecognised `device_class` falls back to `desktop`.
- **Existing rows are never re-bucketed.** They cannot be — `day` is the primary key of a database with no migration path — and they must not be silently reinterpreted either.
- **Test with `npx vitest run`.** `npx tsc --noEmit` and `npx next build` before any commit touching a component. Screens re-shot and reviewed per onboarding ledger D16.
- Branch `friend-timezone`, cut from `main`.

---

## What is actually broken, and where

Three places turn a clock into a calendar unit, all of them in the **server's** timezone:

| Where | What it derives | Impact |
|---|---|---|
| `lib/time/dayKey.ts`, via the walk route | the `day` a tap is stored under | **The bug.** A tap at 21:00 UTC−4 is stored as tomorrow. |
| `users/devtwo/dashboard.tsx:14` | `today`, for streak / 30-day / 14-day | **The bug, again.** The read disagrees with the friend's calendar. |
| `users/devone/queries.ts` `monthRange` | the calendar month to total spend over | Same class, no real impact — devone is a reference dashboard on a dev account. |

`dayKey`'s own docstring says it uses local time rather than UTC because "a tracker whose unit IS the day cannot afford that ambiguity" — and it is right, but *local* there is the server's. It fixed a bug **inside** one process and left the one **between** the friend and the process. `devtwo`'s stored row is the first evidence of it in the wild.

Note what is **not** broken: `shift()` in `users/devtwo/queries.ts` constructs and formats in the same zone, so it is pure calendar arithmetic and is correct whatever that zone is. It stays.

---

## Decisions, flagged

### T1. The zone travels in a cookie, not in the account

The client is the only thing that knows its zone, and it already tells the server one thing this way: `stairwell_dc`. Adding `stairwell_tz` beside it is one line in a script that already exists, and needs no table.

Storing it on the account was the alternative. Rejected: `accounts` has no additive-migration mechanism (the same problem `wrapped_key` had, which is why `account_keys` is its own table), and a stored zone raises a "which wins when they travel" question that a cookie answers by construction — a friend who moves is in a new day, which is the honest reading for a morning-ritual tracker.

### T2. The first render of a session falls back to UTC, and that is inherent

The cookie does not exist until the layout's script has run once. So the very first response of a brand-new session computes `today` in UTC.

This cannot be fixed from the server — it cannot know the zone before the client says so — and it is not worth a round trip to avoid. A friend's first render is the one where they have no logged data at all. Documented, and the fallback is explicit rather than accidental.

### T3. Existing rows keep the keys they were written with

`devtwo`'s single row stays `2026-08-14` even though that instant was the 13th where you were. It cannot be moved: `day` is the primary key of a database that has no migration story, and re-deriving it would need the zone at the moment of a tap that has already happened.

One row, one dev account, no real user. Stated in the ledger so nobody later reads it as a bug in the fix.

### T4. Dashboards are HANDED their day; nothing under `users/` may ask a clock

`DashboardProps` gains `today: string` and `timeZone: string`, computed once per request. `users/devtwo/queries.ts` stops exporting `dayKeyOf`, so no dashboard can call it with a clock reading.

This is the part that stops the bug recurring. There will be three bespoke dashboards, then more, each written fresh — and every one of them will need "today". A sweep test (Task 3) enforces it at sites that do not exist yet, in the spirit of `tests/spec/sandbox.test.ts`.

**Amended before the build, because the first draft of the sweep contradicted Task 4.** It banned `users/*/queries.ts` from importing `lib/time/dayKey` at all — while Task 4 has `devone/queries.ts` calling exactly that to bucket a month. The ban was aimed at the wrong thing. **The bug is asking a clock what day it is, not running the formatter over a stored timestamp**, and converting stored instants to the friend's day is something every finance dashboard will legitimately do. So the sweep forbids:

1. `Date.now()` anywhere under `users/`.
2. **Zero-argument `new Date()`** anywhere under `users/` — the same clock read wearing a different hat, and a hole the first draft left wide open. `new Date(storedTimestamp)` and `new Date(y, m, d)` stay legal; only the no-argument form is a clock.
3. Importing `lib/time/dayKey` **in `dashboard.tsx` only**. A dashboard receives its day; `queries.ts` may call `dayKey(storedTimestamp, timeZone)` freely.

Rules 1 and 2 compose with rule 3 to close the obvious dodge: `queries.ts` may import `dayKey`, but it has no way to hand it a clock reading.

### T5. `devone`'s month bucket is fixed by filtering, not by a zone→instant helper

Converting "start of this month in zone Z" to epoch milliseconds is the genuinely hard direction — it needs the zone's offset at a local midnight that may not exist. It is avoidable: widen the SQL window by two days either side and filter precisely in JS on `dayKey(t.at, tz).slice(0, 7)`. Correct at any offset, no new helper, and irrelevant to performance at pilot scale.

**devone is the file people copy when a new dashboard is scaffolded**, which is the only reason this is in scope at all.

---

## File Structure

**Modified**

| Path | Change |
|---|---|
| `lib/time/dayKey.ts` | `dayKey(at, timeZone)`; `isValidTimeZone`; the docstring's origin story extended. |
| `lib/metrics/deviceClass.ts` → `lib/request/client.ts` | *(No — see Task 1: the reader is added beside `readDeviceClass`, not moved. Renaming a module the whole branch just started citing buys nothing.)* |
| `app/layout.tsx` | The inline script writes `stairwell_tz` alongside `stairwell_dc`. |
| `app/api/users/[user]/walk/route.ts` | Stores the day in the friend's zone. |
| `lib/dashboard/contract.ts` | `DashboardProps` gains `today` and `timeZone`. |
| `app/[user]/page.tsx` | Computes both once and passes them through `renderDashboard`. |
| `users/devtwo/dashboard.tsx`, `users/devtwo/queries.ts` | Consume `today`; stop deriving it; `dayKeyOf` unexported. |
| `users/devone/dashboard.tsx`, `users/devone/queries.ts` | Month bucket in the friend's zone. |
| `platform/templates/dashboard/*.tmpl` | The scaffold hands `today` through, so a new dashboard starts correct. |

**New**

| Path | Responsibility |
|---|---|
| `tests/users/noLocalDay.test.ts` | The sweep: nothing under `users/` asks a clock what day it is. |

**One name, everywhere: `dayKey`.** An earlier draft said `zonedDayKey` in one paragraph and `dayKey` in the tasks. It keeps the existing export name — Task 1 changes its signature, not its identity — so the walk route, the tests and the sweep's rules all talk about the same function.

---

## Task 1: The zone reaches the server

- [ ] **Step 1: Write the failing tests** (`tests/time/dayKey.test.ts`, extended)

```ts
// The case that motivated all of this: 21:03 on the 13th in New York is
// 01:03Z on the 14th, and the friend tapped on the 13th.
expect(dayKey(Date.parse('2026-08-14T01:03:39Z'), 'America/New_York')).toBe('2026-08-13')
expect(dayKey(Date.parse('2026-08-14T01:03:39Z'), 'UTC')).toBe('2026-08-14')

// East of Greenwich, the mirror image.
expect(dayKey(Date.parse('2026-08-13T22:30:00Z'), 'Asia/Tokyo')).toBe('2026-08-14')

// A DST transition does not shift the day it lands in.
expect(dayKey(Date.parse('2026-03-08T06:30:00Z'), 'America/New_York')).toBe('2026-03-08')

// Untrusted input falls back to UTC rather than throwing — a bad cookie must
// never be able to fail a tap.
expect(dayKey(Date.parse('2026-08-14T01:03:39Z'), 'Not/AZone')).toBe('2026-08-14')
expect(dayKey(Date.parse('2026-08-14T01:03:39Z'), undefined)).toBe('2026-08-14')

// And it is NOT the process's zone, whatever that happens to be — the
// assertion the old implementation could not make.
```

- [ ] **Step 2: Implement** — `dayKey(at: number, timeZone: string | undefined): string` using `new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)`, which yields `YYYY-MM-DD` directly. `isValidTimeZone` is a `try`/`catch` around constructing the formatter. Keep the existing docstring and extend it: the original bug was *inside* one process; this one is *between* the friend and the process, and `devtwo`'s stored row is the evidence.

- [ ] **Step 3: The cookie** — `app/layout.tsx`'s existing script gains one line:

```js
document.cookie='stairwell_tz='+encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')+';path=/;max-age=31536000;samesite=lax'
```

and `lib/metrics/deviceClass.ts` gains `readTimeZone()` beside `readDeviceClass()` — same cookie-then-fallback shape, same file, because they are the same mechanism and splitting them would hide that.

- [ ] **Step 4: Red-test control** — make `dayKey` ignore its `timeZone` argument → the New York and Tokyo cases go red. Remove the `try`/`catch` → the invalid-zone case goes red *by throwing*, which is the failure that must never reach a tap.

- [ ] **Step 5: Commit**

---

## Task 2: The write path stores the friend's day

- [ ] **Step 1: Write the failing test** (`tests/routing/walkRoute.test.ts`)

With `stairwell_tz=America/New_York` in the cookie fixture and the clock at `2026-08-14T01:03:39Z`, the inserted row's `day` is `2026-08-13`. With no cookie, `2026-08-14`.

- [ ] **Step 2: Implement** — the route reads the zone once (beside `readDeviceClass`, which it already does) and passes it to `dayKey`. One line each.

- [ ] **Step 3: Red-test control** — revert to `dayKey(Date.now())` → the New York case goes red.

- [ ] **Step 4: Commit**

---

## Task 3: Dashboards are handed their day

- [ ] **Step 1: Write the failing tests**

```ts
// tests/users/noLocalDay.test.ts — the sweep that outlives this branch.
//
// Every bespoke dashboard is written fresh, and every one of them needs
// "today". The rule has to hold at sites that do not exist yet, which an
// assertion inside any one user's tests cannot do — same reasoning as
// tests/spec/sandbox.test.ts.
//
// What it forbids, and what it deliberately allows (T4):
//
//  1. Date.now() anywhere under users/
//  2. zero-argument `new Date()` anywhere under users/ — the same clock read
//     in different clothes. `new Date(row.at)` and `new Date(y, m, d)` are
//     fine; only the no-argument form is a clock.
//  3. importing lib/time/dayKey in dashboard.tsx — a dashboard is HANDED its
//     day. queries.ts may import and call it: turning a stored instant into
//     the friend's day is legitimate, and every finance dashboard will do it.
//  4. the scaffold template obeys all three, so a new dashboard starts correct
//  5. at least one real user folder AND one queries.ts are swept, so neither
//     half is ever vacuous
```

Plus, in `tests/routing/dashboardRegion.test.ts`: the dashboard is called with a `today` matching the request's zone, not the server's.

- [ ] **Step 2: Implement** — `DashboardProps` gains `today: string` and `timeZone: string`, with `today` documented as authoritative (`timeZone` is only for units coarser than a day). `app/[user]/page.tsx` computes both once and threads them through `renderDashboard`, alongside `device_class` which it already threads. `users/devtwo/dashboard.tsx` takes `today` from props; `users/devtwo/queries.ts` stops exporting `dayKeyOf` and keeps it private to `shift`, with the comment explaining that `shift` is zone-independent *because* it constructs and formats in one zone.

- [ ] **Step 3: Red-test control** — have `devtwo/dashboard.tsx` derive `today` from `Date.now()` again → the sweep goes red. Pass the server's zone instead of the request's → the dashboardRegion case goes red.

- [ ] **Step 4: `npx next build`, then commit**

---

## Task 4: devone's month, in the friend's zone

- [ ] **Step 1: Write the failing test** — a transaction at `2026-09-01T02:00:00Z` counts toward **August** for a friend in `America/New_York`, and toward September in UTC.

- [ ] **Step 2: Implement** — `monthRange` widens its SQL window by two days either side and `eatingOutThisMonthCents` filters precisely on `dayKey(t.at, tz).slice(0, 7)`. Explain in the file why the widening is there rather than a zone→instant conversion (T5).

- [ ] **Step 3: Red-test control** — drop the JS filter → the boundary case goes red.

- [ ] **Step 4: Commit**

---

## Task 5: The living documents, and a look

- [ ] **Step 1** — `CLAUDE.md > Dashboard folder conventions`: a dashboard is handed `{ slug, db, today, timeZone }` and **never derives a day from a clock**; the sweep enforces it.
- [ ] **Step 2** — `architecture-overview.md` §2: the day is the friend's, not the server's, and the zone rides in a cookie beside `device_class`.
- [ ] **Step 3** — a ledger for this branch, carrying T1–T5 and three residuals:
  1. the first render of a session falls back to UTC (T2);
  2. existing rows keep the keys they were written with (T3);
  3. **there is no zone override.** The cookie always wins and is re-detected on
     every page load, so a friend who travels moves to the new zone with no way
     to say otherwise. That is the right default for a morning-ritual tracker
     and it is not obviously right for everyone. If a "pin my zone" need ever
     appears, the insertion point is `readTimeZone`: override entry first,
     cookie as the fallback. Not built now, and named so that whoever needs it
     does not have to rediscover where it goes.
- [ ] **Step 4** — `npm run shots -- --task=final`; review `s3-shell-dashboard` in particular, since devtwo's "today" line is the visible surface of all of this.
- [ ] **Step 5** — full verification: `npx vitest run`, `npx tsc --noEmit`, `npx next build`, `.claude/hooks/test-hooks.sh`.

---

## What only a human can check

**Tap "walked" on the deployed devtwo from your own phone, in the evening.** That is the whole bug, and it is the one thing no test here can perform: the suite fixes the clock and the zone, and the thing that was wrong was the relationship between a real phone and a real server. If the row lands on the day you are living, it works.

Worth doing **before** the `walk1` onboarding walk, since it is thirty seconds and it is the same code path a friend's first tap will take.
