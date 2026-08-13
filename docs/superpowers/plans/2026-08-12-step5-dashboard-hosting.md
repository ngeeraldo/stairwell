# Step 5 — Per-user Dashboard Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host bespoke per-user dashboards behind each user's own login, with a
folder convention (`schema.sql` / `seed.py` / `queries.ts` / `dashboard.tsx` /
`tests/`) that is enforced by tests rather than by memory.

**Architecture:** A static registry in `lib/dashboard/registry.ts` maps a slug to
a lazy `import()` of `users/<slug>/dashboard`. `lib/db/userDb.ts` turns a
validated slug into a read-only handle on `users/<slug>/synthetic.db`.
`app/[user]/page.tsx` — which has already proved ownership — passes the
*authorised* slug to both, renders a SYNTHETIC DATA banner, and records a
`dashboard_open` metric. `users/devone/` ships as the worked reference
implementation.

**Tech Stack:** Next.js 15 App Router (React 19 server components), TypeScript
strict, `better-sqlite3-multiple-ciphers`, vitest 3, Python 3 for seed
generators, bash for scripts and git gates.

**Spec:** `docs/superpowers/specs/2026-08-12-step5-dashboard-hosting-design.md`
— read it before Task 1. Section numbers below refer to it.

## Global Constraints

- **Synthetic data only.** Every merchant/value is loudly fake and contains the
  literal `TEST` (e.g. `COFFEE PALACE TEST`). Never open, read, or query any
  `*.db` other than `synthetic.db`.
- **Delete-the-guard discipline.** For every guard you add, delete it, run the
  suite, confirm *exactly its own test* goes red, then restore. A test nobody
  has watched fail is not evidence of anything. Note in the commit message that
  you did it and which test went red.
- **Subprocess timeouts.** Any test that spawns a process (`python3`, `npx tsx`,
  a shell script) declares `const SUBPROCESS_TIMEOUT_MS = 60_000` in its own
  file and passes it as the per-test timeout. Never a global `testTimeout` in
  `vitest.config.ts`. Reason: the droplet is materially slower than the laptop
  and `deploy/deploy.sh` runs the suite before the restart, so a false timeout
  aborts a deploy over nothing. Precedent and full reasoning:
  `tests/scripts/pullSpec.test.ts:130-148`.
- **Run tests with** `npx vitest run` (scope with a path: `npx vitest run tests/db`).
- **Commit gates.** `.githooks/pre-commit` runs Gate A (schema drift), Gate B
  (a guarded change needs a staged test in its own scope) and Gate C (`tsc
  --noEmit`). `.githooks/pre-push` runs Gate E (`npx vitest run`) then Gate D
  (`npx next build`). Do not use `SKIP_*` unless the plan says to; if you do,
  state the reason in the commit message.
- **`users/*/synthetic.db` is gitignored** by `.gitignore`'s `*.db`. Never
  commit one, never hand-edit one.
- **Branch:** `step5-dashboard-hosting`, already created, already carrying the
  design commit `68a852f`. Do not work on `main`.
- **Do not touch** `platform/schema.sql`, `lib/db/reshape.ts`, `lib/chat/*`,
  `lib/spec/*`, or anything under `app/api/`. Step 5 adds a read path; it
  changes no existing data logic.
- **Commit messages** end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `lib/auth/slug.ts` | The single definition of `SLUG_PATTERN` / `RESERVED_SLUGS` |
| `lib/db/userDb.ts` | Slug → read-only handle on `users/<slug>/synthetic.db` |
| `lib/dashboard/contract.ts` | `DashboardProps` / `DashboardComponent` / `DashboardModule` types |
| `lib/dashboard/registry.ts` | slug → lazy dashboard import; `dashboardLoaderFor` |
| `users/devone/schema.sql` | devone's table shapes |
| `users/devone/seed.py` | devone's synthetic generator |
| `users/devone/queries.ts` | devone's SQL, as pure functions |
| `users/devone/dashboard.tsx` | devone's server component |
| `users/devone/README.md` | "this is a hand-written reference, not agent output" |
| `users/devone/tests/queries.test.ts` | devone's data logic |
| `users/devone/tests/dashboard.test.ts` | devone's component wiring |
| `scripts/regen-synthetic.ts` | regenerate every `users/*/synthetic.db` |
| `scripts/new-dashboard.sh` | scaffold a new user folder from templates |
| `platform/templates/dashboard/*` | the scaffold templates (`.tmpl` suffixed) |
| `tests/db/userDb.test.ts` | resolver: traversal, readonly, caching, absence |
| `tests/dashboard/registry.test.ts` | prototype-key guard + registry↔disk drift |
| `tests/routing/dashboardRegion.test.ts` | the page's four-way data region |
| `tests/users/conventions.test.ts` | sweep over every `users/*/` folder |
| `tests/scripts/regenSynthetic.test.ts` | the regeneration walker |
| `tests/scripts/newDashboard.test.ts` | the scaffold script |
| `tests/deploy/deployScript.test.ts` | deploy.sh regenerates before the test gate |
| `docs/superpowers/ledgers/step5.md` | the ledger |

**Modified**

| Path | Change |
|---|---|
| `lib/auth/accounts.ts` | import `SLUG_PATTERN`/`RESERVED_SLUGS` instead of defining them |
| `app/[user]/page.tsx` | data region becomes four-way; banner; two metrics |
| `deploy/deploy.sh` | regenerate synthetic user databases after `npm ci` |
| `deploy/required-env` | one comment line: `USERS_DIR` out of scope, and why |
| `.githooks/pre-commit` | Gate B arm: `users/*.ts` → `guard:platform` |
| `.claude/hooks/test-hooks.sh` | two `class_check` cases for that arm |
| `package.json` | `"synthetic": "tsx scripts/regen-synthetic.ts"` |
| `CLAUDE.md` | "Dashboard folder conventions" section |
| `docs/local-dev.md` | how to see a dashboard locally |

---

### Task 1: The slug definition and the per-user database resolver

**Files:**
- Create: `lib/auth/slug.ts`
- Modify: `lib/auth/accounts.ts:14-35` (remove the two constants, import them)
- Create: `lib/db/userDb.ts`
- Test: `tests/db/userDb.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SLUG_PATTERN: RegExp`, `RESERVED_SLUGS: Set<string>` from `@/lib/auth/slug`
  - `type UserDb = Database.Database` from `@/lib/db/userDb`
  - `type DashboardData = { source: 'synthetic'; db: UserDb } | { source: 'none'; db: undefined }`
  - `usersRoot(): string`
  - `userDbPath(slug: string): string` — throws on an invalid slug
  - `openUserDb(slug: string): DashboardData`
  - `closeUserDbs(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/db/userDb.test.ts`:

```ts
// tests/db/userDb.test.ts
//
// openUserDb is the one function in the repo that turns a slug into a
// filesystem path. Ownership has already been proved by the caller
// (canSeeUserSpace), so the slug check here is defence in depth — but it is
// the layer that decides which FILE gets opened, so it fails closed on
// anything that is not a slug rather than trusting its caller.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeUserDbs, openUserDb, userDbPath, usersRoot } from '@/lib/db/userDb'

let root: string

/** Create users/<slug>/synthetic.db with one loudly-fake row in it. */
function makeUserDb(slug: string): string {
  mkdirSync(join(root, slug), { recursive: true })
  const path = join(root, slug, 'synthetic.db')
  const db = new Database(path)
  db.exec('CREATE TABLE transactions (merchant TEXT NOT NULL)')
  db.prepare('INSERT INTO transactions (merchant) VALUES (?)').run(
    'COFFEE PALACE TEST',
  )
  db.close()
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-userdb-'))
  process.env.USERS_DIR = root
})

afterEach(() => {
  closeUserDbs()
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('usersRoot', () => {
  it('honours USERS_DIR', () => {
    expect(usersRoot()).toBe(root)
  })

  it('falls back to <cwd>/users, which is the deployed WorkingDirectory', () => {
    delete process.env.USERS_DIR
    expect(usersRoot()).toBe(join(process.cwd(), 'users'))
  })
})

describe('userDbPath', () => {
  it('resolves a valid slug inside the users root', () => {
    expect(userDbPath('devone')).toBe(join(root, 'devone', 'synthetic.db'))
  })

  // Each of these would escape users/<slug>/ if the pattern were dropped.
  // They are listed individually rather than in one loop so a failure names
  // the exact input that got through.
  it.each([
    ['..', 'parent directory'],
    ['../platform/dev', 'a relative traversal'],
    ['/etc/passwd', 'an absolute path'],
    ['devone/../../platform', 'a traversal hidden mid-slug'],
    ['dev one', 'a space'],
    ['DEVONE', 'uppercase — accounts cannot be created with it either'],
    ['', 'the empty string'],
    ['a'.repeat(33), 'over the 32-character limit'],
  ])('refuses %s (%s)', (slug) => {
    expect(() => userDbPath(slug)).toThrow(/invalid slug/)
  })
})

describe('openUserDb', () => {
  it('opens an existing synthetic database and labels the source', () => {
    makeUserDb('devone')
    const data = openUserDb('devone')
    expect(data.source).toBe('synthetic')
    const row = data.db!.prepare('SELECT merchant FROM transactions').get() as {
      merchant: string
    }
    expect(row.merchant).toBe('COFFEE PALACE TEST')
  })

  it('returns source "none" with no handle when the file is absent', () => {
    const data = openUserDb('devtwo')
    expect(data).toEqual({ source: 'none', db: undefined })
  })

  it('does not cache the absent verdict — a database created later is picked up', () => {
    // The failure this pins: caching a miss means a dashboard scaffolded and
    // seeded during a dev session keeps rendering "not generated yet" until
    // the server is restarted, which reads as a broken dashboard.
    expect(openUserDb('devone').source).toBe('none')
    makeUserDb('devone')
    expect(openUserDb('devone').source).toBe('synthetic')
  })

  it('returns the same cached handle on a second call', () => {
    makeUserDb('devone')
    expect(openUserDb('devone').db).toBe(openUserDb('devone').db)
  })

  it('opens read-only — a dashboard renders, it does not write', () => {
    makeUserDb('devone')
    const { db } = openUserDb('devone')
    expect(() =>
      db!.prepare('INSERT INTO transactions (merchant) VALUES (?)').run('X TEST'),
    ).toThrow(/readonly/i)
  })

  it('refuses an invalid slug before touching the filesystem', () => {
    expect(() => openUserDb('../platform/dev')).toThrow(/invalid slug/)
  })

  it('closeUserDbs releases handles, so a later call re-opens', () => {
    makeUserDb('devone')
    const first = openUserDb('devone').db
    closeUserDbs()
    expect(openUserDb('devone').db).not.toBe(first)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/userDb.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/db/userDb"`.

- [ ] **Step 3: Create `lib/auth/slug.ts`**

```ts
/**
 * What a slug may be — one definition, imported by everything that judges one.
 *
 * `lib/auth/accounts.ts` uses it to decide what may be CREATED;
 * `lib/db/userDb.ts` uses it to decide what may become a FILESYSTEM PATH.
 * Two copies would be two things that can drift, and the drift would be a
 * path traversal on one side of it.
 *
 * The pattern is also what stands between account creation and an open
 * redirect: `app/api/unlock/route.ts` builds a path from `account.slug`, and
 * a slug allowed to start with '/' (e.g. "/evil.com") would resolve to
 * "//evil.com" — a post-authentication redirect off the trusted origin. A
 * slug that can never contain '/' closes that off at the source, for every
 * caller, rather than re-sanitizing at each place a slug gets interpolated
 * into a path.
 */
export const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/

/**
 * Route segments a slug must not collide with. admin/login/unlock are real
 * top-level routes (app/admin, app/(auth)/login, app/(auth)/unlock); api and
 * _next are reserved by the app/framework; favicon.ico is a static asset
 * route.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'login',
  'unlock',
  'api',
  '_next',
  'favicon.ico',
])
```

- [ ] **Step 4: Point `lib/auth/accounts.ts` at it**

