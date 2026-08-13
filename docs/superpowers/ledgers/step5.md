# Step 5 ledger — per-user dashboard hosting

Spec: `docs/superpowers/specs/2026-08-12-step5-dashboard-hosting-design.md`
Plan: `docs/superpowers/plans/2026-08-12-step5-dashboard-hosting.md`
Branch: `step5-dashboard-hosting`, 19 commits, `a2e0ec9..b8e59ba` (base `a2e0ec9` on `main`)

## Built

Nine implementation tasks, executed subagent-driven with a task review after
each. All four verification layers were run fresh for this ledger, not
recalled from earlier task reports: `npx vitest run` — 569 tests passed, 53
files, 0 failed; `npx tsc --noEmit` — silent, exit 0; `npx next build` —
succeeded, 12 routes generated; `.claude/hooks/test-hooks.sh` — 158/158.

The harness count is worth flagging rather than smoothing over: the plan's
own Task 10 brief predicts "harness 156/156," but the actual run is 158/158.
This is not a layer disagreeing with another — it is the brief's number going
stale mid-branch. Task 8 added a `users/*` catch-all Gate B arm and widened
guard coverage, and its own ledger entry already records "Harness 158/158,
vitest 569/569" after that change landed. The brief was written before Task 8
ran and was never updated; the 158 this ledger reports is consistent with
every task report since Task 8, not a new discrepancy.

`openUserDb` resolves a slug to a read-only synthetic SQLite handle with
a process-wide cache; `lib/dashboard/registry.ts` hand-maps slugs to dashboard
modules behind `Object.hasOwn`; `app/[user]/page.tsx` calls the registered
dashboard as a plain function inside a `try`/`catch` so a per-user throw
degrades to a message instead of a 500, with the chat surface rendered
outside that boundary so it survives; `users/devone/` ships as the worked
reference (schema, seed, queries, dashboard component, tests); a conventions
sweep (`tests/users/conventions.test.ts`) checks every folder under `users/`
against the shared shape; `scripts/regen-synthetic.ts` and
`scripts/new-dashboard.sh` scaffold and regenerate per-user databases; Gate B
now guards every file directly under `users/`, not just three extensions.

**Six rulings were made while writing the spec or during execution:**

1. **The registry lives in `lib/dashboard/registry.ts`, not under `users/`.**
   `users/<slug>/` holds only that user's own things; `lib/` is a scope Gate B
   already guards, so a forgotten registry line fails the same pre-commit
   check that guards everything else in `lib/`.
2. **`devone` is the reference dashboard; `devtwo` is deliberately left
   empty.** `devtwo` is the checkpoint account (see step-4 ledger) and must
   render the not-yet-built state so the checkpoint has something real to
   observe, not a second worked example.
3. **`dashboard_open` metrics are pulled forward from step 7.** Step 5 is the
   first moment a dashboard can be opened at all, and a retention row not
   written today does not exist later — waiting for step 7's dedicated
   metrics task would silently lose every open between now and then.
4. **No `source: 'real'` branch.** Step 6 owns it, and must add its OWN opener
   rather than extend `openUserDb` — `openUserDb`'s process-wide cache is
   correct only for a read-only file that changes at deploy, and a live
   encrypted database does not have that property.
5. **No schema-module include mechanism.** `modules/` stays empty until
   step 6's Plaid integration gives it a second real user to generalise a
   shared shape from; building one now would be designed against a sample
   size of one.
6. **The plan's own conventions-sweep code was amended during execution.**
   `readdirSync` lists dot-prefixed directories, so the plan's third
   guard-drill (rename `users/devone` to `users/.hidden-devone`, confirm the
   sweep still finds a user folder) was unrunnable as written — the sweep
   would have counted the dot-directory as a user. Fixed by filtering `slugs`
   through the `SLUG_PATTERN` that `lib/auth/slug.ts` already owns: an account
   slug can never be dot-prefixed, so anything else under `users/` is not a
   user. This closed the unrunnable drill AND stopped a stray directory from
   being swept as if it were a real user folder.

## What the review layer caught

Worth recording because it is the argument for keeping it: **reading the code
and finding it convincing caught one of these six.** The other five needed
either deleting the guarded behaviour and watching for a red test, or a
reviewer checking a claim against the actual test body.

