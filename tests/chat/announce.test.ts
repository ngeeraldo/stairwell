// tests/chat/announce.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount, findAccountBySlug } from '@/lib/auth/accounts'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { insertSpec } from '@/lib/db/specs'
import {
  AlreadyAnnouncedError,
  announce,
  announceTarget,
  commitAnnouncement,
  plainBody,
} from '@/lib/chat/announce'
import type { SpecVersion } from '@/lib/spec/schema'
import type { LegacySpecPayload } from '@/lib/spec/legacy'

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
    ops: null,
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

function legacyPayload(overrides: Partial<LegacySpecPayload> = {}): LegacySpecPayload {
  return {
    title: 'A legacy dashboard TEST',
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

let specSeq = 0

/**
 * Insert a spec — nothing confirms any more, so this is the only shape a
 * spec row has. Against this file's shared 'devtwo' fixture rather than
 * minting a fresh account per scenario, since these tests share one
 * account's spec history on purpose (each call adds the NEXT version,
 * matching how a real account accumulates them).
 */
function authorAVersion(
  db: PlatformDb,
  slug: string,
  overrides: Partial<SpecVersion> = {},
): number {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)
  specSeq += 1
  return insertSpec(db, {
    accountId: account.id,
    conversationId: `conv-${slug}-${specSeq}`,
    promptSha: `sha-${slug}-${specSeq}`,
    payload: currentPayload(overrides),
    mockupHtml: MOCKUP,
    at: 1_000 + specSeq,
  })
}

/**
 * A minimal notes file that readBuildNotes accepts. Four sections, in order,
 * with a non-empty "What shipped" — lib/build/notes.ts rejects anything else.
 */
function writeNote(usersDir: string, slug: string, version: number): void {
  const notesDir = join(usersDir, slug, 'notes')
  mkdirSync(notesDir, { recursive: true })
  writeFileSync(
    join(notesDir, `v${version}.md`),
    `---\nslug: ${slug}\nversion: ${version}\nbuilt_at: 2026-08-19\n---\n\n` +
      '## What shipped\nA panel TEST.\n\n' +
      '## Built differently\n\n' +
      '## Open\n\n' +
      '## Notes for the next build\n',
  )
}

function markAnnounced(db: PlatformDb, specId: number, accountId: number): void {
  appendMetric(db, {
    accountId,
    event: 'deploy_announced',
    data: { spec_id: specId },
    at: 2_000,
  })
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
  it('reports no_build_notes when nothing has been built', () => {
    // <db>, <slug> from this file's existing fixture helpers. Nothing has
    // even been authored yet for this account at this point in the file, so
    // there is no version notes could exist for either.
    expect(announceTarget(db, 'devtwo')).toEqual({
      ok: false,
      reason: 'no_build_notes',
    })
  })

  it('returns the headline, version and first-ness of the current spec', () => {
    authorAVersion(db, 'devtwo', { change_summary: 'Added a takeaway panel.' })
    // First spec ever authored for 'devtwo' in this file — version 1.
    writeNote(dir, 'devtwo', 1)
    const target = announceTarget(db, 'devtwo', dir)
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.headline).toBe('Added a takeaway panel.')
    expect(target.version).toBe(1)
    expect(target.first).toBe(true)
  })

  it('reports already_announced after a commit', () => {
    authorAVersion(db, 'devtwo', { change_summary: 'x' })
    // Second spec ever authored for 'devtwo' — version 2.
    writeNote(dir, 'devtwo', 2)
    const target = announceTarget(db, 'devtwo', dir)
    if (!target.ok) throw new Error('expected a target')
    commitAnnouncement(db, target, { body: 'hello', promptSha: 'abc123abc123', at: 5 })
    expect(announceTarget(db, 'devtwo', dir)).toEqual({
      ok: false,
      reason: 'already_announced',
    })
  })

  // Own account, not the shared 'devtwo' fixture: a legacy row is a
  // different SHAPE of spec, not just another version of the same account's
  // history, and mixing it into devtwo's sequential version count would make
  // this test's meaning depend on where in that sequence it ran.
  it("falls back to a legacy spec's title as the headline — legacy rows can never be migrated to carry change_summary", async () => {
    const legacyAccountId = await createAccount(db, {
      slug: 'legacyannounce',
      role: 'user',
      password: 'TEST-legacyannounce',
    })
    insertSpec(db, {
      accountId: legacyAccountId,
      conversationId: 'conv-legacyannounce',
      promptSha: 'sha-legacyannounce-0001',
      payload: legacyPayload(),
      mockupHtml: MOCKUP,
      at: 1_000,
    })
    writeNote(dir, 'legacyannounce', 1)

    const target = announceTarget(db, 'legacyannounce', dir)
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.headline).toBe('A legacy dashboard TEST')
  })

  // Ledger D9: a promise made to a person, gotten wrong before. A SECOND
  // BUILT version for an account must not read as its first launch.
  it('calls a second build a rebuild, not a first-time launch', async () => {
    const rebuildAccountId = await createAccount(db, {
      slug: 'rebuildannounce',
      role: 'user',
      password: 'TEST-rebuildannounce',
    })
    insertSpec(db, {
      accountId: rebuildAccountId,
      conversationId: 'conv-rebuildannounce',
      promptSha: 'sha-rebuildannounce-0001',
      payload: currentPayload({ change_summary: 'Added a streak panel TEST.' }),
      mockupHtml: MOCKUP,
      at: 1_000,
    })

    insertSpec(db, {
      accountId: rebuildAccountId,
      conversationId: 'conv-rebuildannounce',
      promptSha: 'sha-rebuildannounce-0002',
      payload: currentPayload({
        change_summary: 'Renamed the eating-out panel TEST.',
        based_on_version: 1,
      }),
      mockupHtml: MOCKUP,
      at: 2_000,
    })
    // BOTH versions were actually built this time — v1's notes exist too, not
    // just v2's. That is what makes this genuinely "a second build": the
    // scenario below (v1 authored-never-built) is a different one, and must
    // NOT read as a rebuild.
    writeNote(dir, 'rebuildannounce', 1)
    writeNote(dir, 'rebuildannounce', 2)

    const target = announceTarget(db, 'rebuildannounce', dir)
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.first).toBe(false)
    expect(plainBody(target.headline, target.first)).toBe(
      'Your dashboard was just rebuilt: Renamed the eating-out panel TEST.',
    )
  })

  // Ledger D9, the actual regression: hasSpecBelow (an earlier spec ROW
  // exists) is not the same question as "was an earlier version actually
  // built" the moment a spec can be authored without being built. A friend
  // iterates in chat — v1 is authored and never built — then asks again and
  // v2 IS built. The account's first-ever real build must still say "is
  // live", not "was just rebuilt", even though a lower-numbered spec row
  // exists.
  it('still calls it a first launch when a lower version was authored but never built', async () => {
    const neverBuiltAccountId = await createAccount(db, {
      slug: 'neverbuiltannounce',
      role: 'user',
      password: 'TEST-neverbuiltannounce',
    })
    insertSpec(db, {
      accountId: neverBuiltAccountId,
      conversationId: 'conv-neverbuiltannounce',
      promptSha: 'sha-neverbuiltannounce-0001',
      payload: currentPayload({ change_summary: 'An idea that never got built TEST.' }),
      mockupHtml: MOCKUP,
      at: 1_000,
    })

    insertSpec(db, {
      accountId: neverBuiltAccountId,
      conversationId: 'conv-neverbuiltannounce',
      promptSha: 'sha-neverbuiltannounce-0002',
      payload: currentPayload({
        change_summary: 'The first thing actually built TEST.',
        based_on_version: 1,
      }),
      mockupHtml: MOCKUP,
      at: 2_000,
    })
    // Only v2 has notes. v1's spec row exists but was never built — no notes
    // file for it, ever.
    writeNote(dir, 'neverbuiltannounce', 2)

    const target = announceTarget(db, 'neverbuiltannounce', dir)
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.first).toBe(true)
    expect(plainBody(target.headline, target.first)).toBe(
      'Your dashboard is live: The first thing actually built TEST.',
    )
  })
})

