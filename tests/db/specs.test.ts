// tests/db/specs.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import {
  currentSpec,
  hasSpec,
  hasSpecBelow,
  insertSpec,
  newestSpec,
  readSpecs,
  specByVersion,
} from '@/lib/db/specs'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-specs-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function write(accountId: number, title: string, at: number): number {
  return insertSpec(db, {
    accountId,
    conversationId: 'conv-1',
    promptSha: 'sha123456789',
    payload: { title },
    mockupHtml: `<!doctype html><p>${title}</p>`,
    at,
  })
}

// specs.account_id carries no FOREIGN KEY (platform/schema.sql's own
// comment: additive-only), so a fresh id here needs no accounts row behind
// it — just a number no other case in this file already used.
let nextAccount = 1000
function freshAccount(): number {
  return nextAccount++
}

describe('insertSpec / readSpecs', () => {
  it('round-trips the payload and the mockup', () => {
    write(1, 'FIRST TEST DASHBOARD', 1_000)
    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.payload)).toEqual({ title: 'FIRST TEST DASHBOARD' })
    expect(rows[0]!.mockup_html).toContain('FIRST TEST DASHBOARD')
  })

  it('returns newest first and numbers versions oldest-to-newest', () => {
    write(1, 'one', 1_000)
    write(1, 'two', 2_000)
    write(1, 'three', 3_000)
    const rows = readSpecs(db, 1)
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1])
    expect(JSON.parse(rows[0]!.payload).title).toBe('three')
  })

  it('scopes to one account', () => {
    write(1, 'mine', 1_000)
    write(2, 'theirs', 2_000)
    expect(readSpecs(db, 1)).toHaveLength(1)
    expect(readSpecs(db, 99)).toEqual([])
  })
})

describe('hasSpecBelow — "is this card the first dashboard?"', () => {
  // The bounded question, and the reason it is not hasSpec. See that
  // function's docstring: the unbounded reading flips the instant a friend's
  // very first card is on screen, which would make that same card start
  // describing a whole first dashboard as a small change on the next page
  // load.

  it('is false for an account with nothing', () => {
    write(1, 'one', 1_000)
    expect(hasSpecBelow(db, 1, 1)).toBe(false)
  })

  it('is false when the ONLY spec is the one being asked about', () => {
    // The card that IS the first dashboard. Nothing existed before it, so
    // nothing sits below it.
    write(1, 'one', 1_000)
    expect(hasSpec(db, 1)).toBe(true)
    expect(hasSpecBelow(db, 1, 1)).toBe(false)
  })

  it('is true once an EARLIER spec exists beneath the one being asked about', () => {
    write(1, 'one', 1_000)
    write(1, 'two', 2_000)
    expect(hasSpecBelow(db, 1, 2)).toBe(true)
  })

  it('scopes to one account', () => {
    write(2, 'theirs', 1_000)
    write(1, 'mine', 2_000)
    expect(hasSpecBelow(db, 1, 1)).toBe(false)
  })
})

describe('hasSpec', () => {
  it('is false until an account has a spec, then true', () => {
    expect(hasSpec(db, 1)).toBe(false)
    write(1, 'one', 1_000)
    expect(hasSpec(db, 1)).toBe(true)
  })
})

describe('currentSpec after confirmations were removed', () => {
  it('returns the newest spec row, confirmed or not', () => {
    // No spec_confirmations row is written anywhere here — that is the point.
    // The newest spec IS the contract now.
    const account = freshAccount()
    write(account, 'first', 1_000)
    const newest = write(account, 'second', 2_000)

    expect(currentSpec(db, account)?.id).toBe(newest)
  })

  it('hasSpec is false until an account has one', () => {
    const account = freshAccount()
    expect(hasSpec(db, account)).toBe(false)
    write(account, 'first', 1_000)
    expect(hasSpec(db, account)).toBe(true)
  })

  it('still reports a historical confirmation without anything writing one', () => {
    // spec_confirmations keeps its rows and its trigger. Nothing in the
    // application writes there any more; reading one still works.
    const account = freshAccount()
    const id = write(account, 'first', 1_000)
    db.prepare('INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)')
      .run(id, account, 1_500)
    expect(readSpecs(db, account)[0]!.confirmed_at).toBe(1_500)
  })
})

describe('specByVersion', () => {
  it('finds a spec by its derived version number', () => {
    // Version is position, so this cannot be a WHERE clause — it has to walk
    // the same derivation readSpecs does, or the two disagree.
    write(1, 'one', 1_000)
    const secondSpecId = write(1, 'two', 2_000)
    expect(specByVersion(db, 1, 2)?.id).toBe(secondSpecId)
  })

  it('returns undefined for a version that does not exist', () => {
    write(1, 'one', 1_000)
    expect(specByVersion(db, 1, 99)).toBeUndefined()
  })

  it('does not find another account\'s spec', () => {
    write(1, 'mine', 1_000)
    expect(specByVersion(db, 2, 1)).toBeUndefined()
  })
})

describe('append-only enforcement', () => {
  it('rejects UPDATE and DELETE on specs', () => {
    write(1, 'one', 1_000)
    expect(() => db.prepare('UPDATE specs SET at = 2').run()).toThrow(
      /append-only/,
    )
    expect(() => db.prepare('DELETE FROM specs').run()).toThrow(/append-only/)
  })

  it('rejects UPDATE and DELETE on spec_confirmations', () => {
    // Nothing in the application writes spec_confirmations rows any more,
    // but the table, its rows, and its append-only triggers all stay —
    // inserted directly here, the way the "historical confirmation" test
    // above does.
    const id = write(1, 'one', 1_000)
    db.prepare('INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)')
      .run(id, 1, 5_000)
    expect(() =>
      db.prepare('UPDATE spec_confirmations SET at = 2').run(),
    ).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM spec_confirmations').run()).toThrow(
      /append-only/,
    )
  })
})