- **The `ORDER BY at DESC, id DESC` tiebreak.** Round 1 added a same-timestamp
  test; re-review found it could only detect an INVERTED order, not a DROPPED
  clause — because `transactions_at` indexes `(at)`, stored as `(at, rowid)`,
  so a reverse index walk for `ORDER BY at DESC` already yields ties in
  rowid-descending order with no `ORDER BY` at all. `EXPLAIN QUERY PLAN`
  confirmed both forms resolve to the identical index scan. Undetectable by
  removal while that index exists; the comment was corrected to say so
  rather than the query being changed.
- **The conventions sweep's "finds at least one user folder" guard.** The
  plan's own drill for this guard — renaming `users/devone` to a dot-prefixed
  name and confirming the sweep still passed — could not be run, because
  `readdirSync` returns dot-directories and the ungated sweep would have
  counted it anyway. This is ruling 6 above; caught while executing the
  drill, not by inspection beforehand.
- **`regenSynthetic`'s slug-naming assertion.** Asserted `toThrow(/broken/)`
  against a generator that fails. Passed for the wrong reason:
  `execFileSync`'s own error message happens to contain the temp directory
  path, which contains the slug — the test never exercised the wrapper's own
  slug-naming, it was satisfied by a coincidence of Node's own error text.
  Caught by the implementer's own guard-deletion drill.
- **`regenSynthetic`'s sort-order assertion.** A test asserting folders are
  processed "in sorted order" passed with the `.sort()` call deleted, because
  APFS's `readdirSync` already returns entries alphabetically on this
  filesystem — the test's own oracle was doing the sorting, not the code
  under test. Fixed with a scoped `vi.mock` over one `readdirSync` call so
  the assertion depends on the code, not the filesystem.
- **`regen-synthetic.ts`'s header comment.** Claimed `noCross.test.ts` pinned
  this script's separation from the platform database. That test in fact
  covers different, sibling helpers in `tests/support/synthetic.ts` — not
  this script. Caught by review checking the claim against the named test's
  actual body, not by running anything.
- **The scaffold test asserting only `existsSync`.** The final assertion in
  the Task 7 scaffold test claimed to apply the conventions sweep to a freshly
  scaffolded folder, but only checked that the database file existed.
  `sqlite3.connect` satisfies `existsSync` by creating a 0-byte file before
  running a single statement — the test could not have failed even if the
  scaffold wrote nothing at all. Caught by review, not by a drill.

**The conclusion, stated plainly: reading the code and finding it convincing
caught one of these six.** The other five needed either deleting the guarded
behaviour and watching a test go red, or a reviewer checking a specific claim
against a specific test body rather than trusting the test's name or the
comment describing it. All six read as correct on a first pass — that is
what makes them worth recording, not that they were exotic.

**Three commit-message inaccuracies are permanent record, not corrected in
history:**

- **`a104de3`** claims all three of its guard deletions "each redden exactly
  one test." Guard 2 reddened none. The message stands; this line is the
  correction.
- **`5d4fd8f`** bundles two fixes (the slug-naming assertion above, plus a
  second, unprompted fix to the sort-order assertion above) but its message
  describes only the first. Flagged by the implementer rather than silently
  rewritten. The message stands; this line is the correction.
- **`3da6069`** is not on this list for the same reason — it was AMENDED to
  `c312a6f` before being pushed anywhere, so there is no public history to
  correct. Its wrong claim ("moving the Gate B arm reddens only one case,"
  when it reddened three) was fixed in place, which is why it is noted here
  as a contrast rather than logged as a permanent inaccuracy.

## Residual risks

1. **A dashboard's queries are per-user code.** The conventions sweep proves
   every folder under `users/` has the right shape (schema, seed, queries,
   dashboard, tests) — it does not and cannot prove any individual query is
   correct. Only that user's own tests cover their own queries.
2. **`users/devone/seed.py` produces clock-relative timestamps.** Nothing
   asserts against its output, by design — a test that pinned exact values
   would be flaky by construction. The file's own comment says so.
3. **The `dashboard_error` degrade has never been seen in a browser.** It is
   exercised only by a test with an injected throw. The catch, the metric
   write, and the fallback paragraph are trace-verified, not eyeball-verified.
4. **`openUserDb` is called OUTSIDE `dashboardRegion`'s `try`/`catch`** in
   `app/[user]/page.tsx` — the call happens before the `try` block opens, not
   inside it. A corrupt `synthetic.db` therefore throws uncaught and 500s the
   whole page, including the chat surface the catch exists specifically to
   protect. Matches the brief and the design doc's stated scope ("the
   dashboard render is wrapped"), so this is not an implementer deviation —
   but it means the "chat always survives a dashboard failure" guarantee
   covers component throws only, not data-layer opens. Revisit before step
   6's encrypted opener, which introduces a second, less predictable way for
   a per-user database open to fail.
