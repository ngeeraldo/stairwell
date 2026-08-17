// tests/spec/author.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { appendTranscript } from '@/lib/db/appendOnly'
import { confirmSpec, insertSpec, readSpecs } from '@/lib/db/specs'
import { CHAT_MODEL, ChatStreamError, type ChatClient, type Usage } from '@/lib/chat/client'
import { MOCKUP_JSON_SCHEMA } from '@/lib/spec/schema'
import { PATCH_JSON_SCHEMA } from '@/lib/spec/patch'
import { readStoredSpec } from '@/lib/spec/stored'
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

const PANEL = {
  id: 'walked_today',
  title: 'Walked today?',
  intent: 'Did I walk the dog today?',
  display: 'A big yes/no with a tap-to-mark control.',
  context_of_use: null,
  values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
  entry: null,
}

/** A complete, valid draft. No based_on_version: the server supplies it. */
const GOOD_DRAFT = {
  title: 'Did I walk the dog today?',
  summary: 'A one-tap daily tracker.',
  background: 'Pivoted from a weather idea.',
  change_summary: 'The whole dashboard: one tap and a streak.',
  screens: [{ id: 'today', title: 'Today', order: 1, panels: [PANEL] }],
  data_requirements: [],
  open_questions: [],
}

/**
 * A COMPLETE response that the validator rejects — two panels sharing an id.
 * That is exactly the retry gate's trigger: a whole JSON object came back, so
 * another sample can plausibly fix it. Truncated and unparsable replies are
 * different and must not be retried.
 */
const BAD_DRAFT = {
  ...GOOD_DRAFT,
  screens: [{ id: 'today', title: 'Today', order: 1, panels: [PANEL, PANEL] }],
}

/**
 * The same failure, but with an id nothing else in this file uses, so an
 * assertion about where that id may and may not appear cannot be satisfied
 * by some other fixture.
 */
const SECRET_ID = 'divorce_lawyer_fund'
const IDENTIFYING_DRAFT = {
  ...GOOD_DRAFT,
  screens: [
    {
      id: 'today',
      title: 'Today',
      order: 1,
      panels: [
        { ...PANEL, id: SECRET_ID },
        { ...PANEL, id: SECRET_ID },
      ],
    },
  ],
}

