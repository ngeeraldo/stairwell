// tests/spec/author.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { appendTranscript } from '@/lib/db/appendOnly'
import { readSpecs } from '@/lib/db/specs'
import { CHAT_MODEL, ChatStreamError, type ChatClient } from '@/lib/chat/client'
import { authorSpec } from '@/lib/spec/author'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-author-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const GOOD = {
  title: 'Eating out and the car fund',
  summary: 'So mornings stop being a surprise.',
  background: 'Checks the banking app most days.',
  panels: [{ name: 'Eating out', shows: 'This month', why: 'Said so', source: 'plaid' }],
  manual_logging: [],
  open_questions: [],
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

const USAGE = { input: 50, output: 900, cache_read: 0, cache_creation: 0 }
const SERVED = { model_served: CHAT_MODEL, fallback_fired: false }

function client(over: Partial<ChatClient> = {}): ChatClient {
  return {
    async stream() {
      throw new Error('unused')
    },
    async propose() {
      return { input: GOOD, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
    },
    ...over,
  } as ChatClient
}

const INPUT = {
  accountId: 1,
  conversationId: 'conv-1',
  signal: new AbortController().signal,
}

const deps = (c: ChatClient) => ({
  db,
  client: c,
  now: () => 5_000,
  context: 'interview' as const,
})

function metrics(): { event: string; data: Record<string, unknown> }[] {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data) }))
}