5. **The page's `try`/`catch` covers only the direct `Dashboard({...})` call**
   — `dashboardRegion` calls the dashboard component as a plain async
   function specifically so its body runs inside the catch. A dashboard that
   instead composed NESTED React function components (returning `<Foo />`
   rather than calling `Foo()` directly) would have those nested bodies
   deferred to Next's own render pass, which runs after this function
   returns and therefore outside the catch. Inherent to how React defers
   component execution; not something this task's code can close, only avoid
   triggering — `users/devone/dashboard.tsx` does not compose nested
   components today.
6. **CLOSED by `82bb90f` (step 6a, Task 3).** ~~`dashboard_error` stores
   `error.message` verbatim in append-only metrics.~~ No scrubbing existed.
   Fine while every dashboard read synthetic data only; this residual named
   the exact trigger — "before step 6 puts a real per-user database behind
   this same catch" — and step 6a then introduced that leak, in a fix
   dispatched mid-task, at precisely the predicted moment. `dashboard_error`
   now carries `{slug, kind}` with `kind` a closed `'wrong_key' | 'error'`,
   derived with `instanceof`. Pinned by a policy test that plants a fake
   account number in an error message and asserts it appears nowhere in the
   raw stored column. **A reviewer found it by reading this ledger and
   checking whether the prediction had come true** — not by reading the
   diff, which looked correct.
7. **Step-4 residual 8 is unchanged.** `devone` and `devtwo` remain live
   production logins with published passwords (`docs/local-dev.md`), and as
   of this step one of them — `devone` — has a real dashboard behind it, not
   just a chat surface. Still synthetic data only; should still close before
   a real user account exists.
8. **The reserved-slug list is duplicated in `scripts/new-dashboard.sh`**
   because bash cannot import the `RESERVED_SLUGS` Set that
   `lib/auth/slug.ts` owns. Two of the six entries, `_next` and
   `favicon.ico`, can never actually be reached by the script's own reserved
   check — the charset check (`case "$slug" in *[!a-z0-9-]*)`) runs first and
   rejects the `_` and `.` characters those two names contain before the
   reserved-word check ever sees them. The script functions correctly (those
   slugs are still rejected, just by the earlier check), but the code
   comment above the reserved-word check ("Mirrors RESERVED_SLUGS... keep the
   two lists in step") does not say that two of the six mirrored entries are
   dead branches. Noted for final-review triage in the Task 7 report; carried
   here unfixed.

## The step-5 checkpoint

**The step-5 checkpoint does not close in this step.** It needs `devtwo`'s
confirmed spec, which needs step 4's checkpoint to have been run by a human —
that has not happened yet as of this ledger. What ships here is the mechanism
and one worked example (`devone`), not the second dashboard the checkpoint
needs to prove isolation between two REAL dashboards rather than one
dashboard and one placeholder.

When a confirmed spec exists for `devtwo`, the exact sequence that closes it:

```bash
./scripts/pull-spec.sh devtwo
./scripts/new-dashboard.sh devtwo
# build toward users/devtwo/mockup.html
# add the registry line to lib/dashboard/registry.ts
npm run synthetic
npx vitest run
# deploy
```

**What IS observable today, confirmed directly rather than through a
browser:**

- `npm run synthetic` regenerated `users/devone/synthetic.db`; a direct
  `sqlite3` query against it (`SELECT count(*) FROM transactions`) returned
  177 rows. `users/devtwo/` does not exist as a folder at all — confirmed
  with `ls users/`, which is the expected state for ruling 2 above.
- The registry (`lib/dashboard/registry.ts`) maps only `devone`; requesting
  any other slug's dashboard falls through to `dashboardLoaderFor` returning
  `undefined`, which `dashboardRegion` renders as "Nothing here yet."
- Every guard and boundary above (the try/catch, the `Object.hasOwn` lookup,
  the 404-not-403 on cross-account access) is exercised by the automated
  suite: 569 passing tests, none of them a browser test.

**No human has yet opened any of this in a browser.** This ledger does not
claim to have seen a banner, a panel, or a "Nothing here yet" message
rendered — only that the code paths producing them are covered by tests and
that the underlying data exists. The brief's Step 3 (log in as `devone`,
observe `/devone`; log in as `devtwo`, observe `/devtwo`; confirm each 404s
on the other's URL) has not been performed by anyone and is not claimed here.
That walkthrough, plus `devtwo`'s spec-confirmation, is what closes this
checkpoint.

## Deferred, accepted

- The reserved-slug duplication between `lib/auth/slug.ts` and
  `scripts/new-dashboard.sh` (residual 8) — bash cannot import a TypeScript
  `Set`, and restating a six-entry list by hand is the accepted cost.
- `declaredObjects()`'s SQL comment-stripping (added during the Task 5 fix
  round) is not string-literal aware — a `--` inside a quoted default value
  would truncate a line early. No schema in the repo triggers this today.
