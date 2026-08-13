# Step 5 — Per-user dashboard hosting + folder conventions

**Status:** design, approved to build. Written 2026-08-12.

Build-order row: `architecture-overview.md` line 149.

> | 5 | Per-user dashboard hosting + folder conventions (`schema.sql` / `seed.py` /
> `tests/` / `synthetic.db`) | Nico builds `devtwo`'s dashboard from `devtwo`'s
> confirmed spec via Claude Code; it deploys behind `devtwo`'s login; `devone`
> can't see it |

## 0. What this step is, and what it is not

Step 5 builds the **hosting mechanism and the conventions**: where a bespoke
dashboard's code, schema, generator, synthetic database and tests live, how the
platform finds them, how they get their data, and what stops one user's
dashboard from reaching another's.

It does **not** build `devtwo`'s dashboard. That dashboard is authored from
`devtwo`'s confirmed spec, and no confirmed spec exists — step 4 has never been
run by a human (step-4 ledger, and the checkpoint at its end). The checkpoint
above therefore cannot close in this step. That is expected and is not a reason
to delay the mechanism: once a spec lands, building a dashboard on top of what
this step ships is a folder, six files, and one registry line.

**Nothing here depends on step-4 runtime behaviour.** Step 4 wrote `spec.md` and
`mockup.html` into `users/<slug>/`; this step reads neither. The only coupling is
that both write into the same folder, and §3 keeps them non-overlapping.

### Step-4 dependencies to verify in tomorrow's manual test

Per Nico's instruction to name these explicitly rather than assume them:

1. **`./scripts/pull-spec.sh devtwo` creates `users/devtwo/` if it does not
   exist.** `writeSpecPair` calls `mkdirSync(dir, {recursive: true})`, so it
   does — but that is code-reading, not observation. If it turns out otherwise,
   `scripts/new-dashboard.sh` (§6) has already created the folder anyway, so the
   failure mode is cosmetic.
2. **A pulled `spec.md` / `mockup.html` pair does not collide with the files
   this step introduces.** Verified by name in §3; the two sets are disjoint.

Neither is load-bearing for anything below. Step 5's implementation stands alone.

---

## 1. The problem

`app/[user]/page.tsx` is one shared route serving every user. A dashboard is
**fully bespoke code per user** (architecture-overview.md, "System shape" — no
config palette; customizability is the thesis). So the route needs a way to
reach code that does not exist when the route is written, without:

- forking routing per user (a per-user `app/` folder duplicates every auth check
  and drifts the moment one copy is edited);
- resolving a module path from a URL segment (`import(\`../../users/${user}\`)`
  makes the URL a filesystem path — the exact shape the slug pattern exists to
  prevent, and it fails `next build` while `users/` is empty);
- putting user data logic in `lib/` (shared code that is not shared).

And the dashboard needs data: a per-user SQLite file, opened per request, with a
hard guarantee that user A's page cannot open user B's file.

---

## 2. Approaches considered

**A. Static registry in `lib/dashboard/registry.ts` (chosen).** One module maps
slug → `() => import('@/users/<slug>/dashboard')`. Explicit, typechecked,
statically analysable by the bundler, and a slug that is not a key gets no code
at all. Cost: one hand-edited line per user. A drift test (§7) makes a forgotten
line a red suite, not a silently blank dashboard.

**B. Convention-based dynamic import.** Zero bookkeeping, but the failure modes
are all runtime, the bundler builds a context over a directory that is empty
today, and it re-opens the "URL segment as path" question that
`lib/auth/slug.ts` closed. Rejected.

**C. A route folder per user under `app/`.** Rejected: it forks the auth
preamble per user.

**Registry location.** In `lib/`, not `users/`. `users/<slug>/` holds only that
user's things — consistent with "shared-module changes happen from repo root
only, never inside `/users/<name>/`". It also lands the registry inside a scope
the pre-commit gate already guards (`lib/*` → `tests/`), where `users/*.ts`
today classifies as *unguarded* and would ship untested.

---

## 3. Folder conventions

```
users/<slug>/
  schema.sql      REQUIRED  table + view shapes for this dashboard
  seed.py         REQUIRED  synthetic generator: python3 seed.py <target.db>
  queries.ts      REQUIRED  pure data functions over a UserDb — no JSX
  dashboard.tsx   REQUIRED  default-export async server component
  tests/          REQUIRED  at least one *.test.ts, run by the root vitest
  synthetic.db    generated, gitignored, never committed, never hand-edited
  spec.md         written by scripts/pull-spec.sh — optional, absent until then
  mockup.html     written by scripts/pull-spec.sh — optional, absent until then
  <slug>.db       step 6. Does not exist yet and is not read by anything here.
```