In `lib/auth/accounts.ts`, delete the `SLUG_PATTERN` const, its comment block,
and the `RESERVED_SLUGS` const (currently lines 14-35), and add to the imports
at the top:

```ts
import { RESERVED_SLUGS, SLUG_PATTERN } from './slug'
```

Nothing else in that file changes — `createAccount` still calls
`SLUG_PATTERN.test(...)` and `RESERVED_SLUGS.has(...)` exactly as before.

- [ ] **Step 5: Create `lib/db/userDb.ts`**

```ts
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SLUG_PATTERN } from '@/lib/auth/slug'

export type UserDb = Database.Database

/**
 * What the page found when it went looking for a user's data.
 *
 * There is no 'real' member yet. Step 6 introduces users/<slug>/<slug>.db,
 * SQLCipher-encrypted and keyed from the in-process keymap; a resolver that
 * selected "real" on mere file existence would open an encrypted file with no
 * key the day that lands. Step 6 owns that branch and must add its OWN
 * opener — see the note on caching below.
 */
export type DashboardData =
  | { source: 'synthetic'; db: UserDb }
  | { source: 'none'; db: undefined }

/**
 * Open handles, keyed by resolved PATH (not by slug — tests point USERS_DIR at
 * a temp tree, and a slug-keyed cache would serve one test's handle to the
 * next). The file only changes at deploy, which restarts the process, so a
 * process-wide read-only handle is correct here.
 *
 * This will be WRONG in step 6, where the handle is keyed to a session's
 * derived key and must not outlive it. Step 6 does not extend this function.
 */
const handles = new Map<string, UserDb>()

/** Where user folders live. USERS_DIR exists for tests; the default is right. */
export function usersRoot(): string {
  return process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
}

/**
 * The synthetic database path for a slug. Throws on anything that is not a
 * slug, before any filesystem call — this is the single place a URL-derived
 * string becomes a path.
 */
export function userDbPath(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug '${slug}': refusing to build a filesystem path from it`,
    )
  }
  return join(usersRoot(), slug, 'synthetic.db')
}

export function openUserDb(slug: string): DashboardData {
  const path = userDbPath(slug)

  const cached = handles.get(path)
  if (cached) return { source: 'synthetic', db: cached }

  // A MISS is never cached: a database generated mid-session (npm run
  // synthetic, or a freshly scaffolded dashboard) must be picked up on the
  // next request rather than after a restart.
  if (!existsSync(path)) return { source: 'none', db: undefined }

  const db = new Database(path, { readonly: true, fileMustExist: true })
  handles.set(path, db)
  return { source: 'synthetic', db }
}

/** Release every handle. For tests, and for anything that swaps the tree. */
export function closeUserDbs(): void {
  for (const db of handles.values()) db.close()
  handles.clear()
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/db/userDb.test.ts tests/auth/accounts.test.ts`
Expected: PASS, both files. (`accounts.test.ts` proves the constant move
changed no behaviour.)

- [ ] **Step 7: Delete-the-guard check**

Comment out the `if (!SLUG_PATTERN.test(slug))` block in `userDbPath` and run
`npx vitest run tests/db/userDb.test.ts`.
Expected: the eight `userDbPath` refusal cases and the `openUserDb` invalid-slug
case go red; every other test in the file stays green. Restore the block and
re-run to confirm green.

Then comment out `{ readonly: true, fileMustExist: true }` (leaving
`new Database(path)`) and re-run.
Expected: exactly the read-only test goes red. Restore.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/auth/slug.ts lib/auth/accounts.ts lib/db/userDb.ts tests/db/userDb.test.ts
git commit -m "$(cat <<'EOF'
Resolve a user's synthetic database from a slug, read-only

One definition of SLUG_PATTERN, in lib/auth/slug.ts, shared by the
validator that decides what may be created and the resolver that decides
what may become a filesystem path. Two copies would be two things that
can drift, and the drift would be a traversal.

openUserDb caches by resolved path, never caches a miss (a database
generated mid-session must appear without a restart), and opens
read-only — a dashboard renders, it does not write.

Guards verified by deletion: removing the slug check reddens the eight
refusal cases and nothing else; removing `readonly: true` reddens exactly
the read-only test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The dashboard contract and registry

**Files:**
- Create: `lib/dashboard/contract.ts`
- Create: `lib/dashboard/registry.ts`
- Test: `tests/dashboard/registry.test.ts`

**Interfaces:**
- Consumes: `UserDb` from `@/lib/db/userDb` (Task 1).
- Produces:
  - `type DashboardProps = { slug: string; db: UserDb }`
  - `type DashboardComponent = (props: DashboardProps) => ReactElement | Promise<ReactElement>`
  - `type DashboardModule = { default: DashboardComponent }`
  - `dashboardLoaderFor(slug: string): (() => Promise<DashboardModule>) | undefined`
  - `registeredSlugs(): string[]`

The registry ships **empty** in this task. Task 4 adds `devone`. That ordering
is deliberate: the drift test written here must be seen going red when Task 4
creates `users/devone/dashboard.tsx` without registering it.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/registry.test.ts`:

```ts
// tests/dashboard/registry.test.ts
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dashboardLoaderFor, registeredSlugs } from '@/lib/dashboard/registry'
import { RESERVED_SLUGS, SLUG_PATTERN } from '@/lib/auth/slug'

// The REAL users/ tree, deliberately — this file's job is to catch a registry
// that has drifted from what is actually on disk, so it must not be pointed
// at a fixture.
const USERS = resolve(__dirname, '..', '..', 'users')

function foldersWithADashboard(): string[] {
  if (!existsSync(USERS)) return []
  return readdirSync(USERS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(USERS, name, 'dashboard.tsx')))
}

describe('dashboardLoaderFor', () => {
  // A bare DASHBOARDS[slug] lookup resolves these three off Object.prototype
  // and hands back a FUNCTION, which the page would then call as a module
  // loader. SLUG_PATTERN happens to exclude them today — that is a
  // coincidence of two unrelated rules, not a guarantee, and it is one
  // accepted slug away from being false.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'returns undefined for the inherited key %s',
    (key) => {
      expect(dashboardLoaderFor(key)).toBeUndefined()
    },
  )

  it('returns undefined for an unregistered slug', () => {
    expect(dashboardLoaderFor('nobody-has-this-slug')).toBeUndefined()
  })
})

describe('registry / disk agreement', () => {
  it('every registered slug has a dashboard.tsx on disk', () => {
    for (const slug of registeredSlugs()) {
      expect(existsSync(join(USERS, slug, 'dashboard.tsx'))).toBe(true)
    }
  })

  // The forgotten-line guard. scripts/new-dashboard.sh prints the registry
  // line rather than editing registry.ts, so this is what turns "forgot to
  // paste it" into a red suite instead of a blank page nobody notices.
  it('every dashboard.tsx on disk is registered', () => {
    expect([...registeredSlugs()].sort()).toEqual(foldersWithADashboard().sort())
  })

  it('every registered slug is a valid, non-reserved slug', () => {
    for (const slug of registeredSlugs()) {
      expect(SLUG_PATTERN.test(slug)).toBe(true)
      expect(RESERVED_SLUGS.has(slug)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard/registry.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/dashboard/registry"`.

- [ ] **Step 3: Create `lib/dashboard/contract.ts`**

```ts
import type { ReactElement } from 'react'
import type { UserDb } from '@/lib/db/userDb'

/**
 * What a bespoke dashboard is handed: its own slug, and an open read-only
 * handle on its own database. It cannot obtain anyone else's, because it is
 * never given one — app/[user]/page.tsx calls openUserDb with the slug it has
 * already authorised, and the dashboard never calls it at all.
 *
 * There is no `source` field and no undefined-`db` case. The page calls a
 * dashboard only once it holds a real handle, so a dashboard has no "what if
 * there is no data" branch to get wrong. Step 6 widens this when there is a
 * second source to distinguish.
 */
export type DashboardProps = { slug: string; db: UserDb }

export type DashboardComponent = (
  props: DashboardProps,
) => ReactElement | Promise<ReactElement>

export type DashboardModule = { default: DashboardComponent }
```

- [ ] **Step 4: Create `lib/dashboard/registry.ts`**

```ts
import type { DashboardModule } from './contract'

/**
 * Slug -> the code that renders that person's dashboard.
 *
 * Deliberately a hand-maintained literal rather than a path built from the URL
 * segment. `import('@/users/' + slug + '/dashboard')` would make a URL segment
 * into a module path — the shape lib/auth/slug.ts exists to prevent — and
 * would build a bundler context over a directory that is empty in a fresh
 * checkout. One line per user is the whole cost, and
 * tests/dashboard/registry.test.ts turns a forgotten line into a red suite.
 *
 * It lives in lib/, not users/, because it is platform code: CLAUDE.md says
 * shared changes happen from the repo root, never inside /users/<name>/. It is
 * also inside a scope the pre-commit gate already guards.
 */
const DASHBOARDS: Record<string, () => Promise<DashboardModule>> = {}

/**
 * Object.hasOwn, not a bare index. A Record literal inherits Object.prototype,
 * so DASHBOARDS['toString'] returns a FUNCTION — which the page would call as
 * a module loader. Pinned by tests/dashboard/registry.test.ts.
 */
export function dashboardLoaderFor(
  slug: string,
): (() => Promise<DashboardModule>) | undefined {
  return Object.hasOwn(DASHBOARDS, slug) ? DASHBOARDS[slug] : undefined
}

export function registeredSlugs(): string[] {
  return Object.keys(DASHBOARDS)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard/registry.test.ts`
Expected: PASS. The two agreement tests are currently vacuous (empty registry,
no `users/*/dashboard.tsx`); Task 4 gives them something to check and Step 6
below proves the prototype guard is not vacuous today.

- [ ] **Step 6: Delete-the-guard check**

Change `dashboardLoaderFor`'s body to `return DASHBOARDS[slug]` and run
`npx vitest run tests/dashboard/registry.test.ts`.
Expected: the `toString`, `constructor`, `valueOf`, `hasOwnProperty` and
`__proto__` cases go red (they resolve real inherited members); nothing else
does. Restore `Object.hasOwn` and re-run to confirm green.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/dashboard/contract.ts lib/dashboard/registry.ts tests/dashboard/registry.test.ts
git commit -m "$(cat <<'EOF'
Add the dashboard contract and an explicit slug -> code registry

A hand-maintained literal, not a path built from the URL segment: a
dynamic import over users/<slug> would make a URL into a module path and
would build a bundler context over a directory that is empty in a fresh
checkout. One line per user, and a drift test that fails the suite if the
line is missing.

dashboardLoaderFor guards with Object.hasOwn. A bare index resolves
toString/constructor/valueOf off Object.prototype and returns a function
the page would call as a loader; SLUG_PATTERN excluding those words today
is a coincidence of two unrelated rules, not a guarantee.

Guard verified by deletion: replacing Object.hasOwn with a bare index
reddens exactly the five inherited-key cases.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The page's data region

**Files:**
- Modify: `app/[user]/page.tsx:62-84` (the returned tree and a new local helper)
- Test: `tests/routing/dashboardRegion.test.ts`

**Interfaces:**
- Consumes: `openUserDb` (Task 1), `dashboardLoaderFor` + `DashboardProps` (Task 2),
  `appendMetric` from `@/lib/db/appendOnly` (existing:
  `appendMetric(db, { accountId: number | null, event: string, data?: unknown, at: number })`).
- Produces: nothing later tasks import. Behaviour only.

The four-way table (spec §5):

| State | Renders |
|---|---|
| locked | `Locked. <a href="/unlock">Unlock</a> to see your data.` (unchanged) |
| unlocked, no registry entry | `Nothing here yet. Your dashboard gets built from your interview.` (unchanged) |
| unlocked, entry, no db | `Your dashboard is built, but its data has not been generated yet.` |
| unlocked, entry, db | `SYNTHETIC DATA — every number below is fake.` + the dashboard |
| unlocked, entry, db, dashboard throws | `This dashboard failed to load.` |

**A new test file, not an extension of `tests/routing/userSpace.test.ts`.** That
file carries the 404-vs-403 security tests and needs no module mocks for
`userDb`/`registry`; adding hoisted `vi.mock` calls for them would apply to
every describe in it. The existing file must keep passing untouched — with an
empty registry its "Nothing here yet" expectations are still correct.

- [ ] **Step 1: Write the failing test**

Create `tests/routing/dashboardRegion.test.ts`:

```ts
// tests/routing/dashboardRegion.test.ts
//
// The data region of app/[user]/page.tsx. Ownership, 404-vs-403 and the
// proposal card are covered in tests/routing/userSpace.test.ts; this file
// covers only what the page does once it has decided the visitor is the
// owner.
//
// The registry and the resolver are mocked here rather than pointed at real
// files, so a test can produce a THROWING dashboard and a missing database on
// demand — neither of which the real tree can be made to do without leaving
// junk in users/.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import type { PlatformDb } from '@/lib/db/platform'

// Same reason as tests/routing/userSpace.test.ts: vitest's esbuild transform
// emits classic React.createElement calls for "jsx": "preserve".
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
const redirectMock = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`)
})
vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
  redirect: (path: string) => redirectMock(path),
}))

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