- ~~The inline declared-tables regex in `newDashboard.test.ts` does not strip
  `--` comments~~ — **closed in the fix wave.** `declaredObjects` was
  extracted to `tests/support/declaredObjects.ts` and both files import it,
  so the two copies cannot diverge again.
- `${t.at}-${t.merchant}` as a React key in `users/devone/dashboard.tsx`
  cannot collide under today's `seed.py` (one row per merchant per day), but
  that is arithmetic luck from the generator's spacing, not a guarantee the
  key itself provides.
- Category values (`'eating out'`, `'groceries'`, `'housing'`) carry no
  `TEST` marker, unlike merchant names. Judged acceptable: a taxonomy label
  reads identically whether the underlying data is real or synthetic, so the
  loud-fake rule was judged to attach only to values that could be mistaken
  for real account activity.
- `tests/deploy/deployScript.test.ts` pins script ordering with `indexOf`
  over the raw script text, so a match sitting inside a comment would satisfy
  it. Pre-existing idiom, accepted rather than fixed here — **except for the
  `npm ci` assertion added in the fix wave**, where exactly that happened and
  the assertion is now an anchored regex. See the fix wave below.

---

## The fix wave — what the whole-branch review found

The branch was reviewed end to end at `6df2f67` before merge. The security
trace came back clean: the slug that reaches the filesystem is always the one
`canSeeUserSpace` authorised, re-validated against `SLUG_PATTERN` before any
filesystem call; the lock opens no database for a locked session and its test
asserts on the *calls* rather than the markup, so it stays honest when step 6
adds the key; no database is committed beyond the `fake-real.db` decoy;
nothing anywhere opens a non-synthetic database; and `dashboard_open` and
`dashboard_error` cannot both be written for one request.

Twelve findings were applied in three commits (`f47fba7`, `40b808a`,
`3364b3a`). Two were more than cleanup:

**A locale bug that would have accepted an invalid slug.**
`scripts/new-dashboard.sh`'s `case "$slug" in *[!a-z0-9-]*)` is a *collation*
range, not a codepoint range. Measured: under `LC_ALL=en_US.UTF-8` it
accepted `Devone`, `DEVONE` and `aÉb`; under `LC_ALL=C` it rejected all
three. No traversal resulted — `/`, `.`, `\`, `&`, `$`, `;` and space are
rejected in every locale — but `users/Devone/` would have been created and
then swept by nothing, and `newDashboard.test.ts`'s `DEVTHREE` assertion
would have failed on a collating host, aborting the deploy at the vitest
gate. Closed with `export LC_ALL=C` in the script itself, so the pin does not
depend on the droplet's environment. The comment claiming the check was "the
same rule as `SLUG_PATTERN`" now says the equivalence holds *because*
collation is pinned.

**A test that would have blocked every future deploy.** The wave fixed a real
inconsistency — `users/devone/dashboard.tsx` rendered dates in UTC while
`queries.ts` bucketed months by the local calendar — and the test added to
pin it passed only west of Greenwich. Under `TZ=UTC` and `TZ=Asia/Tokyo` its
own vacuity guard failed, because there the local and UTC dates for the
fixture are the same string. No timezone is pinned anywhere in this repo and
DigitalOcean images normally run UTC, so `deploy/deploy.sh`'s vitest gate
would have reddened on the droplet permanently, for reasons unrelated to
whatever was being deployed. The wave's own green run was green only because
the machine running it sits at `America/Chicago`.

Fixed in `eb1fce0` by building the expected string from the fixture's own
local calendar components and checking both ends of a local day. Verified
under three timezones. **The limit is recorded in the test itself:** reverting
`day()` to `toISOString()` reddens it wherever the offset is nonzero and
cannot redden it at UTC, because there the two renderings are identical. That
was observed, not assumed.

**Two more claims that outran their evidence**, bringing this branch's total
to nine:

- `tests/db/userDb.test.ts`'s `closeUserDbs releases handles` asserted only
  that a later open returned a different object — true whether or not
  `close()` ever ran, since `new Database()` always returns a fresh object.
  Deleting the `db.close()` loop left it green while every `afterEach` leaked
  a file descriptor. Now asserts `.open === false`.
- The `npm ci` ordering assertion added *during* the wave used a naive
  `indexOf('npm ci')`, which matched an earlier comment in `deploy/deploy.sh`
  and was permanently vacuous. Caught by its own drill and rewritten as an
  anchored regex.

A ninth was self-caught by the implementer mid-drill: a `toContain` per
boundary instant could not discriminate which transaction produced a date
string, since both boundary instants share a local date. Each expected date
is now paired to its own merchant.

**The tally for the branch: nine claims that asserted more than the code
delivered. Five caught by deleting the guarded behaviour, three by review,
one self-caught mid-drill.** None was caught by reading the code and finding
it convincing — every one of them was convincing.

## Verification at merge

Run against `eb1fce0`, all four layers, by the controller rather than
reported second-hand:

| Layer | Result |
|---|---|
| `npx vitest run` | 571 passed, 53 files |
| `TZ=UTC npx vitest run` | 571 passed, 53 files |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx next build` | succeeded, 12 routes |
| `.claude/hooks/test-hooks.sh` | 158/158 |
| `git ls-files` databases | `fake-real.db` only |

