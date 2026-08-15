// tests/db/encryptedUserDb.test.ts
//
// The real assertion in this file is that the bytes on disk are not a SQLite
// database. Everything else is a round-trip, and a round-trip passes just as
// happily against no encryption at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
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
import {
  WrongKeyError,
  createEmptyEncryptedDbAt,
  encryptedUserDbExists,
  encryptedUserDbHasTables,
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

/**
 * Half-built databases the atomic create left under its temp name.
 *
 * The create builds at `.creating-<hex>.<slug>.db` and links that into place,
 * so a failure must clean up the temp entry as well as leave the real path
 * alone. Nothing in the codebase ever reaps these, by design — an unattended
 * process deleting files matching a glob inside a user's folder is a worse
 * risk than the disk it would save — so the cleanup being correct is the only
 * thing standing between a failed create and permanent debris.
 */
function creatingDebris(slug: string): string[] {
  return readdirSync(join(root, slug)).filter((f) => f.startsWith('.creating-'))
}

/**
 * Run `fn` with Database.prototype.pragma and .key spied, recording the ORDER
 * of the cipher pragma and the key call. Every call passes through to the real
 * implementation, so behaviour is unchanged.
 *
 * There is no handle to spy on before openEncryptedUserDb creates its own,
 * which is why this reaches for the prototype.
 */
function pragmaOrderDuring(fn: () => void): string[] {
  const originalPragma = Database.prototype.pragma
  const originalKey = Database.prototype.key
  const order: string[] = []

  const pragmaSpy = vi
    .spyOn(Database.prototype, 'pragma')
    .mockImplementation(function (this: Database.Database, ...args: unknown[]) {
      if (typeof args[0] === 'string' && /^cipher\s*=/.test(args[0])) {
        order.push('cipher-pragma')
      }
      return (originalPragma as (...a: unknown[]) => unknown).apply(this, args)
    })
  const keySpy = vi
    .spyOn(Database.prototype, 'key')
    .mockImplementation(function (this: Database.Database, ...args: unknown[]) {
      order.push('key')
      return (originalKey as (...a: unknown[]) => number).apply(this, args)
    })

  try {
    fn()
  } finally {
    pragmaSpy.mockRestore()
    keySpy.mockRestore()
  }
  return order
}

/**
 * A user folder. Just the folder — no schema.sql, because none exists any
 * more: migrations own a dashboard's shape (2026-08-15 migrations design, D6)
 * and no open applies one.
 */
function makeUserFolder(slug: string) {
  mkdirSync(join(root, slug), { recursive: true })
}

/**
 * Give a database the `walks` table these tests insert into.
 *
 * This used to happen for free: the create read schema.sql and exec'd it, so
 * every opened database arrived with tables. It does not any more, and that is
 * the point of the change — so the tests below say out loud where their shape
 * comes from instead of inheriting it from a file the opener happened to read.
 *
 * A stand-in for lib/db/migrate.ts, deliberately kept dumb: this file's job is
 * proving the bytes are encrypted, and it should not acquire a dependency on
 * the runner to do it.
 */
function giveWalksTable(slug: string) {
  const db = openEncryptedUserDb(slug, KEY)
  try {
    db.exec(SCHEMA)
  } finally {
    db.close()
  }
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
  it('creates the file EMPTY, and round-trips a row once something makes a table', () => {
    // It used to apply schema.sql here. It does not: migrations own the shape
    // (D6), so a writable open brings the FILE into being and nothing else.
    // The round-trip still matters — it is what proves the key works — so the
    // table is made explicitly rather than inherited.
    expect(encryptedUserDbExists('devtwo')).toBe(false)

    const fresh = openEncryptedUserDb('devtwo', KEY)
    try {
      const tables = fresh
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")
        .get() as { n: number }
      expect(tables.n).toBe(0)
    } finally {
      fresh.close()
    }

    giveWalksTable('devtwo')
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
    giveWalksTable('devtwo')
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    const head = readFileSync(encryptedUserDbPath('devtwo')).subarray(0, 16)
    expect(head.toString('latin1')).not.toBe('SQLite format 3\0')
  })

  it('does not leave the day readable in the raw bytes', () => {
    // The point of the whole step, stated as bytes rather than as a promise.
    giveWalksTable('devtwo')
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    const raw = readFileSync(encryptedUserDbPath('devtwo')).toString('latin1')
    expect(raw).not.toContain('2026-08-13')
  })

  it('refuses a wrong key with a NAMED error, not a raw driver error', () => {
    giveWalksTable('devtwo')
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    // The driver reports SQLITE_NOTADB for both a wrong key and a corrupt
    // file. The opener knows the file exists, so it can say which.
    expect(() => openEncryptedUserDb('devtwo', OTHER_KEY)).toThrow(WrongKeyError)
  })

  it('reopens with the right key after a close', () => {
    giveWalksTable('devtwo')
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

  it('calls db.pragma to pin the cipher BEFORE db.key — a real call assertion, not a value scan', () => {
    // A test that only checks the resulting cipher VALUE cannot fail here:
    // the driver's own default is already chacha20 (see fix-round section
    // of the report), which is the same string this module pins, so
    // removing the pragma call changes nothing observable about the
    // outcome — verified by deleting the call and watching the old,
    // value-based version of this test stay green. What IS observable is
    // whether the opener actually makes the call, and in what order. There
    // is no handle to spy on before openEncryptedUserDb creates its own, so
    // this spies on the prototype methods for the duration of one open,
    // passing every call through to the real implementation so behaviour is
    // unchanged.
    const order = pragmaOrderDuring(() => {
      openEncryptedUserDb('devtwo', KEY).close()
    })

    expect(order).toContain('cipher-pragma')
    expect(order).toContain('key')
    expect(order.indexOf('cipher-pragma')).toBeLessThan(order.indexOf('key'))
  })

  it('pins the cipher on the OPEN paths too, not only when creating', () => {
    // The pin was guarded on the CREATE path alone. Removing the pragma from
    // openEncryptedUserDb left the whole suite green; removing it from the
    // create reddened one test. The test above cannot tell them apart, because
    // a first open both creates and opens, so `order` was satisfied by the
    // create's own pragma either way.
    //
    // Why it matters more on the open path than on the create: if a driver
    // upgrade changes the default cipher, new files are still written
    // chacha20 by an unpinned create — but every open of an EXISTING file uses
    // the new default, gets SQLITE_NOTADB, and `existedBefore` is true, so it
    // is reported as WrongKeyError. The friend's dashboard reads "This
    // dashboard failed to load.", every tap 500s, and the named error points
    // diagnosis straight at their password. That is precisely the
    // misdiagnosis the pin exists to prevent, on data with no backup.
    //
    // Created OUTSIDE the spy window, so `order` can only contain calls made
    // while opening a file that already exists.
    openEncryptedUserDb('devtwo', KEY).close()

    const writable = pragmaOrderDuring(() => {
      openEncryptedUserDb('devtwo', KEY).close()
    })
    expect(writable).toContain('cipher-pragma')
    expect(writable).toContain('key')
    expect(writable.indexOf('cipher-pragma')).toBeLessThan(writable.indexOf('key'))

    // And the read-only open, which is the one a dashboard render uses — the
    // path where an unpinned cipher would surface as a broken dashboard rather
    // than as a failed tap.
    const readOnly = pragmaOrderDuring(() => {
      openEncryptedUserDb('devtwo', KEY, { readonly: true }).close()
    })
    expect(readOnly).toContain('cipher-pragma')
    expect(readOnly).toContain('key')
    expect(readOnly.indexOf('cipher-pragma')).toBeLessThan(readOnly.indexOf('key'))
  })

  it('ATOMIC CREATE: <slug>.db is never observable half-made', () => {
    // The property, not the mechanism. A direct `new Database(path)` creates
    // the file and writes pragma bytes immediately, so there is a window in
    // which <slug>.db exists but is not yet a complete, keyed database. This
    // asserts on that window from the inside: at the instant the build is
    // running its pragmas, the real path must not exist yet. Whatever
    // satisfies that — temp file plus link, or anything else — is fine; a file
    // materialising at the real path before it is finished is not.
    //
    // SAMPLED AT `journal_mode`, not at a CREATE TABLE. It used to hook the
    // schema exec, which is gone: migrations own the shape now (D6) and the
    // create writes no tables at all. The pragmas are what still runs against
    // the temp file, and they are equally inside the window.
    //
    // Why the window is worth closing rather than accepting: the render path
    // is read-only, so a half-made file no longer heals on the next page view.
    // The dashboard's first SELECT throws, and the tap control that would heal
    // it sits inside the region that just failed.
    const realPath = encryptedUserDbPath('devtwo')
    const originalPragma = Database.prototype.pragma
    const realPathExistedDuringBuild: boolean[] = []

    const pragmaSpy = vi
      .spyOn(Database.prototype, 'pragma')
      .mockImplementation(function (this: Database.Database, source: string, options?: unknown) {
        if (/journal_mode/i.test(source)) realPathExistedDuringBuild.push(existsSync(realPath))
        return originalPragma.call(this, source, options as never)
      })

    try {
      expect(existsSync(realPath)).toBe(false)
      const db = openEncryptedUserDb('devtwo', KEY)
      db.close()

      expect(realPathExistedDuringBuild.length).toBeGreaterThan(0)
      expect(realPathExistedDuringBuild[0]).toBe(false)
    } finally {
      pragmaSpy.mockRestore()
    }

    // And afterwards it is a real database — holding NO tables, because the
    // create no longer applies anything. Shape arrives from the runner.
    const db = openEncryptedUserDb('devtwo', KEY)
    try {
      const tables = db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")
        .get() as { n: number }
      expect(tables.n).toBe(0)
    } finally {
      db.close()
    }
    // ...with no half-built file left beside it. The temp name is dot-prefixed
    // and still ends in .db, so it is covered by the guard hook and .gitignore
    // while it exists — but it must not survive the call.
    expect(readdirSync(join(root, 'devtwo')).filter((f) => f.includes('creating'))).toEqual(
      [],
    )
  })

  it('ATOMIC CREATE: a concurrent first-write cannot clobber a row the winner stored', () => {
    // WHAT THIS PINS, stated exactly: a create that finds a database already
    // at the real path does not replace it. That is the property the row
    // depends on — two first-writes race for one user, each builds an empty
    // database, and the loser must not land on top of the file the winner has
    // already written a tap into. A lost row, not a lost empty file.
    //
    // WHAT IT DOES NOT PIN: that the mechanism is link() specifically. It
    // reddens against `renameSync` (drilled: 1 failed / 639), because rename
    // clobbers unconditionally — but it would stay green against
    // `existsSync(path) ? skip : renameSync(...)`, which passes this test
    // while keeping a real TOCTOU window between the check and the rename.
    // link()'s EEXIST is atomic and that guard is not; nothing here can tell
    // them apart, and the module comment is where that reasoning lives.
    //
    // The race is forced rather than hoped for: the winner's database is
    // planted at the real path at the exact instant this call is building its
    // own copy — the window in question. Hooked on `foreign_keys` rather than
    // on a CREATE TABLE, because the create no longer execs a schema (D6);
    // the instant is the same one, named by a statement that still runs.
    const realPath = encryptedUserDbPath('devtwo')
    const originalPragma = Database.prototype.pragma
    const originalExec = Database.prototype.exec
    let planted = false

    const pragmaSpy = vi
      .spyOn(Database.prototype, 'pragma')
      .mockImplementation(function (this: Database.Database, source: string, options?: unknown) {
        const result = originalPragma.call(this, source, options as never)
        if (!planted && /foreign_keys/i.test(source)) {
          planted = true
          const winner = new Database(realPath)
          originalPragma.call(winner, `cipher='chacha20'`)
          winner.key(KEY)
          originalExec.call(winner, SCHEMA)
          winner.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
          winner.close()
        }
        return result
      })

    let db: ReturnType<typeof openEncryptedUserDb>
    try {
      db = openEncryptedUserDb('devtwo', KEY)
    } finally {
      pragmaSpy.mockRestore()
    }

    try {
      expect(planted).toBe(true)
      // The winner's row survived, and the loser's empty database did not
      // replace it.
      expect(db.prepare('SELECT day FROM walks').all()).toEqual([{ day: '2026-08-13' }])
    } finally {
      db.close()
    }
  })

  it('READ-ONLY: the handle a dashboard render gets REFUSES a write', () => {
    // A capability assertion, not an option assertion. Checking that
    // `{ readonly: true }` was passed, or that some flag is set on the
    // handle, would pass against a handle that happily writes — this repo has
    // shipped that mistake before (step 5's `closeUserDbs releases handles`
    // asserted a fresh object rather than a closed one, and was green while
    // leaking a descriptor per afterEach). So: attempt the write the walk
    // route makes, and require the driver to refuse it.
    giveWalksTable('devtwo')
    const seeded = openEncryptedUserDb('devtwo', KEY)
    seeded.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    seeded.close()

    const db = openEncryptedUserDb('devtwo', KEY, { readonly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM walks').get()).toEqual({ n: 1 })
      expect(() =>
        db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-14', 2),
      ).toThrow(/readonly/i)
      // And nothing got through: the row count is unchanged.
      expect(db.prepare('SELECT COUNT(*) AS n FROM walks').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('READ-ONLY: never creates a missing file, so a render cannot conjure real data', () => {
    // fileMustExist. The lazy-creation rule is that the FIRST WRITE creates
    // the real database; a page render that created an empty one would put a
    // user permanently onto an empty real file instead of the sample.
    mkdirSync(join(root, 'devthree'), { recursive: true })
    expect(() => openEncryptedUserDb('devthree', KEY, { readonly: true })).toThrow()
    expect(encryptedUserDbExists('devthree')).toBe(false)
  })

  it('READ-ONLY: still names a wrong key rather than leaking a raw driver error', () => {
    // The schema exec is the writable path's key check. The read path has no
    // schema exec, so it needs its own first touch of the encrypted pages —
    // without one, a wrong key would surface later, unnamed, at whatever
    // SELECT the dashboard happened to run first.
    giveWalksTable('devtwo')
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    expect(() => openEncryptedUserDb('devtwo', OTHER_KEY, { readonly: true })).toThrow(
      WrongKeyError,
    )
  })

  it('READ-ONLY: does not change the shape it finds, because a render must not migrate', () => {
    // A render sees whatever shape the database is at and never advances it.
    // That rule outlived its original reason: it used to mean "does not exec
    // schema.sql", and now means "does not run migrations" — the read path is
    // not one of the three places lib/db/migrate.ts fires.
    //
    // A database left at zero tables is the stand-in for a shape that is
    // behind: opening it read-only must neither throw nor create anything.
    const seeded = openEncryptedUserDb('devtwo', KEY)
    seeded.close()

    const db = openEncryptedUserDb('devtwo', KEY, { readonly: true })
    try {
      const tables = db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")
        .get() as { n: number }
      expect(tables.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('leaves no file behind when the create throws after writing real bytes', () => {
    // The create writes real bytes — the file, the cipher, the WAL pragma —
    // before it is finished. Those bytes must not survive a failed create
    // under ANY name: not at the real path, where a stub would make
    // existedBefore true forever after and get the correct key reported as
    // wrong, and not under the temp name either, where nothing would reap it.
    //
    // THE INDUCER CHANGED, AND THE COVERAGE NARROWED. This used to be two
    // tests, driven by an unreadable schema.sql (EISDIR, throwing before the
    // exec) and by invalid SQL inside one (throwing during it). Neither exists
    // any more: no open reads a schema (D6). What is left is a throw from a
    // pragma, which fires AFTER the temp database has been created, keyed and
    // WAL-configured — the same "bytes on disk, then a failure" window both
    // originals were really about, now reachable by one route instead of two.
    const originalPragma = Database.prototype.pragma
    const pragmaSpy = vi
      .spyOn(Database.prototype, 'pragma')
      .mockImplementation(function (this: Database.Database, source: string, options?: unknown) {
        if (/foreign_keys/i.test(source)) throw new Error('induced pragma failure')
        return originalPragma.call(this, source, options as never)
      })

    try {
      mkdirSync(join(root, 'devthree'), { recursive: true })
      expect(() => openEncryptedUserDb('devthree', KEY)).toThrow(/induced pragma failure/)
      expect(encryptedUserDbExists('devthree')).toBe(false)
      expect(creatingDebris('devthree')).toEqual([])
    } finally {
      pragmaSpy.mockRestore()
    }
  })

  it('does not misdiagnose a later, legitimate open after an earlier failed create', () => {
    // The consequence of a leak: once whatever broke is fixed, opening with
    // the correct key must succeed cleanly — not get relabelled as a wrong key
    // because a stub from the earlier failure was still on disk. That
    // misdiagnosis is the expensive one: it points a friend at their password,
    // which has no reset, for a fault that was never theirs.
    //
    // Same induced-pragma inducer as the test above, restored between the two
    // halves rather than left in place.
    mkdirSync(join(root, 'devthree'), { recursive: true })

    const originalPragma = Database.prototype.pragma
    const pragmaSpy = vi
      .spyOn(Database.prototype, 'pragma')
      .mockImplementation(function (this: Database.Database, source: string, options?: unknown) {
        if (/foreign_keys/i.test(source)) throw new Error('induced pragma failure')
        return originalPragma.call(this, source, options as never)
      })
    try {
      expect(() => openEncryptedUserDb('devthree', KEY)).toThrow(/induced pragma failure/)
    } finally {
      pragmaSpy.mockRestore()
    }

    let db: ReturnType<typeof openEncryptedUserDb> | undefined
    expect(() => {
      db = openEncryptedUserDb('devthree', KEY)
    }).not.toThrow(WrongKeyError)
    db?.close()
  })

  it('is not openable as a plain SQLite database', () => {
    giveWalksTable('devtwo')
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

/**
 * A friend who has just set their password: an account, a key, and no
 * dashboard folder at all. onboarding ledger D3.
 *
 * This is the state every invited friend is in for days — between the moment
 * they choose a password and the moment Nico builds their dashboard from a
 * confirmed spec — so it is the state the code has to be right about.
 */
describe('a database with nothing in it', () => {
  const NEWCOMER = 'friendone'

  it('creates users/<slug>/ when nothing has ever created it', () => {
    expect(existsSync(join(root, NEWCOMER))).toBe(false)
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    expect(existsSync(encryptedUserDbPath(NEWCOMER))).toBe(true)
  })

  it('writes a real encrypted file, not a zero-byte placeholder', () => {
    // The distinction the user_version pragma exists for. A zero-byte file
    // opens under ANY key, so without a real write there is nothing encrypted
    // to be wrong about — and the first thing to touch it later would succeed
    // with the wrong key and then fail incomprehensibly.
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    const bytes = readFileSync(encryptedUserDbPath(NEWCOMER))
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 16).toString('utf8')).not.toBe('SQLite format 3 ')
    expect(() => openEncryptedUserDb(NEWCOMER, OTHER_KEY, { readonly: true })).toThrow(
      WrongKeyError,
    )
  })

  it('holds zero tables, so the render path knows there is no data yet', () => {
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    expect(encryptedUserDbHasTables(NEWCOMER, KEY)).toBe(false)
  })

  it('holds zero tables EVEN IF the folder is fully built', () => {
    // "Empty" is this function's name, and it must not depend on what happens
    // to be beside it on disk. This began as a schema.sql test: the create
    // read that file when it existed, so a folder scaffolded BEFORE
    // registration produced a schema'd-but-empty database that read as real.
    //
    // schema.sql is gone and the create reads nothing, so the property is now
    // structural rather than conditional — which is why the folder here is
    // built out with migrations and the answer is still zero. Shape arrives
    // only from lib/db/migrate.ts (D6).
    makeUserFolder(NEWCOMER)
    mkdirSync(join(root, NEWCOMER, 'migrations'), { recursive: true })
    writeFileSync(join(root, NEWCOMER, 'migrations', '001_initial.sql'), SCHEMA)
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    expect(encryptedUserDbHasTables(NEWCOMER, KEY)).toBe(false)
  })

  it('reports no tables for a user who has no file at all', () => {
    expect(encryptedUserDbHasTables('nobodyatall', KEY)).toBe(false)
  })

  it('acquires tables only when something actually writes them', () => {
    // The lifecycle: password set, then nothing until a write happens. An open
    // — writable or not — is not a write. This used to pass because the
    // writable open exec'd schema.sql; it passes now because nothing does, and
    // the table below is made explicitly.
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    expect(encryptedUserDbHasTables(NEWCOMER, KEY)).toBe(false)

    openEncryptedUserDb(NEWCOMER, KEY).close()
    expect(encryptedUserDbHasTables(NEWCOMER, KEY)).toBe(false)

    giveWalksTable(NEWCOMER)
    expect(encryptedUserDbHasTables(NEWCOMER, KEY)).toBe(true)
  })

  it('leaves no .creating-* debris behind', () => {
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    expect(creatingDebris(NEWCOMER)).toEqual([])
  })

  it('does not clobber a database that already holds a row', () => {
    // A retry after a partial registration must never replace a file that
    // already has data in it. The link() EEXIST property from step 6a,
    // restated for this new entry point.
    makeUserFolder(NEWCOMER)
    giveWalksTable(NEWCOMER)
    const db = openEncryptedUserDb(NEWCOMER, KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)

    const reopened = openEncryptedUserDb(NEWCOMER, KEY, { readonly: true })
    try {
      expect(
        (reopened.prepare('SELECT count(*) AS n FROM walks').get() as { n: number }).n,
      ).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('still reports a wrong key as a wrong key on a table-less database', () => {
    // There is no schema exec on any path now, so the writable open's key
    // check is the `journal_mode = WAL` pragma, which throws SQLITE_NOTADB on
    // a wrong key. This asserts that still arrives NAMED rather than surfacing
    // later as an unnamed driver error at whatever statement runs first —
    // which matters most here, on a database with nothing in it, where the
    // next statement might be a long way off.
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    expect(() => openEncryptedUserDb(NEWCOMER, OTHER_KEY)).toThrow(WrongKeyError)
  })

  it('a writable open with no schema neither creates tables nor fails', () => {
    createEmptyEncryptedDbAt(NEWCOMER, encryptedUserDbPath(NEWCOMER), KEY)
    const db = openEncryptedUserDb(NEWCOMER, KEY)
    db.close()
    expect(encryptedUserDbHasTables(NEWCOMER, KEY)).toBe(false)
  })
})
