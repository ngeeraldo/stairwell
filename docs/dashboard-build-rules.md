# Building a friend's dashboard — the rules

Everything that governs `users/<slug>/` work, in one place, **with its source on
every line**. Read this before starting a build; follow the citation when you
need the reasoning.

**This is an index, not a second copy.** Where it disagrees with a cited source,
the source wins and this file is the bug — two copies of a rule are two things
that can drift apart, which is why nothing here is restated without a pointer to
where it actually lives.

Nothing in this file is new. If a rule is not cited, it is not a rule.

---

## 1. Read first

| Document | Why |
|---|---|
| `CLAUDE.md` > Dashboard folder conventions | The hard rules. Everything in §2–§6 below comes from here. |
| `docs/superpowers/specs/2026-08-12-step5-dashboard-hosting-design.md` | §3 folder conventions, §4 the data path, §6 the devone reference, §11 known limits. |
| `docs/superpowers/specs/2026-08-15-user-db-migrations-design.md` | How a friend's tables change shape without losing rows. Read before writing any migration. Closes step-6a ledger residual 2. |
| `docs/superpowers/ledgers/friend-timezone.md` | Why the day belongs to the friend, and what the bug cost. |
| `users/devone/` | The worked reference. Its README: "Copy this folder's shape when building a real dashboard." |
| `users/<slug>/spec.md` + `mockup.html` | The build contract for this friend. |
| `docs/runbook.md` | The operator sequence around the build — step 7 is the commands, in order. This file is why they are what they are; that one does not repeat it. |

---

## 2. The folder

Six entries, per CLAUDE.md > Dashboard folder conventions, swept by
`tests/users/conventions.test.ts`:

`migrations/` · `seed.py` · `queries.ts` · `dashboard.tsx` · `tests/` · `notes/`

CORRECTED (final review, Minor 7): this section used to say "Five entries"
and omit `notes/` — true before `notes/` was added to CLAUDE.md's list, stale
after. It also cited a line number (`:45`) that had already drifted 26 lines
short of where the sweep's own logic lives; cited by name below instead, so
this does not go stale again the next time a line moves.

- `migrations/` holds `001_initial.sql`, `002_*.sql`, … and `manifest.json`.
  It is the only description of a dashboard's shape; `schema.sql` no longer
  exists — CLAUDE.md, 2026-08-15 migrations design D6.
- `seed.py` **runs the migrations** in order and stamps `user_version`, so a
  synthetic database is built by the same files a real one is — CLAUDE.md.
- `queries.ts` holds **every** SQL statement, as pure functions taking a
  `UserDb`; `dashboard.tsx` holds **no SQL** — CLAUDE.md.