Five rules that make the convention mechanical rather than aspirational:

1. **`seed.py` applies `schema.sql`.** It reads the sibling file and `executescript`s
   it before inserting a single row. The generator therefore cannot declare a
   table shape of its own, and "schema.sql + seed.py in the same commit" stops
   being a thing anyone can honour incompletely: the shapes have exactly one
   source. Gate A (`.githooks/pre-commit`) already forces them into one commit;
   this makes them agree.
2. **`seed.py` takes its target as `argv[1]`** and writes nowhere else. This is
   the contract `tests/support/synthetic.ts:regenerateUser` already assumes, and
   `tests/support/noCross.test.ts` already pins in both directions.
3. **`queries.ts` holds every SQL statement; `dashboard.tsx` holds none.** Data
   logic is testable without React; the component is testable at the element
   level. This is the step-4 `ChatPanel` residual applied in advance: extracted
   pure functions were thoroughly tested while all nine of the component's
   call-site mutations survived. Both layers get tests here (§7).
4. **Every synthetic string is loudly fake** — `COFFEE PALACE TEST`. Enforced as
   far as a test can: §7's conventions test requires a `TEST` marker in the
   generated database.
5. **Nothing under `users/<slug>/` is shared.** A second user needing the same
   thing gets their own copy or it moves to `modules/`.

**Modules (`modules/plaid.sql` and friends) are deliberately out of scope.**
`schema.sql` is standalone; there is no include mechanism. The first shared
module arrives with Plaid in step 6, which is when its shape will be known from
two real users rather than guessed from zero. Building an assembler now would
be designing an interface with no implementations.

---

## 4. The data path

### 4.1 `lib/db/userDb.ts`

```ts
export type UserDb = Database.Database
export type DashboardData =
  | { source: 'synthetic'; db: UserDb }
  | { source: 'none'; db: undefined }

export function openUserDb(slug: string): DashboardData
export function closeUserDbs(): void   // test seam
```

- **Slug validated first.** `openUserDb` throws on anything that is not
  `SLUG_PATTERN`. The caller has already proved ownership, so this is
  defence in depth, in the one function that turns a slug into a filesystem
  path. `SLUG_PATTERN` moves out of `lib/auth/accounts.ts` into
  `lib/auth/slug.ts` and both import it — one definition, so the account
  validator and the path validator cannot drift apart.
- **Root:** `process.env.USERS_DIR ?? resolve(process.cwd(), 'users')`, matching
  `lib/db/platform.ts`'s `resolve(process.cwd(), 'platform/schema.sql')`. The
  systemd unit's `WorkingDirectory` is the repo root and
  `tests/deploy/service.test.ts` pins that. `USERS_DIR` exists for tests to
  point at a temp tree; it is **not** added to `deploy/required-env`, because
  unlike `PLATFORM_DB` its default *is* the correct production value —
  falling back is not a failure mode. A line in that file's "out of scope"
  block records the decision.
- **Read-only.** `new Database(path, { readonly: true, fileMustExist: true })`.
  A dashboard renders; it does not write. Enforced by the handle, not by
  convention.
- **Handles are cached per slug** in a module map, like `lib/db/instance.ts`.
  The file only changes at deploy, which restarts the process. A *failed* lookup
  is never cached, so a database created mid-session is picked up on the next
  request.
- **`source: 'none'`** when the file is absent. A user with no dashboard, or a
  dashboard whose synthetic database has not been generated, renders a
  placeholder — never a 500.

**Why there is no `'real'` branch yet.** Step 6 introduces `<slug>.db`,
SQLCipher-encrypted, keyed from the in-process keymap. A step-5 resolver that
selected "real" on mere file existence would open an encrypted file with no key
the day step 6 lands. Step 6 owns that branch. The `source` field exists now so
that adding it is a widening, not a retrofit, and so the banner below already
has something to key on.

### 4.2 Everything on screen is synthetic, and says so

When `source === 'synthetic'`, the page renders a banner above the dashboard:

> **SYNTHETIC DATA** — every number below is fake.

Not decoration. Until step 6 there is no other kind of data, and step 7's
privacy toggle is exactly this banner plus a source switch. The alternative —
an unlabelled page of `COFFEE PALACE TEST` rows — relies on the reader noticing
the merchant names.

### 4.3 The dashboard contract — `lib/dashboard/contract.ts`

