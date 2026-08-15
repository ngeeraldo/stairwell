# User Database Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a friend's encrypted tables changeable in shape without losing their rows, by running migrations at the only moment their key exists — when they unlock.

**Architecture:** Per-friend numbered SQL files under `users/<slug>/migrations/` become the sole source of database shape, replacing `schema.sql`. A runner fires at the three points a key enters the keymap, compares `PRAGMA user_version` against the highest migration, copies the database aside, and applies what is pending inside per-migration transactions. A failure refuses the session rather than rendering over a half-migrated shape. The real-vs-synthetic fallback is deleted: production always serves the encrypted database, dev always serves `synthetic.db` for both reads and writes.

**Tech Stack:** TypeScript, Next.js App Router, better-sqlite3-multiple-ciphers (SQLCipher), vitest, Python 3 (seed scripts only).

**Spec:** `docs/superpowers/specs/2026-08-15-user-db-migrations-design.md` — read it before Task 1. Every decision below argues from it, and the D-numbers referenced in tasks are its §1.

## Global Constraints

- **Migrations are immutable** (D2). Never edit an existing migration file; add a new one. This includes fixing a typo in one you added an hour ago, if it has been applied anywhere.
- **A migration never seeds rows** (D9). DDL only. No `INSERT`.
- **`PRAGMA user_version` is the only bookkeeping** (D8). Never create a `_migrations` table inside a friend's database.
- **`reshape.ts` is never pointed at a user database** (D5). Its zero-rows proof is exactly the assumption that fails on real data.
- **Alerts and metrics carry no user values.** Slug, migration number and error `code` only — never an error `message`, which can carry a column's contents.
- **No user-facing copy may imply recovery exists.** The backup is same-key; a forgotten password still destroys everything.
- **Every dashboard renders on zero rows.** An empty database is a normal state, not an error.
- **Test commands:** `npx vitest run <path>` to scope, `npx vitest run` for all. `npx tsc --noEmit` for types. Never `npm test`.
- **Never open or query any `*.db` but `synthetic.db`** — the guard hook denies it, and a denial is the rule working.

---

## File Structure

**Create:**
- `lib/db/migrationFiles.ts` — discovery and manifest verification. Pure filesystem + crypto, touches no database.
- `lib/db/migrate.ts` — the runner: version read, backup, apply, version write.
- `lib/db/userData.ts` — the one place that answers "which database does this slug use, for reading and for writing", branching on `NODE_ENV`.
- `lib/auth/refuseSession.ts` — the shared refusal exit: drop key, log, alert.
- `users/*/migrations/001_initial.sql` + `manifest.json` — per friend.
- `platform/templates/dashboard/migrations/001_initial.sql.tmpl` + `manifest.json.tmpl`.

**Modify:**
- `lib/db/encryptedUserDb.ts` — delete `createEmptyEncryptedUserDb` and the `applySchema` flag; export the atomic create for the runner.
- `app/[user]/page.tsx:101-122` — delete the real-vs-synthetic branch.
- `app/api/users/[user]/walk/route.ts:68` — open through `userData.ts`.
- `app/api/login/route.ts`, `lib/auth/flow.ts`, `lib/invite/register.ts` — call the runner.
- `lib/copy/onboarding.ts` — fourth pinned block.
- `platform/templates/dashboard/seed.py.tmpl` + every `users/*/seed.py` — run migrations, stamp `user_version`.
- `scripts/new-dashboard.sh` — scaffold `migrations/` not `schema.sql`.
- `tests/users/conventions.test.ts:45` — new required list.
- `screenshots/screens.ts` — empty-state variant.
- `CLAUDE.md`, `docs/dashboard-build-rules.md`.

**Delete:**
- `users/*/schema.sql`, `platform/templates/dashboard/schema.sql.tmpl`.

---

## Task 1: Migration discovery and manifest verification

**Files:**
- Create: `lib/db/migrationFiles.ts`
- Test: `tests/db/migrationFiles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Migration = { number: number; name: string; path: string; sql: string; sha256: string }`
  - `listMigrations(slug: string): Migration[]` — numeric order, `[]` when the folder has none.
  - `class ManifestError extends Error { readonly migrationNumber: number }`
  - `verifyManifest(slug: string): void` — throws `ManifestError` on any mismatch.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/migrationFiles.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestError, listMigrations, verifyManifest } from '@/lib/db/migrationFiles'

let root: string
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function writeMigration(slug: string, file: string, sql: string) {
  mkdirSync(join(root, slug, 'migrations'), { recursive: true })
  writeFileSync(join(root, slug, 'migrations', file), sql)
}
function writeManifest(slug: string, entries: { number: number; sha256: string }[]) {
  writeFileSync(
    join(root, slug, 'migrations', 'manifest.json'),
    JSON.stringify({ migrations: entries }, null, 2),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-mig-'))
  process.env.USERS_DIR = root
})
afterEach(() => {
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('listMigrations', () => {
  it('returns numeric order, not lexical', () => {
    writeMigration('sam', '010_ten.sql', 'SELECT 10;')
    writeMigration('sam', '002_two.sql', 'SELECT 2;')
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    expect(listMigrations('sam').map((m) => m.number)).toEqual([1, 2, 10])
  })

  it('is empty for a folder with no migrations directory', () => {
    mkdirSync(join(root, 'sam'), { recursive: true })
    expect(listMigrations('sam')).toEqual([])
  })

  it('ignores manifest.json and any non-.sql file', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeManifest('sam', [{ number: 1, sha256: sha('SELECT 1;') }])
    writeFileSync(join(root, 'sam', 'migrations', 'notes.md'), 'hi')
    expect(listMigrations('sam').map((m) => m.number)).toEqual([1])
  })

  it('throws on a duplicate number rather than picking one', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeMigration('sam', '001_other.sql', 'SELECT 2;')
    expect(() => listMigrations('sam')).toThrow(/duplicate/i)
  })
})