- `notes/` holds `README.md` plus a `v<n>.md` per BUILT version, added never
  edited — CLAUDE.md, `docs/runbook.md` step 7. Enforced differently from the
  other five: `tests/users/conventions.test.ts`'s own `REQUIRED` constant
  lists only the first five and decides the scaffolded/built/partial split
  below from those alone; `notes/`'s PRESENCE is checked by a separate
  `whenComplete` case in the same file ("has a notes/ directory") once a
  folder is already built, and its CONTENTS by two more ("has nothing in
  notes/ but README.md and v<n>.md files", "every note in notes/ parses").
  Which specific `v<n>.md` files must exist is not swept at all — the sweep
  cannot know which versions were built — and is enforced instead by
  `scripts/announce-deploy.ts`, which refuses to announce a version with no
  matching note.
- **A build note never carries the friend's data.** `notes/` is committed to the
  repo, so a note describes the SHAPE of what was built — a table, a panel, a
  computation — never a row, a value, or a merchant. The same bound `metrics`
  carries (§7), applied to a second artifact — CLAUDE.md > Dashboard folder
  conventions, `users/<slug>/notes/README.md`.
- A note is the only record of what actually SHIPPED. `spec.md` is overwritten
  by the next pull (§8) and records what was *asked for* — the two answer
  different questions, and only one of them survives a pull —
  `scripts/announce-deploy.ts`, which speaks from the note and refuses a version
  that has none.
- `current.md` describes what the dashboard IS, not what changed — required on
  every BUILT folder, its own condition rather than a seventh `REQUIRED`
  entry, since a scaffolded folder has no current shape to describe —
  CLAUDE.md > Dashboard folder conventions.
- **Overwritten every build, never added-alongside like `notes/`.** Nothing
  permanent points at it, unlike a note (an announcement) or a prompt version
  (a stamped `prompt_sha`), so there is nothing an edit could retroactively
  falsify — and replacing it is what keeps it usable: an agent replaying a
  changelog to find the current state is the failure it exists to remove —
  CLAUDE.md, `lib/build/currentState.ts`.
- Frontmatter `slug` + `version`, then five level-2 sections in fixed order —
  `## What this is for`, `## Screens`, `## Panels`, `## What can be entered`,
  `## Deliberately not included` — parsed and validated by
  `lib/build/currentState.ts`; an unknown, misspelled, duplicated or missing
  heading throws, same defensive shape as `lib/build/notes.ts` — CLAUDE.md.
  `## Deliberately not included` is the only place a refusal survives; leaving
  it empty is how the agent re-proposes something already turned down —
  `platform/templates/dashboard/current.md.tmpl`.
- **Never carries the friend's data.** Same bound as `notes/` above, applied to
  a third artifact — describe shape, never a row, a value, or a merchant —
  CLAUDE.md.
- `version: 0` means "predates the spec loop" — `devone` and `devtwo` are
  hand-written and never had a spec version behind them — `lib/build/currentState.ts`.
- **The only artifact under `users/<slug>/` the RUNNING APP puts in front of a
  model.** `app/api/chat/route.ts` reads it; `lib/chat/turn.ts`'s
  `CURRENT_STATE_BLOCK` labels and appends its body onto the system prompt;
  `platform/prompts/agent-v6.md` is what tells the agent to trust it over the
  spec — CLAUDE.md. Scoped to the running app on purpose: `notes/v<n>.md`
  reaches a model too, via `scripts/announce-deploy.ts`'s `draftAnnouncement`
  call — but that is an operator script run by hand, not a path a friend's own
  session ever triggers.
- `tests/users/conventions.test.ts` sweeps `current.md`'s PRESENCE directly —
  unlike a specific `notes/v<n>.md`, where the sweep cannot know which
  versions should exist (that lives in the platform database), `current.md` is
  exactly one file per built dashboard, so its absence is nameable. A BUILT
  folder must have a `current.md` that parses, and its `version` must equal
  the newest `notes/v<n>.md` on disk (`0` when there are none) — the
  staleness gate, since `*.md` is exempt from Gate B and nothing else would
  notice a build that forgot to rewrite it — `lib/build/currentState.ts`.
- A folder has four legitimate-or-not states, and only one is a defect
  (`tests/users/conventions.test.ts`):
  - **pulled** — `spec.md`/`mockup.html` only. Not started; allowed.
  - **scaffolded** — all five `REQUIRED` entries, but `migrations/` holds no
    `.sql`. `new-dashboard.sh` just ran and nobody has designed a shape.
    Allowed; the dashboard says "Under construction" and the friend's
    database stays empty.
  - **built** — all five `REQUIRED` entries AND a shape AND a conforming
    `notes/` AND a `current.md` naming the newest built version. Swept in
    full.
  - **partial** — some of the five `REQUIRED` entries. A defect.
- A dashboard renders only if registered in `lib/dashboard/registry.ts`, one
  line: `<slug>: () => import('@/users/<slug>/dashboard'),`. A folder with no
  registry line fails `tests/dashboard/registry.test.ts` — CLAUDE.md.
- `hasDashboard()` (`lib/dashboard/registry.ts`) is also what decides whether
  their chat opens collapsed — `app/[user]/page.tsx`'s `chatOpenByDefault` — so
  the registry line is what "the dashboard shipped" *means* to the app. With no
  loader, that page returns `PlaceholderCard` instead.

  CORRECTED (runbook split): this cited `docs/runbook.md` step 7, which no
  longer carries the reasoning — the runbook keeps the line to paste, this file
  keeps why it matters. The `app/[user]/page.tsx:76` it also cited had drifted
  to 141; by name now, same lesson as Minor 7 above.
- Scaffold with `./scripts/new-dashboard.sh <slug>`; do not copy by hand —
  CLAUDE.md.

---

## 3. What a dashboard is handed, and what it may not do

A dashboard is handed `{ slug, db, today, timeZone, screen }` and **never
resolves any of them itself** — CLAUDE.md.

- **It never derives a day from a clock.** `tests/users/noLocalDay.test.ts:23-27`
  forbids three things in every `users/*/dashboard.tsx` and `users/*/queries.ts`,
  plus the scaffold templates:
  1. `Date.now()`
  2. `new Date()` with no arguments (`new Date(row.at)` is fine and necessary)
  3. importing `lib/time/dayKey` in a `dashboard.tsx`
- A `queries.ts` **may** import `dayKey` and run it over a **stored** instant.
  Converting a stored timestamp to the friend's day is legitimate; asking a clock
  what day it is never is — CLAUDE.md.
- Why it is a data-safety rule and not style: the day is a primary key, so a
  read and a write that disagree about the calendar write a row that is wrong
  forever. It has happened once — `docs/superpowers/ledgers/friend-timezone.md`.
  **This did NOT relax when migrations arrived.** A migration changes a
  database's SHAPE; it cannot repair a row whose MEANING was wrong when it was
  written. Reading "there are migrations now" as "the day rule is softer" walks
  straight back into that ledger.
- **The handle is read-only on both paths** — `openUserDataForRead` resolves
  which database and opens it read-only in either world. Pinned at both ends,
  because they fail independently — CLAUDE.md, `tests/db/userData.test.ts`.
- Compose only host elements. A nested function component's body is deferred to
  Next's render pass, outside the page's try/catch, so a throw there 500s the
  page after `dashboard_open` was already written —
  `platform/templates/dashboard/dashboard.tsx.tmpl`.
- **Screens are declared, and the platform draws the tabs — never the
  dashboard.** `DashboardModule.screens` is required, its `id`/`title`/`order`
  mirror the spec's own `Screen` type, `?screen=` resolves against it before a
  dashboard ever sees it, and this is exactly why the point above (no nested
  function component) matters: a dashboard's own `<Tabs>` would be one —
  CLAUDE.md > Dashboard folder conventions, `lib/dashboard/contract.ts`.

### What that looks like

Take `id`/`title`/`order` for each screen straight from `spec.md`'s own
`## Screens` section — never a second source that could drift from what the
spec promised:

```ts
export const screens: DashboardScreen[] = [
  { id: 'morning', title: 'Morning', order: 1 },
  { id: 'evening', title: 'Evening', order: 2 },
]

export default function Dashboard({ slug, screen }: DashboardProps) {
  if (screen === 'evening') {
    return (
      <section>
        <h2>Evening</h2>
      </section>
    )
  }
  return (
    <section>
      <h2>Morning</h2>
    </section>
  )
}
```

Branch on `screen` and return host elements. **No tab strip of your own** —
`app/[user]/page.tsx` draws it above whatever this returns, as plain
server-rendered `<a href="?screen=...">` anchors reading this exported array,
and it does that by CALLING this component (`Dashboard(...)`, not
`<Dashboard />`) so the whole render sits inside the page's own `try`/`catch`.
A `<Tabs>` component returned from here would be a nested function component,
whose body React defers to its own render pass, OUTSIDE that catch — a throw
there 500s the page after the `dashboard_open` metric row has already been
written.

`screens` is REQUIRED. An empty array throws at render (`activeScreen`, caught
into `dashboard_error` rather than a 500). `tests/users/conventions.test.ts`
proves shape only — ids unique, orders are integers, the array is non-empty —
never that a screen's content is right or that the tabs read well next to each
other. That is what §12 and the runbook's "See it on a screen" are for. The tab
strip does not appear at all below two screens: a single tab is chrome that
explains nothing.

---

## 4. Writes

- A dashboard may **render** an entry widget, but the widget POSTs to a platform
  route. No dashboard component ever holds a writable handle, only a route does
  — CLAUDE.md.
- **Exactly two things write to a user's real database, and they are
  enumerated** — CLAUDE.md:
  1. `lib/db/migrate.ts` — creates it and changes its SHAPE, at unlock, having
     copied it aside first. Fires at the three places a key enters the keymap:
     the login route, `unlock()`, and registration.
  2. a platform route — writes ROWS into the shape it finds. It never migrates.
  A third is a change to the 2026-08-15 migrations design, not a refactor.
- Every write goes through a platform route, which is the only place the four
  ordered auth checks live — CLAUDE.md.
- A friend who logs anything needs **their own route** alongside
  `app/api/users/[user]/walk/route.ts` — the worked example, not a thing to
  refactor into a shared one. Budget for it while you are reading the spec: a
  dashboard with an entry widget is two pieces of work, and the route is where
  the four ordered auth checks live — CLAUDE.md > Dashboard folder conventions.
- Per-user `tests/` should cover write paths when the dashboard has one, not just
  rendering. `users/devtwo/tests/write.test.ts` is the worked example. This is a
  convention and a scaffold, not a sweep gate — CLAUDE.md.

---

## 5. Shapes change through migrations, and only there

`docs/superpowers/specs/2026-08-15-user-db-migrations-design.md`. This section
used to read "the schema freezes on first write", quoting step-6a ledger
residual 2 — *there is no migration story for encrypted per-user databases*.
That is closed. The reasoning is worth keeping, because it explains why the
answer looks the way it does:

> A friend's database is encrypted under a key that exists only while they have
> an unlocked session. There is no moment at deploy or startup when the server
> can open one. **The cost of zero server-side access is zero server-side
> migration** — so migrations run at unlock, from their own session, or not at
> all.

What that means when you are building:

- **Shape lives in `users/<slug>/migrations/`**, numbered, applied in order.
  `001_initial.sql` is the initial `CREATE TABLE` set.
- **An applied migration is never edited** (D2). A fix is a new file. The
  manifest's SHA-256 per migration is what enforces it; a mismatch refuses the
  session rather than applying something nobody reviewed.
- **Full DDL, `ALTER` included** (D1) — earned by D3, not by restraint.
- **Every migration above `001` ships a data-survival test in the same commit**
  (D3): seed the old shape, migrate, assert the rows survived.
- **The rebuild recipe is sanctioned** (D4) — create new, copy, drop, rename.
  It is what `reshape.ts` does minus the zero-rows proof, which is exactly the
  assumption that fails on a real person's history. **Never point `reshape.ts`
  at a user database** (D5).
- **A migration never seeds rows** (D9). Changing a shape must not invent data.
- **A copy is taken before applying** (D10), at `<slug>.backup.db`, one deep.
  Not a backup system: same key, so a forgotten password still destroys both.
  No user-facing copy may imply recovery exists.
- **A failed migration refuses the session** (D11) — pinned copy, one alert
  carrying slug, migration number and error code, and nothing rendered over a
  half-migrated shape.

---

## 6. Which database serves, and rendering nothing

- **There is no fallback.** Production always serves the friend's own encrypted
  database, empty or not. Dev always serves `synthetic.db`, for reads AND
  writes, so an entry widget is testable end to end — CLAUDE.md,
  `lib/db/userData.ts`.
- The gate is `NODE_ENV` and nothing else, inert in production by construction.
  A variable that could switch production onto synthetic data would rebuild the
  `PLATFORM_DB` failure `deploy/required-env` blocks a deploy over. Red-tested
  in `tests/db/userData.test.ts`.
- The banner follows the WORLD, not the friend's row count, and is bordered,
  tinted chrome rather than a line of text — CLAUDE.md.
- All synthetic merchants/values are loudly fake (`COFFEE PALACE TEST`)
  **wherever the shape has free text to carry the marker** — a seed producing
  only numbers and day keys is not asked for one, since a count cannot contain
  the word and still be a count. `tests/users/conventions.test.ts`'s own
  `isFreeText` decides it per folder — CLAUDE.md > Data safety.
- **Every dashboard must render on zero rows.** A friend's first session shows
  their own empty database; that is ordinary, not an error. The scaffold ships
  an empty-render test and `screenshots/screens.ts` carries an empty-state
  screen — CLAUDE.md, 2026-08-15 migrations design §9.
- **Look at zero rows, do not just test them.** A test proves an empty
  dashboard does not throw; only a picture says whether it reads as "waiting"
  or as "broken". `npm run synthetic -- --empty` rebuilds every
  `users/*/synthetic.db` from its migrations with no rows, and `npm run
  synthetic` puts the sample data back — CLAUDE.md, `docs/runbook.md` step 7.4.
  The `screenshots/screens.ts` empty-state screen does NOT cover this: it is
  pinned to devtwo and photographs the platform chrome, per §12 below.
- **A day before the friend started is not a day they failed.** devtwo's
  dashboard once rendered fourteen rows saying "missed" on a friend's first
  morning, and devone showed `$0.00` where the truth was "nothing logged yet".
  Neither is a throw, so no test failed — both were found by reading the
  screenshot (onboarding ledger D16).

---

## 7. Metrics carry no user values

`dashboard_write` records a slug and a panel and nothing else — no day, no count,
no payload. **Permanent policy for every panel type**, and what makes the login
page's promise true — CLAUDE.md.

Two metric events are load-bearing for correctness rather than observational and
must never be pruned: `deploy_announced` and `first_session_start` — CLAUDE.md >
Sacred data.

---

## 8. The build contract

- `spec.md` + `mockup.html` are the build contract for user dashboards. Build
  toward the mockup. Feasibility doubts → flag to Nico, don't guess — CLAUDE.md.
- Feasibility doubts go back to the friend via `ask-user.ts`, not into a guess —
  `docs/runbook.md` step 7.
- Both files are **written by `./scripts/pull-spec.sh` and overwritten on every
  pull**. Hand edits do not survive. If the spec is wrong, the fix is a new
  confirmed version in chat — `docs/runbook.md` step 6, CLAUDE.md > Never do
  these.
- A confirmed spec version is **whole-surface** — it describes the friend's
  entire dashboard, not one conversation's worth of changes — CLAUDE.md.
- The spec-writer emits a PATCH against a current-shape base; the stored row
  is still the whole surface, so the build contract above is unchanged —
  CLAUDE.md > Dashboard folder conventions.

---

## 9. Shared modules and synced data

- Shared module internals (e.g. `plaid.sql`) are **never forked per user**.
  User-specific needs = views/derived tables in the user's own schema —
  CLAUDE.md.
- Shared-module changes happen from repo root only, never inside `/users/<name>/`
  — CLAUDE.md.
- Annotations on synced rows live in the user's own tables, keyed to the synced
  rows — never as edits to a shared-module table. This is what stops a login sync
  or a re-pull from trampling an annotation — CLAUDE.md.
- **Not built yet.** Plaid-sourced data is step 6b; `modules/` currently holds
  only `tests/`. Scope already approved: Transactions (24mo), Balance,
  Transactions Refresh, Recurring Transactions. Plaid Link runs on the friend's
  device; only the access token is stored, encrypted at rest. Investments and
  Liabilities are **not** enabled — check in the interview before promising a
  panel — `architecture-overview.md` §3.
- Residual 2 (§5) is a **prerequisite for 6b**, not a note: when Plaid tables
  arrive, every existing `<slug>.db` needs a shape it was not born with.

---

## 10. Tests and gates

- Changes to data logic (queries, panels, derived tables) require test changes in
  the same commit. Pure styling/copy changes do not — CLAUDE.md.
- Migrations + `seed.py` + `tests/` update in the **same commit**. No drift —
  CLAUDE.md.
- **A migration above `001` ships a data-survival test in the same commit**:
  seed the old shape, migrate, assert the rows survived — 2026-08-15 migrations
  design D3. This is what earns full DDL.
- Pre-commit Gate B, by scope: `users/<name>/` → a test under
  `users/<name>/tests/` — CLAUDE.md.
- Gate C typechecks (`npx tsc --noEmit`) when any `.ts`/`.tsx` is staged; vitest
  transpiles through esbuild and does not catch type errors — CLAUDE.md.
- Pre-push runs Gate E (`npx vitest run`) then Gate D (`npx next build`),
  unconditionally. "tsc clean" does not mean "builds"; "a test file is staged"
  does not mean "the tests pass" — CLAUDE.md.
- Run with `npx vitest run users/<slug>` — CLAUDE.md.
- **The conventions test proves shape, not correctness.** `queries.ts` is
  per-user code and is reviewed as such: a wrong query is a wrong dashboard, and
  only that user's own tests catch it —
  `docs/superpowers/specs/2026-08-12-step5-dashboard-hosting-design.md` §11.5.
- All dev and testing runs on synthetic data only — CLAUDE.md > Data safety.

---

## 11. Packages

**A dependency is judged by what it touches, not by how many friends want it** —
CLAUDE.md > Build contract. One friend's panel justifies a repo-wide package at
pilot scale, because Next code-splits per route and the registry's dynamic
`import()` keeps a library out of every bundle except the dashboard that imports
it. Three charting libraries across four friends is an accepted outcome, not
drift.

- **Render-only** — charts, formatting, display. Add it — CLAUDE.md.
- **Server-touching** — reads env, the filesystem, or the network. Prefer
  writing the call ourselves: every dependency shares a process with the keymap
  holding every unlocked friend's database key, which is as true at two users as
  at fifty — CLAUDE.md.
- **Brings its own environment variable** — a `deploy/required-env` decision
  before it is a package decision, "including variables read by dependencies
  rather than by our own code" — CLAUDE.md.

Also established:

- `package-lock.json` must be committed: `deploy/deploy.sh` runs `npm ci`.
- Gate D runs `next build` on every push, so a dependency that breaks the build
  is caught before it ships — CLAUDE.md.
- The cost that scales is `npm ci` and Gate D on every push, paid by everyone —
  CLAUDE.md.
- `components/ui/*` is vendored shadcn source, written by `npx shadcn@latest
  add`, never hand-edited. Anything we write ourselves goes in `lib/ui/` or
  beside the page that uses it — CLAUDE.md.

---

## 12. Screens are reviewed as pictures

Every screen is reviewed as a picture before its task is committed;
`npm run shots -- --task=<n>` captures every live screen at 375 and 1440, and
`screenshots/screens.ts` says what each has to look like. It is a review gate,
not a test — no pixel diffing — CLAUDE.md, onboarding ledger D16.

It photographs **platform** screens against its own temp database, and the only
user database it reads is a copy of devone's synthetic one, so it cannot
photograph a friend's dashboard — `scripts/shots.ts`. To look at a built
dashboard, see `docs/runbook.md` step 7, "See it on a screen".
