// tests/db/migrate.test.ts
//
// The runner, which is the only thing in this repo that changes the shape of a
// friend's real database. Its tests are therefore mostly about what survives:
// rows across an ALTER, a version that never disagrees with the shape, and a
// database that is never left half-changed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { MigrationFailure, backupPathFor, migrateUserDb } from '@/lib/db/migrate'
import { encryptedUserDbPath, openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { setNodeEnv } from '@/tests/support/nodeEnv'

const KEY = Buffer.alloc(32, 7)
let root: string

/** Write a migration and rebuild the manifest so the runner accepts it. */
function migration(slug: string, n: number, name: string, sql: string) {
  const dir = join(root, slug, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(n).padStart(3, '0')}_${name}.sql`), sql)
  rewriteManifest(slug)
}

function rewriteManifest(slug: string) {
  const dir = join(root, slug, 'migrations')
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      number: Number(f.slice(0, 3)),
      sha256: createHash('sha256').update(readFileSync(join(dir, f), 'utf8')).digest('hex'),
    }))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ migrations }))
}

function version(slug: string): number {
  const db = openEncryptedUserDb(slug, KEY, { readonly: true })
  try {
    return db.pragma('user_version', { simple: true }) as number
  } finally {
    db.close()
  }
}

function columnsOf(slug: string, table: string): string[] {
  const db = openEncryptedUserDb(slug, KEY, { readonly: true })
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
  } finally {
    db.close()
  }
}

const INITIAL = 'CREATE TABLE weigh_ins (day TEXT PRIMARY KEY, lb REAL);'

let originalEnv: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-run-'))
  process.env.USERS_DIR = root
  // THIS SUITE TESTS THE PRODUCTION PATH, and says so rather than inheriting
  // it. Outside production the runner returns immediately — synthetic.db is
  // the user database there and seed.py owns its shape — so without this every
  // assertion below would pass vacuously against a no-op.
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')
})

afterEach(() => {
  setNodeEnv(originalEnv)
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('migrateUserDb', () => {
  it('creates the database and applies 001 for a friend who has never logged in', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)

    expect(existsSync(encryptedUserDbPath('sam'))).toBe(true)
    expect(version('sam')).toBe(1)
  })

  it('creates the file and applies nothing when the friend has no migrations yet', () => {
    // onboarding-ux-spec.md S2: the database exists the moment the password
    // does, whether or not anyone has built them a dashboard. Not a failure.
    mkdirSync(join(root, 'sam'), { recursive: true })
    migrateUserDb('sam', KEY)

    expect(existsSync(encryptedUserDbPath('sam'))).toBe(true)
    expect(version('sam')).toBe(0)
  })

  it('applies only what is pending, in order', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    expect(version('sam')).toBe(2)
    expect(columnsOf('sam', 'weigh_ins')).toContain('note')
  })

  it('is a no-op when already at the highest number', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    // A re-run must not re-execute 001, which would throw on CREATE TABLE.
    expect(() => migrateUserDb('sam', KEY)).not.toThrow()
    expect(version('sam')).toBe(1)
  })

  it('PRESERVES ROWS across an ALTER — the whole point (D1/D3)', () => {
    migration('sam', 1, 'initial', INITIAL)
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
      expect(read.prepare('SELECT day, lb FROM weigh_ins').get()).toEqual({
        day: '2026-08-15',
        lb: 200.4,
      })
    } finally {
      read.close()
    }
  })

  it('PRESERVES ROWS across the rebuild recipe — create, copy, drop, rename (D4)', () => {
    // What reshape.ts does, minus the zero-rows proof that fails on real data.
    // This is the sanctioned way to do a change SQLite's ALTER cannot express.
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)

    const write = openEncryptedUserDb('sam', KEY)
    try {
      write.prepare('INSERT INTO weigh_ins (day, lb) VALUES (?, ?)').run('2026-08-15', 200.4)
    } finally {
      write.close()
    }

    migration(
      'sam',
      2,
      'rebuild',
      `CREATE TABLE weigh_ins_new (day TEXT PRIMARY KEY, lb REAL NOT NULL);
       INSERT INTO weigh_ins_new (day, lb) SELECT day, lb FROM weigh_ins;
       DROP TABLE weigh_ins;
       ALTER TABLE weigh_ins_new RENAME TO weigh_ins;`,
    )
    migrateUserDb('sam', KEY)

    const read = openEncryptedUserDb('sam', KEY, { readonly: true })
    try {
      expect(read.prepare('SELECT day, lb FROM weigh_ins').get()).toEqual({
        day: '2026-08-15',
        lb: 200.4,
      })
    } finally {
      read.close()
    }
  })

  it('leaves the version untouched when a migration throws', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'broken', 'ALTER TABLE nonexistent ADD COLUMN x TEXT;')

    expect(() => migrateUserDb('sam', KEY)).toThrow(MigrationFailure)
    expect(version('sam')).toBe(1)
  })

  it('rolls the whole failing migration back, not just the failing statement', () => {
    // The version and the shape move together or not at all. A migration whose
    // first statement succeeded and whose second threw must leave neither.
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration(
      'sam',
      2,
      'half_broken',
      `ALTER TABLE weigh_ins ADD COLUMN note TEXT;
       ALTER TABLE nonexistent ADD COLUMN x TEXT;`,
    )

    expect(() => migrateUserDb('sam', KEY)).toThrow(MigrationFailure)
    expect(version('sam')).toBe(1)
    expect(columnsOf('sam', 'weigh_ins')).not.toContain('note')
  })

  it('names the failing migration number and a code, never the message', () => {
    // Both reach an ntfy alert. CLAUDE.md: alerts carry no user values, and a
    // driver message can quote a column's contents.
    migration('sam', 1, 'broken', 'THIS IS NOT SQL;')
    try {
      migrateUserDb('sam', KEY)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(MigrationFailure)
      const failure = e as MigrationFailure
      expect(failure.migrationNumber).toBe(1)
      expect(failure.code.length).toBeGreaterThan(0)
    }
  })

  it('refuses before creating anything when the manifest does not match', () => {
    // The order matters: a bad manifest must not bring a database into being.
    migration('sam', 1, 'initial', INITIAL)
    writeFileSync(join(root, 'sam', 'migrations', '001_initial.sql'), `${INITIAL} -- edited`)

    expect(() => migrateUserDb('sam', KEY)).toThrow(MigrationFailure)
    expect(existsSync(encryptedUserDbPath('sam'))).toBe(false)
  })

  it('reports a manifest mismatch as its own code, not as a SQL error', () => {
    migration('sam', 1, 'initial', INITIAL)
    writeFileSync(join(root, 'sam', 'migrations', '001_initial.sql'), `${INITIAL} -- edited`)
    try {
      migrateUserDb('sam', KEY)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as MigrationFailure).code).toBe('MANIFEST_MISMATCH')
      expect((e as MigrationFailure).migrationNumber).toBe(1)
    }
  })
})

describe('the copy taken before applying', () => {
  it('names the file so the guard hook denies it — .backup.db, never .bak', () => {
    // The hook denies any *.db that is not synthetic.db. A .bak suffix would
    // have made the backup the ONE readable copy of the thing the hook exists
    // to protect, and .gitignore's *.db would have stopped covering it too.
    expect(backupPathFor('sam').endsWith('.backup.db')).toBe(true)
  })

  it('is NOT written when the database was created in this same run', () => {
    // A file with no tables and no rows has nothing to lose, and copying it
    // would spend the single backup slot on an empty database.
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    expect(existsSync(backupPathFor('sam'))).toBe(false)
  })

  it('is written before a migration is applied to an existing database', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    expect(existsSync(backupPathFor('sam'))).toBe(true)
  })

  it('holds the PRE-migration shape, which is what makes it a restore', () => {
    // A copy taken after the change would be a copy of the problem.
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    const backup = new Database(backupPathFor('sam'), { readonly: true, fileMustExist: true })
    try {
      backup.pragma(`cipher='chacha20'`)
      backup.key(KEY)
      const cols = (backup.pragma('table_info(weigh_ins)') as { name: string }[]).map(
        (c) => c.name,
      )
      expect(cols).not.toContain('note')
    } finally {
      backup.close()
    }
  })

  it('holds the rows that existed before the change', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)

    const write = openEncryptedUserDb('sam', KEY)
    try {
      write.prepare('INSERT INTO weigh_ins (day, lb) VALUES (?, ?)').run('2026-08-15', 200.4)
    } finally {
      write.close()
    }

    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    const backup = new Database(backupPathFor('sam'), { readonly: true, fileMustExist: true })
    try {
      backup.pragma(`cipher='chacha20'`)
      backup.key(KEY)
      expect(backup.prepare('SELECT day, lb FROM weigh_ins').get()).toEqual({
        day: '2026-08-15',
        lb: 200.4,
      })
    } finally {
      backup.close()
    }
  })

  it('is encrypted under the same key — a migration-window copy, not a backup', () => {
    // step-6a design section 8.1 is untouched by this: a forgotten password
    // still destroys everything, because this copy needs the same key. No
    // user-facing copy may imply recovery exists.
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'add_note', 'ALTER TABLE weigh_ins ADD COLUMN note TEXT;')
    migrateUserDb('sam', KEY)

    const head = readFileSync(backupPathFor('sam')).subarray(0, 16)
    expect(head.toString('latin1')).not.toBe('SQLite format 3\0')
  })

  it('survives a failed migration, which is the case it exists for', () => {
    migration('sam', 1, 'initial', INITIAL)
    migrateUserDb('sam', KEY)
    migration('sam', 2, 'broken', 'ALTER TABLE nonexistent ADD COLUMN x TEXT;')

    expect(() => migrateUserDb('sam', KEY)).toThrow(MigrationFailure)
    expect(existsSync(backupPathFor('sam'))).toBe(true)
  })
})