---

## Checkpoint result, 2026-08-13

Run by Nico against `app.stairwell.run` after the deploy of `8117b6e`.

**Passed, all five:** `/devone` renders the reference dashboard under the
SYNTHETIC DATA banner; `/devtwo` renders the not-built placeholder; each account
gets a 404 (never a 403) on the other's URL; `/admin` lists both users and
renders `devtwo`'s confirmed spec and mockup; `/devone` 404s for the admin.

**The build half does not close here.** "Nico builds `devtwo`'s dashboard from
`devtwo`'s confirmed spec" now waits on step 6a — see below.

## What the first real use found

Three defects, none of which any suite could have caught, all in code paths no
human had walked. Recorded here because the pattern is the point: every one sat
behind a claim that had been written down and believed.

1. **The spec authoring call could never run.** Non-streaming at 32000
   `max_tokens`, which the SDK refuses outright. Full account and the correction
   are in `step4.md`. Fixed in `65a4cd3`.
2. **`pull-spec.sh`'s droplet path had never been run.** A non-interactive ssh
   loads no profile and no `EnvironmentFile`, so `PLATFORM_DB` was unset and
   `export-spec.ts` fell back to the SYNTHETIC database on the production box.
   It failed loudly only by luck — `platform/dev/` is absent from the droplet's
   checkout, because git will not create a directory whose only contents are
   gitignored. With that directory present it would have written synthetic rows
   into `users/<name>/spec.md` as a real confirmed spec. Fixed in `83a7cc2`,
   pinned by a static scan whose own first two versions measured the wrong
   thing.
3. **An admin had no way to log out.** Step 4 removed the admin's user space,
   and `app/[user]/page.tsx` was the page carrying the control. Nothing asserted
   that a signed-in admin can sign out — the admin tests covered who may *see*
   the portal, never what it lets you *do*. Fixed in `8117b6e`. Same shape as
   residual 1: coverage of the guard, none of the affordance.

## What the conventions sweep learned

`tests/users/conventions.test.ts` rejected the documented workflow at the exact
moment it was followed: `pull-spec.sh` writes `spec.md` and `mockup.html` into a
folder that does not exist yet, and the sweep demanded all five required entries
of it. A user folder now has three states — pulled (contract files only,
allowed), built (all five, swept in full), partial (a defect, named with what is
missing) — plus a guard that at least one BUILT dashboard is swept, so a tree of
pulled-only folders cannot report all-green having run none of the work.

## Step 6 split, and why

`devtwo`'s confirmed spec is a manual-logging tracker whose primary control is a
tap. Step 5 shipped a deliberately read-only data layer, so the first real
dashboard needs a write path before it is what it claims to be. Writing to
`synthetic.db` was rejected twice over: `deploy.sh` regenerates it on every
deploy, and real taps sharing a file with loudly-fake seeded rows breaks the rule
that any screen reads instantly as fake or real.

Ruled by Nico: **6a** is the encrypted per-user data layer plus the first write
path; **6b** is Plaid as scheduled. Encryption therefore lands before the first
real byte rather than after it, which is the only ordering the onboarding promise
supports. `architecture-overview.md`'s build order carries the split.
