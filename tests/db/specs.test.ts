// tests/db/specs.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import {
  confirmSpec,
  currentSpec,
  hasConfirmedSpec,
  insertSpec,
  newestSpec,
  readSpecs,
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

describe('confirmation', () => {
  it('is null until confirmed, then carries the timestamp', () => {
    const id = write(1, 'one', 1_000)
    expect(newestSpec(db, 1)!.confirmed_at).toBeNull()
    expect(hasConfirmedSpec(db, 1)).toBe(false)

    confirmSpec(db, { specId: id, accountId: 1, at: 5_000 })
    expect(newestSpec(db, 1)!.confirmed_at).toBe(5_000)
    expect(hasConfirmedSpec(db, 1)).toBe(true)
  })

  it('reports the EARLIEST confirmation and never duplicates the row', () => {
    // Two confirmations for one spec is the documented concurrent-confirm
    // race (spec section 12). It must not double the spec in readSpecs, and
    // the reported moment must be the first one — that is when the friend
    // actually decided.
    const id = write(1, 'one', 1_000)
    confirmSpec(db, { specId: id, accountId: 1, at: 5_000 })
    confirmSpec(db, { specId: id, accountId: 1, at: 9_000 })
    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.confirmed_at).toBe(5_000)
  })

  it('currentSpec is the newest CONFIRMED spec, not the newest spec', () => {
    const first = write(1, 'confirmed one', 1_000)
    confirmSpec(db, { specId: first, accountId: 1, at: 1_500 })
    write(1, 'later draft', 2_000)

    expect(JSON.parse(newestSpec(db, 1)!.payload).title).toBe('later draft')
    expect(JSON.parse(currentSpec(db, 1)!.payload).title).toBe('confirmed one')
  })

  it('has no current spec before anything is confirmed', () => {
    write(1, 'draft', 1_000)
    expect(currentSpec(db, 1)).toBeUndefined()
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
    const id = write(1, 'one', 1_000)
    confirmSpec(db, { specId: id, accountId: 1, at: 5_000 })
    expect(() =>
      db.prepare('UPDATE spec_confirmations SET at = 2').run(),
    ).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM spec_confirmations').run()).toThrow(
      /append-only/,
    )
  })
})