describe('announceTarget keys off build notes', () => {
  // Own account and own users tree per test, not this file's shared 'devtwo'
  // fixture: these tests assert on version NUMBERS, and 'devtwo's specSeq-
  // driven history keeps growing across the rest of the file, so a shared
  // account would make "version 1" mean something different depending on
  // what ran earlier. A fresh mkdtempSync tree per test, not just per
  // describe block, for the same reason: a notes file written by an earlier
  // test in this block would otherwise still be sitting on disk for a later
  // one's "no version has notes" check.
  let notesUsersDir: string
  let notesSlug: string
  let notesAccountId: number
  let notesSeq = 0

  beforeEach(async () => {
    notesSeq += 1
    notesUsersDir = mkdtempSync(join(tmpdir(), 'stairwell-announce-buildnotes-'))
    notesSlug = `buildnotes${notesSeq}`
    notesAccountId = await createAccount(db, {
      slug: notesSlug,
      role: 'user',
      password: `TEST-buildnotes-${notesSeq}`,
    })
  })

  afterEach(() => {
    rmSync(notesUsersDir, { recursive: true, force: true })
  })

  it('targets the highest version that has a notes file', () => {
    // Two specs, notes for v1 only. v2 is authored but not built — the state
    // between a friend asking and Nico building, which used to be impossible
    // because nothing was authored without a card in front of it.
    authorAVersion(db, notesSlug)
    authorAVersion(db, notesSlug)
    writeNote(notesUsersDir, notesSlug, 1)

    const target = announceTarget(db, notesSlug, notesUsersDir)
    expect(target.ok).toBe(true)
    expect(target.ok && target.version).toBe(1)
  })

  it('reports nothing to announce when no version has notes', () => {
    authorAVersion(db, notesSlug)
    const target = announceTarget(db, notesSlug, notesUsersDir)
    expect(target.ok).toBe(false)
    expect(!target.ok && target.reason).toBe('no_build_notes')
  })

  it('skips a version already announced rather than announcing an older one', () => {
    // v2 announced, v1 also built. Announcing v1 now would tell a friend
    // about an older build than the one they already have.
    authorAVersion(db, notesSlug)
    const second = authorAVersion(db, notesSlug)
    writeNote(notesUsersDir, notesSlug, 1)
    writeNote(notesUsersDir, notesSlug, 2)
    markAnnounced(db, second, notesAccountId)

    const target = announceTarget(db, notesSlug, notesUsersDir)
    expect(target.ok).toBe(false)
    expect(!target.ok && target.reason).toBe('already_announced')
  })

  it('does not require a confirmation', () => {
    // The point of the whole task: no spec_confirmations row exists in this
    // fixture, and the announcement still finds its target.
    authorAVersion(db, notesSlug)
    writeNote(notesUsersDir, notesSlug, 1)
    expect(announceTarget(db, notesSlug, notesUsersDir).ok).toBe(true)
  })
})