```ts
export type DashboardProps = { slug: string; db: UserDb }
export type DashboardComponent =
  (props: DashboardProps) => ReactElement | Promise<ReactElement>
export type DashboardModule = { default: DashboardComponent }
```

A dashboard is a server component handed its own slug and an open handle to its
own database. It cannot obtain a handle to anyone else's, because it is never
given one and `openUserDb` is called by the page, not by the dashboard.

The props carry no `source` field and no undefined-`db` case: the page calls a
dashboard only when it has resolved a real handle, so the component has no
"what if there's no data" branch to get wrong. Step 6 widens this when there is
a second source to distinguish; adding a discriminant now would be a union with
one member.

### 4.4 `lib/dashboard/registry.ts`

```ts
const DASHBOARDS: Record<string, () => Promise<DashboardModule>> = {
  devone: () => import('@/users/devone/dashboard'),
}

export function dashboardLoaderFor(slug: string):
  (() => Promise<DashboardModule>) | undefined
```

`dashboardLoaderFor` guards with `Object.hasOwn`. A bare `DASHBOARDS[slug]`
lookup resolves `toString`, `constructor` and `valueOf` off `Object.prototype`
and hands back a function the page would then call as a module loader. The slug
pattern happens to exclude those three words today; that is a coincidence of two
unrelated rules, not a guarantee, and it is one accepted slug away from being
false. Tested with those exact keys (§7).

---

## 5. The page — `app/[user]/page.tsx`

The existing preamble is unchanged: `requireState` → `canSeeUserSpace` → 404 →
`accountIdFor` → chat panel + newest proposal. The data region below the chat
panel changes from a two-way branch to a four-way one:

| Session state | Registry | Synthetic db | Renders |
|---|---|---|---|
| `authenticated` (locked) | — | — | `Locked. Unlock to see your data.` (unchanged) |
| `unlocked` | no entry | — | `Nothing here yet. Your dashboard gets built from your interview.` (unchanged) |
| `unlocked` | entry | absent | `Your dashboard is built, but its data has not been generated yet.` |
| `unlocked` | entry | present | banner + the dashboard |

**Order matters and is asserted:** the lock is checked *before* the registry and
before `openUserDb`. A locked session must not cause a database file to be
opened at all — in step 6 that read needs a key the locked session does not
have, and a step-5 page that opens first and hides later would put the mistake
one refactor away.

**`dashboard_open` metric.** On the fourth row only — an owner, unlocked, with a
dashboard that actually rendered — `appendMetric(db, {accountId, event:
'dashboard_open', data: {slug, source}, at: Date.now()})`.

This is pulled forward from step 7 deliberately. Step 5 is the first moment a
dashboard open can happen, and architecture-overview.md §9 is unambiguous:
"Retention curves cannot be reconstructed retroactively, and they are the
fundraise." A row not written today does not exist later. `metrics` is
append-only and already exists; this is one call.

**A dashboard that throws must not 500 the page.** Bespoke per-user code is the
least-reviewed code in the repo. The dashboard render is wrapped: on any throw,
the region degrades to `This dashboard failed to load.` and a
`dashboard_error` metric row carrying the slug and the error's message, and the
chat panel above it keeps working — which is the surface the friend uses to tell
Nico it broke. Same reasoning as the corrupt-proposal degrade already in this
file, and the same limit: the chat surface is never inside the wrapper.

---

## 6. `users/devone/` — the reference dashboard

Step 5 ships one real, working dashboard, and it is **`devone`'s**.

`devtwo` is reserved for the checkpoint: it must show the *not-yet-built* state
tomorrow, then get a real dashboard authored from its confirmed spec. `devone`
having one and `devtwo` not is the isolation clause of the checkpoint made
observable in a browser — `/devone` shows a dashboard, `/devtwo` shows the
placeholder, and neither account can reach the other's URL at all.

Without a worked example, this step would ship a mechanism nothing has ever run
through. Given that step 4 shipped exactly that and the ledger's first residual
is the consequence, a reference implementation is not optional here.

**`users/devone/README.md`** states in one paragraph that this dashboard is a
hand-written reference implementation, not the output of an interview, and that
`./scripts/pull-spec.sh devone` would overwrite nothing here (it writes
`spec.md` and `mockup.html`, which this folder does not have).

**Schema** — small, and shaped like something Plaid will later fill:

```sql
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, merchant TEXT NOT NULL, category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_at ON transactions(at);
```

**Panels** — two, so the dashboard exercises an aggregate and a list:

