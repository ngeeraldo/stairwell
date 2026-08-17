// tests/chat/announce.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount, findAccountBySlug } from '@/lib/auth/accounts'
import { readTranscript } from '@/lib/db/appendOnly'
import { insertSpec, confirmSpec } from '@/lib/db/specs'
import { announce, announceTarget, commitAnnouncement, plainBody } from '@/lib/chat/announce'
import type { SpecVersion } from '@/lib/spec/schema'

let dir: string
let db: PlatformDb
let accountId: number

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-announce-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  accountId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'TEST-DEV-TWO',
  })
})

const MOCKUP = '<!doctype html><html><body>COFFEE PALACE TEST</body></html>'

function currentPayload(overrides: Partial<SpecVersion> = {}): SpecVersion {
  return {
    title: 'Did I walk the dog today? TEST',
    summary: 'A one-tap tracker, COFFEE PALACE TEST.',
    background: 'Pivoted from weather TEST.',
    change_summary: 'Added a streak panel TEST.',
    based_on_version: null,
    screens: [
      {
        id: 'today',
        title: 'Today TEST',
        order: 1,
        panels: [
          {
            id: 'walked_today',
            title: 'Walked today? TEST',
            intent: 'Did I walk the dog TEST?',
            display: 'Yes/no with a tap TEST.',
            context_of_use: null,
            values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day TEST.' }],
            entry: null,
          },
        ],
      },
    ],
    data_requirements: [],
    open_questions: [],
    ...overrides,
  }
}

let specSeq = 0

/**
 * Confirm a new spec version for an already-existing account, in the style
 * of tests/scripts/announceDeploy.test.ts's confirmedAccount — but against
 * this file's shared 'devtwo' fixture rather than minting a fresh account
 * per scenario, since these tests share one account's spec history on
 * purpose (each call adds the NEXT confirmed version, matching how a real
 * account accumulates them).
 */
function confirmAVersion(
  db: PlatformDb,
  slug: string,
  overrides: Partial<SpecVersion> = {},
): void {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)
  specSeq += 1
  const specId = insertSpec(db, {
    accountId: account.id,
    conversationId: `conv-${slug}-${specSeq}`,
    promptSha: `sha-${slug}-${specSeq}`,
    payload: currentPayload(overrides),
    mockupHtml: MOCKUP,
    at: 1_000 + specSeq,
  })
  confirmSpec(db, { specId, accountId: account.id, at: 1_500 + specSeq })
}

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('announce', () => {
  it('appends an assistant row the friend sees next time they open the page', () => {
    announce(db, { accountId, body: 'Your streak panel is live TEST.', at: 1 })
    expect(readTranscript(db, accountId).at(-1)).toMatchObject({
      role: 'assistant',
      body: 'Your streak panel is live TEST.',
    })
  })

  it('stamps prompt_sha "operator", so a human message is never mistaken for model output', () => {
    // Every other transcript row's prompt_sha is a content hash of the prompt
    // that produced it. This row had no prompt: a person typed it. The log of
    // record has to be able to tell those apart, permanently.
    //
    // Pinned against the LITERAL string, not the imported OPERATOR_SHA
    // constant — comparing against the constant would make this assertion a
    // tautology that passes no matter what value the constant holds. The
    // exact spelling is the thing every other consumer (and a human reading
    // the row later) relies on.
    announce(db, { accountId, body: 'x', at: 2 })
    expect(readTranscript(db, accountId).at(-1)!.prompt_sha).toBe('operator')
  })

  it('refuses an empty body', () => {
    // An empty body breaks every later turn for that account, forever
    // (lib/chat/history.ts). transcripts cannot be corrected.
    const before = readTranscript(db, accountId).length
    expect(() => announce(db, { accountId, body: '   ', at: 3 })).toThrow()
    expect(readTranscript(db, accountId)).toHaveLength(before)
  })

  it('joins the conversation rather than starting a stray one', () => {
    const existingConversationId = readTranscript(db, accountId).at(-1)!.conversation_id
    announce(db, { accountId, body: 'Still the same conversation TEST.', at: 4 })
    expect(readTranscript(db, accountId).at(-1)!.conversation_id).toBe(existingConversationId)
  })
})

describe('announceTarget', () => {
  it('reports no_confirmed_spec when nothing is confirmed', () => {
    // <db>, <slug> from this file's existing fixture helpers.
    expect(announceTarget(db, 'devtwo')).toEqual({
      ok: false,
      reason: 'no_confirmed_spec',
    })
  })

  it('returns the headline, version and first-ness of the confirmed spec', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'Added a takeaway panel.' })
    const target = announceTarget(db, 'devtwo')
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.headline).toBe('Added a takeaway panel.')
    expect(target.version).toBe(1)
    expect(target.first).toBe(true)
  })

  it('reports already_announced after a commit', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'x' })
    const target = announceTarget(db, 'devtwo')
    if (!target.ok) throw new Error('expected a target')
    commitAnnouncement(db, target, { body: 'hello', promptSha: 'abc123abc123', at: 5 })
    expect(announceTarget(db, 'devtwo')).toEqual({
      ok: false,
      reason: 'already_announced',
    })
  })
})

describe('commitAnnouncement', () => {
  it('stamps the drafting prompt sha, not the operator sentinel', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'x' })
    const target = announceTarget(db, 'devtwo')
    if (!target.ok) throw new Error('expected a target')
    commitAnnouncement(db, target, { body: 'hello', promptSha: 'deadbeef1234', at: 5 })
    const row = db
      .prepare(`SELECT prompt_sha, session_id FROM transcripts ORDER BY id DESC LIMIT 1`)
      .get() as { prompt_sha: string; session_id: string }
    // A drafted sentence was produced by a prompt, so the row names it.
    expect(row.prompt_sha).toBe('deadbeef1234')
    // There is still no session — that sentinel keeps meaning what it says.
    expect(row.session_id).toBe('operator')
  })

  it('refuses a blank body, and writes neither half of the pair', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'x' })
    const target = announceTarget(db, 'devtwo')
    if (!target.ok) throw new Error('expected a target')
    const metricsBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM metrics WHERE account_id = ?`).get(accountId) as {
        n: number
      }
    ).n
    expect(() =>
      commitAnnouncement(db, target, { body: '  ', promptSha: 'a'.repeat(12), at: 5 }),
    ).toThrow()
    // The transaction guarantee this task is about: announce() threw before
    // appendMetric ever ran, so the rejected write must not have posted a
    // deploy_announced row either — otherwise a later run would believe this
    // spec was already announced when nothing was ever said.
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM metrics WHERE account_id = ?`).get(accountId) as {
          n: number
        }
      ).n,
    ).toBe(metricsBefore)
  })
})

describe('plainBody', () => {
  it('keeps both fixed sentences verbatim', () => {
    expect(plainBody('X', true)).toBe('Your dashboard is live: X')
    expect(plainBody('X', false)).toBe('Your dashboard was just rebuilt: X')
  })
})
