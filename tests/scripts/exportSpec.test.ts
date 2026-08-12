// tests/scripts/exportSpec.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import { SpecShapeError, type SpecPayload } from '@/lib/spec/schema'
import { exportSpec } from '@/scripts/export-spec'

const MOCKUP = '<!doctype html><html><body>COFFEE PALACE TEST</body></html>'

function payload(overrides: Partial<SpecPayload> = {}): SpecPayload {
  return {
    title: 'Some dashboard TEST',
    summary: 'A summary, COFFEE PALACE TEST.',
    background: 'Loudly-fake background, COFFEE PALACE TEST.',
    panels: [
      { name: 'Panel one', shows: 'Something', why: 'A reason', source: 'plaid' },
    ],
    manual_logging: [],
    open_questions: [],
    ...overrides,
  }
}

/**
 * Insert a spec row with an arbitrary, possibly-invalid payload string,
 * bypassing insertSpec's JSON.stringify — the only way to construct the
 * corrupt-row fixture below, since specs is append-only (no UPDATE).
 */
function insertRawSpec(
  db: PlatformDb,
  row: {
    accountId: number
    conversationId: string
    promptSha: string
    payloadText: string
    mockupHtml: string
    at: number
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO specs
       (account_id, conversation_id, prompt_sha, payload, mockup_html, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.accountId,
      row.conversationId,
      row.promptSha,
      row.payloadText,
      row.mockupHtml,
      row.at,
    )
  return Number(info.lastInsertRowid)
}

let dir: string
let db: PlatformDb

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-export-spec-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))

  const devoneId = await createAccount(db, {
    slug: 'devone',
    role: 'user',
    password: 'TEST-DEV-ONE',
  })
  const devtwoId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'TEST-DEV-TWO',
  })
  const devthreeId = await createAccount(db, {
    slug: 'devthree',
    role: 'user',
    password: 'TEST-DEV-THREE',
  })
  // 'ghost' is deliberately never created.

  // devone: a proposal that was never confirmed. currentSpec must find
  // nothing, and exportSpec must refuse loudly rather than fall back to it.
  insertSpec(db, {
    accountId: devoneId,
    conversationId: 'conv-devone',
    promptSha: 'sha-devone-0001',
    payload: payload({ title: 'A draft devone never confirmed TEST' }),
    mockupHtml: MOCKUP,
    at: 1_000,
  })

  // devtwo: an OLDER spec that gets confirmed, then a NEWER unconfirmed
  // draft on top of it. currentSpec (and so exportSpec) must still pick the
  // confirmed, older one — the newest PROPOSAL is not the build contract.
  const devtwoConfirmedId = insertSpec(db, {
    accountId: devtwoId,
    conversationId: 'conv-devtwo',
    promptSha: 'sha-devtwo-0001',
    payload: payload({
      title: 'Eating out and the car fund',
      summary:
        'This is the confirmed one; a later draft came after it but was never confirmed.',
    }),
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId: devtwoConfirmedId, accountId: devtwoId, at: 1_500 })
  insertSpec(db, {
    accountId: devtwoId,
    conversationId: 'conv-devtwo',
    promptSha: 'sha-devtwo-0002',
    payload: payload({ title: 'A newer draft nobody confirmed yet TEST' }),
    mockupHtml: '<!doctype html><html><body>SHOULD NOT BE EXPORTED TEST</body></html>',
    at: 2_000,
  })

  // devthree: a CONFIRMED spec whose stored payload is corrupt JSON. Task 3
  // finding: parseSpecPayload throws SpecShapeError on a row like this, and
  // exportSpec must let that propagate as a clear, named failure rather than
  // a generic crash or (worse) a silently empty export.
  const corruptId = insertRawSpec(db, {
    accountId: devthreeId,
    conversationId: 'conv-devthree',
    promptSha: 'sha-devthree-0001',
    payloadText: '{not valid json',
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId: corruptId, accountId: devthreeId, at: 1_500 })
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('exportSpec', () => {
  it('renders the confirmed spec and returns the mockup verbatim', () => {
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('# Eating out and the car fund')
    expect(out.spec_md).toContain('v1')
    expect(out.mockup_html).toBe(MOCKUP)
  })

  it('exports the newest CONFIRMED spec, not the newest proposal', () => {
    // The file is the build contract, and only a confirmed spec is one.
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('confirmed one')
    // The unconfirmed, newer draft's own title must not have leaked in.
    expect(out.spec_md).not.toContain('newer draft')
  })

  it('refuses an account with no confirmed spec, naming why', () => {
    expect(() => exportSpec(db, 'devone')).toThrow(/no confirmed spec/)
  })

  it('refuses an unknown slug', () => {
    expect(() => exportSpec(db, 'ghost')).toThrow(/no account/)
  })

  it('names the failure instead of crashing when the stored payload is corrupt', () => {
    expect(() => exportSpec(db, 'devthree')).toThrow(SpecShapeError)
    expect(() => exportSpec(db, 'devthree')).toThrow(/spec payload/)
  })
})