- *Eating out this month* — summed `amount_cents` where `category = 'eating
  out'`, over the current calendar month.
- *Recent transactions* — the ten most recent rows.

**Seed** — 90 days of loudly-fake transactions: `COFFEE PALACE TEST`,
`BURRITO BARN TEST`, `RENT PAYMENT TEST`, `GROCERY WORLD TEST`. Amounts and
which days get a row come from a fixed `random.Random(seed)`, so two runs on
the same day produce identical numbers. **Timestamps are deliberately relative
to the wall clock** — 90 days back from "now" — because a dashboard panel
reading "this month" must have data in it whenever the generator last ran, and
a fixed epoch would leave every panel empty within weeks.

The two halves of that do not conflict, because **no test asserts against
`seed.py`'s output.** `users/devone/tests/*` build their own fixture rows at
exact timestamps (that is the only way to test a month boundary at all), and
the conventions sweep in §7 checks shape, not values. `seed.py` exists to make
a browser show something plausible, not to be an oracle.

**Month boundaries.** "This month" is computed from an injected `now`, never
from an implicit `Date.now()` inside the query. A query that reads the clock
directly is a query whose test passes for 29 days a month.

---

## 7. Tests

The full-suite rule from step 4 applies to every guard below: **delete the
guarded code, confirm exactly that test goes red, restore.** A test nobody has
watched fail is not evidence of anything.

**`tests/db/userDb.test.ts`**
- resolves `users/<slug>/synthetic.db` under `USERS_DIR`
- rejects `../platform/dev`, `foo/bar`, `/etc/passwd`, `..`, `` (throws, opens nothing)
- returns `source: 'none'` for a missing file, and does not cache that verdict
- the handle is read-only: an `INSERT` through it throws
- `closeUserDbs()` releases handles

**`tests/dashboard/registry.test.ts`**
- `dashboardLoaderFor('toString' | 'constructor' | 'valueOf')` is `undefined`
- every registry key is a real `users/<key>/dashboard.tsx` on disk
- every `users/*/dashboard.tsx` on disk has a registry key ← the forgotten-line drift guard
- every registry key is a valid, non-reserved slug

**`tests/users/conventions.test.ts`** — one parameterised sweep over every
`users/*/` folder, so a dashboard added in six months is covered on the day it
lands:
- the five REQUIRED entries exist; `tests/` holds at least one `*.test.ts`
- `seed.py` runs clean into a temp target
- every `CREATE TABLE` / `CREATE VIEW` name in `schema.sql` exists in the
  generated database's `sqlite_master` ← the anti-drift rule, mechanised. Gate A
  proves the two files were *staged together*; nothing until now proved they
  *agree*.
- the generated database is non-empty and contains at least one text value
  matching `TEST`

  This spawns `python3` per user. `SUBPROCESS_TIMEOUT_MS = 60_000`, per file,
  for the reason recorded in `tests/scripts/pullSpec.test.ts`: the droplet
  spawns subprocesses far slower than the laptop, `deploy/deploy.sh` runs the
  suite before the restart, and a false timeout there aborts a deploy over
  nothing. Not a global `testTimeout` — the other ~500 tests should finish in
  milliseconds and a raised ceiling everywhere would hide a real hang.

**`tests/routing/userSpace.test.ts`** (extended, same idiom as the existing
proposal tests — inspect the returned element tree):
- locked owner: no dashboard, no banner, and **`openUserDb` is never called**
  (asserted with a spy, not inferred from absent output)
- unlocked owner, no registry entry: the existing placeholder
- unlocked owner, registry entry, no synthetic db: the not-generated message
- unlocked owner, registry entry, db present: banner + dashboard content
- a throwing dashboard degrades to the failure message, does not reject, and
  leaves the chat panel's props intact
- `dashboard_open` is written on the rendering case and **not** on the locked,
  unregistered, or 404 cases
- `dashboard_error` is written on the throwing case

**`users/devone/tests/queries.test.ts`** — the month aggregate at both
boundaries (a transaction at 23:59 on the last day of the previous month is
excluded; one at 00:00 on the first day is included), the ten-row cap and its
ordering, and empty-table behaviour.

**`users/devone/tests/dashboard.test.ts`** — the component's *wiring*: given a
db, the returned element tree contains the summed figure and the merchant names,
i.e. the queries are actually called and their results actually reach the
output. This is the test the step-4 ledger says was missing for `ChatPanel`.