const GOOD_MOCKUP = {
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

/**
 * A default PATCH response for tests that only care that authoring
 * SUCCEEDED, not what the writer said — chosen to touch neither a screen id
 * nor a panel id, so it applies cleanly against ANY confirmed current-shape
 * base a test happens to set up, the same way GOOD_DRAFT works as a default
 * regardless of which account is asking.
 */
const GOOD_PATCH = {
  change_summary: 'A small change.',
  data_requirements: [],
  open_questions: [],
  ops: [{ op: 'set_meta', title: null, summary: 'Updated.', background: null }],
}

/** The SPEC call's usage and the MOCKUP call's usage differ on purpose: the
 * mockup_failed row has to prove which call's numbers it is carrying. */
const USAGE: Usage = { input: 50, output: 900, cache_read: 0, cache_creation: 0 }
const MOCKUP_USAGE: Usage = { input: 120, output: 2_400, cache_read: 0, cache_creation: 0 }
const SERVED = { model_served: CHAT_MODEL, fallback_fired: false }

type Call = { system: string; messages: { role: string; content: string }[]; schema: object }

type FakeOptions = {
  /** One entry per SPEC call, in order. An Error is thrown instead. */
  drafts?: unknown[]
  /** The MOCKUP call's parsed input, or an Error to throw. */
  mockup?: unknown
  mockupUsage?: Usage
  /** Fires on every propose() call, before it returns — used to abort mid-flight. */
  onCall?: () => void
}

function fake(options: FakeOptions = {}) {
  const calls: Call[] = []
  // undefined (not defaulted to [GOOD_DRAFT] here) when the test supplied no
  // explicit drafts, so the schema-aware default below can pick GOOD_DRAFT or
  // GOOD_PATCH per call — a test written before patch mode existed and never
  // mentioning `drafts` should not have to know or care which shape the
  // writer was actually asked for.
  const drafts = options.drafts === undefined ? undefined : [...options.drafts]

  const client = {
    async stream() {
      throw new Error('unused')
    },
    async propose({ system, messages, schema }: Parameters<ChatClient['propose']>[0]) {
      calls.push({ system, messages: [...messages], schema })
      options.onCall?.()

      if (schema === MOCKUP_JSON_SCHEMA) {
        const mockup = options.mockup ?? GOOD_MOCKUP
        if (mockup instanceof Error) throw mockup
        return {
          input: mockup,
          usage: options.mockupUsage ?? MOCKUP_USAGE,
          stop_reason: 'end_turn',
          served: SERVED,
        }
      }

      if (drafts !== undefined) {
        const next = drafts.shift()
        if (next === undefined) {
          throw new Error('propose() called more times than the test supplied drafts')
        }
        if (next instanceof Error) throw next
        return { input: next, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
      }

      const input = schema === PATCH_JSON_SCHEMA ? GOOD_PATCH : GOOD_DRAFT
      return { input, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
    },
  } as unknown as ChatClient

  return {
    client,
    calls,
    // MOCKUP_JSON_SCHEMA is the one call this is never asked about — every
    // other schema (whole-surface SPEC_JSON_SCHEMA or PATCH_JSON_SCHEMA) is a
    // "spec call" as far as a caller of this helper is concerned.
    specCalls: () => calls.filter((c) => c.schema !== MOCKUP_JSON_SCHEMA),
  }
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

/** A confirmed spec for account 1, so currentSpec() has something to return. */
function confirmed(payload: unknown): number {
  const id = insertSpec(db, {
    accountId: 1,
    conversationId: 'conv-0',
    promptSha: 'abc123abc123',
    payload,
    mockupHtml: '<!doctype html><html><body>OLD</body></html>',
    at: 1,
  })
  confirmSpec(db, { specId: id, accountId: 1, at: 2 })
  return id
}

const CURRENT_V1 = { ...GOOD_DRAFT, based_on_version: null }

const LEGACY_V1 = {
  title: 'Did I walk the dog today?',
  summary: 'A one-tap tracker.',
  background: 'Pivoted from weather.',
  panels: [
    { name: 'Walked today?', shows: 'Yes or no, for today.', why: 'They asked', source: 'manual' },
  ],
  manual_logging: ['One tap per day.'],
  open_questions: [],
}

function seedConversation(): void {
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
}

describe('authorSpec', () => {
  it('inserts one spec and records spec_proposed', async () => {
    const proposal = await authorSpec(deps(fake().client), INPUT)

    expect(proposal!.version).toBe(1)
    // Tagged `version`: this path now asks for and validates the whole-surface
    // shape. The tag is a statement of fact about the payload.
    expect(proposal!.spec.kind).toBe('version')
    if (proposal!.spec.kind !== 'version') throw new Error('unreachable')
    expect(proposal!.spec.version.title).toBe('Did I walk the dog today?')
    expect(proposal!.spec.version.screens[0]!.panels[0]!.id).toBe('walked_today')
    expect(proposal!.mockup_html).toContain('COFFEE PALACE TEST')

    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conversation_id).toBe('conv-1')

    const [row] = metrics()
    expect(row!.event).toBe('spec_proposed')
    expect(row!.data.spec_id).toBe(proposal!.id)
    expect(row!.data.version).toBe(1)
    expect(row!.data.output).toBe(900)
    expect(row!.data.attempt).toBe(1)
    expect(row!.data.context).toBe('interview')
    // The authoring prompt's sha, NOT the interview prompt's.
    expect(row!.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('records the mockup call\'s own billed tokens alongside the spec call\'s', async () => {
    // Both calls returned, so both spent real, billed tokens. The four
    // standard counters mean "the spec call" on every row in this log
    // (ledger D15); the mockup call's ride beside them under mockup_* names.
    // Without this the success path is the ONE path where a returning model
    // call's usage reaches no metrics row at all.
    await authorSpec(deps(fake().client), INPUT)

    const [row] = metrics()
    expect(row!.event).toBe('spec_proposed')
    expect(row!.data.output).toBe(USAGE.output)
    expect(row!.data.mockup_input).toBe(MOCKUP_USAGE.input)
    expect(row!.data.mockup_output).toBe(MOCKUP_USAGE.output)
    expect(row!.data.mockup_cache_read).toBe(MOCKUP_USAGE.cache_read)
    expect(row!.data.mockup_cache_creation).toBe(MOCKUP_USAGE.cache_creation)
  })

  it('ties the stored mockup to the prompt that produced it', async () => {
    // prompt_sha on every row this module writes is the SPEC prompt's, and
    // specs.prompt_sha likewise — so without this field the HTML sitting in
    // specs.mockup_html names no prompt at all, in two tables that can never
    // be backfilled (ledger D13).
    await authorSpec(deps(fake().client), INPUT)

    const [row] = metrics()
    expect(row!.data.mockup_prompt_sha).toMatch(/^[0-9a-f]{12}$/)
    // A DIFFERENT prompt from the spec call's — copying prompt_sha across
    // would satisfy a bare "is a sha" assertion and be a lie.
    expect(row!.data.mockup_prompt_sha).not.toBe(row!.data.prompt_sha)
  })

  it('writes NO spec and records spec_error when the call fails', async () => {
    const failing = fake({
      drafts: [
        new ChatStreamError(
          { kind: 'rate_limit', status: 429, type: 'rate_limit_error' },
          'slow down',
        ),
      ],
    })
    expect(await authorSpec(deps(failing.client), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('rate_limit')
    expect(row!.data.status).toBe(429)
  })

  it('writes NO spec and records spec_error when the payload is malformed', async () => {
    // A schema-valid REQUEST does not guarantee a schema-valid RESPONSE
    // reaching an append-only table. The validator is the last gate.
    const bad = fake({ drafts: [BAD_DRAFT, BAD_DRAFT] })
    expect(await authorSpec(deps(bad.client), INPUT)).toBeUndefined()
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
    expect(row!.data.message).toContain('duplicate panel id')
  })

  it('records the real usage and served model for a post-response failure, not zeroes', async () => {
    // truncated_spec and unparsable_spec happen AFTER a complete response —
    // hitting SPEC_MAX_TOKENS is the single most expensive failure this call
    // has, and logging it as free would be fiction (turn.ts states the same
    // rule for chat_error). client.propose() carries the real usage/served on
    // the thrown ChatStreamError for exactly these two kinds; authorSpec must
    // use them instead of the pre-response NO_USAGE default.
    const truncated = fake({
      drafts: [
        new ChatStreamError(
          {
            kind: 'truncated_spec',
            status: null,
            type: null,
            usage: { input: 500, output: 32000, cache_read: 0, cache_creation: 0 },
            served: { model_served: 'claude-opus-4-8', fallback_fired: true },
          },
          'authoring call did not complete',
        ),
      ],
    })
    await authorSpec(deps(truncated.client), INPUT)

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
    const failing = fake({
      drafts: [
        new ChatStreamError(
          { kind: 'rate_limit', status: 429, type: 'rate_limit_error' },
          'slow down',
        ),
      ],
    })
    await authorSpec(deps(failing.client), INPUT)

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
    const outcome = await authorSpec(deps(fake().client), {
      ...INPUT,
      conversationId: null as unknown as string,
    })
    expect(outcome).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('unexpected_error')
    expect(row!.data.message).toBeTruthy()
    // BOTH calls actually SUCCEEDED here — insertSpec is what threw, after
    // real, billed tokens were already spent on each. A cost log that reports
    // zero for them is fiction (lib/chat/turn.ts states this rule in its own
    // words). The four standard counters are the spec call's; the mockup
    // call's ride alongside under mockup_* names, as on every other row.
    expect(row!.data.input).toBe(USAGE.input)
    expect(row!.data.output).toBe(USAGE.output)
    expect(row!.data.cache_read).toBe(USAGE.cache_read)
    expect(row!.data.cache_creation).toBe(USAGE.cache_creation)
    expect(row!.data.model_served).toBe(SERVED.model_served)
    expect(row!.data.fallback_fired).toBe(SERVED.fallback_fired)
    expect(row!.data.mockup_output).toBe(MOCKUP_USAGE.output)
    expect(row!.data.mockup_prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('writes NO spec and records spec_aborted when the friend walks away', async () => {
    const controller = new AbortController()
    const aborting = fake({
      drafts: [Object.assign(new Error('aborted'), { name: 'AbortError' })],
      onCall: () => controller.abort(),
    })
    const outcome = await authorSpec(deps(aborting.client), {
      ...INPUT,
      signal: controller.signal,
    })
    expect(outcome).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    expect(metrics()[0]!.event).toBe('spec_aborted')
  })

  it('numbers a second proposal v2 and leaves the first in the record', async () => {
    await authorSpec(deps(fake().client), INPUT)
    const second = await authorSpec(deps(fake().client), INPUT)
    expect(second!.version).toBe(2)
    expect(readSpecs(db, 1)).toHaveLength(2)
  })

  it('never writes the authoring scaffolding to transcripts', async () => {
    // "Write the spec now.", the current-version block, and the retry message
    // are all call-time constructs, not things the friend said. Anything
    // reading the transcript must see only what happened.
    //
    // Seeded so the transcript ends on an assistant turn, which is the ONLY
    // case where the synthetic instruction actually gets constructed and sent
    // (see the messages-shape tests below), and driven through a REJECTED
    // first draft so the retry message is constructed too.
    seedConversation()
    confirmed(CURRENT_V1)

    await authorSpec(deps(fake({ drafts: [BAD_DRAFT, GOOD_DRAFT] }).client), INPUT)

    const rows = db.prepare('SELECT role, body FROM transcripts ORDER BY id').all() as {
      role: string
      body: string
    }[]
    // Exactly the two seeded rows — no third row, and specifically none
    // carrying any of the synthetic text.
    expect(rows).toEqual([
      { role: 'user', body: 'what should I track?' },
      { role: 'assistant', body: 'sure thing' },
    ])
    expect(rows.some((r) => /Write the spec now|validator|current confirmed/i.test(r.body))).toBe(
      false,
    )
  })

  describe('the current version handed to the writer', () => {
    it('gives the writer the current confirmed version as JSON', async () => {
      // Id stability is the whole point of the new shape, so the ids have to
      // arrive in a form the writer can copy verbatim.
      confirmed(CURRENT_V1)
      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = JSON.stringify(client.specCalls()[0]!.messages)
      expect(sent).toContain('walked_today')
      expect(sent).toContain('walk_flag')
    })

    it('tells the writer the spec is empty on the first-ever proposal', async () => {
      // Behaviour-preserving: the v1 path must send a prompt of the same
      // SHAPE, not a prompt with a section missing.
      //
      // A rejected proposal is seeded first, so the second assertion is not
      // vacuous: something in the database DOES contain those ids, and the
      // empty arm is right only because currentSpec asks for the newest
      // CONFIRMED proposal, not the newest one.
      insertSpec(db, {
        accountId: 1,
        conversationId: 'conv-0',
        promptSha: 'abc123abc123',
        payload: CURRENT_V1,
        mockupHtml: '<html></html>',
        at: 1,
      })

      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = JSON.stringify(client.specCalls()[0]!.messages)
      expect(sent).toMatch(/no confirmed spec/i)
      expect(sent).toMatch(/empty/i)
      expect(sent).not.toContain('walked_today')
    })

    it('feeds a legacy current spec in as rendered markdown, with a fresh-ids note', async () => {
      // A legacy row has no ids to stabilise against, so it goes in as prose
      // and the writer is told to assign ids fresh. Asserted on markdown the
      // renderer emits and the stored JSON does not, so dumping the raw
      // payload would not pass.
      confirmed(LEGACY_V1)
      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = client.specCalls()[0]!.messages.map((m) => m.content).join('\n')
      expect(sent).toContain('Did I walk the dog today?')
      expect(sent).toContain('### 1. Walked today?')
      expect(sent).toContain('- **Shows:** Yes or no, for today.')
      expect(sent).toMatch(/fresh/i)
    })
  })

  describe('the validation retry', () => {
    it('retries once with the validator message when the draft fails validation', async () => {
      const client = fake({ drafts: [BAD_DRAFT, GOOD_DRAFT] })
      const proposal = await authorSpec(deps(client.client), INPUT)

      expect(proposal).toBeDefined()
      expect(client.specCalls()).toHaveLength(2)
      expect(client.specCalls()[1]!.messages.at(-1)!.content).toContain('duplicate panel id')
      expect(readSpecs(db, 1)).toHaveLength(1)
    })

    it('records a metric for the FAILED attempt as well as the successful one', async () => {
      // The failed attempt returned a complete response and spent real,
      // billed tokens. A cost log reporting zero for it is fiction.
      await authorSpec(deps(fake({ drafts: [BAD_DRAFT, GOOD_DRAFT] }).client), INPUT)

      const rows = metrics()
      const failed = rows.filter((r) => r.event === 'spec_error')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.data.attempt).toBe(1)
      expect(failed[0]!.data.output).toBeGreaterThan(0)
      expect(rows.find((r) => r.event === 'spec_proposed')!.data.attempt).toBe(2)
    })

    it('sends the id to the MODEL but never writes it to metrics', async () => {
      // The pairing is the whole property. The validator quotes what it
      // rejected, and that quoted id is exactly what lets the model correct
      // itself — so the retry turn must carry it. It is also derived from
      // what the friend asked for, and `metrics` is sacred and append-only:
      // nothing written there can ever be edited or removed. Task 11 ruled
      // "counts, never content" for spec_confirmed, and a rule that holds on
      // one row of that table but not its neighbour stops being a rule.
      const client = fake({ drafts: [IDENTIFYING_DRAFT, GOOD_DRAFT] })
      await authorSpec(deps(client.client), INPUT)

      const retry = client.specCalls()[1]!.messages.at(-1)!.content
      expect(retry).toContain(SECRET_ID)

      const row = metrics().find((r) => r.data.kind === 'malformed_spec')!
      const message = row.data.message as string
      // The SHAPE of the failure survives — this row is still diagnostic.
      expect(message).toContain('duplicate panel id')
      expect(message).not.toContain(SECRET_ID)
      // And nothing else quoted survives either, so a validator message that
      // quotes something new is redacted without anyone remembering to.
      expect(message).not.toMatch(/"[^"]*[a-z0-9][^"]*"/)
    })

    it('keeps redacting when the validator quotes more than one id', async () => {
      // `annotates` failures name two things and end in an unquoted enum
      // word: the redaction has to strip both without eating the diagnosis.
      const annotating = {
        ...GOOD_DRAFT,
        screens: [
          {
            id: 'today',
            title: 'Today',
            order: 1,
            panels: [
              {
                ...PANEL,
                entry: {
                  description: 'One tap.',
                  fields: [],
                  annotates: 'walk_flag',
                },
              },
            ],
          },
        ],
      }
      await authorSpec(deps(fake({ drafts: [annotating, GOOD_DRAFT] }).client), INPUT)

      const message = metrics().find((r) => r.data.kind === 'malformed_spec')!.data
        .message as string
      expect(message).toContain('annotates')
      expect(message).toContain('not synced')
      expect(message).not.toContain('walk_flag')
      expect(message).not.toContain('walked_today')
    })

    it('gives up after exactly two attempts and writes no row', async () => {
      // Two, spelled out: changing MAX_SPEC_ATTEMPTS is a behaviour change
      // and has to break a test.
      const client = fake({ drafts: [BAD_DRAFT, BAD_DRAFT] })
      expect(await authorSpec(deps(client.client), INPUT)).toBeUndefined()
      expect(client.specCalls()).toHaveLength(2)
      expect(readSpecs(db, 1)).toEqual([])
      expect(metrics().filter((r) => r.event === 'spec_error')).toHaveLength(2)
    })

    it('does NOT retry a truncated reply', async () => {
      // It failed for a reason another sample will not fix, and each attempt
      // costs a full authoring latency the friend is watching a spinner
      // through.
      const client = fake({
        drafts: [
          new ChatStreamError(
            {
              kind: 'truncated_spec',
              status: null,
              type: null,
              usage: USAGE,
              served: SERVED,
            },
            'authoring call did not complete',
          ),
          GOOD_DRAFT,
        ],
      })
      expect(await authorSpec(deps(client.client), INPUT)).toBeUndefined()
      expect(client.specCalls()).toHaveLength(1)
    })

    it('does not retry after the signal aborts', async () => {
      const controller = new AbortController()
      const client = fake({
        drafts: [BAD_DRAFT, GOOD_DRAFT],
        onCall: () => controller.abort(),
      })
      expect(
        await authorSpec(deps(client.client), { ...INPUT, signal: controller.signal }),
      ).toBeUndefined()
      expect(client.specCalls()).toHaveLength(1)
    })
  })

  describe('the mockup call', () => {
    it('calls the mockup writer with the VALIDATED payload, after the spec call', async () => {
      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      expect(client.calls).toHaveLength(2)
      const mockupCall = client.calls[1]!
      expect(mockupCall.schema).toBe(MOCKUP_JSON_SCHEMA)
      expect(JSON.stringify(mockupCall.messages)).toContain('walked_today')
    })

    it('writes NO spec row when the mockup call fails', async () => {
      // mockup_html is NOT NULL and a spec row without its preview is a card
      // the friend cannot read. Both calls succeed or neither is stored.
      const client = fake({ mockup: new Error('boom') })
      expect(await authorSpec(deps(client.client), INPUT)).toBeUndefined()
      expect(readSpecs(db, 1)).toEqual([])

      const row = metrics().at(-1)!
      expect(row.event).toBe('spec_error')
      expect(row.data.kind).toBe('mockup_failed')
      expect(row.data.attempt).toBe(1)
      // The prompt was loaded before the call failed, so the row can still
      // say which mockup prompt was in play.
      expect(row.data.mockup_prompt_sha).toMatch(/^[0-9a-f]{12}$/)
      expect(row.data.mockup_prompt_sha).not.toBe(row.data.prompt_sha)
    })

    it("puts the SPEC call's billed tokens on the mockup_failed row", async () => {
      // On the happy path those tokens ride on spec_proposed. No spec_proposed
      // is written here, so this row is their only home — see ledger D15.
      await authorSpec(deps(fake({ mockup: new Error('boom') }).client), INPUT)

      const data = metrics().at(-1)!.data
      expect(data.input).toBe(USAGE.input)
      expect(data.output).toBe(USAGE.output)
    })

    it('reports the mockup call\'s own usage as null when it failed before responding', async () => {
      // Zero is a claim that nothing was billed. For a connection failure that
      // is true of the mockup call and false of the spec call — hence two sets
      // of fields.
      await authorSpec(
        deps(
          fake({
            mockup: new ChatStreamError(
              { kind: 'connection', status: null, type: null },
              'socket hang up',
            ),
          }).client,
        ),
        INPUT,
      )

      const data = metrics().at(-1)!.data
      expect(data.kind).toBe('mockup_failed')
      expect(data.mockup_input).toBeNull()
      expect(data.mockup_output).toBeNull()
      expect(data.mockup_cache_read).toBeNull()
      expect(data.mockup_cache_creation).toBeNull()
    })

    it("reports the mockup call's own usage when it failed AFTER responding", async () => {
      await authorSpec(
        deps(
          fake({
            mockup: new ChatStreamError(
              {
                kind: 'truncated_spec',
                status: null,
                type: null,
                usage: MOCKUP_USAGE,
                served: SERVED,
              },
              'mockup call did not complete',
            ),
          }).client,
        ),
        INPUT,
      )

      const data = metrics().at(-1)!.data
      expect(data.mockup_output).toBe(MOCKUP_USAGE.output)
      // Still the SPEC call's on the four standard names.
      expect(data.output).toBe(USAGE.output)
    })

    it("reports the mockup call's own usage when the VALIDATOR rejects its reply", async () => {
      // The call returned and was billed; only the validator said no. Null
      // here would claim nothing was billed (ledger D15).
      await authorSpec(deps(fake({ mockup: { mockup_html: '   ' } }).client), INPUT)

      const data = metrics().at(-1)!.data
      expect(data.kind).toBe('mockup_failed')
      expect(data.mockup_output).toBe(MOCKUP_USAGE.output)
      expect(readSpecs(db, 1)).toEqual([])
    })
  })

  describe('lineage', () => {
    it('stores the server-supplied based_on_version, not a model-authored one', async () => {
      confirmed(CURRENT_V1)
      await authorSpec(deps(fake().client), INPUT)

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      expect(stored.kind).toBe('version')
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.based_on_version).toBe(1)
    })

    it('stores null based_on_version when nothing is confirmed yet', async () => {
      await authorSpec(deps(fake().client), INPUT)

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.based_on_version).toBeNull()
    })

    it('ignores an UNCONFIRMED newer proposal when choosing the base', async () => {
      // currentSpec is the newest CONFIRMED proposal. A rejected one sitting
      // on top of it is not what the next version is based on.
      confirmed(CURRENT_V1)
      insertSpec(db, {
        accountId: 1,
        conversationId: 'conv-0',
        promptSha: 'abc123abc123',
        payload: { ...GOOD_DRAFT, based_on_version: 1 },
        mockupHtml: '<html></html>',
        at: 3,
      })

      await authorSpec(deps(fake().client), INPUT)

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.based_on_version).toBe(1)
    })

    it('reads the pointer at WRITE time, so a confirmation mid-authoring is not missed', async () => {
      // The authoring call can run for three minutes, and the confirm buttons
      // are gated by `confirming`, not by `busy` — so the card already on
      // screen stays clickable for the whole wait while the friend watches
      // "Putting together a preview…". If they press "Build this" in that
      // window, the row this function writes must not name a base that stopped
      // being current before the row existed: `specs` rejects UPDATE, so the
      // diff for that version is computed against the wrong base forever.
      //
      // onCall fires while the spec call is in flight, which is exactly when
      // the button is live.
      confirmed(CURRENT_V1)
      let fired = false
      const client = fake({
        onCall: () => {
          if (fired) return
          fired = true
          confirmed({ ...CURRENT_V1, change_summary: 'the card that was on screen' })
        },
      })

      await authorSpec(deps(client.client), INPUT)

      const rows = readSpecs(db, 1)
      expect(rows).toHaveLength(3)
      const written = rows[0]!
      expect(written.version).toBe(3)
      const stored = readStoredSpec(written.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      // v2 — the version confirmed mid-flight — not v1, which was current
      // when the call started.
      expect(stored.version.based_on_version).toBe(2)
    })

    it('rejects a draft that authored its own based_on_version', async () => {
      // A model-authored lineage pointer becomes a permanent wrong row in an
      // append-only table.
      const client = fake({ drafts: [{ ...GOOD_DRAFT, based_on_version: 7 }, GOOD_DRAFT] })
      const proposal = await authorSpec(deps(client.client), INPUT)

      expect(client.specCalls()).toHaveLength(2)
      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.based_on_version).toBeNull()
      expect(proposal!.spec.kind).toBe('version')
    })
  })

  describe('the delivery promise rides on the proposal', () => {
    // The card that streams in mid-turn arrives through the `proposal` NDJSON
    // line, and the page never re-renders — so a `first` computed once at page
    // load and handed to every card promised "tomorrow morning" for a one-word
    // relabel proposed later in the same session. The answer has to be
    // computed for THIS card, at the moment the row is written.

    it('calls a first-ever proposal a first dashboard', async () => {
      const proposal = await authorSpec(deps(fake().client), INPUT)
      expect(proposal!.first).toBe(true)
    })

    it('calls a proposal above an already-confirmed version a change, not a first dashboard', async () => {
      confirmed(CURRENT_V1)
      const proposal = await authorSpec(deps(fake().client), INPUT)
      expect(proposal!.first).toBe(false)
    })

    it('still calls it a first dashboard when the version below it was only PROPOSED', async () => {
      // hasConfirmedSpecBelow, not hasConfirmedSpec: a rejected v1 means
      // nothing has ever been built, so v2 really is their first dashboard.
      insertSpec(db, {
        accountId: 1,
        conversationId: 'conv-0',
        promptSha: 'abc123abc123',
        payload: CURRENT_V1,
        mockupHtml: '<html></html>',
        at: 1,
      })
      const proposal = await authorSpec(deps(fake().client), INPUT)
      expect(proposal!.version).toBe(2)
      expect(proposal!.first).toBe(true)
    })
  })

  describe('the messages sent to propose()', () => {
    it('appends the synthetic "Write the spec now." message when the transcript ends on an assistant turn', async () => {
      seedConversation()

      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = client.specCalls()[0]!.messages
      expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
      expect(sent[0]!.content).toBe('what should I track?')
      expect(sent[1]!.content).toBe('sure thing')
      expect(sent[2]!.content).toMatch(/no confirmed spec/i)
      expect(sent[3]!.content).toBe('Write the spec now.')
    })

    it('sends the transcript as-is, with no "Write the spec now.", when it ends on a user turn', async () => {
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

      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = client.specCalls()[0]!.messages
      expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
      expect(sent.map((m) => m.content).slice(0, 3)).toEqual(['hi', 'tell me more', 'my rent'])
      // The current-version block still goes, so the prompt has one shape on
      // every path; only the synthetic instruction is conditional.
      expect(sent).toHaveLength(4)
      expect(sent.some((m) => m.content === 'Write the spec now.')).toBe(false)
      expect(sent.at(-1)!.role).toBe('user')
    })
  })

  /**
   * THE STAGE, FROM THE SIDE THAT PRODUCES IT.
   *
   * Nothing in the suite asked authorSpec to report the crossing before this
   * block existed: the panel's tests push a stage line in by hand, and the
   * route's authorSpec double takes no argument at all. Both halves of the
   * server's contribution — this call, and the route line it feeds — could be
   * deleted with the whole suite staying green, which is what "the wiring test
   * holds the stream open" was taken to cover and does not.
   */
  describe('reporting which half of the wait we are in', () => {
    it('reports the mockup stage BEFORE the mockup call, not after it', async () => {
      // The ordering is the entire point. Announced after the call returns,
      // the friend is told about the slow half once it is already over — the
      // panel would jump to "Drawing the preview…" and immediately resolve.
      const order: string[] = []
      const client = fake({
        onCall: () => order.push('propose'),
      })

      await authorSpec(deps(client.client), {
        ...INPUT,
        onStage: (stage) => order.push(`stage:${stage}`),
      })

      // spec call, then the announcement, then the mockup call.
      expect(order).toEqual(['propose', 'stage:mockup', 'propose'])
      expect(client.specCalls()).toHaveLength(1)
    })

    it('says nothing when the spec never validated and no preview is drawn', async () => {
      // A stage that is announced for a call that never happens is a lie the
      // friend watches for the rest of the turn.
      const seen: string[] = []
      const client = fake({ drafts: [BAD_DRAFT, BAD_DRAFT] })

      expect(
        await authorSpec(deps(client.client), {
          ...INPUT,
          onStage: (stage) => seen.push(stage),
        }),
      ).toBeUndefined()

      expect(seen).toEqual([])
    })
  })

  /**
   * Task 13: which shape the writer is asked for. `mode` is decided in the
   * same place currentVersionBlock already branches — a confirmed row in the
   * current shape gets PATCH, everything else (no confirmed row at all, or a
   * legacy one with no ids) gets WHOLE, same as before this task existed.
   */
  describe('authoring mode', () => {
    const PANEL_WALKS = {
      ...PANEL,
      id: 'walks',
      values: [{ kind: 'entered', id: 'walks_flag', description: 'One tap per day.' }],
    }
    const PANEL_EATING = {
      ...PANEL,
      id: 'eating_out',
      values: [{ kind: 'entered', id: 'eating_out_flag', description: 'One tap per day.' }],
    }

    /** A current confirmed version with two panels, so a patch has something
     * to remove and something left over to prove the rest survived untouched. */
    const TWO_PANEL_CURRENT = {
      ...GOOD_DRAFT,
      based_on_version: null,
      screens: [{ id: 'today', title: 'Today', order: 1, panels: [PANEL_WALKS, PANEL_EATING] }],
    }

    const REMOVE_WALKS_PATCH = {
      change_summary: 'Dropped the walk panel.',
      data_requirements: [],
      open_questions: [],
      ops: [{ op: 'remove_panel', id: 'walks' }],
    }

    /** Shape-valid but names a panel absent from the base — a patch that
     * cannot APPLY, the genuinely new failure mode this task adds. */
    const GHOST_PATCH = {
      change_summary: 'Dropped a panel.',
      data_requirements: [],
      open_questions: [],
      ops: [{ op: 'remove_panel', id: 'ghost' }],
    }

    /** Same failure, naming SECRET_ID instead — proves the id is redacted out
     * of the metrics row the same way a malformed_spec id already is. */
    const SECRET_PATCH = {
      change_summary: 'Dropped a panel.',
      data_requirements: [],
      open_questions: [],
      ops: [{ op: 'remove_panel', id: SECRET_ID }],
    }

    it('authors WHOLE for a first version', async () => {
      // No confirmed spec at all: v1 has no base to patch, and this is the
      // one path this whole task may not change — same prompt, same schema.
      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const [row] = metrics()
      expect(row!.event).toBe('spec_proposed')
      expect(row!.data.authoring_mode).toBe('whole')
      // null, not 0 — 0 would claim a patch with no ops, which is impossible
      // on the whole-surface path.
      expect(row!.data.ops_count).toBeNull()

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.ops).toBeNull()

      expect(client.specCalls()[0]!.system).toContain('complete next version')
    })

    it('authors WHOLE against a legacy base — it has no ids to patch', async () => {
      confirmed(LEGACY_V1)
      await authorSpec(deps(fake().client), INPUT)

      const row = metrics().find((r) => r.event === 'spec_proposed')!
      expect(row.data.authoring_mode).toBe('whole')
    })

    it('authors a PATCH against a current base', async () => {
      confirmed(TWO_PANEL_CURRENT)
      const client = fake({ drafts: [REMOVE_WALKS_PATCH] })
      await authorSpec(deps(client.client), INPUT)

      const row = metrics().find((r) => r.event === 'spec_proposed')!
      expect(row.data.authoring_mode).toBe('patch')
      expect(row.data.ops_count).toBe(1)
    })

    it('stores the applied WHOLE surface alongside the ops', async () => {
      confirmed(TWO_PANEL_CURRENT)
      const client = fake({ drafts: [REMOVE_WALKS_PATCH] })
      await authorSpec(deps(client.client), INPUT)

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      // The whole surface — a builder never replays history.
      expect(stored.version.screens[0]!.panels.map((p) => p.id)).toEqual(['eating_out'])
      // And the ops, so the card and the mockup know what changed.
      expect(stored.version.ops).toEqual(REMOVE_WALKS_PATCH.ops)
    })

    it('retries once on a patch that does not apply, then records patch_failed', async () => {
      confirmed(TWO_PANEL_CURRENT)
      const client = fake({ drafts: [GHOST_PATCH, GHOST_PATCH] })
      const result = await authorSpec(deps(client.client), INPUT)

      expect(result).toBeUndefined()
      expect(client.specCalls()).toHaveLength(2)

      const errors = metrics().filter((r) => r.event === 'spec_error')
      expect(errors.map((e) => e.data.attempt)).toEqual([1, 2])
      expect(errors[0]!.data.kind).toBe('patch_failed')
      expect(errors[1]!.data.kind).toBe('patch_failed')
    })

    it('redacts the quoted id out of the patch_failed metric message', async () => {
      confirmed(TWO_PANEL_CURRENT)
      const client = fake({ drafts: [SECRET_PATCH, SECRET_PATCH] })
      await authorSpec(deps(client.client), INPUT)

      const row = metrics().find((r) => r.data.kind === 'patch_failed')!
      const message = row.data.message as string
      expect(message).not.toContain(SECRET_ID)
      expect(message).toContain('"…"')
    })

    it('feeds the FULL patch error back to the model on the retry', async () => {
      confirmed(TWO_PANEL_CURRENT)
      const client = fake({ drafts: [GHOST_PATCH, GHOST_PATCH] })
      await authorSpec(deps(client.client), INPUT)

      const retryMessages = client.specCalls()[1]!.messages
      expect(JSON.stringify(retryMessages)).toContain('ghost')
    })
  })
})
