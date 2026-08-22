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
| `users/<slug>/spec.md`, `conversation.md`, `current.md` | The build contract for this friend: what changes, what they meant, what already exists. No mockup — §8. |
| `docs/runbook-ai.md` | The two steps the AI builder owns, in order: Step 6 (migrations, seeder, dashboard) and Step 8 (notes, `current.md`). Section 1 is its bounds — what it never does, and when it stops and asks. That file is the SEQUENCE and points here for the substance; this file is why the sequence is what it is, and does not repeat it. |
| `docs/runbook-human.md` | The surrounding operator sequence Nico runs by hand — invite, pull the spec, branch, hand over, look at it on a screen, commit, deploy, announce. |
| `docs/dashboard-ui-ux-guidelines.md` | How a dashboard should LOOK and behave: the default stack (shadcn on Tailwind, Recharts), the fluid 375–1200px container, the four non-happy panel states, formatting, and what animation may and may not imply. Defaults — a friend's own request outranks them, subject to the three limits that file names. |

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
  edited — CLAUDE.md, `docs/runbook-ai.md` §3.1. Enforced differently from the
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
  that has none. It refuses a version `current.md` does not name, too: missing,
  unparseable, or a frontmatter `version` that is not the one being announced
  (`current_state_missing` / `_invalid` / `_stale`, each exit 1, all three
  checked before any drafting call) — `scripts/announce-deploy.ts`'s
  `runAnnounce` and `exitCodeFor`.
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
  the live agent prompt — `lib/chat/prompt.ts`'s `AGENT_PROMPT`, today
  `platform/prompts/agent-v8.md` — is what tells the agent to trust it over the
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
  - **pulled** — the pulled files only (`spec.md`, and an ignored
    `conversation.md`; no `mockup.html` any more — mockup-loop removal). Not
    started; allowed.
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
  to 141; by name now, same lesson as Minor 7 above. `docs/runbook.md` has
  since been split into `docs/runbook-human.md` and `docs/runbook-ai.md` and no
  longer exists; the line to paste is the human file's step 4, and the builder
  is told to CHECK for it rather than add it (`docs/runbook-ai.md` §1.2).
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
- **The component rule, in three arms** — Nico's ruling of 2026-08-19, extended
  2026-08-20. A dashboard composes host elements plus components from these
  three classes, and nothing else:
  1. **Presentational** — shadcn's `Card`, `Button`, anything that renders
     props as markup without deriving values from them. **Trusted.** This has
     always been true in the code: every dashboard already nests `<Card>` and
     `<Button>`.
  2. **Data-computing** — Recharts, and anything deriving scales, layout or
     geometry from values. **Sanctioned, guarded by a states check:**
     degenerate data (empty, single-point, all-identical, NaN) renders the
     panel's empty state as host elements and never mounts the component.
     That list is arm 2's own — a chart can fail to be renderable in more
     ways than a plain read can, so it sharpens
     `docs/dashboard-ui-ux-guidelines.md`'s States section's **Empty** entry
     rather than restating it. The empty-database first render must show
     empty states, not charts.
  3. **Interaction controls** — a component whose job is to accept a press and
     post it. **Sanctioned, and the default for every write** (see §4). Its
     guard is structural: it derives nothing from user values, so it has no
     degenerate-input case a states check would catch.
  **The residual, for all three:** they render outside `app/[user]/page.tsx`'s
  try/catch, because a nested function component's body is deferred to React's
  render pass and a throw there 500s the page after `dashboard_open` is already
  written. For arm 3 that residual sits on the happy path, which is why the
  mechanism is platform code in `lib/ui/` tested once, not per-user code —
  the catch exists because bespoke per-user code is the least-reviewed code in
  the repo, and a shared primitive is not that —
  `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md` §4.