**`tests/deploy/deployScript.test.ts`** — a static scan, in the idiom of
`tests/deploy/service.test.ts`: `deploy/deploy.sh` regenerates synthetic user
databases *before* the `npx vitest run` gate. A deploy whose tests run against
absent databases proves nothing about the deploy.

**`tests/scripts/newDashboard.test.ts`** — sandboxed subprocess run of
`scripts/new-dashboard.sh` (same generous timeout): creates all five required
entries, substitutes the slug, refuses an invalid slug, refuses to overwrite an
existing folder, prints the registry line.

---

## 8. Scaffolding and regeneration

**`scripts/new-dashboard.sh <slug>`** copies `platform/templates/dashboard/*`
into `users/<slug>/`, substituting the slug. Templates carry a `.tmpl`
extension so `tsc`, `vitest` and `next build` never see a placeholder-riddled
`.tsx`. The script **prints** the registry line rather than editing
`registry.ts` — a regex over TypeScript source is a worse failure than a
one-line paste, and §7's drift test already turns a forgotten line into a red
suite rather than a blank page.

**`scripts/regen-synthetic.ts`** (`npm run synthetic`) runs every
`users/*/seed.py` into its sibling `synthetic.db`. This is the "regenerated per
session" line in `CLAUDE.md` made into a command — one exists for the platform
database, none existed for user databases.

**`deploy/deploy.sh`** gains one step: after `npm ci`, before the build and the
test gate, `npx tsx scripts/regen-synthetic.ts`, aborting the deploy on failure.
`users/*/synthetic.db` is gitignored, so without this the droplet has no user
databases at all and every dashboard renders the not-generated message.
`python3` is already provisioned (`deploy/PROVISION.md` step 5).

Regenerating on the droplet is safe by construction: it writes only
`users/<slug>/synthetic.db`. Real data lives in `<slug>.db` from step 6 onward
and is never a target of any generator.

---

## 9. Gate changes

`.githooks/pre-commit`'s Gate B classifier gains **one** arm: `users/*.ts` →
`guard:platform`. Today `users/registry.ts` — or any future shared file directly
under `users/` — classifies as *unguarded* and ships with no test at all. The
registry now lives in `lib/`, so this arm is a backstop against the next file
that lands there, not a load-bearing part of this design.

Changing `.githooks/*` requires staging `.claude/hooks/test-hooks.sh` in the
same commit, so the harness gains a case for it, and per §7 that case gets
deleted once to confirm it goes red.

No other gate changes. `vitest.config.ts` already includes
`users/*/tests/**/*.test.ts`. Gate A already handles `users/*/schema.sql`. Gate
B already handles `users/*/*`. `.gitignore`'s `*.db` already covers
`users/*/synthetic.db`.

---

## 10. Documentation

- **`CLAUDE.md`** — a "Dashboard folder conventions" section: the file list, the
  `seed.py`-applies-`schema.sql` rule, the registry line, `npm run synthetic`,
  and `./scripts/new-dashboard.sh <slug>`. Commands, not prose.
- **`docs/local-dev.md`** — how to see a dashboard locally: regenerate, build,
  log in as `devone`. Added to the numbered "What you should see" list: `/devone`
  shows the dashboard with the synthetic banner; `/devtwo` shows the placeholder.
- **`architecture-overview.md`** — line 149 corrected to name `devtwo`/`devone`
  the way line 148 already does. (Already applied in the working tree,
  uncommitted; this step commits it.)
- **`docs/superpowers/ledgers/step5.md`** — written at the end, carrying the
  rulings above and whatever the review rounds surface.

---

## 11. Known limits, stated rather than implied

1. **The step-5 checkpoint cannot close in this step.** It needs `devtwo`'s
   confirmed spec, which needs step 4 to have been run by a human.
2. **`source: 'real'` does not exist.** Everything a dashboard can display in
   step 5 is synthetic, and the banner says so on every render.
3. **Cross-user isolation rests on `canSeeUserSpace`**, which is where it
   already rested and is mutation-tested at both the unit and page layers. This
   step adds a second, independent barrier — the page passes the *authorised*
   slug to both the registry and `openUserDb`, so a dashboard is never handed a
   handle it could misuse — but does not re-derive the first.
4. **A per-slug cached handle is correct for a read-only file that changes only
   at deploy, and will be wrong in step 6**, where the handle is keyed to a
   session's derived key. Step 6 must not extend `openUserDb`; it introduces its
   own opener with its own lifetime.
5. **`queries.ts` is per-user code and is reviewed as such.** The conventions
   test proves shape, not correctness. A wrong query is a wrong dashboard, and
   only that user's own tests catch it.
