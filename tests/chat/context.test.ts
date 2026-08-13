// tests/chat/context.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
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

  it('is still interview while a proposal is unconfirmed', () => {
    // A spec that was offered and not accepted has not ended the interview.
    draft(1)
    expect(contextFor(db, 1)).toBe('interview')
  })

  it('is tweak once a spec is confirmed', () => {
    const id = draft(1)
    confirmSpec(db, { specId: id, accountId: 1, at: 2_000 })
    expect(contextFor(db, 1)).toBe('tweak')
  })

  it('does not leak across accounts', () => {
    const id = draft(1)
    confirmSpec(db, { specId: id, accountId: 1, at: 2_000 })
    expect(contextFor(db, 2)).toBe('interview')
  })

  it('keeps both era labels, because metrics rows already carry them', () => {
    // A rename here splits an append-only series. See ledger D11.
    const freshAccount = 1
    const confirmedAccount = 2
    const id = draft(confirmedAccount)
    confirmSpec(db, { specId: id, accountId: confirmedAccount, at: 2_000 })

    expect(contextFor(db, freshAccount)).toBe('interview')
    expect(contextFor(db, confirmedAccount)).toBe('tweak')
  })
})