describe('verifyManifest', () => {
  it('passes when every file matches its recorded checksum', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeManifest('sam', [{ number: 1, sha256: sha('SELECT 1;') }])
    expect(() => verifyManifest('sam')).not.toThrow()
  })

  it('throws when an applied migration was edited — D2', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1 EDITED;')
    writeManifest('sam', [{ number: 1, sha256: sha('SELECT 1;') }])
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('names the migration number it refused on', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeMigration('sam', '002_two.sql', 'EDITED;')
    writeManifest('sam', [
      { number: 1, sha256: sha('SELECT 1;') },
      { number: 2, sha256: sha('SELECT 2;') },
    ])
    try {
      verifyManifest('sam')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ManifestError).migrationNumber).toBe(2)
    }
  })

  it('throws when a file exists with no manifest entry', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeManifest('sam', [])
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('throws when the manifest lists a file that is gone', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeManifest('sam', [
      { number: 1, sha256: sha('SELECT 1;') },
      { number: 2, sha256: sha('SELECT 2;') },
    ])
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('is a no-op when there are no migrations and no manifest', () => {
    mkdirSync(join(root, 'sam'), { recursive: true })
    expect(() => verifyManifest('sam')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/migrationFiles.test.ts`
Expected: FAIL — cannot resolve `@/lib/db/migrationFiles`.

- [ ] **Step 3: Implement**

```ts
// lib/db/migrationFiles.ts
//
// Which migrations exist for a friend, and whether they are the ones that were
// reviewed. Pure filesystem and crypto: this module opens no database and needs
// no key, which is what lets it run before anything is unlocked.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { usersRoot } from '@/lib/db/userDb'
import { SLUG_PATTERN } from '@/lib/auth/slug'

export type Migration = {
  number: number
  name: string
  path: string
  sql: string
  sha256: string
}

/**
 * A migration file is not the one the manifest recorded.
 *
 * Carries the number rather than the text: this reaches an ntfy alert, and
 * alerts carry no user values (CLAUDE.md > Metrics).
 */
export class ManifestError extends Error {
  readonly migrationNumber: number
  constructor(migrationNumber: number, detail: string) {
    super(`migration ${migrationNumber}: ${detail}`)
    this.name = 'ManifestError'
    this.migrationNumber = migrationNumber
  }
}

function migrationsDir(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) throw new Error(`invalid slug '${slug}'`)
  return join(usersRoot(), slug, 'migrations')
}

const FILENAME = /^(\d{3})_[a-z0-9_]+\.sql$/

export function listMigrations(slug: string): Migration[] {
  const dir = migrationsDir(slug)
  if (!existsSync(dir)) return []

  const found = new Map<number, Migration>()
  for (const name of readdirSync(dir)) {
    const match = FILENAME.exec(name)
    if (!match) continue
    const number = Number(match[1])
    if (found.has(number)) {
      // Never pick one. Two files claiming 002 means the numbering was
      // reused, and applying either silently would apply half a change.
      throw new Error(`users/${slug}/migrations: duplicate number ${number}`)
    }
    const path = join(dir, name)
    const sql = readFileSync(path, 'utf8')
    found.set(number, {
      number,
      name,
      path,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    })
  }
  return [...found.values()].sort((a, b) => a.number - b.number)
}

type ManifestEntry = { number: number; sha256: string }

export function verifyManifest(slug: string): void {
  const migrations = listMigrations(slug)
  const manifestPath = join(migrationsDir(slug), 'manifest.json')

  if (migrations.length === 0 && !existsSync(manifestPath)) return
  if (!existsSync(manifestPath)) {
    throw new ManifestError(migrations[0]?.number ?? 0, 'manifest.json missing')
  }

  const recorded = new Map<number, string>(
    (JSON.parse(readFileSync(manifestPath, 'utf8')).migrations as ManifestEntry[]).map(
      (e) => [e.number, e.sha256],
    ),
  )

  for (const migration of migrations) {
    const expected = recorded.get(migration.number)
    if (expected === undefined) {
      throw new ManifestError(migration.number, 'file has no manifest entry')
    }
    if (expected !== migration.sha256) {
      // D2: applied migrations are immutable. An edited file and a stamped
      // version are two descriptions of one change that no longer agree.
      throw new ManifestError(migration.number, 'file does not match manifest checksum')
    }
    recorded.delete(migration.number)
  }

  for (const number of recorded.keys()) {
    throw new ManifestError(number, 'manifest entry has no file')
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/db/migrationFiles.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/db/migrationFiles.ts tests/db/migrationFiles.test.ts
git commit -m "Find a friend's migrations, and refuse the ones that changed"
```

---

## Task 2: The runner applies pending migrations

**Files:**
- Create: `lib/db/migrate.ts`
- Modify: `lib/db/encryptedUserDb.ts` — export the atomic create for reuse
- Test: `tests/db/migrate.test.ts`

**Interfaces:**
- Consumes: `listMigrations`, `verifyManifest`, `ManifestError` (Task 1); `openEncryptedUserDb`, `encryptedUserDbPath` (existing).
- Produces:
  - `class MigrationFailure extends Error { readonly migrationNumber: number; readonly code: string }`
  - `migrateUserDb(slug: string, key: Buffer): void` — creates the file if absent, applies pending migrations, throws `MigrationFailure` on any failure.

Backup is **not** in this task — Task 3 adds it, with its own tests.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/migrate.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MigrationFailure, migrateUserDb } from '@/lib/db/migrate'
import { encryptedUserDbPath, openEncryptedUserDb } from '@/lib/db/encryptedUserDb'

const KEY = Buffer.alloc(32, 7)
let root: string

function migration(slug: string, n: number, name: string, sql: string) {
  const dir = join(root, slug, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(n).padStart(3, '0')}_${name}.sql`), sql)
  rewriteManifest(slug)
}

/** Rebuild manifest.json from whatever is on disk — test helper only. */
function rewriteManifest(slug: string) {
  const dir = join(root, slug, 'migrations')
  const entries = require('node:fs')
    .readdirSync(dir)
    .filter((f: string) => f.endsWith('.sql'))
    .map((f: string) => ({
      number: Number(f.slice(0, 3)),
      sha256: createHash('sha256')
        .update(require('node:fs').readFileSync(join(dir, f), 'utf8'))
        .digest('hex'),
    }))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ migrations: entries }))
}