describe('commitAnnouncement', () => {
  it('stamps the drafting prompt sha, not the operator sentinel', () => {
    authorAVersion(db, 'devtwo', { change_summary: 'x' })
    // Third spec ever authored for 'devtwo' — version 3.
    writeNote(dir, 'devtwo', 3)
    const target = announceTarget(db, 'devtwo', dir)
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
    authorAVersion(db, 'devtwo', { change_summary: 'x' })
    // Fourth spec ever authored for 'devtwo' — version 4.
    writeNote(dir, 'devtwo', 4)
    const target = announceTarget(db, 'devtwo', dir)
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

  // Final review, Important 4. Two concurrent `--send` runs both call
  // announceTarget BEFORE either has written anything, so both resolve the
  // SAME ConfirmedTarget with `ok: true` — announceTarget's own check cannot
  // see a commit that has not happened yet. This test hands commitAnnouncement
  // that same stale target twice, simulating exactly that race: the guard has
  // to live inside commitAnnouncement's own transaction, not just in
  // announceTarget's read, or both calls succeed and `deploy_announced` (a
  // sacred, append-only metric per CLAUDE.md) gets a permanent duplicate.
  it('refuses a second commit for the same target, even when both resolved the target before either wrote (the race)', () => {
    authorAVersion(db, 'devtwo', { change_summary: 'racy build' })
    // Fifth spec ever authored for 'devtwo' — version 5.
    writeNote(dir, 'devtwo', 5)
    const target = announceTarget(db, 'devtwo', dir)
    if (!target.ok) throw new Error('expected a target')

    const transcriptBefore = readTranscript(db, accountId).length
    const metricsBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM metrics WHERE account_id = ?`).get(accountId) as {
        n: number
      }
    ).n

    commitAnnouncement(db, target, { body: 'first sender wins', promptSha: 'a'.repeat(12), at: 10 })

    // The SAME target object — exactly what a second, concurrent process
    // would be holding, since it read it before the first commit landed.
    expect(() =>
      commitAnnouncement(db, target, { body: 'second sender loses', promptSha: 'b'.repeat(12), at: 11 }),
    ).toThrow(AlreadyAnnouncedError)

    // Exactly one of each — the second call wrote NEITHER half of the pair,
    // not a partial duplicate.
    expect(readTranscript(db, accountId).length).toBe(transcriptBefore + 1)
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM metrics WHERE account_id = ?`).get(accountId) as {
          n: number
        }
      ).n,
    ).toBe(metricsBefore + 1)
    expect(readTranscript(db, accountId).at(-1)!.body).toBe('first sender wins')
  })
})

describe('plainBody', () => {
  it('keeps both fixed sentences verbatim', () => {
    expect(plainBody('X', true)).toBe('Your dashboard is live: X')
    expect(plainBody('X', false)).toBe('Your dashboard was just rebuilt: X')
  })
})
