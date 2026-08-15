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
| `docs/superpowers/ledgers/step6a.md`, residual 2 | No migration story for a real database. See §5 — it constrains the schema before you write it. |
| `docs/superpowers/ledgers/friend-timezone.md` | Why the day belongs to the friend, and what the bug cost. |
| `users/devone/` | The worked reference. Its README: "Copy this folder's shape when building a real dashboard." |
| `users/<slug>/spec.md` + `mockup.html` | The build contract for this friend. |
| `docs/runbook.md` | The operator sequence around the build. |

---

## 2. The folder

Five entries, swept by `tests/users/conventions.test.ts:45`:

`schema.sql` · `seed.py` · `queries.ts` · `dashboard.tsx` · `tests/`

- `seed.py` **executes `schema.sql`** before inserting, so shapes have exactly
  one source — CLAUDE.md.
- `queries.ts` holds **every** SQL statement, as pure functions taking a
  `UserDb`; `dashboard.tsx` holds **no SQL** — CLAUDE.md.
- A folder has three legitimate states and only one is a defect
  (`tests/users/conventions.test.ts:84-86`):
  - **pulled** — `spec.md`/`mockup.html` only. Not started; allowed.
  - **built** — all five entries. Swept in full.
  - **partial** — some of the five. A defect.
- A dashboard renders only if registered in `lib/dashboard/registry.ts`, one
  line: `<slug>: () => import('@/users/<slug>/dashboard'),`. A folder with no
  registry line fails `tests/dashboard/registry.test.ts` — CLAUDE.md.
- `hasDashboard()` is also what decides whether their chat opens collapsed, so
  the registry line is what "the dashboard shipped" means to the app —
  `docs/runbook.md` step 7. With no loader, the page returns `PlaceholderCard`
  (`app/[user]/page.tsx:76`).
- Scaffold with `./scripts/new-dashboard.sh <slug>`; do not copy by hand —
  CLAUDE.md.

---

## 3. What a dashboard is handed, and what it may not do

A dashboard is handed `{ slug, db, today, timeZone }` and **never resolves any
of them itself** — CLAUDE.md.

- **It never derives a day from a clock.** `tests/users/noLocalDay.test.ts:23-27`
  forbids three things in every `users/*/dashboard.tsx` and `users/*/queries.ts`,
  plus the scaffold templates:
  1. `Date.now()`
  2. `new Date()` with no arguments (`new Date(row.at)` is fine and necessary)
  3. importing `lib/time/dayKey` in a `dashboard.tsx`
- A `queries.ts` **may** import `dayKey` and run it over a **stored** instant.
  Converting a stored timestamp to the friend's day is legitimate; asking a clock
  what day it is never is — CLAUDE.md.
- Why it is a data-safety rule and not style: the day is a primary key in a
  database with no migration story, so a read and a write that disagree about the
  calendar write a row that is wrong forever. It has happened once —
  `docs/superpowers/ledgers/friend-timezone.md`.
- **The handle is read-only on both paths** — `openUserDb` opens the synthetic
  file `readonly`, and the render path opens the encrypted one with
  `openEncryptedUserDb(slug, key, { readonly: true })`. Pinned at both ends,
  because they fail independently — CLAUDE.md.
- Compose only host elements. A nested function component's body is deferred to
  Next's render pass, outside the page's try/catch, so a throw there 500s the
  page after `dashboard_open` was already written —
  `platform/templates/dashboard/dashboard.tsx.tmpl`.

---

## 4. Writes

- A dashboard may **render** an entry widget, but the widget POSTs to a platform
  route. No dashboard component ever holds a writable handle, only a route does
  — CLAUDE.md.
- **Exactly two writable opens create a user's real database, and they are
  enumerated** — CLAUDE.md:
  1. the registration route (`lib/invite/register.ts`) — creates it **empty** at
     password-set time (`createEmptyEncryptedUserDb`,
     `lib/db/encryptedUserDb.ts:315`, which passes `applySchema: false`);
  2. the walk route — creates it **with** a schema, and is still the only thing
     that migrates one.
  A third is a change to onboarding ledger D3, not a refactor.
