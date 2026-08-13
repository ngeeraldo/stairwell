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
