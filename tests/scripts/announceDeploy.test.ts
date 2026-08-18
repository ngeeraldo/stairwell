// tests/scripts/announceDeploy.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import type { ChatClient } from '@/lib/chat/client'
import type { SpecVersion } from '@/lib/spec/schema'
import {
  exitCodeFor,
  resolveClient,
  runAnnounce,
  type AnnounceDeps,
  type AnnounceOutcome,
} from '@/scripts/announce-deploy'

const MOCKUP = '<!doctype html><html><body>COFFEE PALACE TEST</body></html>'

function currentPayload(overrides: Partial<SpecVersion> = {}): SpecVersion {
  return {
    title: 'Did I walk the dog today? TEST',
    summary: 'A one-tap tracker, COFFEE PALACE TEST.',
    background: 'Pivoted from weather TEST.',
    change_summary: 'Added a takeaway panel TEST.',
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

  it('warns when ## Open is non-empty, and never sends it to the drafting call', async () => {
    writeNotes('sam', 1, { open: 'The investment tile needs a connection.' })
    const client = clientReturning('Your takeaway total is up now.')
    const out = await runAnnounce({ ...deps, client }, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('announced')
    expect(out.warnings.join(' ')).toMatch(/Open/)
    // Builder-only: it warns Nico and never reaches the friend. Asserting on
    // the transcript body ALONE would pass even if the raw notes — "## Open"
    // included — were handed straight to draftAnnouncement, because this
    // fixture's fake client ignores its input and always returns the same
    // fixed string (the vacuous-assertion trap tests/chat/draftAnnouncement
    // .test.ts's sentinel test guards against for the lower-level call). The
    // real guarantee has to be checked at the boundary that actually sends
    // bytes: what was passed to propose().
    const sent = JSON.stringify((client.propose as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(sent).not.toContain('investment')
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

  // Final review, Important 4: --body-file sends Nico's own reviewed bytes
  // verbatim, with no model call — the way to actually send what an earlier
  // dry run showed, rather than a fresh independent sample.
  describe('--body-file', () => {
    function writeBody(text: string): string {
      const path = join(dir, 'reviewed-body.txt')
      writeFileSync(path, text)
      return path
    }

    it('sends the file verbatim and makes no model call', async () => {
      const path = writeBody('Exactly what Nico reviewed.')
      const client = failingClient()
      const out = await runAnnounce(
        { ...deps, client },
        { slug: 'sam', send: true, plain: false, bodyFile: path },
      )
      expect(out.kind).toBe('announced')
      expect(lastTranscriptBody(db)).toBe('Exactly what Nico reviewed.')
      expect(client.propose).not.toHaveBeenCalled()
    })

    it('reads the file fresh on a dry run too, and writes nothing', async () => {
      const path = writeBody('Preview only.')
      const out = await runAnnounce(deps, { slug: 'sam', send: false, plain: false, bodyFile: path })
      expect(out.kind).toBe('drafted')
      expect(out.body).toBe('Preview only.')
      expect(transcriptCount(db)).toBe(0)
    })

    it('reports body_file_invalid, naming the path, when the file cannot be read', async () => {
      const out = await runAnnounce(deps, {
        slug: 'sam',
        send: true,
        plain: false,
        bodyFile: join(dir, 'does-not-exist.txt'),
      })
      expect(out.kind).toBe('body_file_invalid')
      expect(out.message).toContain('does-not-exist.txt')
      expect(transcriptCount(db)).toBe(0)
    })

    it('refuses to combine with --plain, since both skip drafting differently', async () => {
      const path = writeBody('irrelevant')
      const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: true, bodyFile: path })
      expect(out.kind).toBe('draft_failed')
      expect(transcriptCount(db)).toBe(0)
    })
  })

  // Final review, Important 4: without --body-file, --send re-drafts — a
  // fresh, independent model sample — so the operator gets told the text
  // about to be written permanently may not match an earlier dry run.
  describe('the re-draft warning', () => {
    it('warns on --send when no --body-file was given', async () => {
      writeNotes('sam', 1)
      const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
      expect(out.kind).toBe('announced')
      expect(out.warnings.join(' ')).toMatch(/fresh|new model sample/i)
      expect(out.warnings.join(' ')).toMatch(/--body-file/)
    })

    it('does not warn on a dry run — nothing is written yet to disagree with', async () => {
      writeNotes('sam', 1)
      const out = await runAnnounce(deps, { slug: 'sam', send: false, plain: false })
      expect(out.kind).toBe('drafted')
      expect(out.warnings).toEqual([])
    })

    it('does not warn on --send --plain — the fixed sentence never varies', async () => {
      writeNotes('sam', 1)
      const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: true })
      expect(out.kind).toBe('announced')
      expect(out.warnings).toEqual([])
    })

    it('does not warn on --send --body-file — nothing was redrafted', async () => {
      const path = join(dir, 'reviewed.txt')
      writeFileSync(path, 'Reviewed text.')
      const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false, bodyFile: path })
      expect(out.kind).toBe('announced')
      expect(out.warnings).toEqual([])
    })
  })

  // D17 (unified-loop ledger), exercised end to end. Every test above seeds
  // no transcript rows, so readTranscript returns [] and the trailing-user-
  // turn branch in scripts/announce-deploy.ts never runs — this is the one
  // test that actually puts an unanswered user turn on the account first.
  it('never sends two consecutive user messages, even when the account’s last turn was an unanswered user message (D17)', async () => {
    writeNotes('sam', 1)
    // A real conversation: friend asks, agent replies, friend asks again and
    // gets no reply before Nico runs this script — readTranscript makes no
    // promise otherwise.
    appendTranscript(db, {
      accountId,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'sha-turn-1',
      role: 'user',
      body: 'Can you add a total? TEST',
      at: 100,
    })
    appendTranscript(db, {
      accountId,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'sha-turn-2',
      role: 'assistant',
      body: 'Working on it TEST.',
      at: 200,
    })
    appendTranscript(db, {
      accountId,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'sha-turn-3',
      role: 'user',
      body: 'Any update? TEST',
      at: 300,
    })

    const client = clientReturning('Your takeaway total is up now.')
    await runAnnounce({ ...deps, client }, { slug: 'sam', send: false, plain: false })

    const sent = (client.propose as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: { role: string; content: string }[]
    }
    const roles = sent.messages.map((m) => m.role)
    expect(roles.length).toBeGreaterThan(1)
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1])
    }
    // And specifically: the trailing unanswered user turn was dropped rather
    // than kept, so the request ends with draftAnnouncement's OWN appended
    // user turn, not two of them back to back.
    expect(roles.at(-1)).toBe('user')
    expect(roles.at(-2)).toBe('assistant')
  })
})