describe('authorSpec', () => {
  it('inserts one spec and records spec_proposed', async () => {
    const proposal = await authorSpec(deps(client()), INPUT)

    expect(proposal!.version).toBe(1)
    expect(proposal!.payload.title).toBe('Eating out and the car fund')
    expect(proposal!.mockup_html).toContain('COFFEE PALACE TEST')

    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conversation_id).toBe('conv-1')

    const [row] = metrics()
    expect(row!.event).toBe('spec_proposed')
    expect(row!.data.spec_id).toBe(proposal!.id)
    expect(row!.data.version).toBe(1)
    expect(row!.data.output).toBe(900)
    expect(row!.data.context).toBe('interview')
    // The authoring prompt's sha, NOT the interview prompt's.
    expect(row!.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('writes NO spec and records spec_error when the call fails', async () => {
    const failing = client({
      async propose() {
        throw new ChatStreamError(
          { kind: 'rate_limit', status: 429, type: 'rate_limit_error' },
          'slow down',
        )
      },
    })
    expect(await authorSpec(deps(failing), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('rate_limit')
    expect(row!.data.status).toBe(429)
  })

  it('writes NO spec and records spec_error when the payload is malformed', async () => {
    // A schema-valid REQUEST does not guarantee a schema-valid RESPONSE
    // reaching an append-only table. The validator is the last gate.
    const bad = client({
      async propose() {
        return {
          input: { ...GOOD, panels: [] },
          usage: USAGE,
          stop_reason: 'end_turn',
          served: SERVED,
        }
      },
    })
    expect(await authorSpec(deps(bad), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('malformed_spec')
    // `type` is the API's own error.type discriminator EVERYWHERE else in
    // this codebase. The validator's prose message must not leak into it —
    // a query grouping spec_error rows by `type` would otherwise mix
    // discriminators with sentences, permanently. The message goes in its
    // own field instead.
    expect(row!.data.type).toBeNull()
    expect(row!.data.message).toContain('panels is empty')
  })

  it('records the real usage and served model for a post-response failure, not zeroes', async () => {
    // truncated_spec and unparsable_spec happen AFTER a complete response —
    // hitting SPEC_MAX_TOKENS is the single most expensive failure this call
    // has, and logging it as free would be fiction (turn.ts states the same
    // rule for chat_error). client.propose() carries the real usage/served on
    // the thrown ChatStreamError for exactly these two kinds; authorSpec must
    // use them instead of the pre-response NO_USAGE default.
    const truncated = client({
      async propose() {
        throw new ChatStreamError(
          {
            kind: 'truncated_spec',
            status: null,
            type: null,
            usage: { input: 500, output: 32000, cache_read: 0, cache_creation: 0 },
            served: { model_served: 'claude-opus-4-8', fallback_fired: true },
          },
          'authoring call did not complete',
        )
      },
    })
    await authorSpec(deps(truncated), INPUT)

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('truncated_spec')
    expect(row!.data.input).toBe(500)
    expect(row!.data.output).toBe(32000)
    expect(row!.data.model_served).toBe('claude-opus-4-8')
    expect(row!.data.fallback_fired).toBe(true)
  })

  it('records honest zero usage for a pre-response failure — nothing was actually known', async () => {
    // The other half of the honesty rule: a failure with no response at all
    // (rate limit here) must NOT fabricate usage or a served model.
    const failing = client({
      async propose() {
        throw new ChatStreamError(
          { kind: 'rate_limit', status: 429, type: 'rate_limit_error' },
          'slow down',
        )
      },
    })
    await authorSpec(deps(failing), INPUT)

    const [row] = metrics()
    expect(row!.data).toMatchObject({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
      model_served: CHAT_MODEL,
      fallback_fired: false,
    })
  })

  it('never throws — an unexpected failure with no dedicated branch still records spec_error and returns undefined', async () => {
    // loadPrompt, insertSpec, the version read-back, and the spec_proposed
    // write itself all used to sit outside any try. A throw from any of them
    // would propagate out of runTurn into the route's ReadableStream AFTER
    // the assistant row was already committed — the stream would then die
    // with no {done:true}, no controller.close(), and no failure metric
    // anywhere. Forced here via a conversationId that violates the specs
    // table's NOT NULL constraint: insertSpec throws a real SQLite error,
    // not a contrived one.
    const outcome = await authorSpec(deps(client()), {
      ...INPUT,
      conversationId: null as unknown as string,
    })
    expect(outcome).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('unexpected_error')
    expect(row!.data.message).toBeTruthy()
    // The call to propose() actually SUCCEEDED here — client() always
    // returns USAGE/SERVED — and insertSpec is what threw, after real,
    // billed tokens were already spent. A cost log that reports zero for
    // them is fiction (lib/chat/turn.ts states this rule in its own words).
    // 950 billed tokens logged as free is the exact defect this guards.
    expect(row!.data.input).toBe(USAGE.input)
    expect(row!.data.output).toBe(USAGE.output)
    expect(row!.data.cache_read).toBe(USAGE.cache_read)
    expect(row!.data.cache_creation).toBe(USAGE.cache_creation)
    expect(row!.data.model_served).toBe(SERVED.model_served)
    expect(row!.data.fallback_fired).toBe(SERVED.fallback_fired)
  })

  it('writes NO spec and records spec_aborted when the friend walks away', async () => {
    const controller = new AbortController()
    const aborting = client({
      async propose() {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })
    const outcome = await authorSpec(deps(aborting), {
      ...INPUT,
      signal: controller.signal,
    })
    expect(outcome).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    expect(metrics()[0]!.event).toBe('spec_aborted')
  })

  it('numbers a second proposal v2 and leaves the first in the record', async () => {
    await authorSpec(deps(client()), INPUT)
    const second = await authorSpec(deps(client()), INPUT)
    expect(second!.version).toBe(2)
    expect(readSpecs(db, 1)).toHaveLength(2)
  })

  it('never writes the synthetic authoring message to transcripts', async () => {
    // "Write the spec now." is a call-time construct, not a thing the friend
    // said. Anything reading the transcript must see only what happened.
    //
    // Seeded so the transcript ends on an assistant turn, which is the ONLY
    // case where the synthetic message actually gets constructed and sent
    // (see the messages-shape tests below). Calling authorSpec against an
    // empty transcript — the previous version of this test — never took that
    // branch at all, so it could not have caught authorSpec writing the
    // synthetic message to transcripts even if it did.
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's',
      conversationId: 'conv-1',
      promptSha: 'abc123abc123',
      role: 'user',
      body: 'what should I track?',
      at: 1,
    })
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's',
      conversationId: 'conv-1',
      promptSha: 'abc123abc123',
      role: 'assistant',
      body: 'sure thing',
      at: 2,
    })

    await authorSpec(deps(client()), INPUT)

    const rows = db
      .prepare('SELECT role, body FROM transcripts ORDER BY id')
      .all() as { role: string; body: string }[]
    // Exactly the two seeded rows — no third row, and specifically none
    // carrying the synthetic text.
    expect(rows).toEqual([
      { role: 'user', body: 'what should I track?' },
      { role: 'assistant', body: 'sure thing' },
    ])
    expect(rows.some((r) => r.body === 'Write the spec now.')).toBe(false)
  })

  describe('the messages sent to propose()', () => {
    function captor() {
      const seen: { role: string; content: string }[][] = []
      const c = client({
        async propose({ messages }) {
          seen.push(messages)
          return { input: GOOD, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
        },
      })
      return { c, seen }
    }

    it('appends the synthetic "Write the spec now." message when the transcript ends on an assistant turn', async () => {
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'conv-1',
        promptSha: 'abc123abc123',
        role: 'user',
        body: 'what should I track?',
        at: 1,
      })
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'conv-1',
        promptSha: 'abc123abc123',
        role: 'assistant',
        body: 'sure thing',
        at: 2,
      })

      const { c, seen } = captor()
      await authorSpec(deps(c), INPUT)

      expect(seen[0]).toEqual([
        { role: 'user', content: 'what should I track?' },
        { role: 'assistant', content: 'sure thing' },
        { role: 'user', content: 'Write the spec now.' },
      ])
    })

    it('sends the transcript as-is, with no synthetic message, when it ends on a user turn', async () => {
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'conv-1',
        promptSha: 'abc123abc123',
        role: 'user',
        body: 'hi',
        at: 1,
      })
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'conv-1',
        promptSha: 'abc123abc123',
        role: 'assistant',
        body: 'tell me more',
        at: 2,
      })
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'conv-1',
        promptSha: 'abc123abc123',
        role: 'user',
        body: 'my rent',
        at: 3,
      })

      const { c, seen } = captor()
      await authorSpec(deps(c), INPUT)

      expect(seen[0]).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'tell me more' },
        { role: 'user', content: 'my rent' },
      ])
      expect(seen[0]!.some((m) => m.content === 'Write the spec now.')).toBe(false)
    })
  })
})
