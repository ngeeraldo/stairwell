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