describe('resolveClient', () => {
  // Final review, Important 4: --body-file must not require ANTHROPIC_API_KEY
  // either — it makes no model call, the same situation --plain already
  // covers, just from a file instead of a fixed sentence.
  it('--body-file: returns the same never-called stub as --plain, needing no credential', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const client = resolveClient(false, '/some/path.txt')
      await expect(
        client.propose({
          system: '',
          messages: [],
          signal: new AbortController().signal,
          schema: {},
        }),
      ).rejects.toThrow()
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('--plain: returns a stub that rejects if ever called, needing no credential', async () => {
    const client = resolveClient(true)
    await expect(
      client.propose({
        system: '',
        messages: [],
        signal: new AbortController().signal,
        schema: {},
      }),
    ).rejects.toThrow()
    await expect(
      client.stream({
        system: '',
        messages: [],
        signal: new AbortController().signal,
        onText: () => {},
        onUsage: () => {},
        onServed: () => {},
      }),
    ).rejects.toThrow()
  })

  it('not --plain: constructs a real client when a credential is present', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-FAKE-NEVER-SENT'
    try {
      const client = resolveClient(false)
      expect(typeof client.propose).toBe('function')
      expect(typeof client.stream).toBe('function')
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('not --plain: throws (rather than silently degrading) when no credential is set', () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      expect(() => resolveClient(false)).toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
    }
  })
})

describe('exitCodeFor', () => {
  it('is nonzero for every refusal kind, zero for everything else', () => {
    const refusals: AnnounceOutcome['kind'][] = [
      'notes_missing',
      'notes_invalid',
      'draft_failed',
      'no_confirmed_spec',
      'body_file_invalid',
    ]
    const ok: AnnounceOutcome['kind'][] = ['drafted', 'announced', 'already_announced']
    for (const kind of refusals) expect(exitCodeFor(kind)).not.toBe(0)
    for (const kind of ok) expect(exitCodeFor(kind)).toBe(0)
  })
})
