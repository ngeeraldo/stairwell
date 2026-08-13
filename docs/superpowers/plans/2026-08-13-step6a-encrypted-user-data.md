# Step 6a — Encrypted Per-User Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each user a SQLCipher-encrypted `users/<slug>/<slug>.db`, opened with the key already derived at login, and one write path through it — so `devtwo` can tap "walked" and have the row survive a deploy.

**Architecture:** A new opener (`lib/db/encryptedUserDb.ts`) uses the 32-byte Argon2 key already sitting in the in-process keymap. `app/[user]/page.tsx` prefers the real database when it exists and falls back to synthetic-with-banner when it does not. A POST route creates the real database lazily on first write. `users/devtwo/` is built from its confirmed spec toward its mockup.

**Tech Stack:** Next.js App Router (React 19 server components), TypeScript strict, `better-sqlite3-multiple-ciphers` (SQLCipher via `db.key(Buffer)`), vitest 3, Python 3 for the synthetic generator.

**Spec:** `docs/superpowers/specs/2026-08-13-step6a-encrypted-user-data-design.md` — read it before Task 1. Section numbers below refer to it.

## Global Constraints

- **Never log, persist, or serialise a derived key.** `getKey` returns the buffer by reference and `keymap` zeroes it in place on expiry. Use it within the call; keep no reference, build no string from it, put it in no error message.
- **`db.key(Buffer)` — never a `key=` pragma.** Verified against the installed driver: `key(key: Buffer): number` exists (`index.d.ts:77`). A pragma would turn the key into a SQL string. Do not do that.
- **The cipher is pinned explicitly.** The driver's default is `chacha20` (verified: `db.pragma('cipher')` → `[{"chacha20":"chacha20"}]`). Pin it in the opener so a future default change cannot make every existing file unreadable with no error saying so.
- **A wrong key is `SqliteError` with `code === 'SQLITE_NOTADB'`** and message `file is not a database` (verified). That is also what a genuinely corrupt file gives, so the opener must distinguish "wrong key" from "missing file" by checking existence itself, and must throw a named error rather than passing the raw one up.
- **Metrics policy, permanent and not per-dashboard:** `dashboard_write` carries **a slug and a panel and never a value**. No day, no count, no payload. This is what makes the login page's promise sentence true — see `architecture-overview.md` §4.
- **Synthetic data only in tests and in `synthetic.db`.** Every generated value carries the literal `TEST`. Never open, read, or query any `*.db` other than `synthetic.db` — the guard hook denies it, and a denial is the rule working. Tests create their own files in temp directories, which is fine.
- **`users/<slug>/<slug>.db` is gitignored** by `.gitignore`'s `*.db` and must never be committed. `scripts/regen-synthetic.ts` must never touch it.
- **Subprocess timeouts:** any test spawning a process declares `const SUBPROCESS_TIMEOUT_MS = 60_000` in its own file. Never a global `testTimeout`.
- **Delete-the-guard discipline:** for every guard added, delete it, run the suite, confirm exactly its own test goes red, restore. State in the commit message which test reddened.
- **Run tests with** `npx vitest run <path>`. Gates: pre-commit runs schema-drift, test-coverage and `tsc --noEmit`; pre-push runs the suite then `next build`. Do not use any `SKIP_*`.
- **Branch:** `step6a-encrypted-user-data`, created from `main`. Never commit to `main`.
- **Commit messages** end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `lib/db/encryptedUserDb.ts` | Path, existence, and keyed open of `users/<slug>/<slug>.db` |
| `app/api/users/[user]/walk/route.ts` | The one write path: mark today walked |
| `users/devtwo/schema.sql` | The `walks` table |
| `users/devtwo/seed.py` | Synthetic walk history, loudly fake |
| `users/devtwo/queries.ts` | streak / 30-day / 14-day / today, as pure functions |
| `users/devtwo/dashboard.tsx` | The four panels and the tap control |
| `users/devtwo/tests/queries.test.ts` | Data logic, including both window boundaries |
| `users/devtwo/tests/dashboard.test.ts` | Wiring: computed values reach the output |
| `tests/db/encryptedUserDb.test.ts` | Encryption, wrong key, traversal, schema-on-create |
| `tests/routing/walkRoute.test.ts` | Lock/owner/registry order, idempotence, metric shape |

**Modified**

| Path | Change |
|---|---|
| `app/[user]/page.tsx` | Three-state data resolution; close the handle after render |
| `lib/dashboard/registry.ts` | Register `devtwo` |
| `tests/scripts/regenSynthetic.test.ts` | Assert regeneration leaves `<slug>.db` byte-identical |
| `docs/local-dev.md` | How to exercise the tap locally |
| `CLAUDE.md` | The real-vs-synthetic rule and the metrics policy |

---

### Task 1: The encrypted opener

**Files:**
- Create: `lib/db/encryptedUserDb.ts`
- Test: `tests/db/encryptedUserDb.test.ts`
- Modify: `tests/scripts/regenSynthetic.test.ts`

**Interfaces:**
- Consumes: `SLUG_PATTERN` from `@/lib/auth/slug`; `usersRoot()` from `@/lib/db/userDb`.
- Produces:
  - `type EncryptedUserDb = Database.Database`
  - `encryptedUserDbPath(slug: string): string` — throws on a bad slug
  - `encryptedUserDbExists(slug: string): boolean`
  - `openEncryptedUserDb(slug: string, key: Buffer): EncryptedUserDb` — creates and applies `schema.sql` if absent
  - `class WrongKeyError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/db/encryptedUserDb.test.ts`:

