// tests/scripts/announceDeploy.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import { readTranscript } from '@/lib/db/appendOnly'
import type { ChatClient } from '@/lib/chat/client'
import type { SpecVersion } from '@/lib/spec/schema'
import { runAnnounce, type AnnounceDeps } from '@/scripts/announce-deploy'

const MOCKUP = '<!doctype html><html><body>COFFEE PALACE TEST</body></html>'

function currentPayload(overrides: Partial<SpecVersion> = {}): SpecVersion {
  return {
    title: 'Did I walk the dog today? TEST',
    summary: 'A one-tap tracker, COFFEE PALACE TEST.',
    background: 'Pivoted from weather TEST.',
    change_summary: 'Added a takeaway panel TEST.',
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

/** A client whose propose() resolves with a fixed drafted message. */
function clientReturning(message: string): ChatClient {
  return {
    stream: vi.fn(),
    propose: vi.fn(async () => ({
      input: { message },
      usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
      stop_reason: 'end_turn',
      served: { model_served: 'claude-opus-5', fallback_fired: false },
    })),
  } as unknown as ChatClient
}

/**
 * A client whose propose() always rejects — used to prove both that
 * runAnnounce REFUSES on a drafting failure rather than falling back, and
 * (in the --plain tests) that it is never even called.
 */
function failingClient(): ChatClient {
  return {
    stream: vi.fn(),
    propose: vi.fn(async () => {
      throw new Error('model unreachable TEST')
    }),
  } as unknown as ChatClient
}

let dir: string
let usersDir: string
let db: PlatformDb
let accountId: number
let deps: AnnounceDeps

/** users/sam/notes/v<version>.md, written fresh for each test that needs one. */
function writeNotes(slug: string, version: number, opts: { open?: string } = {}): void {
  mkdirSync(join(usersDir, slug, 'notes'), { recursive: true })
  const text = [
    '---',
    `slug: ${slug}`,
    `version: ${version}`,
    'built_at: 2026-08-17',
    '---',
    '',
    '## What shipped',
    '',
    'The takeaway panel now shows a weekly total TEST.',
    '',
    '## Built differently',
    '',
    '',
    '## Open',
    '',
    opts.open ?? '',
    '',
    '## Notes for the next build',
    '',
    '',
  ].join('\n')
  writeFileSync(join(usersDir, slug, 'notes', `v${version}.md`), text)
}

function transcriptCount(database: PlatformDb): number {
  return readTranscript(database, accountId).length
}

function metricCount(database: PlatformDb, event: string): number {
  const row = database
    .prepare('SELECT COUNT(*) AS n FROM metrics WHERE account_id = ? AND event = ?')
    .get(accountId, event) as { n: number }
  return row.n
}

function lastTranscriptBody(database: PlatformDb): string {
  const rows = readTranscript(database, accountId)
  return rows.at(-1)!.body
}

// Fresh platform db AND fresh USERS_DIR per test: a slug/version pair
// ('sam' v1) is reused verbatim across scenarios, so scenarios cannot share
// one database — the idempotency guard under test (already_announced) would
// otherwise depend on test run order, exactly the trap the pre-existing
// announceDeploy fixture comment (git history) warns about.
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-announce-deploy-'))
  usersDir = mkdtempSync(join(tmpdir(), 'stairwell-announce-deploy-notes-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  accountId = await createAccount(db, { slug: 'sam', role: 'user', password: 'TEST-sam' })
  const specId = insertSpec(db, {
    accountId,
    conversationId: 'conv-sam',
    promptSha: 'sha-sam-0001',
    payload: currentPayload(),
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId, accountId, at: 1_500 })

  deps = {
    db,
    client: clientReturning('Your takeaway total is up now.'),
    now: () => 2_000,
    usersDir,
  }
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(usersDir, { recursive: true, force: true })
})

describe('runAnnounce', () => {
  it('refuses when the notes file is missing, naming the path', async () => {
    const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('notes_missing')
    expect(out.message).toMatch(/v1\.md/)
    expect(transcriptCount(db)).toBe(0)
  })

  it('drafts and prints without writing, by default', async () => {
    writeNotes('sam', 1)
    const out = await runAnnounce(deps, { slug: 'sam', send: false, plain: false })
    expect(out.kind).toBe('drafted')
    expect(out.body).toBe('Your takeaway total is up now.')
    // The dry run must write NEITHER, or the real send becomes a no-op.
    expect(transcriptCount(db)).toBe(0)
    expect(metricCount(db, 'deploy_announced')).toBe(0)
  })

  it('sends on --send', async () => {
    writeNotes('sam', 1)
    const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('announced')
    expect(transcriptCount(db)).toBe(1)
  })

  it('warns when ## Open is non-empty, and still announces', async () => {
    writeNotes('sam', 1, { open: 'The investment tile needs a connection.' })
    const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('announced')
    expect(out.warnings.join(' ')).toMatch(/Open/)
    // Builder-only: it warns Nico and never reaches the friend.
    expect(lastTranscriptBody(db)).not.toContain('investment')
  })

  it('--plain sends the fixed sentence and makes no model call', async () => {
    writeNotes('sam', 1)
    const client = failingClient()
    const out = await runAnnounce({ ...deps, client }, { slug: 'sam', send: true, plain: true })
    expect(out.kind).toBe('announced')
    expect(lastTranscriptBody(db)).toMatch(/^Your dashboard is live: /)
    expect(client.propose).not.toHaveBeenCalled()
  })

  it('refuses rather than silently falling back when drafting fails', async () => {
    writeNotes('sam', 1)
    const out = await runAnnounce(
      { ...deps, client: failingClient() },
      { slug: 'sam', send: true, plain: false },
    )
    expect(out.kind).toBe('draft_failed')
    expect(transcriptCount(db)).toBe(0)
  })

  it('reports already_announced without drafting again', async () => {
    writeNotes('sam', 1)
    await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    const client = failingClient()
    const out = await runAnnounce({ ...deps, client }, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('already_announced')
    expect(client.propose).not.toHaveBeenCalled()
  })
})
