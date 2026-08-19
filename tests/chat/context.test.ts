// tests/chat/context.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { insertSpec } from '@/lib/db/specs'
import { contextFor } from '@/lib/chat/context'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-context-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function draft(accountId: number): number {
  return insertSpec(db, {
    accountId,
    conversationId: 'c',
    promptSha: 'sha123456789',
    payload: { title: 'TEST' },
    mockupHtml: '<!doctype html>',
    at: 1_000,
  })
}

describe('contextFor', () => {
  it('is interview for an account with no specs at all', () => {
    expect(contextFor(db, 1)).toBe('interview')
  })

  it('is tweak the moment a spec exists — nothing confirms any more', () => {
    // The newest spec IS the contract now (lib/db/specs.ts's currentSpec), so
    // there is no "offered but not accepted" state left to distinguish.
    draft(1)
    expect(contextFor(db, 1)).toBe('tweak')
  })

  it('does not leak across accounts', () => {
    draft(1)
    expect(contextFor(db, 2)).toBe('interview')
  })

  it('keeps both era labels, because metrics rows already carry them', () => {
    // A rename here splits an append-only series. See ledger D11.
    const freshAccount = 1
    const accountWithASpec = 2
    draft(accountWithASpec)

    expect(contextFor(db, freshAccount)).toBe('interview')
    expect(contextFor(db, accountWithASpec)).toBe('tweak')
  })
})