function version(slug: string): number {
  const db = openEncryptedUserDb(slug, KEY, { readonly: true })
  try {
    return db.pragma('user_version', { simple: true }) as number
  } finally {
    db.close()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-run-'))
  process.env.USERS_DIR = root
})
afterEach(() => {
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('migrateUserDb', () => {
  it('creates the database and applies 001 for a friend who has never logged in', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)

    expect(existsSync(encryptedUserDbPath('sam'))).toBe(true)
    expect(version('sam')).toBe(1)
  })

  it('creates the file and applies nothing when the friend has no migrations yet', () => {
    // S2: the database exists the moment the password does, dashboard or not.
    mkdirSync(join(root, 'sam'), { recursive: true })
    migrateUserDb('sam', KEY)
    expect(existsSync(encryptedUserDbPath('sam'))).toBe(true)
    expect(version('sam')).toBe(0)
  })

  it('applies only what is pending, in order', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    expect(version('sam')).toBe(2)
    const db = openEncryptedUserDb('sam', KEY, { readonly: true })
    try {
      const cols = (db.pragma('table_info(weigh_ins)') as { name: string }[]).map((c) => c.name)
      expect(cols).toContain('note')
    } finally {
      db.close()
    }
  })

  it('is a cheap no-op when already at the highest number', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)
    // Running again must not throw on a re-executed CREATE TABLE.
    expect(() => migrateUserDb('sam', KEY)).not.toThrow()
    expect(version('sam')).toBe(1)
  })

  it('PRESERVES ROWS across an ALTER — the whole point (D1/D3)', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)

    const write = openEncryptedUserDb('sam', KEY)
    try {
      write.prepare('INSERT INTO weigh_ins (day, lb) VALUES (?, ?)').run('2026-08-15', 200.4)
    } finally {
      write.close()
    }

    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    const read = openEncryptedUserDb('sam', KEY, { readonly: true })
    try {
      const row = read.prepare('SELECT day, lb FROM weigh_ins').get() as {
        day: string
        lb: number
      }
      expect(row).toEqual({ day: '2026-08-15', lb: 200.4 })
    } finally {
      read.close()
    }
  })

  it('leaves the version untouched when a migration throws', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'broken', 'ALTER TABLE nonexistent ADD COLUMN x TEXT;')

    expect(() => migrateUserDb('sam', KEY)).toThrow(MigrationFailure)
    expect(version('sam')).toBe(1)
  })

  it('names the failing migration number and a code, never the message', () => {
    migration('sam', 1, 'broken', 'THIS IS NOT SQL;')
    try {
      migrateUserDb('sam', KEY)
      throw new Error('should have thrown')
    } catch (e) {
      const failure = e as MigrationFailure
      expect(failure.migrationNumber).toBe(1)
      expect(typeof failure.code).toBe('string')
      expect(failure.code.length).toBeGreaterThan(0)
    }
  })

  it('refuses before applying anything when the manifest does not match', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    writeFileSync(
      join(root, 'sam', 'migrations', '001_initial.sql'),
      'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL, edited INTEGER);',
    )
    expect(() => migrateUserDb('sam', KEY)).toThrow(MigrationFailure)
    expect(existsSync(encryptedUserDbPath('sam'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: FAIL — cannot resolve `@/lib/db/migrate`.

- [ ] **Step 3: Export the atomic create from `encryptedUserDb.ts`**

In `lib/db/encryptedUserDb.ts`, change `createEncryptedUserDb`'s signature to drop the `applySchema` option added earlier today and never apply a schema — migrations own the shape now (D6):

```ts
/**
 * Build a real database at `path`, atomically, holding NO tables.
 *
 * Shape is applied by lib/db/migrate.ts and nowhere else (D6). This function
 * exists to produce the encrypted file itself: the `journal_mode = WAL` pragma
 * below writes the encrypted header, so the result is a real SQLCipher
 * database rather than a zero-byte file that opens under any key.
 */
export function createEmptyEncryptedDbAt(slug: string, path: string, key: Buffer): void {
```

Keep the whole temp-and-link body as it is; delete only the `schemaTextFor` call and the `applySchema` parameter. Delete `schemaTextFor` itself and the now-unused `createEmptyEncryptedUserDb` wrapper. Update `openEncryptedUserDb`'s create branch to call `createEmptyEncryptedDbAt(slug, path, key)`.

- [ ] **Step 4: Implement the runner**

```ts
// lib/db/migrate.ts
//
// Migrations run at the ONE moment a friend's key exists: when they unlock.
// There is no deploy-time or startup-time alternative — the key lives only in
// the in-process keymap for the length of their session and is never
// serialized, so nothing on the server can open their database without them.
// See docs/superpowers/specs/2026-08-15-user-db-migrations-design.md.
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import { ManifestError, listMigrations, verifyManifest } from '@/lib/db/migrationFiles'
import {
  createEmptyEncryptedDbAt,
  encryptedUserDbPath,
  openEncryptedUserDb,
} from '@/lib/db/encryptedUserDb'

/**
 * A migration did not apply, so this session must be refused.
 *
 * Carries a NUMBER and a CODE and never the driver's message: a constraint
 * violation can quote a column's contents, and this reaches an ntfy alert.
 */
export class MigrationFailure extends Error {
  readonly migrationNumber: number
  readonly code: string
  constructor(migrationNumber: number, code: string) {
    super(`migration ${migrationNumber} failed (${code})`)
    this.name = 'MigrationFailure'
    this.migrationNumber = migrationNumber
    this.code = code
  }
}

/**
 * One in-process lock per slug. Sufficient only because the service is a
 * single process — the same assumption lib/session/keymap.ts already makes.
 * It fails by ALLOWING two concurrent migrations rather than by refusing, so
 * it is named here rather than left to be discovered.
 */
const running = new Set<string>()

export function migrateUserDb(slug: string, key: Buffer): void {
  if (running.has(slug)) return
  running.add(slug)
  try {
    runMigrations(slug, key)
  } finally {
    running.delete(slug)
  }
}

function runMigrations(slug: string, key: Buffer): void {
  // BEFORE the file is created, so a bad manifest never brings a database
  // into being. tests/db/migrate.test.ts pins that.
  try {
    verifyManifest(slug)
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new MigrationFailure(error.migrationNumber, 'MANIFEST_MISMATCH')
    }
    throw error
  }

  const path = encryptedUserDbPath(slug)
  if (!existsSync(path)) createEmptyEncryptedDbAt(slug, path, key)

  const migrations = listMigrations(slug)
  const target = migrations.length === 0 ? 0 : migrations[migrations.length - 1].number

  const db = openEncryptedUserDb(slug, key)
  try {
    const current = db.pragma('user_version', { simple: true }) as number
    if (current >= target) return

    for (const migration of migrations) {
      if (migration.number <= current) continue
      try {
        // The version moves inside the SAME transaction as the DDL it
        // describes, so a crash can never leave a database whose recorded
        // version and actual shape disagree.
        db.exec('BEGIN')
        db.exec(migration.sql)
        db.pragma(`user_version = ${migration.number}`)
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Already rolled back by the driver. Nothing to add.
        }
        throw new MigrationFailure(
          migration.number,
          (error as { code?: string }).code ?? (error as Error).name ?? 'UNKNOWN',
        )
      }
    }
  } finally {
    db.close()
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/db/migrate.test.ts tests/db/encryptedUserDb.test.ts`
Expected: `migrate.test.ts` PASS. `encryptedUserDb.test.ts` will FAIL on the tests naming `createEmptyEncryptedUserDb` and on schema application — that is correct and Task 4 rewrites them. Note which fail; do not fix them here.

- [ ] **Step 6: Commit**

```bash
git add lib/db/migrate.ts lib/db/encryptedUserDb.ts tests/db/migrate.test.ts
git commit -m "Apply a friend's pending migrations when they unlock

SKIP_TEST_GATE not needed; tests/db/migrate.test.ts is staged.
tests/db/encryptedUserDb.test.ts is knowingly red here and is
rewritten in the task that removes the schema path."
```

---

## Task 3: Copy the database aside before applying

**Files:**
- Modify: `lib/db/migrate.ts`
- Test: `tests/db/migrate.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's `migrateUserDb`.
- Produces: `backupPathFor(slug: string): string` — `users/<slug>/<slug>.backup.db`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/db/migrate.test.ts
import { backupPathFor } from '@/lib/db/migrate'

describe('the copy taken before applying', () => {
  it('is NOT written when the database was created in this same run', () => {
    // A file with no tables and no rows has nothing to lose, and copying it
    // would spend the one backup slot on an empty database.
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)
    expect(existsSync(backupPathFor('sam'))).toBe(false)
  })

  it('is written before a migration is applied to an existing database', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)
    expect(existsSync(backupPathFor('sam'))).toBe(true)
  })

  it('holds the PRE-migration shape, which is what makes it a restore', () => {
    migration('sam', 1, 'initial', 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);')
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    const backup = new Database(backupPathFor('sam'))
    try {
      backup.pragma(`cipher='sqlcipher'`)
      backup.key(KEY)
      const cols = (backup.pragma('table_info(weigh_ins)') as { name: string }[]).map(
        (c) => c.name,
      )
      expect(cols).not.toContain('note')
    } finally {
      backup.close()
    }
  })

  it('names the file so the guard hook denies it — .backup.db, never .bak', () => {
    expect(backupPathFor('sam').endsWith('.backup.db')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/migrate.test.ts -t "copy taken"`
Expected: FAIL — `backupPathFor` is not exported.

- [ ] **Step 3: Implement**

Add to `lib/db/migrate.ts`:

```ts
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The migration-window copy.
 *
 * `.backup.db`, deliberately: the guard hook denies any `*.db` that is not
 * synthetic.db, so this is denied with NO hook change, and `.gitignore`'s
 * `*.db` covers it. A `.bak` suffix would have made the backup the one
 * readable copy of the thing the hook exists to protect.
 *
 * NOT a backup system. Same key as the original, so a forgotten password
 * still destroys both (step-6a design §8.1).
 */
export function backupPathFor(slug: string): string {
  const path = encryptedUserDbPath(slug)
  return join(dirname(path), `${slug}.backup.db`)
}
```

In `runMigrations`, after computing `current` and the early return, before the apply loop:

```ts
    if (current >= target) return

    // Only when there is something to lose. `createdNow` is true when this
    // run brought the file into being moments ago.
    if (!createdNow) {
      db.close()
      copyFileSync(path, backupPathFor(slug))
      reopened = openEncryptedUserDb(slug, key)
    }
```

Restructure so the copy happens on a closed handle — a WAL copy of an open database can miss committed pages. Simplest correct shape: read `user_version` in its own short-lived handle, close it, copy if needed, then open the handle used for applying. Rewrite `runMigrations` accordingly:

```ts
function runMigrations(slug: string, key: Buffer): void {
  try {
    verifyManifest(slug)
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new MigrationFailure(error.migrationNumber, 'MANIFEST_MISMATCH')
    }
    throw error
  }

  const path = encryptedUserDbPath(slug)
  const createdNow = !existsSync(path)
  if (createdNow) createEmptyEncryptedDbAt(slug, path, key)

  const migrations = listMigrations(slug)
  const target = migrations.length === 0 ? 0 : migrations[migrations.length - 1].number

  const probe = openEncryptedUserDb(slug, key, { readonly: true })
  let current: number
  try {
    current = probe.pragma('user_version', { simple: true }) as number
  } finally {
    probe.close()
  }
  if (current >= target) return

  // Closed-handle copy: a WAL database copied while open can miss committed
  // pages that live in the -wal file.
  if (!createdNow) copyFileSync(path, backupPathFor(slug))

  const db = openEncryptedUserDb(slug, key)
  try {
    for (const migration of migrations) {
      if (migration.number <= current) continue
      try {
        db.exec('BEGIN')
        db.exec(migration.sql)
        db.pragma(`user_version = ${migration.number}`)
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Already rolled back by the driver.
        }
        throw new MigrationFailure(
          migration.number,
          (error as { code?: string }).code ?? (error as Error).name ?? 'UNKNOWN',
        )
      }
    }
  } finally {
    db.close()
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: PASS, all tests including Task 2's.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add lib/db/migrate.ts tests/db/migrate.test.ts
git commit -m "Copy a friend's database aside before changing its shape"
```

---

## Task 4: Replace schema.sql with migrations across every folder

**Files:**
- Create: `users/devone/migrations/001_initial.sql`, `users/devtwo/migrations/001_initial.sql`, `users/run3/migrations/001_initial.sql`, each with `manifest.json`
- Create: `platform/templates/dashboard/migrations/001_initial.sql.tmpl`, `platform/templates/dashboard/migrations/manifest.json.tmpl`
- Delete: `users/*/schema.sql`, `platform/templates/dashboard/schema.sql.tmpl`
- Modify: `platform/templates/dashboard/seed.py.tmpl`, `users/*/seed.py`, `scripts/new-dashboard.sh`, `tests/users/conventions.test.ts`
- Modify: `tests/db/encryptedUserDb.test.ts` — the tests Task 2 knowingly reddened
- Test: `tests/users/conventions.test.ts`, `tests/scripts/newDashboard.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the five-entry list `['migrations', 'seed.py', 'queries.ts', 'dashboard.tsx', 'tests']`.

- [ ] **Step 1: Move each schema.sql to a migration, byte-for-byte**

For each of `devone`, `devtwo`, `run3`:

```bash
mkdir -p users/<slug>/migrations
git mv users/<slug>/schema.sql users/<slug>/migrations/001_initial.sql
```

`git mv` rather than create-and-delete, so the diff shows a rename and a reviewer can see the content did not change. **Do not edit the SQL.** It is the shape those synthetic databases already have.

- [ ] **Step 2: Write each manifest**

```bash
for slug in devone devtwo run3; do
  node -e '
    const {createHash}=require("crypto"), {readFileSync,writeFileSync,readdirSync}=require("fs");
    const dir=`users/${process.argv[1]}/migrations`;
    const migrations=readdirSync(dir).filter(f=>f.endsWith(".sql")).sort().map(f=>({
      number:Number(f.slice(0,3)),
      sha256:createHash("sha256").update(readFileSync(`${dir}/${f}`,"utf8")).digest("hex"),
    }));
    writeFileSync(`${dir}/manifest.json`, JSON.stringify({migrations},null,2)+"\n");
  ' "$slug"
done
```

- [ ] **Step 3: Update the conventions test to the new five**

In `tests/users/conventions.test.ts:45`:

```ts
/** The five entries a BUILT dashboard has. See the state note below. */
const REQUIRED = ['migrations', 'seed.py', 'queries.ts', 'dashboard.tsx', 'tests']
```

Add a test that the migrations directory is not merely present but usable:

```ts
    whenBuilt('has a numbered 001 migration and a manifest that matches it', () => {
      // The shape source. A migrations/ holding no 001 is a folder that
      // passes the sweep and builds nothing.
      const dir = join(dir_, 'migrations')
      expect(existsSync(join(dir, 'manifest.json'))).toBe(true)
      const sql = readdirSync(dir).filter((f) => f.endsWith('.sql'))
      expect(sql.some((f) => f.startsWith('001_'))).toBe(true)
      expect(() => verifyManifest(slug)).not.toThrow()
    })
```

Import `verifyManifest` from `@/lib/db/migrationFiles` and `readdirSync` from `node:fs`. Rename the existing `const dir = join(USERS, slug)` if it collides.

- [ ] **Step 4: Update seed.py.tmpl to run migrations and stamp the version**

Replace the schema block in `platform/templates/dashboard/seed.py.tmpl`:

```python
HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")


def apply_migrations(db):
    """Build the shape the same way a real database gets it: 001..n, in order.

    Stamps user_version so a synthetic database reports the same version a
    migrated real one does — which is what lets lib/db/migrate.ts treat dev as
    an ordinary no-op rather than a special case.
    """
    files = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    for name in files:
        with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as handle:
            db.executescript(handle.read())
    if files:
        db.execute(f"PRAGMA user_version = {int(files[-1][:3])}")
```

and in `main()`, replace `db.executescript(schema)` with `apply_migrations(db)`. Delete the `SCHEMA = ...` constant and the `with open(SCHEMA...)` block.

Apply the same change to `users/devone/seed.py`, `users/devtwo/seed.py`, `users/run3/seed.py`.

- [ ] **Step 5: Update the scaffold**

In `scripts/new-dashboard.sh`, replace the copy loop:

```bash
  mkdir -p "$dest/tests" "$dest/migrations"
  local f
  for f in seed.py queries.ts dashboard.tsx; do
    sed "s/__SLUG__/$slug/g" "$src/$f.tmpl" > "$dest/$f"
  done
  sed "s/__SLUG__/$slug/g" "$src/migrations/001_initial.sql.tmpl" \
    > "$dest/migrations/001_initial.sql"
  sed "s/__SLUG__/$slug/g" "$src/tests/dashboard.test.ts.tmpl" \
    > "$dest/tests/dashboard.test.ts"
  chmod +x "$dest/seed.py"
```

Then generate the scaffolded manifest so a fresh folder passes `verifyManifest`. Add after the copies:

```bash
  node -e '
    const {createHash}=require("crypto"), {readFileSync,writeFileSync}=require("fs");
    const dir=process.argv[1]+"/migrations";
    const sql=readFileSync(dir+"/001_initial.sql","utf8");
    writeFileSync(dir+"/manifest.json", JSON.stringify(
      {migrations:[{number:1,sha256:createHash("sha256").update(sql).digest("hex")}]},null,2)+"\n");
  ' "$dest"
```

- [ ] **Step 6: Fix the tests Task 2 reddened**

In `tests/db/encryptedUserDb.test.ts`: replace every `createEmptyEncryptedUserDb(slug, KEY)` with `createEmptyEncryptedDbAt(slug, encryptedUserDbPath(slug), KEY)`. Delete the test `'creates the file, applies schema.sql, and round-trips a row'` — no open applies a schema now — and replace it with one asserting the create makes an encrypted, table-less file. Delete `makeUserFolder`'s `schema.sql` write. Keep every encryption assertion untouched: they are the real content of that file.

- [ ] **Step 7: Regenerate and run**

```bash
npm run synthetic
npx vitest run tests/users tests/scripts tests/db users
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx tsc --noEmit
git add -A users platform/templates scripts/new-dashboard.sh tests
git commit -m "Make migrations the one source of a dashboard's shape

schema.sql is gone; users/<slug>/migrations/001_initial.sql replaces it
byte for byte, so no shape changed in this commit. seed.py now builds a
synthetic database by running the same migrations a real one gets, and
stamps user_version to match."
```

---

## Task 5: The fourth copy block

**Files:**
- Modify: `lib/copy/onboarding.ts`
- Test: `tests/copy/onboarding.test.ts`

**Interfaces:**
- Produces: `SESSION_REFUSED` — the pinned sentence.

- [ ] **Step 1: Write the failing test**

```ts
// tests/copy/onboarding.test.ts — append
import { SESSION_REFUSED } from '@/lib/copy/onboarding'

describe('the refused-session line', () => {
  it('is exactly the sentence that was agreed', () => {
    expect(SESSION_REFUSED).toBe('Something broke on our end and we need to fix it.')
  })

  it('does not tell the friend to retry — this failure is not retryable', () => {
    expect(SESSION_REFUSED).not.toMatch(/again|retry|once more/i)
  })

  it('does not imply recovery exists', () => {
    expect(SESSION_REFUSED).not.toMatch(/reset|recover|restore/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/copy/onboarding.test.ts`
Expected: FAIL — `SESSION_REFUSED` is not exported.

- [ ] **Step 3: Implement**

```ts
// lib/copy/onboarding.ts
/**
 * Shown when a session is refused because something server-side failed and
 * the friend can do nothing about it — today, a failed migration.
 *
 * NOT `PASSWORD_ERRORS.server`, which says "try once more, then text Nico".
 * That was written for a retryable failure. This one is not: a migration that
 * threw will throw again, and telling a friend locked out at 7am to retry
 * something that cannot succeed spends the honesty that refusing the session
 * was chosen to buy.
 */
export const SESSION_REFUSED = 'Something broke on our end and we need to fix it.'
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run tests/copy/onboarding.test.ts
npx tsc --noEmit
git add lib/copy/onboarding.ts tests/copy/onboarding.test.ts
git commit -m "Say plainly that we broke it, without telling them to retry"
```

---

## Task 6: The shared refusal exit

**Files:**
- Create: `lib/auth/refuseSession.ts`
- Modify: `lib/alerts/ntfy.ts` — add the alert kind
- Test: `tests/auth/refuseSession.test.ts`

**Interfaces:**
- Consumes: `MigrationFailure` (Task 2), `dropKey` (`lib/session/keymap.ts`), `logDbFailure` (`lib/db/failureLog.ts`), `alerter` (`lib/alerts/ntfy.ts`).
- Produces: `refuseSession(deps: RefuseDeps, input: { sessionId: string; slug: string; error: unknown }): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/refuseSession.test.ts
import { describe, expect, it, vi } from 'vitest'
import { MigrationFailure } from '@/lib/db/migrate'
import { refuseSession } from '@/lib/auth/refuseSession'

function deps() {
  return {
    dropKey: vi.fn(),
    log: vi.fn(),
    alert: vi.fn(async () => {}),
  }
}

describe('refuseSession', () => {
  it('drops the key, so a refused session cannot read anything', async () => {
    const d = deps()
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: new MigrationFailure(2, 'SQLITE_ERROR') })
    expect(d.dropKey).toHaveBeenCalledWith('s1')
  })

  it('alerts with slug, migration number and code', async () => {
    const d = deps()
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: new MigrationFailure(2, 'SQLITE_ERROR') })
    expect(d.alert).toHaveBeenCalledWith({ slug: 'sam', migrationNumber: 2, code: 'SQLITE_ERROR' })
  })

  it('NEVER puts the error message in the alert payload', async () => {
    // A constraint violation can quote a column's contents. CLAUDE.md:
    // metrics and alerts carry no user values.
    const d = deps()
    const err = new MigrationFailure(2, 'SQLITE_CONSTRAINT')
    err.message = 'UNIQUE constraint failed: weigh_ins.day = 2026-08-15 200.4'
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: err })
    const payload = JSON.stringify(d.alert.mock.calls[0][0])
    expect(payload).not.toMatch(/200\.4/)
    expect(payload).not.toMatch(/UNIQUE/)
  })

  it('sends the full error to the log, which is where why lives', async () => {
    const d = deps()
    const err = new MigrationFailure(2, 'SQLITE_ERROR')
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: err })
    expect(d.log).toHaveBeenCalledWith('migration_failed', 'sam', err)
  })

  it('still drops the key when the alert throws', async () => {
    // The alert is the least important thing here. A friend holding a key to a
    // half-migrated database is the most important.
    const d = deps()
    d.alert = vi.fn(async () => {
      throw new Error('ntfy down')
    })
    await expect(
      refuseSession(d, { sessionId: 's1', slug: 'sam', error: new MigrationFailure(1, 'X') }),
    ).resolves.toBeUndefined()
    expect(d.dropKey).toHaveBeenCalledWith('s1')
  })

  it('handles an unknown error shape without inventing a number', async () => {
    const d = deps()
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: new Error('boom') })
    expect(d.alert).toHaveBeenCalledWith({ slug: 'sam', migrationNumber: 0, code: 'UNKNOWN' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth/refuseSession.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/refuseSession`.

- [ ] **Step 3: Implement**

```ts
// lib/auth/refuseSession.ts
//
// The ONE exit for a refused session. One function, one copy block, one alert
// — per-case branching is what produces a refusal path nobody has read in six
// months. Today only a failed migration reaches it.
import { MigrationFailure } from '@/lib/db/migrate'

export type RefusalAlert = { slug: string; migrationNumber: number; code: string }

export type RefuseDeps = {
  dropKey: (sessionId: string) => void
  log: (event: string, slug: string, error: unknown) => void
  alert: (payload: RefusalAlert) => Promise<void>
}

export async function refuseSession(
  deps: RefuseDeps,
  input: { sessionId: string; slug: string; error: unknown },
): Promise<void> {
  // FIRST, and before anything that can throw. A friend holding a key to a
  // half-migrated database is the failure this whole path exists to prevent;
  // a missing push notification is not.
  deps.dropKey(input.sessionId)

  const failure = input.error instanceof MigrationFailure ? input.error : undefined
  deps.log('migration_failed', input.slug, input.error)

  try {
    await deps.alert({
      slug: input.slug,
      migrationNumber: failure?.migrationNumber ?? 0,
      code: failure?.code ?? 'UNKNOWN',
    })
  } catch {
    // Already logged above. An alerter that cannot reach ntfy.sh must not
    // turn a refused session into an unhandled rejection.
  }
}
```

- [ ] **Step 4: Add the alert kind**

In `lib/alerts/ntfy.ts`, extend `ALERT_TEXT`:

```ts
export const ALERT_TEXT = {
  conversation_started: 'started a conversation',
  spec_confirmed: 'confirmed a spec',
  migration_failed: 'migration failed — session refused',
} as const
```

The existing alerter takes `(kind, accountId)` and looks the slug up itself. Add a sibling that takes the refusal payload, so the number and code ride along without widening the general alerter:

```ts
export function migrationAlerter(
  deps: AlerterDeps,
): (payload: { slug: string; migrationNumber: number; code: string }) => Promise<void> {
  const send = alerter(deps)
  return async ({ slug, migrationNumber, code }) => {
    // Text is assembled HERE from three non-user values, and there is still
    // no exported path through which arbitrary text reaches ntfy.sh.
    await send.raw?.(
      `${slug}: ${ALERT_TEXT.migration_failed} (migration ${migrationNumber}, ${code})`,
    )
  }
}
```

**If `alerter` has no `raw` seam**, do not invent one: instead extract the existing POST body construction into a non-exported `post(deps, text)` and have both `alerter` and `migrationAlerter` call it. Read the file before choosing — the constraint is that no exported function accepts free text.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run tests/auth tests/alerts
npx tsc --noEmit
git add lib/auth/refuseSession.ts lib/alerts/ntfy.ts tests/auth/refuseSession.test.ts
git commit -m "Refuse a broken session once, in one place, and say which migration"
```

---

## Task 7: Fire the runner at every point a key appears

**Files:**
- Modify: `app/api/login/route.ts`, `lib/auth/flow.ts`, `lib/invite/register.ts`
- Test: `tests/auth/routes.test.ts`, `tests/invite/register.test.ts`

**Interfaces:**
- Consumes: `migrateUserDb` (Task 2), `refuseSession` (Task 6).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/auth/routes.test.ts — append
describe('migrations at login', () => {
  it('runs before the session is usable', async () => {
    // Pinned by observing the database, not by spying: after a login, the
    // friend's database is at the highest migration number.
    const sessionId = await loginAs('devtwo', 'TEST-DEV-TWO')
    expect(versionOf('devtwo')).toBe(highestMigrationNumber('devtwo'))
    expect(getKey(sessionId)).toBeDefined()
  })

  it('refuses the login when a migration fails, and drops the key', async () => {
    breakMigrationFor('devtwo')
    const response = await POST(loginRequest('devtwo', 'TEST-DEV-TWO'))
    expect(response.headers.get('location')).toMatch(/error=refused/)
    expect(anyKeyFor('devtwo')).toBeUndefined()
  })
})
```

Write the helpers concretely against whatever harness `tests/auth/routes.test.ts` already uses — read it first and follow its existing setup rather than introducing a second style.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth/routes.test.ts`
Expected: FAIL — no `error=refused` branch exists.

- [ ] **Step 3: Implement in the login route**

In `app/api/login/route.ts`, replace the `putKey` block:

```ts
  const key = await databaseKeyFor(getDb(), account, password).catch(() => undefined)
  if (!key) return relativeRedirect('/login?error=1')

  try {
    // BEFORE putKey: a session must never become usable over a half-migrated
    // shape. migrateUserDb is a one-pragma no-op on every login after the
    // first that needed it.
    migrateUserDb(account.slug, key)
  } catch (error) {
    await refuseSession(refuseDeps(), { sessionId, slug: account.slug, error })
    return relativeRedirect('/login?error=refused')
  }
  putKey(sessionId, key)
```

Do the same in `lib/auth/flow.ts`'s `unlock()` — migrate before `putKey`, and return `false` on failure after calling `refuseSession` — and in `lib/invite/register.ts` before its `putKey` at line 121.

`refuseDeps()` is a small factory in `lib/auth/refuseSession.ts` wiring the real `dropKey`, `logDbFailure` and `migrationAlerter`. Add it there rather than in each route.

- [ ] **Step 4: Render the copy**

In `app/(auth)/login/page.tsx`, show `SESSION_REFUSED` when `searchParams.error === 'refused'`, and `WRONG_PASSWORD` otherwise. Same treatment on the unlock page.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run tests/auth tests/invite
npx tsc --noEmit
git add app lib tests
git commit -m "Migrate at unlock, and refuse the session if it will not"
```

---

## Task 8: One resolver for which database serves, and the fallback deleted

**Files:**
- Create: `lib/db/userData.ts`
- Modify: `app/[user]/page.tsx:101-122`, `app/api/users/[user]/walk/route.ts:68`
- Test: `tests/db/userData.test.ts`, `tests/routing/dashboard.test.tsx`

**Interfaces:**
- Produces:
  - `openUserDataForRead(slug: string, key: Buffer): UserDb` — readonly, always.
  - `openUserDataForWrite(slug: string, key: Buffer): UserDb` — writable; routes only.
  - `isDevData(): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/userData.test.ts
describe('which database serves', () => {
  it('production reads the encrypted file', () => {
    withNodeEnv('production', () => {
      const db = openUserDataForRead('devtwo', KEY)
      expect(pathOf(db)).toBe(encryptedUserDbPath('devtwo'))
      db.close()
    })
  })

  it('dev reads synthetic.db', () => {
    withNodeEnv('development', () => {
      const db = openUserDataForRead('devtwo', KEY)
      expect(pathOf(db)).toMatch(/synthetic\.db$/)
      db.close()
    })
  })

  it('dev WRITES to synthetic.db too, so an entry widget is testable', () => {
    withNodeEnv('development', () => {
      const db = openUserDataForWrite('devtwo', KEY)
      expect(() => db.exec('CREATE TABLE IF NOT EXISTS probe (x)')).not.toThrow()
      db.close()
    })
  })

  it('the read handle refuses a write in BOTH worlds', () => {
    for (const env of ['production', 'development']) {
      withNodeEnv(env, () => {
        const db = openUserDataForRead('devtwo', KEY)
        expect(() => db.exec('CREATE TABLE probe (x)')).toThrow()
        db.close()
      })
    }
  })

  it('RED TEST: production can never be talked into synthetic', () => {
    // Deleting the NODE_ENV gate must turn this red. There is no variable
    // that switches production onto fake data — that is the PLATFORM_DB
    // failure mode deploy/required-env exists to describe.
    withNodeEnv('production', () => {
      process.env.SYNTHETIC_DASHBOARDS = '1'
      const db = openUserDataForRead('devtwo', KEY)
      expect(pathOf(db)).toBe(encryptedUserDbPath('devtwo'))
      db.close()
      delete process.env.SYNTHETIC_DASHBOARDS
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/userData.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// lib/db/userData.ts
//
// The ONE place that answers "which database does this slug use". There is no
// fallback: production always serves the friend's encrypted database, even
// when it holds zero rows, and dev always serves synthetic.db for reads AND
// writes so an entry widget is testable end to end.
//
// Gated on NODE_ENV and nothing else. A variable that could switch production
// onto synthetic data would rebuild the exact hazard deploy/required-env
// describes for PLATFORM_DB: loudly-fake data served in production with every
// health check green.
import Database from 'better-sqlite3-multiple-ciphers'
import { openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { userDbPath, type UserDb } from '@/lib/db/userDb'

export function isDevData(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export function openUserDataForRead(slug: string, key: Buffer): UserDb {
  if (isDevData()) return new Database(userDbPath(slug), { readonly: true, fileMustExist: true })
  return openEncryptedUserDb(slug, key, { readonly: true })
}

export function openUserDataForWrite(slug: string, key: Buffer): UserDb {
  if (isDevData()) return new Database(userDbPath(slug), { fileMustExist: true })
  return openEncryptedUserDb(slug, key)
}
```

- [ ] **Step 4: Delete the fallback from the page**

In `app/[user]/page.tsx`, remove the `useReal` block (lines 101-122), the `encryptedUserDbHasTables` import, and the synthetic branch. The page becomes: no loader → `PlaceholderCard`; otherwise open through `openUserDataForRead` and render. The banner renders when `isDevData()` is true.

Delete `encryptedUserDbHasTables` from `lib/db/encryptedUserDb.ts` and its tests.

- [ ] **Step 5: Point the walk route at the resolver**

`app/api/users/[user]/walk/route.ts:68` becomes `openUserDataForWrite(user, key)`.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run
npx tsc --noEmit
git add lib app tests
git commit -m "Serve a friend their own database, empty or not"
```

---

## Task 9: Every dashboard renders on zero rows

**Files:**
- Modify: `platform/templates/dashboard/tests/dashboard.test.ts.tmpl`
- Create: empty-render tests in `users/devone/tests/`, `users/devtwo/tests/`, `users/run3/tests/`
- Modify: `screenshots/screens.ts`, `scripts/shots.ts`

- [ ] **Step 1: Add the scaffolded empty-render test to the template**

```ts
// platform/templates/dashboard/tests/dashboard.test.ts.tmpl — append
it('renders on an EMPTY database without throwing', async () => {
  // A friend's first session shows their own database, which has no rows.
  // That is a normal state, not an error: there is no synthetic fallback to
  // hide behind (2026-08-15 migrations design, §9).
  const db = emptyDbFromMigrations('__SLUG__')
  await expect(
    Dashboard({ slug: '__SLUG__', db, today: '2026-01-01', timeZone: 'UTC' }),
  ).resolves.toBeDefined()
})
```

Add `emptyDbFromMigrations` to a shared test helper that applies `users/<slug>/migrations/*.sql` to an in-memory database and returns a readonly handle.

- [ ] **Step 2: Add the same test to each existing user folder**

Copy it into `users/devone/tests/`, `users/devtwo/tests/`, `users/run3/tests/`, substituting the slug.

- [ ] **Step 3: Run — expect real failures**

Run: `npx vitest run users`
Expected: any dashboard indexing `rows[0]` without a guard now fails. **Fix the dashboards, not the test.** That is the defect this task exists to find.

- [ ] **Step 4: Add the empty-state screenshot**

In `screenshots/screens.ts`, add a screen with `state: 'friend-built-empty'`, `live: true`, and assertions describing what an empty dashboard must look like — a heading, and a line saying there is nothing yet, not a blank panel. Add the matching seeder in `scripts/shots.ts` creating an account whose database has been migrated but never written to.

- [ ] **Step 5: Review the pictures and commit**

```bash
npm run shots -- --task=migrations
```

Open both widths of the new screen and check against its assertions. Then:

```bash
git add users platform/templates screenshots scripts/shots.ts
git commit -m "Render every dashboard on an empty database, and look at it"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/dashboard-build-rules.md`

- [ ] **Step 1: CLAUDE.md**

Four passages, per the spec's §10:
- **`CLAUDE.md:154-159`** — rewrite the "exactly TWO writable opens" enumeration. The runner is one; the walk route is one; registration no longer creates anything. Keep the sentence shape that makes adding another a deliberate act.
- **`CLAUDE.md:97-100`** — "Nothing migrates it" is false. Replace with a pointer to the design doc and the D-numbers.
- **`CLAUDE.md:148-153`** — the read-only handle rule. **Preserve it.** It sits inside the rewritten passage and must survive.
- **`CLAUDE.md:32-35`** — `reshape.ts`. Unchanged; add D5's clause: the runner is the second schema-surgery site, its exception is data-preserving surgery proven by test, and reshape is never pointed at a user database.
- Folder conventions: `schema.sql` → `migrations/`; delete "everything a dashboard shows is synthetic until that user's first write".

- [ ] **Step 2: dashboard-build-rules.md**

- §1 table: the residual-2 row becomes a pointer to the design.
- §4: the enumeration.
- §5: retitle from "The schema freezes on first write" and rewrite — the premise is gone.
- §10: add the migration test rule (D3).
- **§3 line 72: guard, do not edit.** "A database with no migration story" is the friend-timezone rationale. A migration changes a shape; it cannot repair a row whose meaning was wrong when written.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/dashboard-build-rules.md
git commit -m "Write down that user tables can change shape now

Docs only, so no test gate applies."
```

---

## Self-Review

**Spec coverage:** §2 runner → Tasks 2, 7. §3 pragma and manifest → Tasks 1, 2. §4 migration files → Task 4. §5 failure, backup, alert → Tasks 3, 5, 6. §6 which database serves → Task 8. §7 folder conventions → Task 4. §8 existing databases → done by hand already. §9 zero rows → Task 9. §10 documentation → Task 10. §11 copy → Task 5. §12 tests → distributed. No gaps.

**Known soft spots, flagged rather than hidden:**
1. **Task 6 Step 4** depends on `lib/alerts/ntfy.ts`'s internal shape, which I did not read in full. The task says to read it first and states the invariant to preserve (no exported function takes free text) rather than asserting a seam that may not exist.
2. **Task 7 Step 1** references helpers (`loginAs`, `versionOf`, `breakMigrationFor`) that must be written against the existing harness in `tests/auth/routes.test.ts`. The task says to read it first and follow its style.
3. **Task 9 Step 3 will find real bugs** in existing dashboards. That is intended; fix the dashboard, never the test.