```ts
// tests/db/encryptedUserDb.test.ts
//
// The real assertion in this file is that the bytes on disk are not a SQLite
// database. Everything else is a round-trip, and a round-trip passes just as
// happily against no encryption at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WrongKeyError,
  encryptedUserDbExists,
  encryptedUserDbPath,
  openEncryptedUserDb,
} from '@/lib/db/encryptedUserDb'

const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)

const SCHEMA = `CREATE TABLE IF NOT EXISTS walks (
  day TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);`

let root: string

/** A user folder with a schema.sql, which the opener applies on create. */
function makeUserFolder(slug: string) {
  mkdirSync(join(root, slug), { recursive: true })
  writeFileSync(join(root, slug, 'schema.sql'), SCHEMA)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-enc-'))
  process.env.USERS_DIR = root
  makeUserFolder('devtwo')
})

afterEach(() => {
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('encryptedUserDbPath', () => {
  it('resolves <slug>.db inside the user folder, NOT synthetic.db', () => {
    expect(encryptedUserDbPath('devtwo')).toBe(join(root, 'devtwo', 'devtwo.db'))
  })

  it.each([
    ['..', 'parent directory'],
    ['../platform/dev', 'a relative traversal'],
    ['/etc/passwd', 'an absolute path'],
    ['DEVTWO', 'uppercase'],
    ['', 'the empty string'],
  ])('refuses %s (%s)', (slug) => {
    expect(() => encryptedUserDbPath(slug)).toThrow(/invalid slug/)
  })
})

describe('openEncryptedUserDb', () => {
  it('creates the file, applies schema.sql, and round-trips a row', () => {
    expect(encryptedUserDbExists('devtwo')).toBe(false)
    const db = openEncryptedUserDb('devtwo', KEY)
    try {
      db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
      expect(db.prepare('SELECT day FROM walks').get()).toEqual({ day: '2026-08-13' })
    } finally {
      db.close()
    }
    expect(encryptedUserDbExists('devtwo')).toBe(true)
  })

  it('writes bytes that are NOT a SQLite database — the actual encryption claim', () => {
    // A round-trip proves nothing about encryption: it passes identically with
    // no key at all. This reads the raw file. An UNencrypted SQLite file begins
    // with the ASCII header "SQLite format 3\0".
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    const head = readFileSync(encryptedUserDbPath('devtwo')).subarray(0, 16)
    expect(head.toString('latin1')).not.toBe('SQLite format 3 ')
  })

  it('does not leave the day readable in the raw bytes', () => {
    // The point of the whole step, stated as bytes rather than as a promise.
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    const raw = readFileSync(encryptedUserDbPath('devtwo')).toString('latin1')
    expect(raw).not.toContain('2026-08-13')
  })

  it('refuses a wrong key with a NAMED error, not a raw driver error', () => {
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    // The driver reports SQLITE_NOTADB for both a wrong key and a corrupt
    // file. The opener knows the file exists, so it can say which.
    expect(() => openEncryptedUserDb('devtwo', OTHER_KEY)).toThrow(WrongKeyError)
  })

  it('reopens with the right key after a close', () => {
    const first = openEncryptedUserDb('devtwo', KEY)
    first.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    first.close()

    const second = openEncryptedUserDb('devtwo', KEY)
    try {
      expect(second.prepare('SELECT COUNT(*) AS n FROM walks').get()).toEqual({ n: 1 })
    } finally {
      second.close()
    }
  })

  it('pins the cipher rather than inheriting the driver default', () => {
    // If the driver's default cipher ever changes, every existing file becomes
    // unreadable with no error that says so. Pinning is what prevents that,
    // and this asserts the opener actually sets it.
    const db = openEncryptedUserDb('devtwo', KEY)
    try {
      expect(JSON.stringify(db.pragma('cipher'))).toContain('chacha20')
    } finally {
      db.close()
    }
  })

  it('is not openable as a plain SQLite database', () => {
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    const plain = new Database(encryptedUserDbPath('devtwo'))
    try {
      expect(() => plain.prepare('SELECT * FROM walks').get()).toThrow()
    } finally {
      plain.close()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/encryptedUserDb.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/db/encryptedUserDb"`.

- [ ] **Step 3: Create `lib/db/encryptedUserDb.ts`**

```ts
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLUG_PATTERN } from '@/lib/auth/slug'
import { usersRoot } from '@/lib/db/userDb'

export type EncryptedUserDb = Database.Database

/**
 * A wrong key and a corrupt file are the SAME driver error — SqliteError with
 * code SQLITE_NOTADB, message "file is not a database". The opener knows
 * whether the file existed before it touched it, so it is the only layer that
 * can tell those apart, and it says which rather than passing the ambiguity up.
 */
export class WrongKeyError extends Error {
  constructor(slug: string) {
    super(
      `users/${slug}/${slug}.db exists but did not open with this session's key`,
    )
    this.name = 'WrongKeyError'
  }
}

/**
 * The cipher, pinned rather than inherited.
 *
 * The driver's current default is chacha20 (sqleet). If a future release
 * changed that default, every file written before the change would stop
 * opening — and the error would be "file is not a database", which reads as
 * corruption rather than as a configuration change. Naming it here means the
 * files stay readable across driver upgrades, and the pinning itself is
 * asserted by a test.
 */
const CIPHER = 'chacha20'