// --- the two seams under test ---------------------------------------------
type Loader = (() => Promise<{ default: (p: unknown) => unknown }>) | undefined
const loaderSlot: { value: Loader } = { value: undefined }
const loaderFor = vi.fn((_slug: string): Loader => loaderSlot.value)
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: (slug: string) => loaderFor(slug),
  registeredSlugs: () => [],
}))

type Data = { source: 'synthetic' | 'none'; db: unknown }
const dataSlot: { value: Data } = { value: { source: 'none', db: undefined } }
const openUserDbMock = vi.fn((_slug: string): Data => dataSlot.value)
vi.mock('@/lib/db/userDb', () => ({
  openUserDb: (slug: string) => openUserDbMock(slug),
}))

const SLUG = 'devone'

let pageDir: string
let handle: PlatformDb | undefined
let accountId: number

/** Log devone in, unlocked unless `lock` is set, and return the page module. */
async function arrange(opts: { lock?: boolean } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: SLUG,
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) putKey(sid, Buffer.alloc(32, 1))
  cookieSlot.value = { value: sid }
  const { default: UserSpace } = await import('@/app/[user]/page')
  return UserSpace
}

function metricEvents(): string[] {
  return (
    handle!.prepare('SELECT event FROM metrics ORDER BY id').all() as {
      event: string
    }[]
  ).map((r) => r.event)
}

function metricData(event: string): Record<string, unknown> | undefined {
  const row = handle!
    .prepare('SELECT data FROM metrics WHERE event = ? ORDER BY id DESC LIMIT 1')
    .get(event) as { data: string | null } | undefined
  return row?.data ? (JSON.parse(row.data) as Record<string, unknown>) : undefined
}

/** A real read-only handle over a throwaway file, for the rendering cases. */
function realDb(): unknown {
  const path = join(pageDir, 'devone-synthetic.db')
  const seed = new Database(path)
  seed.exec('CREATE TABLE transactions (merchant TEXT NOT NULL)')
  seed
    .prepare('INSERT INTO transactions (merchant) VALUES (?)')
    .run('COFFEE PALACE TEST')
  seed.close()
  return new Database(path, { readonly: true, fileMustExist: true })
}

beforeEach(() => {
  pageDir = mkdtempSync(join(tmpdir(), 'stairwell-dashregion-'))
  process.env.PLATFORM_DB = join(pageDir, 'synthetic.db')
  vi.resetModules()
  notFoundMock.mockClear()
  redirectMock.mockClear()
  cookieGet.mockClear()
  loaderFor.mockClear()
  openUserDbMock.mockClear()
  cookieSlot.value = undefined
  loaderSlot.value = undefined
  dataSlot.value = { source: 'none', db: undefined }
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  rmSync(pageDir, { recursive: true, force: true })
})