- **Screens are declared, and the platform draws the tabs — never the
  dashboard.** `DashboardModule.screens` is required and its
  `id`/`title`/`order` mirror `lib/spec/schema.ts`'s `Screen` — a FROZEN
  reader type now, since a change-only spec carries no ids at all, so the
  `id` and `order` are the builder's to choose and `current.md`'s
  `## Screens` is where they are recorded (see "What that looks like" below).
  `?screen=` resolves against the declared list before a dashboard ever sees
  it. **This is a chrome-ownership rule, not the component rule above** —
  shadcn's `<Tabs>` is arm 1, presentational, trusted like any other shadcn
  component. The reason a dashboard never draws its own tab strip is that the
  platform already draws one, from this exact array (see "No tab strip of
  your own," below): a second `<Tabs>` here would be a second implementation
  of the same navigation, not a forbidden component —
  CLAUDE.md > Dashboard folder conventions, `lib/dashboard/contract.ts`.

### What that looks like

A change-only `spec.md` has no `## Screens` section and carries no ids — its
sections are `## What changed`, `## Changes`, `## Data requirements` and
`## Open questions` (`lib/spec/render.ts`'s `renderChangeMarkdown`). So take
each screen's `title` from what the spec's `## Changes` asks for, and keep
every screen that is only described in `current.md`'s `## Screens`; the `id`
and `order` are yours to choose, and `current.md` is where you write them down
so the next build and the agent see the same set:

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
server-rendered `<a href="?screen=...">` anchors reading this exact exported
`screens` array. The reason is **chrome ownership, not the component rule
above** — shadcn's `<Tabs>` is arm 1, presentational, trusted, so nesting one
is not what this forbids. The platform already draws the tab strip from this
array; a dashboard's own `<Tabs>` would be a second implementation of the
same navigation, and it would give up everything the anchor shape buys — §4's
"no client-side navigation" note has the mechanical reason. (Calling rather
than nesting — `Dashboard(...)`, not `<Dashboard />` — also keeps the whole
render inside the page's own `try`/`catch`, the residual §3 accepts for all
three component arms; that residual is not what singles out tabs, chrome
ownership and the URL-state mechanics are.)

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
- **The write updates the page IN PLACE. It never navigates** — Nico's ruling,
  2026-08-20. Use `lib/ui/WriteAction.tsx`; it is the default and you write none
  of the mechanics. The contract it implements:
  > press → the controls sharing that route go pending → the server answers →
  > every affected value patches in together, in place, no navigation.
  Nothing on screen moves before the server answers, so there is no optimistic
  state and no rollback path. The pending state ends when the refreshed tree
  COMMITS, not when the POST returns — otherwise the count and the chart update
  a frame apart. Pending is grouped by ACTION URL, never by page: two controls
  writing the same route lock together, two controls writing different routes
  do not. `WriteAction` renders a real form, so the no-JS path is the original
  redirect, unchanged —
  `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md` §2-3.
- **This app has no client-side navigation anywhere — screens included.**
  Platform tabs are plain `<a href="?screen=">` anchors, so the active screen
  lives in the URL. `activeScreen` (§3) resolves it there, deep links and
  bookmarks work, and every screen switch is a real page render. That each of
  those renders then writes a row is a SEPARATE ruling — `dashboard_open` is
  written once per render, every render, with no write-path dedup (CLAUDE.md);
  the anchor shape is only what makes a tab switch a render in the first
  place. A `<Tabs>` switching in component state bypasses all three: no URL,
  no working deep link, and no row at all for the switch — `screen_order`
  freezes at whatever screen first rendered. A DIFFERENT hazard, a client-side
  `<Link>`/`router.push` under `app/[user]/`, does reach the server, as an RSC
  fetch — that is what breaks the `rsc`-header refresh detection
  `lib/metrics/renderTrigger.ts` depends on — CLAUDE.md.
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
  `platform/templates/route/route.ts.tmpl` — the worked example, not a thing to
  refactor into a shared one. Budget for it while you are reading the spec: a
  dashboard with an entry widget is two pieces of work, and the route is where
  the four ordered auth checks live — CLAUDE.md > Dashboard folder conventions.
- Per-user `tests/` should cover write paths when the dashboard has one, not just
  rendering. `platform/templates/dashboard/tests/dashboard.test.ts.tmpl` is the
  worked example. This is a convention and a scaffold, not a sweep gate — CLAUDE.md.

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
  synthetic` puts the sample data back — CLAUDE.md, `docs/runbook-human.md`
  step 7. That step is NICO'S, not the builder's: `docs/runbook-ai.md` ends at
  tests, because whether an empty screen reads as "waiting" or as "broken" is
  the one question only a person looking at it can answer.
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

- Four things are the build contract for user dashboards, each answering a
  different question: **`spec.md`** (what changes), **`conversation.md`** (what
  they meant), **`current.md`** (what already exists), and the code. There is no
  mockup — nothing composes or serves mockup HTML any more, and `mockup.html` is
  gone from every folder (mockup-loop removal). Feasibility doubts → flag to
  Nico, don't guess — CLAUDE.md > Build contract.
- Feasibility doubts never become a guess. The builder finishes everything not
  blocked on the answer and reports to NICO, who decides — `docs/runbook-ai.md`
  §1.4, `docs/runbook-human.md` step 6. `scripts/ask-user.ts` still exists and
  still puts an operator-typed question into the friend's chat, which is the
  route the 2026-08-17 design §3.5 named for a `## Open` entry, but it is Nico's
  to reach for and rare: the friend confirmed a spec, and adjusting it afterwards
  is the ordinary path. The builder never runs it —
  `docs/runbook-human.md` > Reference.
- **Both pulled files are written by `./scripts/pull-spec.sh` and overwritten on
  every pull.** Hand edits do not survive. If the spec is wrong, the fix is
  asking for a change in chat and pulling again — `docs/runbook-human.md`
  step 5.
- **`conversation.md` is gitignored and must stay that way.** It is the friend's
  raw transcript, not a designed artifact; the guard hook covers `.db` and
  `.env`, not markdown, so two `.gitignore` lines and `tests/repo/gitignore.test.ts`
  are the whole defence — CLAUDE.md > Data safety.
- A spec version is **change-only** — it describes what changes against
  `current.md`, the dashboard as it was actually built, not the friend's entire
  dashboard. No ids, and no `title`, `summary` or `background`; a panel's detail
  is prose in its `description`. So `spec.md` alone does NOT describe the
  dashboard — read it against `current.md` — CLAUDE.md > Schema & module rules,
  `lib/spec/change.ts`.
- Nothing confirms a version any more; the newest spec row is the contract the
  moment `propose_spec` writes it — CLAUDE.md > Schema & module rules.
- Because the next spec is written against `current.md`, **a `current.md` you
  got wrong corrupts the next version too**, not just this one's record — the
  design's own failure mode §11, `lib/spec/author.ts`.

---

## 9. Shared modules and synced data

### 9.1 Plaid is BUILT. What you actually do

A finance dashboard reads tables that are **already there and already
populated**. You write three files and none of them mentions Plaid as a
service:

| You write | What it is |
|---|---|
| `migrations/00N_<slug>_finance.sql` | views over the JSON |
| `queries.ts` | pure functions reading those views |
| `dashboard.tsx` | panels, plus the controls below |

**You never import `lib/plaid/`.** A dashboard never knows a network exists
(CLAUDE.md > Testing). Every Plaid call lives in a platform route that is
already written and shared by every finance friend — you do not create, copy or
edit one.

`users/plaidtest/` is the worked example. Read its `queries.ts` before writing
your own.

### 9.2 The envelope: 8 tables, and almost no schema

`modules/plaid/initial.sql` stores **Plaid's payload verbatim as JSON**. Only
three kinds of column get their own slot: the key a row is upserted on, the key
it is deleted on, and the one date every query filters by.

```
plaid_items                    item, access token, cursor, available_products,
                               institution_name, disconnected_at
plaid_accounts                 account_id, item_id, payload
plaid_transactions             transaction_id, account_id, item_id, date, payload
plaid_holdings                 (account_id, security_id), item_id, payload
plaid_securities               security_id, payload
plaid_recurring_streams        stream_id, account_id, item_id, direction, payload
plaid_investment_transactions  investment_transaction_id, account_id, item_id, …
plaid_refreshes                at, day, product, ok, code, item_id
```

**Every synced row names the bank it came from.** `item_id` is on all of them
(002_multi_source), so a query about one connection scopes directly rather than
joining through `plaid_accounts` — which matters because an account that has
since closed is gone from there, stranding its rows where nothing can reach
them. `plaid_securities` is the one exception and has no owner: two brokerages
holding the same fund report the same `security_id`.

**`disconnected_at IS NULL` means live.** A disconnected bank keeps every row it
brought — see §9.6.

So a panel reads `json_extract(payload, '$.merchant_name')`, not a column. That
is deliberate and it is what makes your job cheap: a friend who later wants a
field nobody anticipated gets a VIEW, not a migration against an encrypted
database that nobody — including Nico — can open.

SQLite ships JSON1, so `json_extract` needs no extension. If a query is ever
slow, add a generated column over it and index that, without touching a stored
row.

### 9.3 Vendoring the module into a friend's folder

It is a copy, and there are **two files now** — every one in `modules/plaid/`,
in that order:

```bash
ls users/<slug>/migrations/           # each takes the NEXT free number
cp modules/plaid/initial.sql \
   users/<slug>/migrations/00N_module_plaid_initial.sql
cp modules/plaid/002_multi_source.sql \
   users/<slug>/migrations/00M_module_plaid_multi_source.sql
```

Then regenerate the manifest (runbook-ai §2.2a).

`002` ALTERs tables `initial.sql` creates, so **the order of the numbers is
load-bearing** — reversed, it throws at unlock, on the friend's own encrypted
file, where nobody can open it to see why.

The `_module_` segment records where the file came from. **Never edit the
copy** — that is the fork the never-forked rule forbids. A friend's own needs
go in a LATER migration of their own, as views on top.

`modules/tests/vendored.test.ts` sweeps for both failures: a vendored copy that
differs from the module source, and a folder that vendored one file and not the
other.

### 9.4 What you may not do

- **No INSERT, UPDATE or DELETE against a `plaid_*` table.** Three platform
  routes write them and nothing else does: `refresh` (the synced data),
  `connect` (the connection), `disconnect` (stopping one, or deleting it and
  everything it brought). You write none of them and copy none of them. Your
  handle is read-only in both dev and production, so this is enforced, not
  merely asked.
- **Exactly one thing deletes a friend's financial history:** `disconnect` with
  `action=remove`, behind a button that says so. Nothing else — no sync, no
  reconnect, no account picker — removes a synced row.
- **An annotation is not an edit.** A friend's note on a transaction goes in
  THEIR OWN table keyed to `transaction_id`. Edit the synced row and the next
  refresh overwrites it.
- **Never derive a day from a clock.** `today` and `timeZone` arrive as props.

### 9.5 The bank management surface is REQUIRED, and it is one component

```tsx
import { PlaidSources } from '@/lib/ui/PlaidSources'
import { readPlaidSources } from '@/modules/plaid/sources'

const sources = readPlaidSources(db)
…
<PlaidSources slug={slug} sources={sources} now={now} timeZone={timeZone} />
```

That is the whole of it. **`tests/users/plaidSurface.test.ts` fails the suite**
if a folder holding a vendored `_module_plaid` migration does not render it, so
this is not a component you may choose among others.

It gives every friend, identically: connect another bank, choose which accounts
each bank shares, sign in again when one expires, stop one updating, delete one
and its data, refresh, and a last-updated time beside the refresh control.

The two that take something away — **Stop updating** and **Delete data** — ask
before they act (`confirm` on `<WriteAction>`): the first press arms the button
and changes what it says, the second does it, and it disarms itself after a few
seconds. Use the same prop for any control of your own that a friend cannot
undo.

**Why it is uniform rather than a menu.** §9.5 used to LIST these as available
parts. A builder then wired up exactly what one friend's spec asked for and no
more, and shipped a screen a friend could connect a bank to once and never
manage again. Nothing was violated; there was nothing to violate. The
capabilities are not a design question — a friend who can connect a bank can
always manage it, and *which* subset they got would otherwise vary per friend
for no reason either of them chose.

**Put it near the TOP of the screen.** Pressing Refresh is the only way a
friend's data ever changes, so burying it under the panels it updates makes the
one control that matters the last one they find. The rows collapse to a line
each, so the whole block is a header strip rather than a panel — which is what
makes top placement affordable at 375px.

**What you still decide:** what surrounds it, and everything else on the
screen.

**Do not write your own.** No `<PlaidConnect>` of your own, no disconnect form,
no refresh button. A folder that grows its own bank list drifts from every
other friend's, which is the fork the never-forked rule forbids (CLAUDE.md >
Schema & module rules) applied to the UI.

**There is no automatic refresh and there cannot be one.** A friend's data key
exists only in memory while they are unlocked, so nothing can pull on their
behalf while they are away. No scheduled job, no login sync, and no alert or
notification may be promised to someone who is not in the app. A friend's bank
data is as fresh as the last time they pressed Refresh.

### 9.6 The states a finance panel owes

`<PlaidSources>` already says all of this about the CONNECTIONS. This section is
about **your own panels** — the numbers you put on screen, which are what a
friend actually reads, and which can be stale without saying so.

Five per source, from `readPlaidSources(db)`'s `status`, and the first two are
the ones that get missed:

| status | means |
|---|---|
| `never_refreshed` | connected, nothing pulled yet — **working, not broken** |
| `live` | a refresh succeeded; `lastRefreshAt` is meaningful |
| `needs_login` | the one failure only the friend can fix |
| `unreachable` | something else failed; not theirs to repair |
| `disconnected` | they stopped it. The history is still on screen and must say so |

**A refresh can succeed and fail at the same time.** One bank's transactions
land while its balances don't, and `status` stays `live` because the connection
genuinely is. `failedProducts` carries what didn't arrive in the newest round,
and the shared surface says so in red and tells the friend to press Refresh
again — which is the real fix, since a bank that fails intermittently usually
answers on the second try and nothing can retry on their behalf. If your own
panel shows a number fed by a product in that list, it is showing the previous
value: say so rather than letting it read as current.

**READ TRANSACTIONS THROUGH `plaid_accounts`.** Not a style note — it is what
keeps an account a friend removed off their screen:

```sql
FROM plaid_transactions t
JOIN plaid_accounts a ON a.account_id = t.account_id
```

The account picker in Plaid Link **only ever adds**. Nothing deletes the data
of an account a bank stops sharing, deliberately: that picker opens with
nothing ticked, so a friend adding one account looks from the server like a
friend removing all the others, and deleting on that basis destroyed history
nobody could restore. So an unticked account loses its `plaid_accounts` row on
the next refresh — a deselected account and a *closed* one are
indistinguishable from Plaid, and a closed one has to leave the screen — while
every transaction under it stays.

The join is what turns that into the right behaviour: the account stops
appearing and nothing was destroyed. Query `plaid_transactions` on its own and
you will keep counting an account your friend removed, forever, with nothing on
screen to explain it.

**`tests/users/plaidTransactionJoin.test.ts` fails the suite if you don't.**
It checks per SQL statement, and a view of your own over `plaid_accounts`
counts — `users/run11` reads through its `spending_accounts` view, which is the
shape §9.2 asks for.

**Re-adding an account does not restore its old rows.** Plaid issues it a new
`account_id` and new `transaction_id`s, so the history ends up stored twice —
once under the stale account, once under the live one (measured: 24
transactions became 42). The stranded copy is invisible behind the join and is
removed with the bank. It is deliberately never pruned: "transactions whose
account is no longer listed" cannot tell a re-added account's dead duplicate
from a removed account's only surviving copy.

**A disconnected source's rows are still in your queries too.** Nothing deletes
them — that is the point of a soft disconnect — so a panel that sums
transactions is summing a frozen bank's alongside a live one's. Say so, or
scope the panel to live sources with `status !== 'disconnected'`. Rendering
them silently is the orphan this whole thing exists to remove.

And the four underlying states, unchanged:

1. **Not connected.** Decide this by whether a `plaid_items` row exists —
   **never** by whether transactions exist. A freshly connected bank has a
   token and zero rows for several seconds while Plaid backfills, and inferring
   "not connected" from an empty table tells a friend their connection failed
   while it is working.
2. **Connected, nothing arrived yet.** Say so. `$0.00` is a confident false
   statement about someone's money.
3. **Refreshed, with an outcome per product.** `plaid_refreshes` has THREE
   outcomes, not two: ok, a failure, and `not_ready` — Plaid holds the
   connection and has not finished preparing that product. Recurring routinely
   reports `not_ready` on the first refresh after connecting. Calling that a
   failure puts "couldn't reach your bank" on screen while everything works.
4. **Needs re-authentication** (`item_login_required`). The one failure only
   the friend can fix. Say that, rather than showing a generic error.

### 9.7 Synthetic data understates production — the trap

`users/<slug>/synthetic.db` is filled from a **recorded, scrubbed Plaid Sandbox
response** (`modules/plaid/seed_plaid.py`), so its field shape is real. It also
carries one loudly-fake `plaid_items` row, so your dashboard renders its
CONNECTED state by default; `npm run synthetic -- --empty` gives you the
not-connected one. Both are reachable without a bank. But
Sandbox returns **`cusip`, `isin`, `sector`, `industry` and `close_price` as
null on every security.**

So a "holdings by sector" panel looks impossible in dev and probably works in
production. **Do not conclude a field is unusable because synthetic data has it
null.** Flag it to Nico instead.

The reverse trap is guarded for you: names are marked `TEST` but category
enums, ids, dates, tickers and amounts are byte-identical to production, so a
view that groups on `personal_finance_category.primary` means the same thing in
both worlds.

### 9.8 Standing rules

- Shared module internals are **never forked per user**. User-specific needs =
  views/derived tables in the user's own schema — CLAUDE.md.
- Shared-module changes happen from repo root only, never inside
  `/users/<name>/` — CLAUDE.md.
- Annotations on synced rows live in the user's own tables, keyed to the synced
  rows — never as edits to a shared-module table. This is what stops a refresh
  from trampling an annotation — CLAUDE.md.

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
dashboard, see `docs/runbook-human.md` step 7 — the manual pass Nico runs
after the builder hands back.
