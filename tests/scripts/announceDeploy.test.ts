// tests/scripts/announceDeploy.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import { readTranscript } from '@/lib/db/appendOnly'
import { announceDeploy, OPERATOR_SHA } from '@/lib/chat/announce'
import type { SpecVersion } from '@/lib/spec/schema'
import type { LegacySpecPayload } from '@/lib/spec/legacy'

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

let dir: string
let db: PlatformDb

/**
 * A fresh account with one confirmed, current-shape spec version. Each
 * scenario below gets its OWN account (a distinct slug) rather than sharing
 * one across `it`s — announceDeploy mutates the database (a transcript row
 * and a metric row per call), and a scenario that shares state with another
 * would make removing the idempotency guard fail whichever test happens to
 * run after the mutation, not just the test that means to exercise it.
 */
async function confirmedAccount(
  slug: string,
  overrides: Partial<SpecVersion> = {},
): Promise<number> {
  const accountId = await createAccount(db, { slug, role: 'user', password: `TEST-${slug}` })
  const specId = insertSpec(db, {
    accountId,
    conversationId: `conv-${slug}`,
    promptSha: `sha-${slug}-0001`,
    payload: currentPayload(overrides),
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId, accountId, at: 1_500 })
  return accountId
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-announce-deploy-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('announceDeploy', () => {
  it("posts the confirmed version's change summary", async () => {
    const accountId = await confirmedAccount('changesummary')
    const result = announceDeploy(db, 'changesummary', () => 2_000)
    expect(result).toMatchObject({ announced: true })
    expect(readTranscript(db, accountId).at(-1)!.body).toContain('Added a streak')
  })

  it('refuses when the account has no confirmed spec', async () => {
    // Never confirmed — a draft only, so currentSpec must find nothing.
    const accountId = await createAccount(db, {
      slug: 'noconfirmedspec',
      role: 'user',
      password: 'TEST-noconfirmedspec',
    })
    insertSpec(db, {
      accountId,
      conversationId: 'conv-noconfirmedspec',
      promptSha: 'sha-noconfirmedspec-0001',
      payload: currentPayload({ title: 'A draft nobody confirmed TEST' }),
      mockupHtml: MOCKUP,
      at: 1_000,
    })

    expect(announceDeploy(db, 'noconfirmedspec', () => 2_000)).toMatchObject({
      announced: false,
      reason: 'no_confirmed_spec',
    })
    expect(readTranscript(db, accountId)).toHaveLength(0)
  })

  it('is idempotent per spec — a re-deploy does not say it twice', async () => {
    // deploy.sh may run several times against the same confirmed version.
    // transcripts is append-only, so a duplicate is permanent.
    const accountId = await confirmedAccount('idempotent')
    announceDeploy(db, 'idempotent', () => 2_000)
    expect(announceDeploy(db, 'idempotent', () => 3_000)).toMatchObject({
      announced: false,
      reason: 'already_announced',
    })
    expect(
      readTranscript(db, accountId).filter((r) => r.prompt_sha === OPERATOR_SHA),
    ).toHaveLength(1)
  })

  it('announces again after a NEW version is confirmed', async () => {
    const accountId = await confirmedAccount('newversion')
    expect(announceDeploy(db, 'newversion', () => 2_000).announced).toBe(true)

    const newSpecId = insertSpec(db, {
      accountId,
      conversationId: 'conv-newversion',
      promptSha: 'sha-newversion-0002',
      payload: currentPayload({
        change_summary: 'Added an export button TEST.',
        based_on_version: 1,
      }),
      mockupHtml: MOCKUP,
      at: 4_000,
    })
    confirmSpec(db, { specId: newSpecId, accountId, at: 4_500 })

    expect(announceDeploy(db, 'newversion', () => 5_000).announced).toBe(true)
    expect(
      readTranscript(db, accountId).filter((r) => r.prompt_sha === OPERATOR_SHA),
    ).toHaveLength(2)
  })

  it('announces a legacy confirmed spec using its title', async () => {
    // A legacy row has no change_summary. Falling back to the title beats
    // saying nothing on the one morning the promise is being kept.
    const accountId = await createAccount(db, {
      slug: 'legacyuser',
      role: 'user',
      password: 'TEST-legacyuser',
    })
    const legacySpecId = insertSpec(db, {
      accountId,
      conversationId: 'conv-legacyuser',
      promptSha: 'sha-legacyuser-0001',
      payload: legacyPayload(),
      mockupHtml: MOCKUP,
      at: 1_000,
    })
    confirmSpec(db, { specId: legacySpecId, accountId, at: 1_500 })

    const result = announceDeploy(db, 'legacyuser', () => 2_000)
    expect(result.announced).toBe(true)
    expect(readTranscript(db, accountId).at(-1)!.body).toContain('A legacy dashboard TEST')
  })
})