describe('app/[user]/page.tsx data region', () => {
  it('shows the locked notice and never opens a database', async () => {
    // The order property, not just the output: in step 6 opening this file
    // needs a key the locked session does not have. A page that opened first
    // and hid the result afterwards would look identical here and be wrong
    // then, so the assertion is on the CALL, not on the markup.
    const UserSpace = await arrange({ lock: true })
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('Locked')
    expect(openUserDbMock).not.toHaveBeenCalled()
    expect(loaderFor).not.toHaveBeenCalled()
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('shows the not-built placeholder when no dashboard is registered', async () => {
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('Nothing here yet')
    expect(json).not.toContain('SYNTHETIC DATA')
    expect(openUserDbMock).not.toHaveBeenCalled()
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('says so when the dashboard exists but its data has not been generated', async () => {
    loaderSlot.value = async () => ({ default: () => null as never })
    dataSlot.value = { source: 'none', db: undefined }
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('has not been generated yet')
    expect(json).not.toContain('SYNTHETIC DATA')
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('renders the dashboard under a synthetic banner and records dashboard_open', async () => {
    const db = realDb()
    dataSlot.value = { source: 'synthetic', db }
    const seen: unknown[] = []
    loaderSlot.value = async () => ({
      default: (props: unknown) => {
        seen.push(props)
        return React.createElement('section', null, 'PANEL RENDERED TEST')
      },
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('SYNTHETIC DATA')
    expect(json).toContain('PANEL RENDERED TEST')
    // The dashboard got its own slug and the exact handle the page resolved —
    // this is the wiring assertion, not just "some component rendered".
    // Identity (toBe) on the handle, not deep equality: a Database instance
    // is a native object and toEqual on one compares nothing meaningful.
    expect(seen).toHaveLength(1)
    expect((seen[0] as { slug: string }).slug).toBe(SLUG)
    expect((seen[0] as { db: unknown }).db).toBe(db)
    expect(loaderFor).toHaveBeenCalledWith(SLUG)
    expect(openUserDbMock).toHaveBeenCalledWith(SLUG)
    expect(metricEvents()).toContain('dashboard_open')
    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
    })
  })

  it('degrades a throwing dashboard instead of 500ing the whole page', async () => {
    // Bespoke per-user code is the least-reviewed code in the repo. The chat
    // surface above this region is how the friend TELLS Nico it broke, so it
    // must survive.
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => {
        throw new Error('panel query blew up TEST')
      },
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('This dashboard failed to load')
    expect(json).not.toContain('PANEL RENDERED TEST')
    expect(notFoundMock).not.toHaveBeenCalled()
    // A failed render is not an open.
    expect(metricEvents()).toContain('dashboard_error')
    expect(metricEvents()).not.toContain('dashboard_open')
    expect(metricData('dashboard_error')).toEqual({
      slug: SLUG,
      message: 'panel query blew up TEST',
    })
  })

  it('degrades a loader that fails to import at all', async () => {
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => {
      throw new Error('module not found TEST')
    }
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('This dashboard failed to load')
    expect(metricEvents()).toContain('dashboard_error')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/routing/dashboardRegion.test.ts`
Expected: FAIL — the locked and placeholder cases pass by accident, the four
dashboard cases fail (no `SYNTHETIC DATA`, no `dashboard_open`).

- [ ] **Step 3: Modify `app/[user]/page.tsx`**

Add to the imports:

```ts
import { appendMetric } from '@/lib/db/appendOnly'
import { openUserDb } from '@/lib/db/userDb'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
```

Add this local helper above `export default async function UserSpace`:

```tsx
/**
 * The data region, for an owner whose session is already UNLOCKED.
 *
 * Called only from the unlocked branch below, so no database file is opened
 * for a locked session — in step 6 that read needs a key a locked session does
 * not have, and a page that opened first and hid the result afterwards would
 * pass today and be wrong then.
 *
 * The dashboard component is CALLED, not returned as <Dashboard />. Returning
 * an element would defer its execution to React's render, outside this
 * try/catch, and the whole point of the catch is that bespoke per-user code is
 * the least-reviewed code in the repo. The chat surface stays OUTSIDE this
 * function on purpose: it is the surface a friend uses to report that the
 * dashboard broke.
 */
async function dashboardRegion(slug: string, accountId: number) {
  const loader = dashboardLoaderFor(slug)
  if (!loader) {
    return <p>Nothing here yet. Your dashboard gets built from your interview.</p>
  }

  const data = openUserDb(slug)
  if (data.source === 'none') {
    return <p>Your dashboard is built, but its data has not been generated yet.</p>
  }

  try {
    const { default: Dashboard } = await loader()
    const rendered = await Dashboard({ slug, db: data.db })
    // After a successful render, never before: a dashboard that threw is not
    // an open, and metrics is append-only so a wrong row cannot be removed.
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_open',
      data: { slug, source: data.source },
      at: Date.now(),
    })
    return (
      <>
        <p role="status">SYNTHETIC DATA — every number below is fake.</p>
        {rendered}
      </>
    )
  } catch (error) {
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_error',
      data: {
        slug,
        message: error instanceof Error ? error.message : String(error),
      },
      at: Date.now(),
    })
    return <p>This dashboard failed to load.</p>
  }
}
```

Replace the existing `{unlocked ? (...) : (...)}` block in the returned tree with:

```tsx
      {unlocked ? (
        await dashboardRegion(user, accountId)
      ) : (
        <p>
          Locked. <a href="/unlock">Unlock</a> to see your data.
        </p>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/routing/dashboardRegion.test.ts tests/routing/userSpace.test.ts`
Expected: PASS, both files. `userSpace.test.ts` is unmodified and still green —
with an empty registry the unlocked owner still gets "Nothing here yet".
(Task 4 registers `devone` and stubs the registry in that file; do not
pre-empt it here.)

- [ ] **Step 5: Delete-the-guard check**

Three deletions, one at a time, each followed by `npx vitest run tests/routing/`:

1. Move the `openUserDb(slug)` call above the `if (!loader)` early return.
   Expected red: *only* "shows the not-built placeholder…" (its
   `openUserDbMock` assertion). Restore.
2. Remove the `try`/`catch`, leaving the body bare.
   Expected red: *only* the two degrade tests, which now reject. Restore.
3. Move the `appendMetric(… 'dashboard_open' …)` call above the `await
   Dashboard(...)` line.
   Expected red: *only* "degrades a throwing dashboard…", on its
   `not.toContain('dashboard_open')`. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add app/\[user\]/page.tsx tests/routing/dashboardRegion.test.ts
git commit -m "$(cat <<'EOF'
Render a registered dashboard in the user space, behind the lock

Four-way data region: locked / no dashboard / no data / dashboard. The
lock is checked before the registry and before openUserDb, so a locked
session opens no database file at all — in step 6 that read needs a key a
locked session does not have, and the test asserts the CALL, not the
markup, so it stays honest then.

The dashboard component is called rather than returned as an element, so
a throw lands in this file's catch instead of React's render. It degrades
to a message and a dashboard_error row; the chat surface above it — the
surface a friend uses to report the breakage — stays outside the wrapper.

dashboard_open is pulled forward from step 7 deliberately: step 5 is the
first moment a dashboard can be opened, and a retention row not written
today does not exist later.

Guards verified by deletion: hoisting openUserDb above the registry check,
removing the try/catch, and moving the metric before the render each
redden exactly one test and nothing else.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `users/devone/` — the reference dashboard

**Files:**
- Create: `users/devone/schema.sql`
- Create: `users/devone/seed.py`
- Create: `users/devone/queries.ts`
- Create: `users/devone/dashboard.tsx`
- Create: `users/devone/README.md`
- Test: `users/devone/tests/queries.test.ts`
- Test: `users/devone/tests/dashboard.test.ts`
- Modify: `lib/dashboard/registry.ts` (one line)

**Interfaces:**
- Consumes: `DashboardProps` (Task 2), `UserDb` (Task 1).
- Produces:
  - `monthRange(now: number): { start: number; end: number }`
  - `eatingOutThisMonthCents(db: UserDb, now: number): number`
  - `recentTransactions(db: UserDb, limit?: number): Transaction[]`
  - `type Transaction = { merchant: string; category: string; amount_cents: number; at: number }`
  - default export `DevOneDashboard` from `users/devone/dashboard`

Gate A fires on a staged `users/devone/schema.sql`: the same commit must stage
`users/devone/seed.py` or something under `users/devone/tests/`. This task
stages all of them, so it passes.

- [ ] **Step 1: Write the failing tests**

Create `users/devone/tests/queries.test.ts`:

```ts
// users/devone/tests/queries.test.ts
//
// Fixtures are built here at exact timestamps rather than generated by
// seed.py — a month-boundary test cannot be written against a generator whose
// timestamps float with the wall clock, and seed.py exists to make a browser
// show something plausible, not to be an oracle.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UserDb } from '@/lib/db/userDb'
import {
  eatingOutThisMonthCents,
  monthRange,
  recentTransactions,
} from '@/users/devone/queries'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

function add(row: {
  merchant: string
  category: string
  amount_cents: number
  at: number
}) {
  db.prepare(
    'INSERT INTO transactions (merchant, category, amount_cents, at) VALUES (?, ?, ?, ?)',
  ).run(row.merchant, row.category, row.amount_cents, row.at)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devone-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// 15 March 2026, 12:00 local. Local, not UTC: monthRange builds its bounds
// from the local calendar, so a UTC literal here would put the test and the
// code in different months for anyone west of Greenwich.
const MID_MARCH = new Date(2026, 2, 15, 12, 0, 0).getTime()

describe('monthRange', () => {
  it('spans the calendar month containing now', () => {
    const { start, end } = monthRange(MID_MARCH)
    expect(new Date(start).getTime()).toBe(new Date(2026, 2, 1).getTime())
    expect(new Date(end).getTime()).toBe(new Date(2026, 3, 1).getTime())
  })

  it('rolls the year over in December', () => {
    const { end } = monthRange(new Date(2026, 11, 15).getTime())
    expect(new Date(end).getTime()).toBe(new Date(2027, 0, 1).getTime())
  })
})

describe('eatingOutThisMonthCents', () => {
  it('returns 0 on an empty table rather than null', () => {
    // COALESCE, not a null that renders as "$NaN" on the friend's page.
    expect(eatingOutThisMonthCents(db, MID_MARCH)).toBe(0)
  })

  it('sums only the eating-out rows inside the month', () => {
    add({ merchant: 'COFFEE PALACE TEST', category: 'eating out', amount_cents: 500, at: MID_MARCH })
    add({ merchant: 'BURRITO BARN TEST', category: 'eating out', amount_cents: 1200, at: MID_MARCH })
    add({ merchant: 'GROCERY WORLD TEST', category: 'groceries', amount_cents: 9000, at: MID_MARCH })
    expect(eatingOutThisMonthCents(db, MID_MARCH)).toBe(1700)
  })

  it('excludes the last millisecond of the previous month', () => {
    add({
      merchant: 'COFFEE PALACE TEST',
      category: 'eating out',
      amount_cents: 500,
      at: new Date(2026, 2, 1).getTime() - 1,
    })
    expect(eatingOutThisMonthCents(db, MID_MARCH)).toBe(0)
  })

  it('includes the first millisecond of this month', () => {
    add({
      merchant: 'COFFEE PALACE TEST',
      category: 'eating out',
      amount_cents: 500,
      at: new Date(2026, 2, 1).getTime(),
    })
    expect(eatingOutThisMonthCents(db, MID_MARCH)).toBe(500)
  })

  it('excludes the first millisecond of next month', () => {
    // Without an upper bound this passes anyway for a clock-relative "now",
    // and then silently counts future-dated rows the day one appears.
    add({
      merchant: 'COFFEE PALACE TEST',
      category: 'eating out',
      amount_cents: 500,
      at: new Date(2026, 3, 1).getTime(),
    })
    expect(eatingOutThisMonthCents(db, MID_MARCH)).toBe(0)
  })
})

describe('recentTransactions', () => {
  it('returns the newest first, capped at ten', () => {
    for (let i = 0; i < 15; i++) {
      add({
        merchant: `MERCHANT ${i} TEST`,
        category: 'eating out',
        amount_cents: 100 + i,
        at: MID_MARCH + i,
      })
    }
    const rows = recentTransactions(db)
    expect(rows).toHaveLength(10)
    expect(rows[0]!.merchant).toBe('MERCHANT 14 TEST')
    expect(rows[9]!.merchant).toBe('MERCHANT 5 TEST')
  })

  it('honours an explicit limit', () => {
    for (let i = 0; i < 5; i++) {
      add({ merchant: `M${i} TEST`, category: 'eating out', amount_cents: 1, at: MID_MARCH + i })
    }
    expect(recentTransactions(db, 2)).toHaveLength(2)
  })

  it('returns an empty array on an empty table', () => {
    expect(recentTransactions(db)).toEqual([])
  })
})
```

Create `users/devone/tests/dashboard.test.ts`:

```ts
// users/devone/tests/dashboard.test.ts
//
// The component's WIRING, not its queries. The step-4 ledger's first residual
// is a component whose extracted pure functions were thoroughly tested while
// all nine of its call-site mutations survived — a suite that stayed green
// while the product did nothing. These tests fail if the component stops
// calling a query or stops putting its result in the output.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import DevOneDashboard from '@/users/devone/dashboard'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devone-dash-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function add(merchant: string, category: string, cents: number, at: number) {
  db.prepare(
    'INSERT INTO transactions (merchant, category, amount_cents, at) VALUES (?, ?, ?, ?)',
  ).run(merchant, category, cents, at)
}

describe('users/devone/dashboard.tsx', () => {
  it('renders the eating-out total and the recent list from the database', async () => {
    const now = Date.now()
    add('COFFEE PALACE TEST', 'eating out', 450, now - 1000)
    add('BURRITO BARN TEST', 'eating out', 1550, now - 2000)
    add('GROCERY WORLD TEST', 'groceries', 8000, now - 3000)

    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db }))

    // $20.00 = 450 + 1550, i.e. the aggregate actually ran and reached the
    // output. A hard-coded panel would not produce this.
    expect(json).toContain('$20.00')
    expect(json).toContain('COFFEE PALACE TEST')
    expect(json).toContain('BURRITO BARN TEST')
    // The recent list is not filtered by category.
    expect(json).toContain('GROCERY WORLD TEST')
  })

  it('renders both panels with an empty database instead of throwing', async () => {
    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db }))
    expect(json).toContain('$0.00')
    expect(json).toContain('No transactions yet')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run users/devone`
Expected: FAIL — `Failed to resolve import "@/users/devone/queries"`.

- [ ] **Step 3: Create `users/devone/schema.sql`**

```sql
-- users/devone/schema.sql
--
-- devone is a loudly-fake fixture account. Every row generated into this shape
-- by seed.py contains the literal TEST (CLAUDE.md > Data safety).
--
-- seed.py executes THIS FILE before inserting anything, so the table shapes
-- have exactly one source and the generator cannot declare one of its own.

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  merchant     TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_at ON transactions(at);
```

- [ ] **Step 4: Create `users/devone/queries.ts`**

```ts
// users/devone/queries.ts
//
// Every SQL statement for devone's dashboard. The component holds none: data
// logic that lives in a .tsx file can only be tested by rendering, and the
// month-boundary cases below are the reason that matters.
import type { UserDb } from '@/lib/db/userDb'

export type Transaction = {
  merchant: string
  category: string
  amount_cents: number
  at: number
}

/**
 * [start, end) for the calendar month containing `now`, in the host timezone.
 *
 * `now` is a PARAMETER. A query that reads the clock itself is a query whose
 * test passes for twenty-nine days a month and cannot be made to fail on the
 * thirtieth.
 */
export function monthRange(now: number): { start: number; end: number } {
  const d = new Date(now)
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
  }
}

/** Total spent on eating out inside the calendar month containing `now`. */
export function eatingOutThisMonthCents(db: UserDb, now: number): number {
  const { start, end } = monthRange(now)
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM transactions
        WHERE category = 'eating out'
          AND at >= ? AND at < ?`,
    )
    .get(start, end) as { total: number }
  return row.total
}

/** The most recent transactions, newest first. */
export function recentTransactions(db: UserDb, limit = 10): Transaction[] {
  return db
    .prepare(
      `SELECT merchant, category, amount_cents, at
         FROM transactions
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as Transaction[]
}
```

- [ ] **Step 5: Create `users/devone/dashboard.tsx`**

```tsx
// users/devone/dashboard.tsx
//
// devone's dashboard. A server component handed its own slug and an open
// read-only handle on its own database — it never resolves either itself.
import type { DashboardProps } from '@/lib/dashboard/contract'
import { eatingOutThisMonthCents, recentTransactions } from './queries'

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export default function DevOneDashboard({ db }: DashboardProps) {
  const now = Date.now()
  const eatingOut = eatingOutThisMonthCents(db, now)
  const recent = recentTransactions(db)

  return (
    <section>
      <section>
        <h2>Eating out this month</h2>
        <p>{money(eatingOut)}</p>
      </section>
      <section>
        <h2>Recent transactions</h2>
        {recent.length === 0 ? (
          <p>No transactions yet.</p>
        ) : (
          <ul>
            {recent.map((t) => (
              <li key={`${t.at}-${t.merchant}`}>
                {day(t.at)} — {t.merchant} — {money(t.amount_cents)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
```

- [ ] **Step 6: Create `users/devone/seed.py`**

```python
#!/usr/bin/env python3
"""Synthetic data generator for devone's dashboard.

    python3 seed.py <target.db>

Writes ONLY to the target given as argv[1] (the contract
tests/support/synthetic.ts:regenerateUser assumes, and
tests/support/noCross.test.ts pins in both directions).

Executes ../devone/schema.sql before inserting anything, so table shapes have
exactly one source and this file cannot declare one of its own.

Amounts and which days get a row come from a fixed seed, so two runs on the
same day produce identical numbers. TIMESTAMPS are deliberately relative to
the wall clock: a panel reading "this month" must have data in it whenever the
generator last ran, and a fixed epoch would leave every panel empty within
weeks. Nothing asserts against this output — users/devone/tests/* build their
own fixtures at exact timestamps.
"""

import os
import random
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")

# Loudly fake, every one of them (CLAUDE.md > Data safety): merchant, category,
# min cents, max cents.
MERCHANTS = [
    ("COFFEE PALACE TEST", "eating out", 350, 900),
    ("BURRITO BARN TEST", "eating out", 900, 2200),
    ("GROCERY WORLD TEST", "groceries", 1500, 9000),
    ("RENT PAYMENT TEST", "housing", 120000, 120000),
]

DAYS = 90
DAY_MS = 86_400_000


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    with open(SCHEMA, encoding="utf-8") as handle:
        schema = handle.read()

    rng = random.Random(20260812)
    now = int(time.time() * 1000)

    rows = []
    for back in range(DAYS):
        for merchant, category, low, high in MERCHANTS:
            if category == "housing" and back % 30 != 0:
                continue
            if category != "housing" and rng.random() < 0.35:
                continue
            rows.append(
                (
                    merchant,
                    category,
                    rng.randint(low, high),
                    now - back * DAY_MS + rng.randrange(DAY_MS),
                )
            )

    db = sqlite3.connect(target)
    try:
        db.executescript(schema)
        # Idempotent: regenerating replaces the data rather than doubling it.
        db.execute("DELETE FROM transactions")
        db.executemany(
            "INSERT INTO transactions (merchant, category, amount_cents, at)"
            " VALUES (?, ?, ?, ?)",
            rows,
        )
        db.commit()
    finally:
        db.close()

    print(f"devone: {len(rows)} synthetic transactions -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Make it executable: `chmod +x users/devone/seed.py`

- [ ] **Step 7: Create `users/devone/README.md`**

```markdown
# devone — reference dashboard

This dashboard is **hand-written as the reference implementation** of the
folder convention in `CLAUDE.md > Dashboard folder conventions`. It is not the
output of an interview and there is no confirmed spec behind it.

That is why this folder has no `spec.md` and no `mockup.html`: those two files
are a projection of a confirmed spec record, written by
`./scripts/pull-spec.sh <slug>`, and `devone` has never confirmed one. Running
that script here would create them; nothing in this folder would be
overwritten.

Copy this folder's shape when building a real dashboard — or better, run
`./scripts/new-dashboard.sh <slug>`, which produces the same shape from
templates.
```

- [ ] **Step 8: Register devone**

In `lib/dashboard/registry.ts`, change the empty literal to:

```ts
const DASHBOARDS: Record<string, () => Promise<DashboardModule>> = {
  devone: () => import('@/users/devone/dashboard'),
}
```

- [ ] **Step 9: Stub the registry in the authorization tests**

Registering `devone` changes what `tests/routing/userSpace.test.ts` sees: that
file's page tests create an account called `devone` and assert the unlocked
owner gets `Nothing here yet`, which stops being true the moment a `devone`
dashboard exists. Without this step, Task 4 turns two of that file's tests red
for a reason that has nothing to do with what they test.

Add near the other `vi.mock` calls at the top of
`tests/routing/userSpace.test.ts` (after the `next/headers` mock):

```ts
// devone gains a real dashboard in step 5. This file tests AUTHORISATION —
// 404-vs-403, admin-is-not-an-override, the proposal card — and
// tests/routing/dashboardRegion.test.ts owns the data region. Stub the
// registry empty here so these assertions do not move every time a dashboard
// is added to or removed from the repo.
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => undefined,
  registeredSlugs: () => [],
}))
```

Nothing else in that file changes.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run users/devone tests/dashboard tests/routing`
Expected: PASS. The registry drift test is now non-vacuous — it compares
`['devone']` against `['devone']` — and `userSpace.test.ts` is green with its
original expectations intact.

- [ ] **Step 11: Delete-the-guard check**

1. Remove the `devone:` line from the registry and run
   `npx vitest run tests/dashboard`.
   Expected red: "every dashboard.tsx on disk is registered", and nothing else.
   Restore.
2. In `queries.ts`, delete `AND at < ?` (and the second `end` argument) and run
   `npx vitest run users/devone`.
   Expected red: *only* "excludes the first millisecond of next month".
   Restore.
3. In `dashboard.tsx`, replace `{money(eatingOut)}` with a literal `$0.00` and
   run `npx vitest run users/devone`.
   Expected red: *only* "renders the eating-out total and the recent list…".
   This is the mutation the step-4 ledger says survived for `ChatPanel`.
   Restore.

- [ ] **Step 12: Generate the database and look at it**

```bash
python3 users/devone/seed.py users/devone/synthetic.db
npx tsx -e "const D=require('better-sqlite3-multiple-ciphers');const d=new D('users/devone/synthetic.db',{readonly:true});console.log(d.prepare('SELECT COUNT(*) n FROM transactions').get());console.log(d.prepare('SELECT * FROM transactions ORDER BY at DESC LIMIT 3').all())"
```

Expected: a non-zero count and three rows whose merchants all end in `TEST`.
The file is gitignored; do not stage it.

- [ ] **Step 13: Typecheck and commit**

```bash
npx tsc --noEmit
git add users/devone/schema.sql users/devone/seed.py users/devone/queries.ts \
        users/devone/dashboard.tsx users/devone/README.md users/devone/tests \
        lib/dashboard/registry.ts tests/routing/userSpace.test.ts
git commit -m "$(cat <<'EOF'
Ship devone as the worked reference dashboard

Step 4 shipped a mechanism nothing had ever run through, and its first
residual is the consequence. This is the same mechanism with one real
dashboard on the end of it: schema.sql, a seed.py that executes that
schema rather than declaring its own, queries.ts holding every statement,
and a component that holds none.

devtwo is deliberately left without one — it is the checkpoint account,
and "/devone shows a dashboard, /devtwo shows the placeholder, neither
account can reach the other's URL" is the isolation clause made visible in
a browser.

Guards verified by deletion: unregistering devone reddens only the drift
test; dropping the month's upper bound reddens only the next-month case;
replacing the rendered total with a literal reddens only the wiring test —
which is exactly the mutation that survived for ChatPanel in step 4.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The folder-convention sweep

**Files:**
- Test: `tests/users/conventions.test.ts`

**Interfaces:**
- Consumes: `users/devone/*` (Task 4) as its first subject.
- Produces: nothing importable.

This is the anti-drift rule mechanised. Gate A proves `schema.sql` and
`seed.py` were *staged together*; nothing until now proved they *agree*.

- [ ] **Step 1: Write the failing test**

Create `tests/users/conventions.test.ts`:

```ts
// tests/users/conventions.test.ts
//
// One sweep over every users/<slug>/ folder, so a dashboard added in six
// months is covered on the day it lands rather than when someone remembers to
// write a test for it.
//
// The high-value assertion is the schema one: CLAUDE.md's anti-drift rule says
// schema.sql + seed.py + tests/ move in the same commit, and Gate A enforces
// that they were STAGED together. Nothing before this proved they AGREE.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Every test in this file spawns python3 once per user folder. vitest's
 * 5-second default is not a budget for that on the droplet, which spawns
 * subprocesses far slower than the laptop and runs this suite as a deploy
 * gate — a false timeout there aborts a deploy over nothing. Per-file, never a
 * global testTimeout: the other ~500 tests should finish in milliseconds and
 * raising the ceiling everywhere would hide a real hang. Precedent and full
 * reasoning: tests/scripts/pullSpec.test.ts.
 */
const SUBPROCESS_TIMEOUT_MS = 60_000

const USERS = resolve(__dirname, '..', '..', 'users')

const slugs = existsSync(USERS)
  ? readdirSync(USERS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : []

const temps: string[] = []
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

/** Table and view names declared in a schema file. */
function declaredObjects(sql: string): string[] {
  const names: string[] = []
  const re = /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(sql)) !== null) names.push(match[1]!)
  return names
}

describe('users/ folder conventions', () => {
  // Without this the it.each below is vacuous on an empty users/ tree: zero
  // cases, zero failures, a green suite that checked nothing. devone exists,
  // so this is a real assertion, not a formality.
  it('finds at least one user folder to check', () => {
    expect(slugs.length).toBeGreaterThan(0)
  })

  describe.each(slugs)('users/%s', (slug) => {
    const dir = join(USERS, slug)

    it.each(['schema.sql', 'seed.py', 'queries.ts', 'dashboard.tsx', 'tests'])(
      'has %s',
      (entry) => {
        expect(existsSync(join(dir, entry))).toBe(true)
      },
    )

    it('has at least one test of its own', () => {
      const tests = readdirSync(join(dir, 'tests')).filter((f) =>
        f.endsWith('.test.ts'),
      )
      expect(tests.length).toBeGreaterThan(0)
    })

    it(
      'seed.py runs clean and produces every object schema.sql declares',
      () => {
        const out = mkdtempSync(join(tmpdir(), `stairwell-conv-${slug}-`))
        temps.push(out)
        const target = join(out, 'synthetic.db')

        execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })

        const db = new Database(target, { readonly: true, fileMustExist: true })
        try {
          const present = new Set(
            (
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
                )
                .all() as { name: string }[]
            ).map((r) => r.name),
          )
          const declared = declaredObjects(readFileSync(join(dir, 'schema.sql'), 'utf8'))
          expect(declared.length).toBeGreaterThan(0)
          for (const name of declared) expect(present.has(name)).toBe(true)
        } finally {
          db.close()
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    )

    it(
      'generates loudly-fake, non-empty data',
      () => {
        const out = mkdtempSync(join(tmpdir(), `stairwell-loud-${slug}-`))
        temps.push(out)
        const target = join(out, 'synthetic.db')
        execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })

        const db = new Database(target, { readonly: true, fileMustExist: true })
        try {
          const tables = (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
              )
              .all() as { name: string }[]
          ).map((r) => r.name)

          let rows = 0
          let loud = false
          for (const table of tables) {
            const all = db.prepare(`SELECT * FROM "${table}"`).all()
            rows += all.length
            if (JSON.stringify(all).includes('TEST')) loud = true
          }
          expect(rows).toBeGreaterThan(0)
          expect(loud).toBe(true)
        } finally {
          db.close()
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it passes, then prove it can fail**

Run: `npx vitest run tests/users/conventions.test.ts`
Expected: PASS for `users/devone`.

- [ ] **Step 3: Delete-the-guard check**

1. In `users/devone/schema.sql`, add a line
   `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY);` and comment out
   the `db.executescript(schema)` line in `seed.py` (replacing it with a
   hand-written `CREATE TABLE transactions ...` so the inserts still work).
   Run `npx vitest run tests/users/conventions.test.ts`.
   Expected red: *only* "seed.py runs clean and produces every object schema.sql
   declares". Restore both files.
2. Change every `TEST` in `users/devone/seed.py`'s `MERCHANTS` to `REAL`.
   Expected red: *only* "generates loudly-fake, non-empty data". Restore.
3. Temporarily rename `users/devone` to `users/.hidden-devone` (so `slugs` is
   empty) and run the file.
   Expected red: "finds at least one user folder to check". Rename back.

- [ ] **Step 4: Commit**

```bash
npx vitest run
git add tests/users/conventions.test.ts
git commit -m "$(cat <<'EOF'
Sweep every user folder for the convention, and for schema agreement

Gate A proves schema.sql and seed.py were STAGED in the same commit.
Nothing proved they AGREE. This runs each generator into a temp target and
checks that every table and view schema.sql declares actually exists in
what came out — the anti-drift rule as a test rather than as a habit.

Also pins the required-file list, the loud-fake marker, and a non-empty
result. The "finds at least one user folder" case exists because
describe.each over an empty list is a green suite that checked nothing.

python3 per folder, so SUBPROCESS_TIMEOUT_MS = 60_000 per file, for the
reason recorded in tests/scripts/pullSpec.test.ts.

Guards verified by deletion: desynchronising schema.sql from seed.py,
renaming the fake merchants, and hiding the only user folder each redden
exactly one case.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Regeneration, and the deploy step that needs it

**Files:**
- Create: `scripts/regen-synthetic.ts`
- Modify: `package.json` (one script line)
- Modify: `deploy/deploy.sh` (a new step 3a, after `npm ci`)
- Modify: `deploy/required-env` (one comment line in the out-of-scope block)
- Test: `tests/scripts/regenSynthetic.test.ts`
- Test: `tests/deploy/deployScript.test.ts`

**Interfaces:**
- Consumes: `users/*/seed.py` (Task 4).
- Produces:
  - `userSlugsWithSeeds(usersDir: string): string[]`
  - `regenerateAll(usersDir: string): string[]` — returns the target paths written

- [ ] **Step 1: Write the failing tests**

Create `tests/scripts/regenSynthetic.test.ts`:

```ts
// tests/scripts/regenSynthetic.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { regenerateAll, userSlugsWithSeeds } from '@/scripts/regen-synthetic'

/** See tests/scripts/pullSpec.test.ts — the droplet spawns processes slowly. */
const SUBPROCESS_TIMEOUT_MS = 60_000

let root: string

/** A minimal, valid user folder: schema.sql + a seed.py that executes it. */
function makeUser(slug: string, extraSql = '') {
  const dir = join(root, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'schema.sql'),
    `CREATE TABLE IF NOT EXISTS spend (merchant TEXT NOT NULL);${extraSql}`,
  )
  writeFileSync(
    join(dir, 'seed.py'),
    [
      'import os, sqlite3, sys',
      'here = os.path.dirname(os.path.abspath(__file__))',
      'schema = open(os.path.join(here, "schema.sql"), encoding="utf-8").read()',
      'db = sqlite3.connect(sys.argv[1])',
      'db.executescript(schema)',
      'db.execute("DELETE FROM spend")',
      `db.execute("INSERT INTO spend VALUES ('${slug.toUpperCase()} PALACE TEST')")`,
      'db.commit()',
      'db.close()',
      '',
    ].join('\n'),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-regen-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('userSlugsWithSeeds', () => {
  it('lists folders that have a seed.py, in sorted order', () => {
    makeUser('devtwo')
    makeUser('devone')
    expect(userSlugsWithSeeds(root)).toEqual(['devone', 'devtwo'])
  })

  it('skips a folder with no seed.py', () => {
    makeUser('devone')
    mkdirSync(join(root, 'devtwo'), { recursive: true })
    expect(userSlugsWithSeeds(root)).toEqual(['devone'])
  })

  it('returns an empty list when the users directory does not exist', () => {
    expect(userSlugsWithSeeds(join(root, 'nope'))).toEqual([])
  })
})

describe('regenerateAll', () => {
  it(
    'writes each user database inside that user folder and nowhere else',
    () => {
      makeUser('devone')
      makeUser('devtwo')

      const written = regenerateAll(root)

      expect(written).toEqual([
        join(root, 'devone', 'synthetic.db'),
        join(root, 'devtwo', 'synthetic.db'),
      ])
      for (const slug of ['devone', 'devtwo']) {
        const db = new Database(join(root, slug, 'synthetic.db'), {
          readonly: true,
        })
        try {
          const row = db.prepare('SELECT merchant FROM spend').get() as {
            merchant: string
          }
          expect(row.merchant).toBe(`${slug.toUpperCase()} PALACE TEST`)
        } finally {
          db.close()
        }
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'is idempotent — a second run replaces rather than doubles',
    () => {
      makeUser('devone')
      regenerateAll(root)
      regenerateAll(root)
      const db = new Database(join(root, 'devone', 'synthetic.db'), {
        readonly: true,
      })
      try {
        expect(
          (db.prepare('SELECT COUNT(*) AS n FROM spend').get() as { n: number }).n,
        ).toBe(1)
      } finally {
        db.close()
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'removes stale -wal and -shm sidecars before regenerating',
    () => {
      // A sidecar left from an older shape can resurrect rows the new
      // generator never wrote. tests/support/synthetic.ts already does this
      // for the same reason.
      makeUser('devone')
      regenerateAll(root)
      writeFileSync(join(root, 'devone', 'synthetic.db-wal'), 'stale')
      regenerateAll(root)
      expect(existsSync(join(root, 'devone', 'synthetic.db-wal'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'throws, naming the slug, when a generator fails',
    () => {
      mkdirSync(join(root, 'broken'), { recursive: true })
      writeFileSync(join(root, 'broken', 'seed.py'), 'raise SystemExit(3)\n')
      expect(() => regenerateAll(root)).toThrow(/broken/)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})
```

Create `tests/deploy/deployScript.test.ts`:

```ts
// tests/deploy/deployScript.test.ts
//
// A static scan, in the idiom of tests/deploy/service.test.ts: nothing in this
// repo can run deploy.sh, so the ordering property it must hold is pinned by
// reading it.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const script = readFileSync('deploy/deploy.sh', 'utf8')

describe('deploy/deploy.sh', () => {
  it('regenerates synthetic user databases', () => {
    expect(script).toContain('scripts/regen-synthetic.ts')
  })

  it('regenerates them BEFORE the test gate', () => {
    // users/*/synthetic.db is gitignored, so a fresh checkout has none. Tests
    // that run first would exercise the "data has not been generated yet"
    // path and pass, proving nothing about the deploy.
    const regen = script.indexOf('scripts/regen-synthetic.ts')
    const gate = script.indexOf('npx vitest run')
    expect(regen).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(-1)
    expect(regen).toBeLessThan(gate)
  })

  it('aborts the deploy when regeneration fails', () => {
    // Guarded by `if ! ...; then ... exit 1; fi`, not by a bare call whose
    // failure `set -e` would... also catch, but silently, with no line saying
    // which step died in the deploy log.
    expect(script).toMatch(
      /if ! npx tsx scripts\/regen-synthetic\.ts; then[\s\S]{0,400}?exit 1/,
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scripts/regenSynthetic.test.ts tests/deploy/deployScript.test.ts`
Expected: FAIL — unresolved import, and three failing deploy assertions.

- [ ] **Step 3: Create `scripts/regen-synthetic.ts`**

```ts
// scripts/regen-synthetic.ts
//
// Regenerate every users/<slug>/synthetic.db from that user's seed.py.
//
//   npm run synthetic
//
// users/*/synthetic.db is gitignored, so a fresh checkout — and every deploy
// — starts with none. CLAUDE.md says synthetic.db is regenerated at session
// start; this is that sentence as a command.
//
// This NEVER touches platform/dev/synthetic.db. That file holds accounts and
// sessions and is seeded by scripts/create-dev-users.ts;
// tests/support/noCross.test.ts pins the separation in both directions.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Slugs under `usersDir` that have a seed.py, sorted for stable output. */
export function userSlugsWithSeeds(usersDir: string): string[] {
  if (!existsSync(usersDir)) return []
  return readdirSync(usersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(usersDir, name, 'seed.py')))
    .sort()
}

/**
 * Run every generator. Returns the target paths written, in slug order.
 * Throws on the first failure, naming the slug — a deploy log that says
 * "regeneration failed" without saying whose is a log that sends the reader
 * to the wrong folder.
 */
export function regenerateAll(usersDir: string): string[] {
  const written: string[] = []
  for (const slug of userSlugsWithSeeds(usersDir)) {
    const target = join(usersDir, slug, 'synthetic.db')
    // The sidecars hold the same rows as the database itself; a stale one can
    // resurrect rows the new generator never wrote.
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${target}${suffix}`, { force: true })
    }
    try {
      execFileSync('python3', [join(usersDir, slug, 'seed.py'), target], {
        stdio: 'pipe',
      })
    } catch (error) {
      throw new Error(
        `users/${slug}/seed.py failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    written.push(target)
  }
  return written
}

if (process.argv[1]?.endsWith('regen-synthetic.ts')) {
  const usersDir = process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
  const written = regenerateAll(usersDir)
  if (written.length === 0) {
    console.log(`No user generators found under ${usersDir}.`)
  } else {
    for (const path of written) console.log(`Regenerated ${path}`)
  }
}
```

- [ ] **Step 4: Add the npm script**

In `package.json`, inside `"scripts"`, after `"start"`:

```json
    "synthetic": "tsx scripts/regen-synthetic.ts",
```

- [ ] **Step 5: Add the deploy step**

In `deploy/deploy.sh`, immediately after the `npm ci` line (currently line 100)
and before the `# 4. Build` comment, insert:

```bash
  # 3a. Synthetic per-user databases.
  #
  #     users/*/synthetic.db is gitignored (CLAUDE.md > Data safety: no
  #     database is ever committed), so a fresh checkout has none and every
  #     dashboard would render "its data has not been generated yet".
  #
  #     BEFORE the test gate, not after: tests/users/conventions.test.ts and
  #     the per-user suites are the things that would notice a broken
  #     generator, and a suite that runs first would happily exercise the
  #     no-data path and pass.
  #
  #     Explicit `if !` rather than leaning on `set -e`, so the deploy log
  #     carries a line naming this step instead of ending mid-script.
  if ! npx tsx scripts/regen-synthetic.ts; then
    echo >&2
    echo "DEPLOY ABORTED — synthetic user databases could not be generated." >&2
    echo "The running version is untouched." >&2
    echo >&2
    exit 1
  fi
```

- [ ] **Step 6: Record the USERS_DIR decision**

In `deploy/required-env`, inside the `# OUT OF SCOPE, deliberately:` block,
after the `CHAT_MODEL` entry, add:

```
#   USERS_DIR        exists so tests can point at a temp tree. Unlike
#                    PLATFORM_DB, its default (<cwd>/users) IS the correct
#                    production value, so falling back is not a failure mode
#                    and listing it would block deploys over a variable that
#                    should normally be unset.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run tests/scripts/regenSynthetic.test.ts tests/deploy/deployScript.test.ts
npm run synthetic
```

Expected: PASS, and `Regenerated .../users/devone/synthetic.db`.

- [ ] **Step 8: Delete-the-guard check**

1. Remove the sidecar-removal loop from `regenerateAll` and run
   `npx vitest run tests/scripts/regenSynthetic.test.ts`.
   Expected red: *only* the stale-sidecar test. Restore.
2. Replace `throw new Error(\`users/${slug}/seed.py failed: ...\`)` with a bare
   `throw error`.
   Expected red: *only* "throws, naming the slug…". Restore.
3. Move the whole `3a.` block in `deploy.sh` to just after the `npx vitest run`
   gate and run `npx vitest run tests/deploy/deployScript.test.ts`.
   Expected red: *only* "regenerates them BEFORE the test gate". Restore.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
git add scripts/regen-synthetic.ts package.json deploy/deploy.sh \
        deploy/required-env tests/scripts/regenSynthetic.test.ts \
        tests/deploy/deployScript.test.ts
git commit -m "$(cat <<'EOF'
Regenerate every user's synthetic database, and do it before the test gate

users/*/synthetic.db is gitignored, so a fresh checkout and every deploy
start with none. `npm run synthetic` is the command CLAUDE.md's
"regenerated at session start" sentence never had.

In deploy.sh it goes after npm ci and before the build and the suite. A
suite that ran first would exercise the "data has not been generated yet"
path and pass, proving nothing — so tests/deploy/deployScript.test.ts pins
the ORDER, not just the presence.

Guards verified by deletion: dropping the sidecar cleanup, the slug-naming
error wrapper, and moving the deploy step after the gate each redden
exactly one test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The scaffold script

**Files:**
- Create: `platform/templates/dashboard/schema.sql.tmpl`
- Create: `platform/templates/dashboard/seed.py.tmpl`
- Create: `platform/templates/dashboard/queries.ts.tmpl`
- Create: `platform/templates/dashboard/dashboard.tsx.tmpl`
- Create: `platform/templates/dashboard/tests/dashboard.test.ts.tmpl`
- Create: `scripts/new-dashboard.sh`
- Test: `tests/scripts/newDashboard.test.ts`

**Interfaces:**
- Consumes: the conventions from Task 4/5.
- Produces: `./scripts/new-dashboard.sh <slug>` — exit 0 on success, 2 on a bad
  or missing slug or an existing folder.

The `.tmpl` suffix is load-bearing: a `dashboard.tsx` full of `__SLUG__`
placeholders would be typechecked by Gate C, compiled by `next build`, and
collected by vitest. Nothing in the repo looks at `.tmpl`.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/newDashboard.test.ts`:

```ts
// tests/scripts/newDashboard.test.ts
//
// Runs the real script as a subprocess with cwd pointed at a disposable
// sandbox, the same way tests/scripts/pullSpec.test.ts does — so
// `users/<slug>` lands inside the sandbox and never inside the real tree, no
// matter how the process exits.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** See tests/scripts/pullSpec.test.ts — the droplet spawns processes slowly. */
const SUBPROCESS_TIMEOUT_MS = 60_000

const REPO = resolve(__dirname, '..', '..')
const sandboxes: string[] = []

afterEach(() => {
  while (sandboxes.length > 0) {
    const d = sandboxes.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

function makeSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'stairwell-new-dashboard-'))
  sandboxes.push(sandbox)
  for (const name of ['scripts', 'platform']) {
    symlinkSync(join(REPO, name), join(sandbox, name))
  }
  return sandbox
}

function run(sandbox: string, args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync(
      join(sandbox, 'scripts', 'new-dashboard.sh'),
      args,
      { cwd: sandbox, stdio: 'pipe', encoding: 'utf8' },
    )
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

describe('scripts/new-dashboard.sh', () => {
  it(
    'creates every required entry, with the slug substituted',
    () => {
      const sandbox = makeSandbox()
      const { status, output } = run(sandbox, ['devthree'])

      expect(status).toBe(0)
      const dir = join(sandbox, 'users', 'devthree')
      for (const entry of ['schema.sql', 'seed.py', 'queries.ts', 'dashboard.tsx']) {
        expect(existsSync(join(dir, entry))).toBe(true)
      }
      expect(existsSync(join(dir, 'tests', 'dashboard.test.ts'))).toBe(true)

      // No placeholder survives anywhere.
      for (const entry of ['schema.sql', 'seed.py', 'queries.ts', 'dashboard.tsx']) {
        expect(readFileSync(join(dir, entry), 'utf8')).not.toContain('__SLUG__')
      }
      expect(readFileSync(join(dir, 'dashboard.tsx'), 'utf8')).toContain('devthree')

      // The registry is NOT edited — the script prints the line instead.
      expect(output).toContain("devthree: () => import('@/users/devthree/dashboard')")
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'refuses an invalid slug and creates nothing',
    () => {
      const sandbox = makeSandbox()
      for (const bad of ['../escape', 'Dev Three', 'DEVTHREE', 'dev.three']) {
        const { status } = run(sandbox, [bad])
        expect(status).toBe(2)
      }
      expect(existsSync(join(sandbox, 'users'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'refuses to overwrite an existing folder',
    () => {
      const sandbox = makeSandbox()
      mkdirSync(join(sandbox, 'users', 'devthree'), { recursive: true })
      const { status, output } = run(sandbox, ['devthree'])
      expect(status).toBe(2)
      expect(output).toMatch(/already exists/)
      expect(existsSync(join(sandbox, 'users', 'devthree', 'schema.sql'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'requires a slug',
    () => {
      const sandbox = makeSandbox()
      const { status, output } = run(sandbox, [])
      expect(status).toBe(2)
      expect(output).toMatch(/usage/)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'produces a folder that passes the conventions sweep and generates data',
    () => {
      // The scaffold is only worth having if what comes out of it is valid on
      // the first run. This is the same check tests/users/conventions.test.ts
      // makes, applied to the generated folder rather than to a committed one.
      const sandbox = makeSandbox()
      expect(run(sandbox, ['devthree']).status).toBe(0)
      const dir = join(sandbox, 'users', 'devthree')
      const target = join(dir, 'synthetic.db')
      execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })
      expect(existsSync(target)).toBe(true)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scripts/newDashboard.test.ts`
Expected: FAIL — the script does not exist (ENOENT / status 1).

- [ ] **Step 3: Create the templates**

`platform/templates/dashboard/schema.sql.tmpl`:

```sql
-- users/__SLUG__/schema.sql
--
-- Table and view shapes for __SLUG__'s dashboard. seed.py executes THIS FILE
-- before inserting anything, so shapes have exactly one source.
--
-- CLAUDE.md > Schema & module rules: this file, seed.py and tests/ move in the
-- same commit. Gate A blocks a commit that stages this alone.

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  merchant     TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_at ON transactions(at);
```

`platform/templates/dashboard/seed.py.tmpl`:

```python
#!/usr/bin/env python3
"""Synthetic data generator for __SLUG__'s dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1]. Executes schema.sql before inserting anything.

Every value here is loudly fake (CLAUDE.md > Data safety) — a screen full of
these must read as obviously synthetic at a glance.
"""

import os
import random
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")

MERCHANTS = [
    ("COFFEE PALACE TEST", "eating out", 350, 900),
    ("GROCERY WORLD TEST", "groceries", 1500, 9000),
]

DAYS = 90
DAY_MS = 86_400_000


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    with open(SCHEMA, encoding="utf-8") as handle:
        schema = handle.read()

    rng = random.Random(1)
    now = int(time.time() * 1000)

    rows = [
        (
            merchant,
            category,
            rng.randint(low, high),
            now - back * DAY_MS + rng.randrange(DAY_MS),
        )
        for back in range(DAYS)
        for merchant, category, low, high in MERCHANTS
        if rng.random() >= 0.35
    ]

    db = sqlite3.connect(target)
    try:
        db.executescript(schema)
        db.execute("DELETE FROM transactions")
        db.executemany(
            "INSERT INTO transactions (merchant, category, amount_cents, at)"
            " VALUES (?, ?, ?, ?)",
            rows,
        )
        db.commit()
    finally:
        db.close()

    print(f"__SLUG__: {len(rows)} synthetic transactions -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`platform/templates/dashboard/queries.ts.tmpl`:

```ts
// users/__SLUG__/queries.ts
//
// Every SQL statement for __SLUG__'s dashboard. The component holds none —
// data logic in a .tsx file can only be tested by rendering it.
import type { UserDb } from '@/lib/db/userDb'

export type Transaction = {
  merchant: string
  category: string
  amount_cents: number
  at: number
}

/**
 * The most recent transactions, newest first.
 *
 * Replace this with __SLUG__'s real panels. Anything that needs "today" or
 * "this month" takes `now` as a PARAMETER — a query that reads the clock
 * itself is a query whose test passes for twenty-nine days a month.
 */
export function recentTransactions(db: UserDb, limit = 10): Transaction[] {
  return db
    .prepare(
      `SELECT merchant, category, amount_cents, at
         FROM transactions
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as Transaction[]
}
```

`platform/templates/dashboard/dashboard.tsx.tmpl`:

```tsx
// users/__SLUG__/dashboard.tsx
//
// __SLUG__'s dashboard. Handed its own slug and an open read-only handle on
// its own database; it never resolves either itself.
//
// Register it in lib/dashboard/registry.ts or it will not render:
//   __SLUG__: () => import('@/users/__SLUG__/dashboard'),
import type { DashboardProps } from '@/lib/dashboard/contract'
import { recentTransactions } from './queries'

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export default function Dashboard({ db }: DashboardProps) {
  const recent = recentTransactions(db)

  return (
    <section>
      <h2>Recent transactions</h2>
      {recent.length === 0 ? (
        <p>No transactions yet.</p>
      ) : (
        <ul>
          {recent.map((t) => (
            <li key={`${t.at}-${t.merchant}`}>
              {t.merchant} — {money(t.amount_cents)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

`platform/templates/dashboard/tests/dashboard.test.ts.tmpl`:

```ts
// users/__SLUG__/tests/dashboard.test.ts
//
// Fixtures are built here at exact values rather than generated by seed.py:
// a test whose expectations come from a generator is a test that changes its
// mind when the generator does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard from '@/users/__SLUG__/dashboard'
import { recentTransactions } from '@/users/__SLUG__/queries'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-__SLUG__-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
  db.prepare(
    'INSERT INTO transactions (merchant, category, amount_cents, at) VALUES (?, ?, ?, ?)',
  ).run('COFFEE PALACE TEST', 'eating out', 450, Date.now())
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('users/__SLUG__', () => {
  it('reads the transaction back', () => {
    expect(recentTransactions(db)[0]!.merchant).toBe('COFFEE PALACE TEST')
  })

  // Wiring, not queries: this fails if the component stops calling a query or
  // stops putting its result in the output. See the step-4 ledger's residual 1
  // for why that is worth its own test.
  it('puts the query result in the rendered output', async () => {
    const json = JSON.stringify(await Dashboard({ slug: '__SLUG__', db }))
    expect(json).toContain('COFFEE PALACE TEST')
    expect(json).toContain('$4.50')
  })
})
```

- [ ] **Step 4: Create `scripts/new-dashboard.sh`**

```bash
#!/usr/bin/env bash
# Scaffold a new user dashboard folder. Run from the repo root:
#   ./scripts/new-dashboard.sh devthree
#
# Creates users/<slug>/ from platform/templates/dashboard/ with the slug
# substituted, then PRINTS the line to add to lib/dashboard/registry.ts.
#
# It does not edit registry.ts. A regex over TypeScript source is a worse
# failure than a one-line paste, and tests/dashboard/registry.test.ts already
# turns a forgotten line into a red suite rather than a blank page.
#
# Templates carry a .tmpl suffix on purpose: a dashboard.tsx full of __SLUG__
# placeholders would be typechecked by Gate C, compiled by `next build`, and
# collected by vitest.
set -euo pipefail

main() {
  local slug="${1:-}"

  if [ -z "$slug" ]; then
    echo "usage: ./scripts/new-dashboard.sh <slug>" >&2
    exit 2
  fi

  # The same rule as lib/auth/slug.ts's SLUG_PATTERN: lowercase letters,
  # digits and hyphens, 1-32 characters. Stated here rather than imported
  # because this is bash; tests/scripts/newDashboard.test.ts pins the
  # rejections.
  case "$slug" in
    *[!a-z0-9-]*)
      echo "invalid slug '$slug': lowercase letters, digits and hyphens only" >&2
      exit 2
      ;;
  esac
  if [ ${#slug} -gt 32 ]; then
    echo "invalid slug '$slug': longer than 32 characters" >&2
    exit 2
  fi

  local dest="users/$slug"
  if [ -e "$dest" ]; then
    echo "$dest already exists — refusing to overwrite" >&2
    exit 2
  fi

  local src="platform/templates/dashboard"
  if [ ! -d "$src" ]; then
    echo "$src not found — run this from the repo root" >&2
    exit 2
  fi

  mkdir -p "$dest/tests"
  local f
  for f in schema.sql seed.py queries.ts dashboard.tsx; do
    sed "s/__SLUG__/$slug/g" "$src/$f.tmpl" > "$dest/$f"
  done
  sed "s/__SLUG__/$slug/g" "$src/tests/dashboard.test.ts.tmpl" \
    > "$dest/tests/dashboard.test.ts"
  chmod +x "$dest/seed.py"

  cat <<MSG

Created $dest

1. Add this line to DASHBOARDS in lib/dashboard/registry.ts:

     $slug: () => import('@/users/$slug/dashboard'),

   Until you do, tests/dashboard/registry.test.ts fails and the page renders
   the not-built placeholder.

2. Generate data and run the new tests:

     npm run synthetic
     npx vitest run users/$slug

3. Build toward users/$slug/mockup.html. Pull the confirmed spec first:

     ./scripts/pull-spec.sh $slug

MSG
}

main "$@"
```

Make it executable: `chmod +x scripts/new-dashboard.sh`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/scripts/newDashboard.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Delete-the-guard check**

1. Remove the `case "$slug" in *[!a-z0-9-]*)` block and run the file.
   Expected red: *only* "refuses an invalid slug and creates nothing". Restore.
2. Remove the `if [ -e "$dest" ]` block.
   Expected red: *only* "refuses to overwrite an existing folder". Restore.
3. Change the `sed` for `dashboard.tsx` to a plain `cp` (so `__SLUG__`
   survives).
   Expected red: *only* "creates every required entry, with the slug
   substituted". Restore.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add scripts/new-dashboard.sh platform/templates tests/scripts/newDashboard.test.ts
git commit -m "$(cat <<'EOF'
Scaffold a user dashboard folder from templates

The convention as an executable, not as a paragraph someone re-reads. The
script prints the registry line rather than editing registry.ts — a regex
over TypeScript source is a worse failure than a one-line paste, and the
drift test already turns a forgotten line into a red suite.

Templates carry .tmpl on purpose: a dashboard.tsx full of __SLUG__ would
be typechecked by Gate C, compiled by next build, and collected by vitest.

The last test runs the scaffolded folder's own generator, because a
scaffold is only worth having if what comes out of it is valid on the
first run.

Guards verified by deletion: dropping the slug check, the overwrite check,
and the substitution each redden exactly one test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Close the Gate B hole under `users/`

**Files:**
- Modify: `.githooks/pre-commit` (one arm in `_gate_b_class`)
- Modify: `.claude/hooks/test-hooks.sh` (two `class_check` cases)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

Today `users/registry.ts` — or any future shared file directly under `users/` —
classifies as `unguarded` and ships with no test at all. The registry now lives
in `lib/`, so this is a backstop against the next file that lands there.

Note the ordering trap, which is already documented in that file: `case` globs
match `/`, so a `users/*.ts` arm placed *before* `users/*/*` would swallow
`users/alice/queries.ts` and misclassify it as platform scope. It goes after.

- [ ] **Step 1: Write the failing test**

In `.claude/hooks/test-hooks.sh`, in the Gate B `class_check` group (after the
existing `platform/prompts` cases, around line 375), add:

```bash
  class_check "guard:platform" "users/registry.ts is guarded, not unguarded" \
    users/registry.ts
  class_check "guard:user:alice" "users/alice/queries.ts still scopes to its own user" \
    users/alice/queries.ts
```

The second case is not decoration: it is what catches a `users/*.ts` arm placed
before `users/*/*`, which would classify every per-user TypeScript file as
platform scope and let a user-folder change be satisfied by a test under
`tests/`.

- [ ] **Step 2: Run the harness to verify it fails**

Run: `.claude/hooks/test-hooks.sh`
Expected: FAIL on "users/registry.ts is guarded, not unguarded" — `got
unguarded, want guard:platform`. The alice case already passes.

- [ ] **Step 3: Add the arm**

In `.githooks/pre-commit`, in `_gate_b_class`'s "Guarded scopes" `case`, after
the closing `;;` of the `users/*/*)` arm, add:

```bash
    # A shared file directly under users/ — e.g. a registry or an index. It
    # is platform code, so its test belongs under tests/, and without this arm
    # it falls through every case below and classifies as `unguarded`.
    #
    # MUST stay AFTER users/*/* : `case` globs match '/', so users/*.ts also
    # matches users/alice/queries.ts. Placed first it would classify every
    # per-user file as platform scope, and a users/alice change would be
    # satisfied by a test under tests/. The alice case in test-hooks.sh is
    # what catches that.
    users/*.ts|users/*.tsx|users/*.sh) echo "guard:platform"; return ;;
```

- [ ] **Step 4: Run the harness to verify it passes**

Run: `.claude/hooks/test-hooks.sh`
Expected: all cases pass (156/156 — the previous 154 plus these two).

- [ ] **Step 5: Delete-the-guard check**

1. Remove the new arm and re-run the harness.
   Expected: *only* "users/registry.ts is guarded, not unguarded" fails. Restore.
2. Move the new arm *above* the `users/*/*)` arm and re-run.
   Expected: *only* "users/alice/queries.ts still scopes to its own user"
   fails. Move it back.

- [ ] **Step 6: Commit**

Both files are in the `guards` scope, and staging `.claude/hooks/test-hooks.sh`
is exactly what satisfies Gate B for a `.githooks/` change.

```bash
git add .githooks/pre-commit .claude/hooks/test-hooks.sh
git commit -m "$(cat <<'EOF'
Guard shared TypeScript sitting directly under users/

users/registry.ts classified as `unguarded` and would have shipped with no
test in any scope. The dashboard registry lives in lib/ instead, so this
is a backstop for whatever lands there next.

The arm goes AFTER users/*/*, because `case` globs match '/': placed first,
users/*.ts also matches users/alice/queries.ts and would let a per-user
change be satisfied by a test under tests/. The alice case is what catches
that, and it was verified by moving the arm up and watching only that case
fail.

Guard verified by deletion: removing the arm reddens only the registry
case.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (new section after "Schema & module rules")
- Modify: `docs/local-dev.md` (two additions)

**Interfaces:** none.

All paths here are Gate B exempt (`*.md`), so this commit stages no test.

- [ ] **Step 1: Add the conventions section to `CLAUDE.md`**

Insert after the "Schema & module rules" section, before "Build contract":

```markdown
## Dashboard folder conventions
- A user dashboard lives entirely in `users/<slug>/`. Five entries are
  required; `tests/users/conventions.test.ts` sweeps every folder and fails
  if one is missing:
  - `schema.sql` — table/view shapes
  - `seed.py` — `python3 seed.py <target.db>`; **executes `schema.sql`** before
    inserting, so shapes have exactly one source
  - `queries.ts` — every SQL statement, as pure functions taking a `UserDb`
  - `dashboard.tsx` — default-export server component, **no SQL**
  - `tests/` — at least one `*.test.ts`
- `spec.md` and `mockup.html` are written by `./scripts/pull-spec.sh <slug>`
  and are absent until a spec is confirmed. `synthetic.db` is generated and
  gitignored. `<slug>.db` arrives in step 6.
- A dashboard renders only if it is registered in `lib/dashboard/registry.ts`.
  One line: `<slug>: () => import('@/users/<slug>/dashboard'),`. A folder with
  no registry line fails `tests/dashboard/registry.test.ts`.
- Scaffold a new one — do not copy by hand:
  ```bash
  ./scripts/new-dashboard.sh <slug>   # creates the folder, prints the registry line
  npm run synthetic                   # regenerates every users/*/synthetic.db
  npx vitest run users/<slug>
  ```
- `users/devone/` is the worked reference implementation. It is hand-written,
  not agent output — see its README.
- A dashboard is handed `{ slug, db }` and never resolves either itself. It
  gets a read-only handle, so it cannot write.
- Everything a dashboard can show today is synthetic and the page says so on
  every render. Real per-user data arrives in step 6.
```

- [ ] **Step 2: Extend `docs/local-dev.md`**

In "First-time setup", after the `create-dev-users.ts` line, add:

```markdown
```bash
npm run synthetic               # generates every users/*/synthetic.db
```

`users/*/synthetic.db` is gitignored, so a fresh clone has none and every
dashboard renders "its data has not been generated yet" until this runs.
```

In the "What you should see" list, after item 10, add:

```markdown
11. `/devone` shows the reference dashboard under a **SYNTHETIC DATA** banner:
    an eating-out total and a list of `COFFEE PALACE TEST` transactions.
12. `/devtwo` shows "Nothing here yet" — devtwo has no dashboard until its
    spec is confirmed and one is built. Neither account can reach the other's
    URL at all; both get a 404, not a 403.
```

Add a new section after "Pulling a confirmed spec into the repo":

```markdown
## Building a dashboard

```bash
./scripts/new-dashboard.sh <slug>   # scaffold; prints the registry line to add
npm run synthetic                   # regenerate every users/*/synthetic.db
npx vitest run users/<slug>
```

The conventions and what each file is for: `CLAUDE.md > Dashboard folder
conventions`. `users/devone/` is a worked example.
```

- [ ] **Step 3: Verify the commands in the docs actually work**

```bash
npm run synthetic
npx vitest run users/devone
```

Expected: both succeed. A documented command that does not run is the failure
mode this step exists to avoid.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/local-dev.md
git commit -m "$(cat <<'EOF'
Document the dashboard folder conventions as commands

CLAUDE.md gains the five required entries, the registry line, and the
scaffold/regenerate/test cycle. docs/local-dev.md gains `npm run
synthetic` in first-time setup — without it a fresh clone renders "data
has not been generated yet" everywhere — and two more numbered
expectations: /devone shows the reference dashboard, /devtwo shows the
placeholder.

Every command in both files was run before committing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Full verification and the ledger

**Files:**
- Create: `docs/superpowers/ledgers/step5.md`

**Interfaces:** none.

- [ ] **Step 1: Run every layer**

These do not imply each other — run all four, and paste the actual counts into
the ledger rather than "all green".

```bash
npx vitest run
npx tsc --noEmit
npx next build
.claude/hooks/test-hooks.sh
```

Expected: suite passes with a count above 496; `tsc` silent; build succeeds;
harness 156/156.

- [ ] **Step 2: Confirm the working tree is clean of generated files**

```bash
git status --short
```

Expected: no `users/*/synthetic.db` (or `-wal`/`-shm`) listed — `.gitignore`'s
`*.db` covers them. If one appears, stop and fix `.gitignore` before anything
else.

- [ ] **Step 3: Look at the real thing**

```bash
npm run synthetic
npm run build
PLATFORM_DB=platform/dev/synthetic.db npm start
```

Then, in a browser: log in as `devone` / `TEST-DEV-ONE` → `/devone` shows the
banner and both panels; `/devtwo` is a 404 for this session. Log in as
`devtwo` / `TEST-DEV-TWO` → `/devtwo` shows "Nothing here yet".

Record what you actually saw in the ledger. If the local database has no dev
accounts yet, create them per `docs/local-dev.md` first.

- [ ] **Step 4: Write `docs/superpowers/ledgers/step5.md`**

Follow the shape of `docs/superpowers/ledgers/step4.md`: **Built** (what
shipped, plus any amendment ruled during implementation and where it was
recorded), **What the review layer caught**, **Residual risks** (numbered), **The
step-5 checkpoint** (see below), **Deferred, accepted**.

Rulings made while writing the spec, which belong in the ledger:

1. **The registry lives in `lib/`, not `users/`.** `users/<slug>/` holds only
   that user's things, and `lib/` is a scope Gate B already guards.
2. **`devone` is the reference dashboard; `devtwo` is left empty on purpose.**
   devtwo is the checkpoint account and must show the not-yet-built state.
3. **`dashboard_open` is pulled forward from step 7.** Step 5 is the first
   moment a dashboard can be opened, and a retention row not written today does
   not exist later.
4. **No `source: 'real'` branch.** Step 6 owns it, and must add its own opener
   rather than extending `openUserDb`, whose process-wide cache is correct only
   for a read-only file that changes at deploy.
5. **No schema-module include mechanism.** `modules/` stays empty until Plaid
   in step 6 gives it a second real user to generalise from.
6. **Templates are `.tmpl`-suffixed** so Gate C, `next build` and vitest never
   see a placeholder-riddled source file.

Known residuals to carry, at minimum:

- **A dashboard's queries are per-user code and only that user's own tests
  cover them.** The conventions sweep proves shape, not correctness.
- **`users/devone/seed.py` produces clock-relative timestamps.** Nothing
  asserts against its output, by design — but a future test that did would be
  flaky, and the file says so.
- **The `dashboard_error` degrade has never been seen in a browser**, only in a
  test with an injected throw.
- **Step-4 residual 8 is unchanged:** `devone` and `devtwo` are live production
  logins with published passwords, and now one of them has a dashboard behind
  it. Still synthetic data only; still should close before a real user exists.

The checkpoint section must say plainly:

> **The step-5 checkpoint does not close in this step.** It needs `devtwo`'s
> confirmed spec, which needs step 4 to have been run by a human. What ships
> here is the mechanism and one worked example. When a confirmed spec exists:
> `./scripts/pull-spec.sh devtwo` → `./scripts/new-dashboard.sh devtwo` →
> build toward `users/devtwo/mockup.html` → add the registry line →
> `npm run synthetic` → `npx vitest run` → deploy.
>
> The isolation half of the checkpoint IS observable today: `/devone` renders a
> dashboard, `/devtwo` renders the placeholder, and each account gets a 404 on
> the other's URL.

- [ ] **Step 5: Commit and push**

```bash
git add docs/superpowers/ledgers/step5.md
git commit -m "$(cat <<'EOF'
Record what step 5 shipped, what was ruled, and what it leaves open

The step-5 checkpoint does not close here: it needs devtwo's confirmed
spec, which needs step 4 to have been run by a human. The mechanism and
one worked example ship; the ledger says exactly which commands close the
checkpoint once a spec exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin step5-dashboard-hosting
```

The pre-push gate runs Gate E (`npx vitest run`) then Gate D (`npx next
build`). Both must pass unaided — do not use `SKIP_TEST_RUN_GATE` or
`SKIP_BUILD_GATE`.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §0 step-4 dependencies named | Task 10 ledger; §0 of the spec itself |
| §3 folder conventions | Tasks 4, 5, 7, 9 |
| §3 modules deferred | Task 10 ruling 5 |
| §4.1 `lib/db/userDb.ts` | Task 1 |
| §4.2 synthetic banner | Task 3 |
| §4.3 contract | Task 2 |
| §4.4 registry + `Object.hasOwn` | Task 2 |
| §5 four-way region, order, metrics, degrade | Task 3 |
| §6 `users/devone/` | Task 4 |
| §7 every named test file | Tasks 1–7 |
| §8 scaffolding + regeneration + deploy | Tasks 6, 7 |
| §9 Gate B arm | Task 8 |
| §10 documentation | Tasks 9, 10 |
| §11 known limits | Task 10 ledger |

**Type consistency:** `UserDb`, `DashboardData`, `DashboardProps`,
`DashboardModule`, `dashboardLoaderFor`, `registeredSlugs`, `openUserDb`,
`userDbPath`, `usersRoot`, `closeUserDbs`, `monthRange`,
`eatingOutThisMonthCents`, `recentTransactions`, `Transaction`,
`userSlugsWithSeeds`, `regenerateAll` are each defined once and used with the
same signature everywhere. `DashboardProps` is `{ slug, db }` in the contract
(Task 2), in devone's component (Task 4), in the template (Task 7), and in the
page's call (Task 3).

**Placeholders:** none. Every code step carries the actual content.
