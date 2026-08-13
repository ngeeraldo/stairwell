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
    expect(head.toString('latin1')).not.toBe('SQLite format 3\0')
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

  it('ATOMIC CREATE: <slug>.db is never observable without its schema', () => {
    // The property, not the mechanism. A direct `new Database(path)` creates
    // the file and writes pragma bytes BEFORE schema.sql is read, so there is
    // a window in which <slug>.db exists with no tables. This asserts on that
    // window from the inside: at the instant the schema is being applied, the
    // real path must not exist yet. Whatever satisfies that — temp file plus
    // link, or anything else — is fine; a file materialising at the real path
    // before its tables is not.
    //
    // Why the window is worth closing rather than accepting: the render path
    // is read-only now, so a table-less file no longer heals on the next page
    // view. The dashboard's first SELECT throws, and the tap control that
    // would heal it sits inside the region that just failed.
    const realPath = encryptedUserDbPath('devtwo')
    const originalExec = Database.prototype.exec
    const realPathExistedDuringSchema: boolean[] = []

    const execSpy = vi
      .spyOn(Database.prototype, 'exec')
      .mockImplementation(function (this: Database.Database, sql: string) {
        if (/CREATE TABLE/i.test(sql)) realPathExistedDuringSchema.push(existsSync(realPath))
        return originalExec.call(this, sql)
      })

    try {
      expect(existsSync(realPath)).toBe(false)
      const db = openEncryptedUserDb('devtwo', KEY)
      db.close()

      expect(realPathExistedDuringSchema.length).toBeGreaterThan(0)
      expect(realPathExistedDuringSchema[0]).toBe(false)
    } finally {
      execSpy.mockRestore()
    }

    // And afterwards it is a real database with the schema applied...
    const db = openEncryptedUserDb('devtwo', KEY)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM walks').get()).toEqual({ n: 0 })
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
    // planted at the real path at the exact instant this call is applying the
    // schema to its own copy — the window in question.
    const realPath = encryptedUserDbPath('devtwo')
    const originalExec = Database.prototype.exec
    let planted = false

    const execSpy = vi
      .spyOn(Database.prototype, 'exec')
      .mockImplementation(function (this: Database.Database, sql: string) {
        const result = originalExec.call(this, sql)
        if (!planted && /CREATE TABLE/i.test(sql)) {
          planted = true
          const winner = new Database(realPath)
          winner.pragma(`cipher='chacha20'`)
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
      execSpy.mockRestore()
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
    writeFileSync(join(root, 'devthree', 'schema.sql'), SCHEMA)
    expect(() => openEncryptedUserDb('devthree', KEY, { readonly: true })).toThrow()
    expect(encryptedUserDbExists('devthree')).toBe(false)
  })

  it('READ-ONLY: still names a wrong key rather than leaking a raw driver error', () => {
    // The schema exec is the writable path's key check. The read path has no
    // schema exec, so it needs its own first touch of the encrypted pages —
    // without one, a wrong key would surface later, unnamed, at whatever
    // SELECT the dashboard happened to run first.
    const db = openEncryptedUserDb('devtwo', KEY)
    db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-13', 1)
    db.close()

    expect(() => openEncryptedUserDb('devtwo', OTHER_KEY, { readonly: true })).toThrow(
      WrongKeyError,
    )
  })

  it('READ-ONLY: does not apply schema.sql, because a render must not migrate', () => {
    // Removing schema.sql after creation is a stand-in for a schema that has
    // gained a table since the file was written: the read path must not be
    // the thing that applies it. Recorded as a consequence rather than
    // sold as a feature — see the step-6a ledger's residual on stale schemas.
    const seeded = openEncryptedUserDb('devtwo', KEY)
    seeded.close()
    rmSync(join(root, 'devtwo', 'schema.sql'))

    // No throw: the read path never reads schema.sql at all.
    const db = openEncryptedUserDb('devtwo', KEY, { readonly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM walks').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('leaves no file behind when the open fails on a brand-new file', () => {
    // The create writes real bytes — the file, the cipher, the WAL and
    // foreign_keys pragmas — before schema.sql is even read. Those bytes must
    // not survive a failed create under ANY name: not at the real path, where
    // a stub would make existedBefore true forever after and get the correct
    // key reported as wrong, and not under the temp name either, where nothing
    // would ever reap it.
    //
    // This is the failure path that throws BEFORE the schema exec — the
    // readFileSync of a missing schema.sql, evaluated as its argument.
    mkdirSync(join(root, 'devthree'), { recursive: true })
    // Deliberately no schema.sql: the exec() call has nothing to read.
    expect(() => openEncryptedUserDb('devthree', KEY)).toThrow()
    expect(encryptedUserDbExists('devthree')).toBe(false)
    expect(creatingDebris('devthree')).toEqual([])
  })

  it('leaves no half-built temp file behind when the SCHEMA ITSELF throws', () => {
    // The sibling failure path: a throw from INSIDE db.exec rather than from
    // evaluating its argument. Different route through the create's two nested
    // finally blocks — the database has had statements run against it and a
    // WAL to discard, where the case above had neither — so the cleanup is
    // worth pinning at both, not just at whichever one happened to be written
    // first.
    mkdirSync(join(root, 'devfour'), { recursive: true })
    writeFileSync(join(root, 'devfour', 'schema.sql'), 'CREATE TABLE ;;; not sql;')

    // Matched on the SQL parse error, so this cannot pass because the create
    // fell over somewhere earlier and never reached exec at all.
    expect(() => openEncryptedUserDb('devfour', KEY)).toThrow(/syntax|near/i)
    expect(encryptedUserDbExists('devfour')).toBe(false)
    expect(creatingDebris('devfour')).toEqual([])
  })

  it('does not misdiagnose a later, legitimate open after an earlier failed create', () => {
    // The consequence of the leak above: once schema.sql is fixed, opening
    // with a key must succeed cleanly — not get relabelled as a wrong key
    // because a stub from the earlier failure was still on disk.
    mkdirSync(join(root, 'devthree'), { recursive: true })
    expect(() => openEncryptedUserDb('devthree', KEY)).toThrow()

    writeFileSync(join(root, 'devthree', 'schema.sql'), SCHEMA)
    let db: ReturnType<typeof openEncryptedUserDb> | undefined
    expect(() => {
      db = openEncryptedUserDb('devthree', KEY)
    }).not.toThrow(WrongKeyError)
    db?.close()
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