- Every write goes through a platform route, which is the only place the four
  ordered auth checks live — CLAUDE.md.
- A friend who logs anything needs their own route alongside the walk route; it
  is not a refactor of an existing one — `docs/runbook.md` step 7.
- Per-user `tests/` should cover write paths when the dashboard has one, not just
  rendering. `users/devtwo/tests/write.test.ts` is the worked example. This is a
  convention and a scaffold, not a sweep gate — CLAUDE.md.

---

## 5. The schema freezes on first write

`docs/superpowers/ledgers/step6a.md`, residual 2:

> **THERE IS NO MIGRATION STORY FOR ENCRYPTED PER-USER DATABASES.**

A real `<slug>.db` is created once with whatever `schema.sql` said that day and
**frozen at that shape**. The only thing that re-executes `schema.sql` against it
is the walk route's writable open, and `CREATE TABLE IF NOT EXISTS` can add a
table but cannot alter one that already exists. The read path does not apply the
schema at all, so a render sees the frozen shape.

Consequences for a build:

- Get the schema right **before their first write**, not before the deploy.
- A later version needing a new **column** on an existing table has no mechanism
  to get one.
- `lib/db/reshape.ts` is **not** reusable here: it proves a table holds zero rows
  before dropping it, which is exactly the assumption that fails on a database
  holding a real person's history.
- Also: **nothing migrates a real database**, so check this residual before
  changing any `schema.sql` a real database was created from — CLAUDE.md.

---

## 6. Synthetic vs real, and the banner

- Two databases per user — CLAUDE.md:
  - `synthetic.db` — loudly fake, regenerated by every deploy, shown under a
    **SYNTHETIC DATA** banner. Safe to read locally.
  - `<slug>.db` — real data, SQLCipher-encrypted. Never regenerated, never
    committed, never readable without that session's key.
- A dashboard reads the real database when it exists and the session is unlocked;
  otherwise the synthetic one, with the banner — CLAUDE.md.
- **"Exists" means HOLDS AT LEAST ONE TABLE, not "the file is there"**
  (`encryptedUserDbHasTables`, `lib/db/encryptedUserDb.ts:345`). Reading mere
  existence as data renders a permanent "This dashboard failed to load" that the
  friend has no control to escape — CLAUDE.md, onboarding ledger D3.
- The banner is the only thing distinguishing the two screens, so it is never
  rendered over real data, and it is bordered, tinted chrome rather than a line
  of text — CLAUDE.md, and `app/[user]/page.tsx:187`.
- All synthetic merchants/values are loudly fake (`COFFEE PALACE TEST`) —
  CLAUDE.md > Data safety.
- Everything a dashboard shows is synthetic **until that user's first write** —
  CLAUDE.md.

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
- `schema.sql` + `seed.py` + `tests/` update in the **same commit**. No drift —
  CLAUDE.md.
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

## 11. Packages — undecided

**No document in this repo says how to decide on a dependency.** That is a gap,
recorded here rather than filled with a rule nobody agreed.

What is established:

- `package-lock.json` must be committed: `deploy/deploy.sh` runs `npm ci`.
- Gate D runs `next build` on every push, so a dependency that breaks the build
  is caught before it ships — CLAUDE.md.
- A package that reads its own environment variable means adding that name to
  `deploy/required-env`, "including variables read by dependencies rather than by
  our own code" — CLAUDE.md.
- `components/ui/*` is vendored shadcn source, written by `npx shadcn@latest
  add`, never hand-edited. Anything we write ourselves goes in `lib/ui/` or
  beside the page that uses it — CLAUDE.md.

What is **not** established: whether one friend's panel justifies a repo-wide
dependency. Decide it with Nico before adding one.

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