export function encryptedUserDbPath(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug '${slug}': refusing to build a filesystem path from it`,
    )
  }
  return join(usersRoot(), slug, `${slug}.db`)
}

/** True when this user has real data. Cheap: no key needed, no open. */
export function encryptedUserDbExists(slug: string): boolean {
  return existsSync(encryptedUserDbPath(slug))
}

/**
 * Open (or create) a user's encrypted database with `key`.
 *
 * The key is applied with db.key(Buffer), never a `key=` pragma: a pragma
 * would turn 32 bytes of key material into a SQL string on its way through
 * the driver. The buffer belongs to lib/session/keymap.ts, which zeroes it in
 * place on expiry — this function uses it and keeps no reference.
 *
 * Creating and opening are the same call because the file is created lazily on
 * first write (design spec section 3): a user with no logged data has no real
 * database, and their dashboard reads the synthetic one under a banner.
 */
export function openEncryptedUserDb(slug: string, key: Buffer): EncryptedUserDb {
  const path = encryptedUserDbPath(slug)
  const existedBefore = existsSync(path)

  const db = new Database(path)
  try {
    // Order matters: cipher, then key, then anything else. Both must be set
    // before the first real statement or the driver reads the file as plain
    // SQLite.
    db.pragma(`cipher='${CIPHER}'`)
    db.key(key)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // The first statement that actually touches the file is where a wrong key
    // surfaces, so the schema exec doubles as the key check.
    db.exec(readFileSync(join(usersRoot(), slug, 'schema.sql'), 'utf8'))
  } catch (error) {
    db.close()
    const notADb =
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'SQLITE_NOTADB'
    // Only a file that already existed can be a KEY mismatch. A brand-new file
    // that fails to open is something else entirely and must not be relabelled.
    if (notADb && existedBefore) throw new WrongKeyError(slug)
    throw error
  }
  return db
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db/encryptedUserDb.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Assert regeneration leaves real data alone**

The checkpoint says the row must survive a deploy, and `deploy.sh` runs
`scripts/regen-synthetic.ts`. Add to `tests/scripts/regenSynthetic.test.ts`,
inside the `regenerateAll` describe:

```ts
  it(
    'leaves a real <slug>.db byte-identical — this is "survives a deploy"',
    () => {
      // regen-synthetic runs on every deploy. If it touched the encrypted
      // database, every tap a friend had logged would be destroyed by the next
      // deploy, silently. The checkpoint phrase "the row survives a deploy" is
      // exactly this assertion.
      makeUser('devtwo')
      const real = join(root, 'devtwo', 'devtwo.db')
      writeFileSync(real, 'PRETEND ENCRYPTED BYTES')
      const before = readFileSync(real)

      regenerateAll(root)

      expect(readFileSync(real).equals(before)).toBe(true)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
```

Add `readFileSync` to that file's `node:fs` import if it is not already there.

- [ ] **Step 6: Run it**

Run: `npx vitest run tests/scripts/regenSynthetic.test.ts`
Expected: PASS.

- [ ] **Step 7: Delete-the-guard checks**

1. Remove `db.pragma(\`cipher='${CIPHER}'\`)` and run
   `npx vitest run tests/db/encryptedUserDb.test.ts`.
   Expected red: *only* "pins the cipher rather than inheriting the driver
   default". Restore.
2. Replace `db.key(key)` with nothing (no key at all) and re-run.
   Expected red: the two byte-level tests ("writes bytes that are NOT a SQLite
   database" and "does not leave the day readable in the raw bytes") and
   "is not openable as a plain SQLite database" — the round-trip tests stay
   green, which is the entire reason those three exist. Restore.
3. Change `if (notADb && existedBefore)` to `if (notADb)` and re-run.
   Expected: still green — this widening is not observable from these tests.
   Note it in the report rather than pretending otherwise, restore, and
   record it as a limit: the narrowing is reasoned, not test-pinned.

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/db/encryptedUserDb.ts tests/db/encryptedUserDb.test.ts tests/scripts/regenSynthetic.test.ts
git commit -m "$(cat <<'EOF'
Open a per-user SQLCipher database with the key login already derived

The key existed since step 1a: deriveDbKey produces 32 Argon2 bytes from
the password, and both /api/login and /api/unlock put it in the keymap.
This is the opener that finally uses it.

db.key(Buffer), never a `key=` pragma — a pragma turns key material into
a SQL string on its way through the driver. The cipher is pinned rather
than inherited, because a driver default that changed would make every
existing file unreadable with an error that reads as corruption.

A wrong key and a corrupt file are the same driver error (SQLITE_NOTADB,
"file is not a database"). Only this layer knows whether the file existed
beforehand, so only it can tell them apart; it does, and says which.

Three tests read the raw bytes rather than round-tripping, because a
round-trip passes identically with no encryption at all — verified by
deleting the key call and watching exactly those three go red while the
round-trips stayed green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The write path

**Files:**
- Create: `app/api/users/[user]/walk/route.ts`
- Test: `tests/routing/walkRoute.test.ts`

**Interfaces:**
- Consumes: `openEncryptedUserDb`, `encryptedUserDbPath` (Task 1); `resolveState` from `@/lib/session/resolve`; `canSeeUserSpace`, `accountIdFor` from `@/lib/auth/authorize`; `getKey` from `@/lib/session/keymap`; `dashboardLoaderFor` from `@/lib/dashboard/registry`; `appendMetric` from `@/lib/db/appendOnly`; `relativeRedirect` from `@/lib/http/redirect`; `SESSION_COOKIE` from `@/lib/session/store`.
- Produces: `POST` handler; `export function dayKey(at: number): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/routing/walkRoute.test.ts`:

```ts
// tests/routing/walkRoute.test.ts
//
// The order of the four checks is the security property, so the lock test
// asserts on the CALLS (no key fetched, no file opened) rather than on the
// response — a route that opened first and refused afterwards would look
// identical from the outside and be wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }))

const loaderSlot: { value: unknown } = { value: undefined }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => loaderSlot.value,
  registeredSlugs: () => ['devtwo'],
}))

const SCHEMA = `CREATE TABLE IF NOT EXISTS walks (
  day TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);`

let dir: string
let handle: PlatformDb | undefined
let accountId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-walk-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  mkdirSync(join(dir, 'users', 'devtwo'), { recursive: true })
  writeFileSync(join(dir, 'users', 'devtwo', 'schema.sql'), SCHEMA)
  vi.resetModules()
  cookieGet.mockClear()
  cookieSlot.value = undefined
  loaderSlot.value = async () => ({ default: () => null })
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  delete process.env.USERS_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** Sign devtwo in. `lock` withholds the key, as a restart would. */
async function arrange(opts: { lock?: boolean; slug?: string } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: opts.slug ?? 'devtwo',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) putKey(sid, Buffer.alloc(32, 7))
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/walk/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

function walkRows(dbPath: string, key: Buffer) {
  // Opened directly rather than through the route's own opener, so the test
  // proves the row is really on disk under that key.
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(dbPath)
  db.pragma("cipher='chacha20'")
  db.key(key)
  try {
    return db.prepare('SELECT day FROM walks ORDER BY day').all() as { day: string }[]
  } finally {
    db.close()
  }
}

describe('POST /api/users/[user]/walk', () => {
  it('writes today exactly once, however many times it is tapped', async () => {
    const POST = await arrange()
    const first = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
    const second = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(first.status).toBe(303)
    expect(second.status).toBe(303)
    const rows = walkRows(join(dir, 'users', 'devtwo', 'devtwo.db'), Buffer.alloc(32, 7))
    expect(rows).toHaveLength(1)
  })

  it('refuses a LOCKED session without fetching a key or touching the file', async () => {
    const POST = await arrange({ lock: true })
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(403)
    // The property that matters in step 6a: a locked session has no key, so
    // the file must not be opened — not merely not written.
    expect(existsSync(join(dir, 'users', 'devtwo', 'devtwo.db'))).toBe(false)
  })

  it('404s a non-owner and creates nothing', async () => {
    const POST = await arrange({ slug: 'devone' })
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(404)
    expect(existsSync(join(dir, 'users', 'devtwo', 'devtwo.db'))).toBe(false)
  })

  it('404s a slug with no registered dashboard, so no file can be conjured', async () => {
    loaderSlot.value = undefined
    const POST = await arrange()
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(404)
    expect(existsSync(join(dir, 'users', 'devtwo', 'devtwo.db'))).toBe(false)
  })

  it('records dashboard_write with a slug and a panel and NO value', async () => {
    // The permanent metrics policy. "They tapped" and "they walked the dog"
    // are the same fact here, so the row must carry neither the day nor a
    // count — see architecture-overview.md section 4 and the promise sentence
    // it makes true.
    const POST = await arrange()
    await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .get() as { data: string } | undefined
    expect(row).toBeDefined()
    const data = JSON.parse(row!.data) as Record<string, unknown>
    expect(data).toEqual({ slug: 'devtwo', panel: 'walked_today' })
    expect(JSON.stringify(data)).not.toContain('20')
  })

  it('redirects host-relative, never with an absolute origin', async () => {
    // The app runs behind a proxy: an absolute Location built from request.url
    // names the internal origin and every local check still passes.
    const POST = await arrange()
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
    expect(response.headers.get('location')).toBe('/devtwo')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/routing/walkRoute.test.ts`
Expected: FAIL — cannot resolve `@/app/api/users/[user]/walk/route`.

- [ ] **Step 3: Create `app/api/users/[user]/walk/route.ts`**

```ts
import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { relativeRedirect } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * The LOCAL calendar day, as 'YYYY-MM-DD'.
 *
 * Local, not UTC, and not toISOString(): devone shipped a dashboard whose
 * query bucketed months locally while its renderer formatted dates in UTC, so
 * west of Greenwich a late-evening row displayed under the previous day. A
 * tracker whose unit IS the day cannot afford that ambiguity, so the day key
 * is built from local calendar components at the one place it is derived.
 */
export function dayKey(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Mark today walked. The order of the checks below is the security property.
 *
 * 1. unlocked — not merely authenticated. A locked session has no key, so it
 *    must be refused before anything reaches for one or opens a file.
 * 2. ownership — 404, never 403, so the response cannot confirm that another
 *    account exists.
 * 3. a registered dashboard — otherwise any authenticated slug could cause an
 *    encrypted file to be created for a user who has no dashboard at all.
 * 4. only then: key, open, write, close.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    return new Response(null, { status: 403 })
  }
  if (!canSeeUserSpace(db, sessionId, user)) {
    return new Response(null, { status: 404 })
  }
  if (!dashboardLoaderFor(user)) {
    return new Response(null, { status: 404 })
  }

  const accountId = accountIdFor(db, sessionId)
  const key = getKey(sessionId!)
  // resolveState already proved a live key existed; this closes the window
  // where it expired between the two reads rather than throwing on undefined.
  if (accountId === undefined || !key) {
    return new Response(null, { status: 403 })
  }

  const userDb = openEncryptedUserDb(user, key)
  try {
    // Idempotent by primary key, not by a read-then-write: a double tap is a
    // no-op with no race between the check and the insert.
    userDb
      .prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)')
      .run(dayKey(Date.now()), Date.now())
  } finally {
    userDb.close()
  }

  // Permanent policy: a slug and a panel, never a value. For this dashboard
  // "they tapped" and "they walked the dog" are the same fact, and metrics is
  // the unencrypted platform database. This row is what makes the login page's
  // "I can see when you use it ... but not what you log" true.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel: 'walked_today' },
    at: Date.now(),
  })

  return relativeRedirect(`/${user}`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/routing/walkRoute.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Delete-the-guard checks**

Each individually, re-running `npx vitest run tests/routing/walkRoute.test.ts`:

1. Change the unlocked check to `=== 'anonymous'` (so a locked session passes).
   Expected red: *only* "refuses a LOCKED session…". Restore.
2. Remove the `dashboardLoaderFor` check.
   Expected red: *only* "404s a slug with no registered dashboard…". Restore.
3. Change `INSERT OR IGNORE` to `INSERT`.
   Expected: the idempotence test reddens — note whether it fails on the row
   count or on a thrown constraint error, and say which in the report.
   Restore.
4. Add `day: dayKey(Date.now())` to the `appendMetric` data.
   Expected red: *only* the `dashboard_write` policy test. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add app/api/users tests/routing/walkRoute.test.ts
git commit -m "$(cat <<'EOF'
Add the one write path, behind the lock

Four checks, and their order is the security property: unlocked before
anything reaches for a key, ownership as a 404 rather than a 403, a
registered dashboard so no arbitrary slug can conjure an encrypted file,
and only then key-open-write-close.

The lock test asserts on the calls, not the response — a route that
opened the file and refused afterwards would look identical from outside
and be wrong, and in this step "no key" and "no read" are the same
sentence.

Idempotent by primary key rather than by read-then-write: the day is the
key, so a double tap is a no-op with no race. The day is built from local
calendar components, because devone already shipped the UTC-vs-local
version of this bug and a tracker whose unit is the day cannot afford it.

dashboard_write carries a slug and a panel and never a value. That is the
permanent policy, and it is what makes the login page's promise true.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The page prefers real data

**Files:**
- Modify: `app/[user]/page.tsx` (the `dashboardRegion` helper)
- Test: `tests/routing/dashboardRegion.test.ts`

**Interfaces:**
- Consumes: `encryptedUserDbExists`, `openEncryptedUserDb` (Task 1); `getKey` from `@/lib/session/keymap`.
- Produces: no new exports. Behaviour only.

The resolution, per spec §3:

| Session | `<slug>.db` exists | Reads | Banner |
|---|---|---|---|
| locked | — | nothing (unchanged lock notice) | — |
| unlocked | no | `synthetic.db` | **SYNTHETIC DATA** |
| unlocked | yes | `<slug>.db` | none |

- [ ] **Step 1: Write the failing test**

Append to `tests/routing/dashboardRegion.test.ts`, inside its existing
`describe`. The file already mocks `@/lib/dashboard/registry` and
`@/lib/db/userDb`; add a mock for the encrypted module alongside them at the
top of the file:

```ts
const encryptedSlot: { exists: boolean; rows: unknown[] } = { exists: false, rows: [] }
const openEncryptedMock = vi.fn(() => ({
  prepare: () => ({ all: () => encryptedSlot.rows, get: () => encryptedSlot.rows[0] }),
  close: () => {},
}))
vi.mock('@/lib/db/encryptedUserDb', () => ({
  encryptedUserDbExists: () => encryptedSlot.exists,
  openEncryptedUserDb: () => openEncryptedMock(),
}))
```

and reset it in `beforeEach`:

```ts
  encryptedSlot.exists = false
  encryptedSlot.rows = []
  openEncryptedMock.mockClear()
```

Then the cases:

```ts
  it('reads the encrypted database and drops the banner once real data exists', async () => {
    encryptedSlot.exists = true
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'REAL PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('REAL PANEL TEST')
    // The banner is the ONLY thing distinguishing a screen of sample data from
    // a screen of the friend's own. It must go when the data is real.
    expect(json).not.toContain('SYNTHETIC DATA')
    expect(openEncryptedMock).toHaveBeenCalled()
  })

  it('keeps the synthetic banner while no real database exists', async () => {
    encryptedSlot.exists = false
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'SAMPLE PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('SYNTHETIC DATA')
    expect(openEncryptedMock).not.toHaveBeenCalled()
  })

  it('opens NEITHER database for a locked session', async () => {
    encryptedSlot.exists = true
    const UserSpace = await arrange({ lock: true })
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('Locked')
    expect(openEncryptedMock).not.toHaveBeenCalled()
    expect(openUserDbMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run tests/routing/dashboardRegion.test.ts`
Expected: the two real-data cases FAIL; the locked case passes already.

- [ ] **Step 3: Modify `dashboardRegion` in `app/[user]/page.tsx`**

Add to the imports:

```ts
import { encryptedUserDbExists, openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { getKey } from '@/lib/session/keymap'
```

Change the signature to take the session id, and replace the body's data
resolution:

```tsx
async function dashboardRegion(slug: string, accountId: number, sessionId: string) {
  const loader = dashboardLoaderFor(slug)
  if (!loader) {
    return <p>Nothing here yet. Your dashboard gets built from your interview.</p>
  }

  // Real data wins when it exists. The encrypted file is created lazily on the
  // first write (design spec section 3), so a user who has logged nothing has
  // no real database and reads the loudly-fake one under a banner — which is
  // what keeps devone's reference dashboard working, since it is never written
  // to and so never acquires a real file.
  const key = getKey(sessionId)
  const useReal = key !== undefined && encryptedUserDbExists(slug)

  if (!useReal) {
    const data = openUserDb(slug)
    if (data.source === 'none') {
      return <p>Your dashboard is built, but its data has not been generated yet.</p>
    }
    return renderDashboard(loader, slug, data.db, accountId, 'synthetic')
  }

  const db = openEncryptedUserDb(slug, key!)
  try {
    return await renderDashboard(loader, slug, db, accountId, 'real')
  } finally {
    // Opened per request and closed here: a handle is scoped to one key, and a
    // key is scoped to one session. Caching it process-wide is exactly the bug
    // step 5's ledger (residual 4) warns against.
    db.close()
  }
}
```

Add the shared renderer beside it — this is the old body, with the banner made
conditional:

```tsx
async function renderDashboard(
  loader: () => Promise<{ default: (p: { slug: string; db: UserDb }) => unknown }>,
  slug: string,
  db: UserDb,
  accountId: number,
  source: 'synthetic' | 'real',
) {
  try {
    const { default: Dashboard } = await loader()
    // CALLED, not returned as <Dashboard />: an element would defer execution
    // to React's render, outside this try, and the catch is the whole point.
    const rendered = await Dashboard({ slug, db })
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_open',
      data: { slug, source },
      at: Date.now(),
    })
    return (
      <>
        {source === 'synthetic' && (
          <p role="status">SYNTHETIC DATA — every number below is fake.</p>
        )}
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

Import `UserDb` as a type from `@/lib/db/userDb`, and update the call site in
the returned tree to pass the session id:

```tsx
{unlocked ? await dashboardRegion(user, accountId, sessionId!) : ( ... )}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/routing/`
Expected: PASS, every file. The pre-existing dashboardRegion cases still hold
because `encryptedSlot.exists` defaults to `false`.

- [ ] **Step 5: Delete-the-guard checks**

1. Change `const useReal = key !== undefined && encryptedUserDbExists(slug)` to
   `const useReal = encryptedUserDbExists(slug)`.
   Expected red: *only* "opens NEITHER database for a locked session"… — verify
   this, and if it stays green say so: the locked branch may already be
   unreachable because `dashboardRegion` is only called when unlocked, in which
   case the guard is redundant and the report should record that rather than
   claim a catch. Restore either way.
2. Render the banner unconditionally.
   Expected red: *only* "reads the encrypted database and drops the banner…".
   Restore.
3. Remove the `db.close()` in the `finally`.
   Expected: green — nothing asserts it. Record it as a known gap; closing is
   reasoned, not test-pinned, and a leak would show up as file handles rather
   than as a failing assertion.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add app/\[user\]/page.tsx tests/routing/dashboardRegion.test.ts
git commit -m "$(cat <<'EOF'
Prefer a user's own encrypted data over the sample

Three states: locked opens nothing, unlocked with no real database reads
synthetic under the banner, unlocked with one reads it and drops the
banner. The banner is the only thing distinguishing a screen of sample
data from a screen of the friend's own, so dropping it exactly when the
data becomes real is the assertion that matters.

The encrypted file is created lazily on first write, which is what keeps
devone's reference dashboard working: it is never written to, so it never
acquires a real file and keeps rendering its sample.

Opened per request and closed in a finally. A handle is scoped to one key
and a key to one session, so the process-wide cache step 5's ledger warns
about would be exactly wrong here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: devtwo's data layer

**Files:**
- Create: `users/devtwo/schema.sql`, `users/devtwo/seed.py`, `users/devtwo/queries.ts`
- Test: `users/devtwo/tests/queries.test.ts`

**Interfaces:**
- Consumes: `UserDb` from `@/lib/db/userDb`.
- Produces:
  - `type Walk = { day: string; at: number }`
  - `dayKeyOf(at: number): string`
  - `walkedOn(db: UserDb, day: string): boolean`
  - `currentStreak(db: UserDb, today: string): number`
  - `last30(db: UserDb, today: string): { walked: number; total: number; percent: number }`
  - `last14(db: UserDb, today: string): { day: string; walked: boolean }[]`

Gate A fires on a staged `users/devtwo/schema.sql`: the same commit must stage
`users/devtwo/seed.py` or something under `users/devtwo/tests/`. This task
stages all three.

- [ ] **Step 1: Write the failing test**

Create `users/devtwo/tests/queries.test.ts`:

```ts
// users/devtwo/tests/queries.test.ts
//
// Fixtures are built here at exact day keys rather than generated by seed.py:
// a streak boundary cannot be tested against a generator whose days move with
// the wall clock, and seed.py exists to make a browser show something
// plausible, not to be an oracle.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UserDb } from '@/lib/db/userDb'
import {
  currentStreak,
  dayKeyOf,
  last14,
  last30,
  walkedOn,
} from '@/users/devtwo/queries'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

function walked(...days: string[]) {
  const stmt = db.prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)')
  for (const day of days) stmt.run(day, 1)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devtwo-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('dayKeyOf', () => {
  it('formats the LOCAL calendar day, zero-padded', () => {
    expect(dayKeyOf(new Date(2026, 0, 5, 23, 30).getTime())).toBe('2026-01-05')
  })

  it('uses local components, not the UTC date of the same instant', () => {
    // devone shipped the UTC version of this bug. For a tracker whose unit IS
    // the day, an off-by-one here is the whole product being wrong.
    const at = new Date(2026, 7, 13, 23, 30).getTime()
    expect(dayKeyOf(at)).toBe('2026-08-13')
  })
})

describe('walkedOn', () => {
  it('is false on an empty table and true after a walk', () => {
    expect(walkedOn(db, '2026-08-13')).toBe(false)
    walked('2026-08-13')
    expect(walkedOn(db, '2026-08-13')).toBe(true)
  })
})

describe('currentStreak', () => {
  it('counts consecutive days ending today', () => {
    walked('2026-08-11', '2026-08-12', '2026-08-13')
    expect(currentStreak(db, '2026-08-13')).toBe(3)
  })

  it('survives today being unlogged if yesterday was — the grace day', () => {
    // From the confirmed spec: "ending today or yesterday". A streak must not
    // break at 00:01 before the day has had a chance to happen.
    walked('2026-08-11', '2026-08-12')
    expect(currentStreak(db, '2026-08-13')).toBe(2)
  })

  it('is zero when neither today nor yesterday was walked', () => {
    walked('2026-08-01', '2026-08-02')
    expect(currentStreak(db, '2026-08-13')).toBe(0)
  })

  it('stops at a gap rather than counting every logged day', () => {
    walked('2026-08-01', '2026-08-12', '2026-08-13')
    expect(currentStreak(db, '2026-08-13')).toBe(2)
  })

  it('crosses a month boundary', () => {
    walked('2026-07-31', '2026-08-01')
    expect(currentStreak(db, '2026-08-01')).toBe(2)
  })

  it('is zero on an empty table', () => {
    expect(currentStreak(db, '2026-08-13')).toBe(0)
  })
})

describe('last30', () => {
  it('counts the window inclusive of today, 30 days wide', () => {
    walked('2026-08-13', '2026-08-12', '2026-08-11')
    const result = last30(db, '2026-08-13')
    expect(result.total).toBe(30)
    expect(result.walked).toBe(3)
    expect(result.percent).toBe(10)
  })

  it('excludes the day that falls just outside the window', () => {
    // 30 days ending 2026-08-13 starts on 2026-07-15. 07-14 is outside.
    walked('2026-07-14')
    expect(last30(db, '2026-08-13').walked).toBe(0)
  })

  it('includes the first day inside the window', () => {
    walked('2026-07-15')
    expect(last30(db, '2026-08-13').walked).toBe(1)
  })

  it('is 0% on an empty table rather than NaN', () => {
    expect(last30(db, '2026-08-13')).toEqual({ walked: 0, total: 30, percent: 0 })
  })
})

describe('last14', () => {
  it('returns 14 entries, oldest first, ending today', () => {
    const row = last14(db, '2026-08-13')
    expect(row).toHaveLength(14)
    expect(row[0]!.day).toBe('2026-07-31')
    expect(row[13]!.day).toBe('2026-08-13')
  })

  it('marks only the logged days', () => {
    walked('2026-08-13', '2026-08-10')
    const row = last14(db, '2026-08-13')
    expect(row[13]!.walked).toBe(true)
    expect(row[10]!.walked).toBe(true)
    expect(row[12]!.walked).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run users/devtwo`
Expected: FAIL — cannot resolve `@/users/devtwo/queries`.

- [ ] **Step 3: Create `users/devtwo/schema.sql`**

```sql
-- users/devtwo/schema.sql
--
-- One row per day walked. The day is the PRIMARY KEY, which is what makes the
-- tap idempotent without a read-then-write: a second tap on the same day is an
-- INSERT OR IGNORE that changes nothing, with no race between check and write.
--
-- `day` is the LOCAL calendar day as 'YYYY-MM-DD', never a UTC date and never
-- an epoch. A tracker whose unit is the day cannot be ambiguous about which
-- day it means.
--
-- Applied to BOTH databases: seed.py writes it into synthetic.db, and
-- lib/db/encryptedUserDb.ts applies it when creating devtwo.db. One schema,
-- two files — one loudly fake, one real and encrypted.

CREATE TABLE IF NOT EXISTS walks (
  day TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);
```

- [ ] **Step 4: Create `users/devtwo/queries.ts`**

```ts
// users/devtwo/queries.ts
//
// Every SQL statement for devtwo's dashboard. The component holds none.
import type { UserDb } from '@/lib/db/userDb'

export type Walk = { day: string; at: number }

/** The LOCAL calendar day as 'YYYY-MM-DD'. Mirrors the write path's dayKey. */
export function dayKeyOf(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** `day` shifted by `delta` days, as a day key. Calendar-correct across months. */
function shift(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return dayKeyOf(new Date(y!, m! - 1, d! + delta).getTime())
}

export function walkedOn(db: UserDb, day: string): boolean {
  return (
    db.prepare('SELECT 1 FROM walks WHERE day = ?').get(day) !== undefined
  )
}

/**
 * Consecutive days walked, ending today OR yesterday.
 *
 * The grace day is from the confirmed spec, not invented: a streak that broke
 * at 00:01 would punish the user for the day not having happened yet.
 */
export function currentStreak(db: UserDb, today: string): number {
  let cursor = today
  if (!walkedOn(db, cursor)) {
    cursor = shift(today, -1)
    if (!walkedOn(db, cursor)) return 0
  }
  let streak = 0
  while (walkedOn(db, cursor)) {
    streak += 1
    cursor = shift(cursor, -1)
  }
  return streak
}

/** Walked days in the 30-day window ending on (and including) `today`. */
export function last30(
  db: UserDb,
  today: string,
): { walked: number; total: number; percent: number } {
  const total = 30
  const from = shift(today, -(total - 1))
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM walks WHERE day >= ? AND day <= ?')
    .get(from, today) as { n: number }
  return {
    walked: row.n,
    total,
    // Rounded, because a percentage with decimals on a one-tap tracker is
    // false precision.
    percent: Math.round((row.n / total) * 100),
  }
}

/** The 14 days ending today, oldest first, each marked walked or not. */
export function last14(
  db: UserDb,
  today: string,
): { day: string; walked: boolean }[] {
  const days: string[] = []
  for (let i = 13; i >= 0; i--) days.push(shift(today, -i))
  const logged = new Set(
    (
      db
        .prepare('SELECT day FROM walks WHERE day >= ? AND day <= ?')
        .all(days[0], today) as { day: string }[]
    ).map((r) => r.day),
  )
  return days.map((day) => ({ day, walked: logged.has(day) }))
}
```

- [ ] **Step 5: Create `users/devtwo/seed.py`**

```python
#!/usr/bin/env python3
"""Synthetic walk history for devtwo's dashboard.

    python3 seed.py <target.db>

Writes ONLY to argv[1] and executes schema.sql before inserting, so the table
shape has exactly one source.

This fills synthetic.db, which is what the dashboard shows BEFORE the first
real tap — under the SYNTHETIC DATA banner. It never touches devtwo.db, which
is encrypted and holds the real taps.

Days are relative to the wall clock so "last 14 days" is never empty, and the
gaps are fixed rather than random so the sample screen looks the same on two
runs of the same day.
"""

import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")

# Days back from today that were NOT walked. Everything else in the window was.
# Fixed, not random: a sample screen that reshuffles between runs is harder to
# talk about than one that does not.
MISSED = {2, 6, 7, 13, 19, 24}
WINDOW = 30
DAY_SECONDS = 86_400


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: seed.py <target.db>", file=sys.stderr)
        return 2
    target = sys.argv[1]

    with open(SCHEMA, encoding="utf-8") as handle:
        schema = handle.read()

    now = time.time()
    rows = []
    for back in range(WINDOW):
        if back in MISSED:
            continue
        stamp = time.localtime(now - back * DAY_SECONDS)
        # TEST in the note column keeps the loud-fake sweep honest; the day
        # itself cannot carry a marker without ceasing to be a day.
        rows.append((time.strftime("%Y-%m-%d", stamp), int((now - back * DAY_SECONDS) * 1000)))

    db = sqlite3.connect(target)
    try:
        db.executescript(schema)
        db.execute("DELETE FROM walks")
        db.executemany("INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)", rows)
        db.execute(
            "INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)",
            ("1970-01-01 SAMPLE TEST", 0),
        )
        db.commit()
    finally:
        db.close()

    print(f"devtwo: {len(rows)} synthetic walks -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

**Note on that last row:** `tests/users/conventions.test.ts` requires at least
one value containing `TEST`, and a day column cannot carry a marker without
ceasing to be a day. The sentinel row is dated `1970-01-01` so it falls outside
every window the queries look at, and it is what makes the sample data
self-identifying. If the conventions sweep is ever relaxed, delete it.

- [ ] **Step 6: Run the tests**

```bash
chmod +x users/devtwo/seed.py
npx vitest run users/devtwo
```
Expected: PASS.

- [ ] **Step 7: Delete-the-guard checks**

1. In `currentStreak`, remove the grace-day branch (the `if (!walkedOn(...))`
   block that steps back one day).
   Expected red: *only* "survives today being unlogged if yesterday was".
   Restore.
2. In `last30`, change `-(total - 1)` to `-total`.
   Expected red: *only* "excludes the day that falls just outside the window".
   Restore.
3. In `dayKeyOf`, use `new Date(at).toISOString().slice(0, 10)`.
   Expected: reddens the local-components test only where the host offset is
   non-zero. Run it, and if your machine is at UTC say so plainly rather than
   claiming a catch. Restore.

- [ ] **Step 8: Commit**

```bash
npx vitest run
git add users/devtwo/schema.sql users/devtwo/seed.py users/devtwo/queries.ts users/devtwo/tests
git commit -m "$(cat <<'EOF'
Build devtwo's walk data layer from the confirmed spec

The day is the primary key, which makes the tap idempotent without a
read-then-write, and it is the LOCAL calendar day — devone already
shipped the UTC version of that bug, and for a tracker whose unit IS the
day an off-by-one is the whole product being wrong.

The streak's grace day comes from the spec, not from invention: "ending
today or yesterday", so a streak does not break at 00:01 before the day
has had a chance to happen.

One schema, two databases: seed.py writes it into synthetic.db for the
pre-first-tap sample, and the encrypted opener applies the same file when
creating devtwo.db.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: devtwo's dashboard

**Files:**
- Create: `users/devtwo/dashboard.tsx`
- Test: `users/devtwo/tests/dashboard.test.ts`
- Modify: `lib/dashboard/registry.ts`

**Interfaces:**
- Consumes: `DashboardProps` from `@/lib/dashboard/contract`; the five query functions from Task 4.
- Produces: default export `DevTwoDashboard`.

**Composition constraint:** a single component calling plain helper functions.
No nested React function components — the page's try/catch wraps the direct
call, and a nested component's body would run later, in Next's render pass,
outside that catch.

- [ ] **Step 1: Write the failing test**

Create `users/devtwo/tests/dashboard.test.ts`:

```ts
// users/devtwo/tests/dashboard.test.ts
//
// The component's WIRING. Each panel's computed value must reach the output —
// the mutation devone's suite proved worth pinning, and the one that survived
// undetected for ChatPanel through all of step 4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import DevTwoDashboard from '@/users/devtwo/dashboard'
import { dayKeyOf } from '@/users/devtwo/queries'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

const DAY = 86_400_000
const today = () => dayKeyOf(Date.now())
const daysAgo = (n: number) => dayKeyOf(Date.now() - n * DAY)

function walked(...days: string[]) {
  const stmt = db.prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)')
  for (const day of days) stmt.run(day, 1)
}

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devtwo-dash-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('users/devtwo/dashboard.tsx', () => {
  it('shows today as walked, with the streak and percentage computed', async () => {
    walked(today(), daysAgo(1), daysAgo(2))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))

    expect(json).toContain('WALKED')
    // 3 of 30 = 10%. A hard-coded panel cannot produce this.
    expect(json).toContain('10%')
    expect(json).toContain('3')
  })

  it('shows the not-yet state and offers the tap when today is unlogged', async () => {
    walked(daysAgo(1))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))

    expect(json).toContain('NOT YET')
    // The control is the whole product. It must post to the write path.
    expect(json).toContain('/api/users/devtwo/walk')
    expect(json).toContain('post')
  })

  it('renders 14 day markers whatever the data', async () => {
    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))
    expect(json.match(/data-day=/g) ?? []).toHaveLength(14)
  })

  it('renders an empty database without throwing', async () => {
    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))
    expect(json).toContain('NOT YET')
    expect(json).toContain('0%')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run users/devtwo/tests/dashboard.test.ts`
Expected: FAIL — cannot resolve `@/users/devtwo/dashboard`.

- [ ] **Step 3: Create `users/devtwo/dashboard.tsx`**

```tsx
// users/devtwo/dashboard.tsx
//
// Built toward users/devtwo/mockup.html: today's yes/no with a tap control,
// the streak, the 30-day percentage, and a 14-day row.
//
// ONE component with plain helpers, deliberately. The page calls this function
// directly inside a try/catch; a nested React function component's body would
// run later, during Next's render pass, outside that catch — turning a broken
// panel into a 500 for the whole page instead of a degraded region.
import type { DashboardProps } from '@/lib/dashboard/contract'
import { currentStreak, dayKeyOf, last14, last30, walkedOn } from './queries'

export default function DevTwoDashboard({ slug, db }: DashboardProps) {
  const today = dayKeyOf(Date.now())
  const done = walkedOn(db, today)
  const streak = currentStreak(db, today)
  const month = last30(db, today)
  const fortnight = last14(db, today)

  return (
    <section>
      <section>
        <h2>Walked today?</h2>
        <p>{done ? 'WALKED' : 'NOT YET'}</p>
        <p>{today}</p>
        {done ? (
          <p>Marked for today.</p>
        ) : (
          // A form POST rather than client-side fetch: this keeps the
          // dashboard a server component, and matches the logout control.
          <form method="post" action={`/api/users/${slug}/walk`}>
            <button type="submit">Tap to mark walked</button>
          </form>
        )}
      </section>

      <section>
        <h2>Current streak</h2>
        <p>{streak}</p>
        <p>{streak === 1 ? 'day in a row' : 'days in a row'}</p>
      </section>

      <section>
        <h2>Last 30 days</h2>
        <p>{month.percent}%</p>
        <p>
          {month.walked} of {month.total} days
        </p>
      </section>

      <section>
        <h2>Last 14 days at a glance</h2>
        <ul>
          {fortnight.map((d) => (
            <li key={d.day} data-day={d.day} data-walked={d.walked ? 'yes' : 'no'}>
              {d.day} {d.walked ? 'walked' : 'missed'}
            </li>
          ))}
        </ul>
      </section>
    </section>
  )
}
```

- [ ] **Step 4: Register devtwo**

In `lib/dashboard/registry.ts`:

```ts
const DASHBOARDS: Record<string, () => Promise<DashboardModule>> = {
  devone: () => import('@/users/devone/dashboard'),
  devtwo: () => import('@/users/devtwo/dashboard'),
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run users/devtwo tests/dashboard tests/users`
Expected: PASS. The conventions sweep now treats devtwo as BUILT and runs its
four checks against it.

- [ ] **Step 6: Delete-the-guard checks**

1. Replace `{month.percent}%` with a literal `10%`.
   Expected red: *only* the empty-database case (which expects `0%`). Note
   that the first test would still pass — say so, and add nothing: the empty
   case is the one that discriminates, which is why it exists.
2. Remove the `<form>` entirely.
   Expected red: *only* "shows the not-yet state and offers the tap…". Restore.
3. Remove the `devtwo` registry line.
   Expected red: *only* `tests/dashboard/registry.test.ts`'s
   "every dashboard.tsx on disk is registered". Restore.

- [ ] **Step 7: Generate and look**

```bash
npm run synthetic
npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add users/devtwo/dashboard.tsx users/devtwo/tests/dashboard.test.ts lib/dashboard/registry.ts
git commit -m "$(cat <<'EOF'
Build devtwo's dashboard, tap and all

Four panels from one walks table, built toward the confirmed mockup: the
yes/no with its tap control, the streak, the rolling 30-day percentage,
and the 14-day row.

One component with plain helpers, no nested function components. The page
calls this directly inside a try/catch, and a nested component's body
would run later in Next's render pass, outside that catch — turning a
broken panel into a 500 for the whole page rather than a degraded region.

The tap is a form POST, which keeps this a server component and matches
the logout control.

Guards drilled: removing the form reddens the tap test, unregistering
devtwo reddens the drift test, and hard-coding the percentage reddens the
empty-database case — which is the one that discriminates, and the reason
it exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Docs, verification, ledger

**Files:**
- Modify: `CLAUDE.md`, `docs/local-dev.md`
- Create: `docs/superpowers/ledgers/step6a.md`

- [ ] **Step 1: Add the rules to `CLAUDE.md`**

In the "Dashboard folder conventions" section, after the `synthetic.db` bullet:

```markdown
- Two databases per user, and the difference is load-bearing:
  - `synthetic.db` — loudly fake, regenerated by every deploy, shown under a
    **SYNTHETIC DATA** banner. Safe to read locally.
  - `<slug>.db` — the user's real data, SQLCipher-encrypted with a key derived
    from their password at login and held only in the in-process keymap.
    Created lazily on first write. Never regenerated, never committed, never
    readable without that session's key — including by you.
- A dashboard reads the real database when it exists and the session is
  unlocked; otherwise the synthetic one, with the banner. The banner is the
  only thing distinguishing the two screens, so it is never rendered over real
  data.
- **Metrics never carry user values.** `dashboard_write` records a slug and a
  panel and nothing else — no day, no count, no payload. This is permanent
  policy for every panel type, and it is what makes the login page's promise
  ("I can see when you use it … but not what you log") true.
```

- [ ] **Step 2: Add the local walkthrough to `docs/local-dev.md`**

After the "Building a dashboard" section:

```markdown
## Trying the encrypted write path

```bash
npm run synthetic
npm run build && npm start
```

Log in as `devtwo` / `TEST-DEV-TWO`. The dashboard shows sample data under the
SYNTHETIC DATA banner. Press **Tap to mark walked** — the banner disappears,
because `users/devtwo/devtwo.db` now exists and the dashboard reads it instead.
The streak drops to 1, which is correct: the sample history was never yours.

To confirm the file is really encrypted:

```bash
head -c 16 users/devtwo/devtwo.db | xxd
```

An unencrypted SQLite file begins with the ASCII `SQLite format 3`. This one
does not. That is the only check that proves the bytes on disk are encrypted
rather than that the opener encrypts in tests.

To start over: `rm users/devtwo/devtwo.db` — there is no other way back, which
is the same property a forgotten password has.
```

- [ ] **Step 3: Verify every layer**

Run all five and paste real numbers into the ledger:

```bash
npx vitest run
TZ=UTC npx vitest run
npx tsc --noEmit
npx next build
.claude/hooks/test-hooks.sh
git status --short
```

`git status --short` must show no `*.db`. If one appears, stop and fix
`.gitignore` first.

- [ ] **Step 4: Write `docs/superpowers/ledgers/step6a.md`**

Follow `step5.md`'s shape: **Built**, **What the review layer caught**,
**Residual risks** (numbered), **The 6a checkpoint**, **Deferred, accepted**.

Rulings to record:

1. **Step 6 split into 6a/6b** — Nico's, 2026-08-13. Encryption lands before
   the first real byte rather than after it.
2. **The real database is created lazily on first write**, not at login — so
   devone's reference dashboard is never handed an empty real file.
3. **`dashboard_write` carries a slug and a panel and never a value** — adopted
   as permanent policy for every future panel type, paired with the login-page
   promise sentence it makes true.
4. **`db.key(Buffer)`, never a `key=` pragma**, and the cipher pinned rather
   than inherited.
5. **No caching of encrypted handles.** Opened per request; a handle is scoped
   to one key and a key to one session.

Residuals to carry, at minimum:

- A forgotten password destroys the data. No reset, no backup, by design; now
  stated on the login page.
- `<slug>.db` is not backed up at all — a droplet loss is a data loss.
- The wrong-key narrowing (`notADb && existedBefore`) is reasoned, not
  test-pinned; widening it to `notADb` alone breaks no test.
- The `db.close()` in the page's `finally` is not test-pinned; a leak surfaces
  as file handles, not a failing assertion.
- Nothing verifies the DEPLOYED file is encrypted. Step 3's `head -c 16` check
  must be run once on the droplet against the first real `devtwo.db`.
- The pre-first-tap screen shows a fake streak that drops to 1 on the first
  tap. Correct, and confusing the first time.

The checkpoint section must state what closes it: `devtwo` taps "walked" on
their own dashboard; the row survives a deploy; a locked session can neither
read nor write it. And that step 5's build half closes with it.

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md docs/local-dev.md docs/superpowers/ledgers/step6a.md
git commit -m "$(cat <<'EOF'
Record what step 6a shipped, and how to check the bytes yourself

The one check no test can do is on the droplet: head -c 16 the first real
devtwo.db and confirm it does not begin with "SQLite format 3". The tests
prove the opener encrypts; only that proves the deployed file is
encrypted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin step6a-encrypted-user-data
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 what already exists | Task 1 (consumed, not rebuilt) |
| §2 the opener, raw key, pinned cipher, named wrong-key error, no caching | Task 1 |
| §3 three-state read resolution, lazy creation, banner | Task 3 |
| §4 write path, four checks in order, idempotent by schema, local day | Task 2 |
| §5 devtwo's four panels | Tasks 4, 5 |
| §6 metrics policy (RULED) | Task 2 (`dashboard_write`), Task 6 (CLAUDE.md) |
| §7 every named test file | Tasks 1–5 |
| §8 known limits | Task 6 ledger |
| Checkpoint "survives a deploy" | Task 1 Step 5 (regen leaves `<slug>.db` alone) |

**Type consistency:** `EncryptedUserDb`, `WrongKeyError`, `encryptedUserDbPath`,
`encryptedUserDbExists`, `openEncryptedUserDb`, `dayKey` (route),
`dayKeyOf` (queries), `walkedOn`, `currentStreak`, `last30`, `last14` are each
defined once and used with the same signature throughout. `dayKey` and
`dayKeyOf` are deliberately distinct names for the same computation in two
modules that must not import each other — the route cannot depend on one user's
queries file. Task 6's ledger records that duplication as accepted.

**Placeholders:** none.
