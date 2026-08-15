// tests/db/userData.test.ts
//
// Which database serves, and the gate that decides.
//
// There is no fallback any more: production always serves the friend's own
// encrypted database, empty or not, and dev always serves synthetic.db for
// reads AND writes so an entry widget can be tested end to end. The gate is
// NODE_ENV and nothing else — a variable that could switch production onto
// synthetic data would rebuild the failure deploy/required-env describes for
// PLATFORM_DB: loudly-fake data served in production, every health check green.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { encryptedUserDbPath } from '@/lib/db/encryptedUserDb'
import { migrateUserDb } from '@/lib/db/migrate'
import { isDevData, openUserDataForRead, openUserDataForWrite } from '@/lib/db/userData'
import { userDbPath } from '@/lib/db/userDb'
import { setNodeEnv, withNodeEnv } from '@/tests/support/nodeEnv'

const KEY = Buffer.alloc(32, 7)
let root: string
let originalEnv: string | undefined

/** A synthetic database with one table, as seed.py would leave it. */
function makeSynthetic(slug: string) {
  mkdirSync(join(root, slug), { recursive: true })
  const db = new Database(userDbPath(slug))
  try {
    db.exec('CREATE TABLE walks (day TEXT PRIMARY KEY, at INTEGER NOT NULL);')
    db.pragma('user_version = 1')
  } finally {
    db.close()
  }
}

/** A real encrypted database with one table, as the runner would leave it. */
function makeReal(slug: string) {
  mkdirSync(join(root, slug, 'migrations'), { recursive: true })
  withNodeEnv('production', () => {
    const db = openUserDataForWrite(slug, KEY)
    try {
      db.exec('CREATE TABLE walks (day TEXT PRIMARY KEY, at INTEGER NOT NULL);')
    } finally {
      db.close()
    }
  })
}

beforeEach(() => {
  originalEnv = process.env.NODE_ENV
  root = mkdtempSync(join(tmpdir(), 'stairwell-data-'))
  process.env.USERS_DIR = root
})

afterEach(() => {
  setNodeEnv(originalEnv)
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('isDevData', () => {
  it('is false in production and true everywhere else', () => {
    withNodeEnv('production', () => expect(isDevData()).toBe(false))
    withNodeEnv('development', () => expect(isDevData()).toBe(true))
    withNodeEnv('test', () => expect(isDevData()).toBe(true))
  })
})

describe('which database serves', () => {
  it('production reads the friend’s encrypted file', () => {
    makeReal('devtwo')
    withNodeEnv('production', () => {
      const db = openUserDataForRead('devtwo', KEY)
      try {
        expect(db.name).toBe(encryptedUserDbPath('devtwo'))
      } finally {
        db.close()
      }
    })
  })

  it('dev reads synthetic.db', () => {
    makeSynthetic('devtwo')
    withNodeEnv('development', () => {
      const db = openUserDataForRead('devtwo', KEY)
      try {
        expect(db.name).toBe(userDbPath('devtwo'))
      } finally {
        db.close()
      }
    })
  })

  it('dev WRITES to synthetic.db too, so an entry widget is testable', () => {
    // The whole reason dev is not "synthetic for reads, real for writes":
    // that split makes typing a weight save somewhere the screen never reads.
    makeSynthetic('devtwo')
    withNodeEnv('development', () => {
      const db = openUserDataForWrite('devtwo', KEY)
      try {
        db.prepare('INSERT INTO walks (day, at) VALUES (?, ?)').run('2026-08-15', 1)
      } finally {
        db.close()
      }

      const read = openUserDataForRead('devtwo', KEY)
      try {
        expect(read.prepare('SELECT COUNT(*) AS n FROM walks').get()).toEqual({ n: 1 })
      } finally {
        read.close()
      }
    })
  })

  it('the READ handle refuses a write in BOTH worlds', () => {
    // A dashboard component never holds a writable handle. That rule is
    // unchanged by this design and must hold on the dev path too, which is new
    // — before, dev's synthetic open was read-only by construction because
    // nothing ever wrote to it.
    makeSynthetic('devtwo')
    withNodeEnv('development', () => {
      const db = openUserDataForRead('devtwo', KEY)
      try {
        expect(() => db.exec('CREATE TABLE probe (x)')).toThrow(/readonly/i)
      } finally {
        db.close()
      }
    })

    makeReal('devthree')
    withNodeEnv('production', () => {
      const db = openUserDataForRead('devthree', KEY)
      try {
        expect(() => db.exec('CREATE TABLE probe (x)')).toThrow(/readonly/i)
      } finally {
        db.close()
      }
    })
  })

  it('RED TEST: production cannot be talked onto synthetic data', () => {
    // Deleting the NODE_ENV gate must turn this red. There is no variable that
    // switches production onto fake data, and there must never be one: that is
    // the PLATFORM_DB failure mode, which deploy/required-env blocks a deploy
    // over.
    makeReal('devtwo')
    makeSynthetic('devtwo')
    withNodeEnv('production', () => {
      process.env.SYNTHETIC_DASHBOARDS = '1'
      process.env.USE_SYNTHETIC = '1'
      try {
        const db = openUserDataForRead('devtwo', KEY)
        try {
          expect(db.name).toBe(encryptedUserDbPath('devtwo'))
        } finally {
          db.close()
        }
      } finally {
        delete process.env.SYNTHETIC_DASHBOARDS
        delete process.env.USE_SYNTHETIC
      }
    })
  })
})

describe('the runner in dev', () => {
  it('does nothing, and creates no real-named file', () => {
    // seed.py owns synthetic's shape and stamps user_version, so there is
    // nothing to apply. More importantly a real-named file must never exist on
    // a laptop: the guard hook's whole partition is "synthetic.db is the only
    // database anything local may open".
    mkdirSync(join(root, 'devtwo', 'migrations'), { recursive: true })
    withNodeEnv('development', () => {
      expect(() => migrateUserDb('devtwo', KEY)).not.toThrow()
    })
    expect(existsSync(encryptedUserDbPath('devtwo'))).toBe(false)
  })
})
