// tests/spec/author.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { appendTranscript } from '@/lib/db/appendOnly'
import { insertSpec, readSpecs } from '@/lib/db/specs'
import { CHAT_MODEL, ChatStreamError, type ChatClient, type Usage } from '@/lib/chat/client'
import { parseStoredChange } from '@/lib/spec/change'
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

/**
 * A well-formed change, as the model would return it. No `shape` and no
 * `based_on_version`: both are server-written, and parseSpecChangeDraft
 * rejects a draft that authors either.
 */
const GOOD_CHANGE = {
  change_summary: 'Adds a weekly average.',
  changes: [
    {
      action: 'add',
      target: 'panel',
      name: 'Weekly average',
      description: 'Under the streak. Mean of the last seven logged days.',
    },
  ],
  data_requirements: [],
  open_questions: [],
}

/**
 * A COMPLETE response that the validator rejects — no changes in it at all.
 * That is exactly the retry gate's trigger: a whole JSON object came back, so
 * another sample can plausibly fix it. Truncated and unparsable replies are
 * different and must not be retried.
 */
const BAD_CHANGE = { ...GOOD_CHANGE, changes: [] }

/**
 * The same failure mode, carrying a name nothing else in this file uses, so an
 * assertion about where that name may and may not appear cannot be satisfied
 * by some other fixture. `tweak` is not one of add/change/remove, so the
 * object is complete and the validator rejects it.
 */
const SECRET_NAME = 'divorce_lawyer_fund'
const IDENTIFYING_CHANGE = {
  ...GOOD_CHANGE,
  changes: [{ ...GOOD_CHANGE.changes[0], action: 'tweak', name: SECRET_NAME }],
}

const USAGE: Usage = { input: 50, output: 900, cache_read: 0, cache_creation: 0 }
const SERVED = { model_served: CHAT_MODEL, fallback_fired: false }

type Call = { system: string; messages: { role: string; content: string }[]; schema: object }

type FakeOptions = {
  /** One entry per SPEC call, in order. An Error is thrown instead. */
  drafts?: unknown[]
  /** Fires on every propose() call, before it returns — used to abort mid-flight. */
  onCall?: () => void
}

/**
 * The fake ChatClient every test in this file drives authorSpec with. Its
 * `propose()` only ever sees the ONE call authorSpec makes — the change —
 * since the mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop,
 * Task 4) deleted the second, per-screen mockup call this fake used to also
 * answer.
 *
 * The default reply is GOOD_CHANGE, unconditionally. It used to pick between
 * a whole-surface draft and a patch by inspecting the schema it was handed;
 * there is one authoring path and one schema now, so there is nothing left to
 * discriminate on.
 */
function fake(options: FakeOptions = {}) {
  const calls: Call[] = []
  const drafts = options.drafts === undefined ? undefined : [...options.drafts]

  const client = {
    async stream() {
      throw new Error('unused')
    },
    async propose({ system, messages, schema }: Parameters<ChatClient['propose']>[0]) {
      calls.push({ system, messages: [...messages], schema })
      options.onCall?.()

      if (drafts !== undefined) {
        const next = drafts.shift()
        if (next === undefined) {
          throw new Error('propose() called more times than the test supplied drafts')
        }
        if (next instanceof Error) throw next
        return { input: next, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
      }

      return { input: GOOD_CHANGE, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
    },
  } as unknown as ChatClient

  return {
    client,
    calls,
    // Every call this fake ever records IS a spec call now — kept as its own
    // accessor (rather than pointing every existing call site at `calls`
    // directly) because that used to be a real distinction from the mockup
    // call and rewriting every one of this file's `client.specCalls()` sites
    // for no behaviour change would be pure churn.
    specCalls: () => calls,
  }
}

/**
 * `currentState: null` by default — the account with no built dashboard, which
 * is what most of this file's tests are about. Tests that care about the base
 * override it.
 */
const INPUT = {
  accountId: 1,
  conversationId: 'conv-1',
  signal: new AbortController().signal,
  currentState: null as string | null,
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

/**
 * A spec row for account 1, so currentSpec() has something to return — nothing
 * confirms any more, so the row existing is what makes it current.
 *
 * The PAYLOAD no longer matters to authoring at all: the writer's base is
 * current.md, not a stored row, and the only thing authorSpec still asks the
 * specs table is "what version number would this supersede". A stored change
 * is used here because that is what this path now writes.
 */
function existingSpec(payload: unknown = { ...GOOD_CHANGE, shape: 'change', based_on_version: null }): number {
  return insertSpec(db, {
    accountId: 1,
    conversationId: 'conv-0',
    promptSha: 'abc123abc123',
    payload,
    mockupHtml: '',
    at: 1,
  })
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

  it('stores a tagged change payload', async () => {
    // Read back through the SHARED reader as well as the change parser: a row
    // this path writes has to land in readStoredSpec's `change` arm, or every
    // consumer that dispatches on the tag reads it as something else.
    const proposal = await authorSpec(deps(fake().client), {
      ...INPUT,
      currentState: '## What this is for\nA walk tracker.\n',
    })
    expect(proposal).toBeDefined()

    const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
    expect(stored.kind).toBe('change')

    const change = parseStoredChange(readSpecs(db, 1)[0]!.payload)
    expect(change.shape).toBe('change')
    expect(change.changes[0]!.name).toBe('Weekly average')
    expect(change.change_summary).toBe('Adds a weekly average.')
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
    const bad = fake({ drafts: [BAD_CHANGE, BAD_CHANGE] })
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
    expect(row!.data.message).toContain('spec.changes is empty')
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
    // The spec call actually SUCCEEDED here — insertSpec is what threw, after
    // real, billed tokens were already spent on it. A cost log that reports
    // zero for it is fiction (lib/chat/turn.ts states this rule in its own
    // words).
    expect(row!.data.input).toBe(USAGE.input)
    expect(row!.data.output).toBe(USAGE.output)
    expect(row!.data.cache_read).toBe(USAGE.cache_read)
    expect(row!.data.cache_creation).toBe(USAGE.cache_creation)
    expect(row!.data.model_served).toBe(SERVED.model_served)
    expect(row!.data.fallback_fired).toBe(SERVED.fallback_fired)
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
    // "Write the change now.", the current-state block, and the retry message
    // are all call-time constructs, not things the friend said. Anything
    // reading the transcript must see only what happened.
    //
    // Seeded so the transcript ends on an assistant turn, which is the ONLY
    // case where the synthetic instruction actually gets constructed and sent
    // (see the messages-shape tests below), driven through a REJECTED first
    // attempt so the retry message is constructed too, and given a
    // currentState so the built-dashboard arm of the block exists to look for.
    seedConversation()

    await authorSpec(deps(fake({ drafts: [BAD_CHANGE, GOOD_CHANGE] }).client), {
      ...INPUT,
      currentState: '## Panels\nA streak, and nothing else.\n',
    })

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
    expect(
      rows.some((r) => /Write the change now|validator|as it exists right now/i.test(r.body)),
    ).toBe(false)
  })

  /**
   * THE BASE THE WRITER IS SHOWN. It used to be the newest spec ROW — model
   * output no build ever touched — which is the defect this design removes.
   * It is now current.md's body, read once by app/api/chat/route.ts and handed
   * to both the agent and this writer.
   */
  describe('the current state handed to the writer', () => {
    it('puts current.md in front of the writer when there is one', async () => {
      const client = fake()
      await authorSpec(deps(client.client), {
        ...INPUT,
        currentState: '## Panels\nA streak, and nothing else.\n',
      })

      const messages = client.specCalls()[0]!.messages
      expect(messages.some((m) => m.content.includes('A streak, and nothing else.'))).toBe(true)
    })

    it('tells the writer nothing is built when there is no current.md', async () => {
      const client = fake()
      await authorSpec(deps(client.client), { ...INPUT, currentState: null })

      const messages = client.specCalls()[0]!.messages
      expect(messages.some((m) => m.content.includes('nothing has been built'))).toBe(true)
    })

    it('never shows the writer a stored spec row, even when the account has one', async () => {
      // The whole point of the switch: an account WITH a spec history still
      // gets current.md as its base. A previous spec row is a prediction, and
      // showing one is what made a second conversation argue with a dashboard
      // that was never built that way.
      existingSpec({
        ...GOOD_CHANGE,
        shape: 'change',
        based_on_version: null,
        change_summary: 'a panel nobody ever built',
      })
      const client = fake()
      await authorSpec(deps(client.client), { ...INPUT, currentState: '## Panels\nA streak.\n' })

      const sent = JSON.stringify(client.specCalls()[0]!.messages)
      expect(sent).not.toContain('a panel nobody ever built')
      expect(sent).toContain('A streak.')
    })

    it('asks for the change prompt, not an earlier era\'s', async () => {
      // spec-v4.md is the change prompt; v2 and v3 asked for a whole surface
      // and a patch respectively, and both files are still on disk because
      // stored prompt_sha values point at them.
      const client = fake()
      await authorSpec(deps(client.client), INPUT)
      expect(client.specCalls()[0]!.system).toMatch(/writing the CHANGE/)
    })
  })

  describe('the validation retry', () => {
    it('retries once with the validator message when the draft fails validation', async () => {
      const client = fake({ drafts: [BAD_CHANGE, GOOD_CHANGE] })
      const proposal = await authorSpec(deps(client.client), INPUT)

      expect(proposal).toBeDefined()
      expect(client.specCalls()).toHaveLength(2)
      expect(client.specCalls()[1]!.messages.at(-1)!.content).toContain('spec.changes is empty')
      expect(readSpecs(db, 1)).toHaveLength(1)
    })

    it('records a metric for the FAILED attempt as well as the successful one', async () => {
      // The failed attempt returned a complete response and spent real,
      // billed tokens. A cost log reporting zero for it is fiction.
      await authorSpec(deps(fake({ drafts: [BAD_CHANGE, GOOD_CHANGE] }).client), INPUT)

      const rows = metrics()
      const failed = rows.filter((r) => r.event === 'spec_error')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.data.attempt).toBe(1)
      expect(failed[0]!.data.output).toBeGreaterThan(0)
      expect(rows.find((r) => r.event === 'spec_proposed')!.data.attempt).toBe(2)
    })

    it('sends the full validator message to the MODEL but never the friend\'s words to metrics', async () => {
      // The pairing is the whole property. The validator's message is exactly
      // what lets the model correct itself, so the retry turn must carry it
      // whole. The metrics copy is redacted instead, because `metrics` is
      // sacred and append-only: nothing written there can ever be edited or
      // removed, and Task 11 ruled "counts, never content" for that table.
      //
      // The change validator's own messages are structural (a path and a fixed
      // enum list), so today there is nothing for metricMessage's redaction to
      // strip — the `not.toContain` below is what keeps that true: it fails on
      // a friend-derived name reaching the row by ANY route, quoted or not.
      const client = fake({ drafts: [IDENTIFYING_CHANGE, GOOD_CHANGE] })
      await authorSpec(deps(client.client), INPUT)

      const retry = client.specCalls()[1]!.messages.at(-1)!.content
      expect(retry).toContain('changes[0].action is not one of')

      const row = metrics().find((r) => r.data.kind === 'malformed_spec')!
      const message = row.data.message as string
      // The SHAPE of the failure survives — this row is still diagnostic.
      expect(message).toContain('changes[0].action')
      expect(message).not.toContain(SECRET_NAME)
      // And no free text from the draft survives anywhere else on the row.
      expect(JSON.stringify(row.data)).not.toContain(SECRET_NAME)
    })

    it('gives up after exactly two attempts and writes no row', async () => {
      // Two, spelled out: changing MAX_SPEC_ATTEMPTS is a behaviour change
      // and has to break a test.
      const client = fake({ drafts: [BAD_CHANGE, BAD_CHANGE] })
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
          GOOD_CHANGE,
        ],
      })
      expect(await authorSpec(deps(client.client), INPUT)).toBeUndefined()
      expect(client.specCalls()).toHaveLength(1)
    })

    it('does not retry after the signal aborts', async () => {
      const controller = new AbortController()
      const client = fake({
        drafts: [BAD_CHANGE, GOOD_CHANGE],
        onCall: () => controller.abort(),
      })
      expect(
        await authorSpec(deps(client.client), { ...INPUT, signal: controller.signal }),
      ).toBeUndefined()
      expect(client.specCalls()).toHaveLength(1)
    })
  })

  describe('lineage', () => {
    it('stores the server-supplied based_on_version, not a model-authored one', async () => {
      existingSpec()
      await authorSpec(deps(fake().client), INPUT)

      const stored = parseStoredChange(readSpecs(db, 1)[0]!.payload)
      expect(stored.based_on_version).toBe(1)
    })

    it('supplies based_on_version from the record across two authoring calls', async () => {
      // One spec already exists in this account by the time the second call
      // runs, so the next is based on v1. The model is not asked for it and
      // cannot author it — parseSpecChangeDraft rejects the key outright.
      await authorSpec(deps(fake().client), INPUT)
      await authorSpec(deps(fake().client), { ...INPUT, conversationId: 'conv-2' })

      const newest = parseStoredChange(readSpecs(db, 1)[0]!.payload)
      expect(newest.based_on_version).toBe(1)
    })

    it('stores null based_on_version when there is no prior spec yet', async () => {
      await authorSpec(deps(fake().client), INPUT)

      const stored = parseStoredChange(readSpecs(db, 1)[0]!.payload)
      expect(stored.based_on_version).toBeNull()
    })

    it('bases the next version on the newest proposal, confirmed or not', async () => {
      // currentSpec is the newest proposal, full stop — nothing confirms any
      // more, so there is no longer an "unconfirmed proposal" for it to skip.
      existingSpec()
      insertSpec(db, {
        accountId: 1,
        conversationId: 'conv-0',
        promptSha: 'abc123abc123',
        payload: { ...GOOD_CHANGE, shape: 'change', based_on_version: 1 },
        mockupHtml: '',
        at: 3,
      })

      await authorSpec(deps(fake().client), INPUT)

      const stored = parseStoredChange(readSpecs(db, 1)[0]!.payload)
      // Version 2 (the row just inserted above), not version 1.
      expect(stored.based_on_version).toBe(2)
    })

    it('reads the pointer at WRITE time, so a spec written mid-authoring is not missed', async () => {
      // The authoring call can run for a minute and a half. If some other
      // write lands a newer spec row while THIS call is still in flight — a
      // second conversation, a retry, anything — the row this function writes
      // must not name a base that stopped being current before the row
      // existed: `specs` rejects UPDATE, so the diff for that version is
      // computed against the wrong base forever.
      //
      // onCall fires while the spec call is in flight, which is exactly when
      // that race is live.
      existingSpec()
      let fired = false
      const client = fake({
        onCall: () => {
          if (fired) return
          fired = true
          existingSpec({
            ...GOOD_CHANGE,
            shape: 'change',
            based_on_version: 1,
            change_summary: 'a spec written while the first call was in flight',
          })
        },
      })

      await authorSpec(deps(client.client), INPUT)

      const rows = readSpecs(db, 1)
      expect(rows).toHaveLength(3)
      const written = rows[0]!
      expect(written.version).toBe(3)
      // v2 — the version written mid-flight — not v1, which was current
      // when the call started.
      expect(parseStoredChange(written.payload).based_on_version).toBe(2)
    })

    it('rejects a draft that authored its own based_on_version', async () => {
      // A model-authored lineage pointer becomes a permanent wrong row in an
      // append-only table.
      const client = fake({ drafts: [{ ...GOOD_CHANGE, based_on_version: 7 }, GOOD_CHANGE] })
      const proposal = await authorSpec(deps(client.client), INPUT)

      expect(client.specCalls()).toHaveLength(2)
      expect(proposal).toBeDefined()
      expect(parseStoredChange(readSpecs(db, 1)[0]!.payload).based_on_version).toBeNull()
    })

    it('rejects a draft that authored its own shape tag', async () => {
      // The second server-written field, and the more dangerous one: `shape`
      // is what lib/spec/stored.ts dispatches on, so a model-supplied tag
      // decides how every later reader parses a row nobody can rewrite.
      const client = fake({ drafts: [{ ...GOOD_CHANGE, shape: 'version' }, GOOD_CHANGE] })
      await authorSpec(deps(client.client), INPUT)

      expect(client.specCalls()).toHaveLength(2)
      expect(parseStoredChange(readSpecs(db, 1)[0]!.payload).shape).toBe('change')
    })
  })

  describe('the messages sent to propose()', () => {
    it('appends the synthetic "Write the change now." message when the transcript ends on an assistant turn', async () => {
      seedConversation()

      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = client.specCalls()[0]!.messages
      expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
      expect(sent[0]!.content).toBe('what should I track?')
      expect(sent[1]!.content).toBe('sure thing')
      expect(sent[2]!.content).toMatch(/nothing has been built/i)
      expect(sent[3]!.content).toBe('Write the change now.')
    })

    it('sends the transcript as-is, with no "Write the change now.", when it ends on a user turn', async () => {
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
      // The current-state block still goes, so the prompt has one shape on
      // every path; only the synthetic instruction is conditional.
      expect(sent).toHaveLength(4)
      expect(sent.some((m) => m.content === 'Write the change now.')).toBe(false)
      expect(sent.at(-1)!.role).toBe('user')
    })
  })

  /**
   * The metrics pair every row this function writes carries. `authoring_mode`
   * is a constant — there is one authoring path — kept so a query grouping
   * spec rows by mode reads 'patch', 'whole' and 'change' as three eras of one
   * field. `ops_count` is replaced by `changes_count`, because ops no longer
   * exist and a field that can only ever be null is a lie in a table nobody
   * can correct.
   */
  describe('authoring mode and change count', () => {
    it('records authoring_mode and a change count on the success row', async () => {
      await authorSpec(deps(fake().client), INPUT)

      const row = metrics().find((r) => r.event === 'spec_proposed')!
      expect(row.data.authoring_mode).toBe('change')
      expect(row.data.changes_count).toBe(1)
      // ops_count named a thing that no longer exists. A column that can only
      // ever be null is worse than an absent one.
      expect(row.data).not.toHaveProperty('ops_count')
      // The bound: a count, never a name. Nothing in this row may carry the
      // words a friend used.
      expect(JSON.stringify(row.data)).not.toContain('Weekly average')
    })

    it('records a null change count when nothing parsed', async () => {
      await authorSpec(deps(fake({ drafts: [{ change_summary: 'x' }, { change_summary: 'x' }] }).client), INPUT)

      const row = metrics().filter((r) => r.event === 'spec_error').at(-1)!
      expect(row.data.authoring_mode).toBe('change')
      expect(row.data.changes_count).toBeNull()
    })

    it('carries authoring_mode on a spec_aborted row too, not just spec_proposed', async () => {
      // The field is only worth having if EVERY row this function writes
      // carries it — a spec_aborted row with no mode would be a hole in the
      // series `metrics` can never backfill.
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
      const [row] = metrics()
      expect(row!.event).toBe('spec_aborted')
      expect(row!.data.authoring_mode).toBe('change')
      // Nothing parsed on this path — null, not 0.
      expect(row!.data.changes_count).toBeNull()
    })

    it('carries authoring_mode on the outer catch\'s row too, where it is not spread in', async () => {
      // The outer catch builds its data object by hand, because metricBase may
      // not exist yet when it fires. authoring_mode used to be null there for
      // a failure that struck before a mode was CHOSEN; nothing is chosen any
      // more, so 'change' is true of every row this function can write and
      // null would leave a permanent hole in the one field that lets the three
      // eras be read as one series.
      //
      // Forced through insertSpec's NOT NULL constraint, the same real throw
      // the never-throws test above uses.
      await authorSpec(deps(fake().client), {
        ...INPUT,
        conversationId: null as unknown as string,
      })

      const [row] = metrics()
      expect(row!.data.kind).toBe('unexpected_error')
      expect(row!.data.authoring_mode).toBe('change')
      // The parse SUCCEEDED before insertSpec threw, so the count is the real
      // one — a row that reported null here would understate a call that did
      // the whole model round trip.
      expect(row!.data.changes_count).toBe(1)
    })

    it('never reports a change count on a row whose parse failed', async () => {
      // A stale count is a permanently wrong row: `metrics` rejects UPDATE.
      // Both attempts here fail to parse, so both rows must report null —
      // and the count is read off the parsed draft rather than typed as a
      // literal, so it cannot drift from what actually parsed.
      const client = fake({ drafts: [BAD_CHANGE, {}] })
      const result = await authorSpec(deps(client.client), INPUT)

      expect(result).toBeUndefined()
      const errors = metrics().filter((r) => r.event === 'spec_error')
      expect(errors).toHaveLength(2)
      expect(errors.map((e) => e.data.attempt)).toEqual([1, 2])
      expect(errors.map((e) => e.data.kind)).toEqual(['malformed_spec', 'malformed_spec'])
      expect(errors.map((e) => e.data.changes_count)).toEqual([null, null])
    })

    it('counts every entry, not just the first', async () => {
      const three = {
        ...GOOD_CHANGE,
        changes: [
          GOOD_CHANGE.changes[0],
          { ...GOOD_CHANGE.changes[0], action: 'remove', name: 'Streak' },
          { ...GOOD_CHANGE.changes[0], action: 'change', target: 'screen', name: 'Today' },
        ],
      }
      await authorSpec(deps(fake({ drafts: [three] }).client), INPUT)

      const row = metrics().find((r) => r.event === 'spec_proposed')!
      expect(row.data.changes_count).toBe(3)
    })
  })

  describe('authorSpec no longer draws a mockup', () => {
    it('makes exactly ONE model call', async () => {
      // Two was the old shape: the spec, then the per-screen mockup. The second
      // call is what that task removed, and a count is the only assertion that
      // notices if it comes back.
      const f = fake()
      await authorSpec(deps(f.client), INPUT)
      expect(f.calls).toHaveLength(1)
    })

    it('stores an empty mockup_html rather than failing the NOT NULL column', async () => {
      // The column stays — altering it would be schema surgery on an
      // append-only table. '' readably means "authored after mockups were
      // removed"; a row that failed to insert would mean nothing at all.
      await authorSpec(deps(fake().client), INPUT)
      const row = db
        .prepare('SELECT mockup_html FROM specs ORDER BY id DESC LIMIT 1')
        .get() as { mockup_html: string }
      expect(row.mockup_html).toBe('')
    })

    it('writes no spec_screen_mockups row', async () => {
      const proposal = await authorSpec(deps(fake().client), INPUT)
      // A zero count is not proof by itself — it is also what a total
      // authoring failure looks like (nothing written at all). Assert the
      // spec row actually landed first, so this test can only pass by
      // proving "a spec was written, and it has no mockup rows" rather than
      // "nothing happened".
      expect(proposal).toBeDefined()
      expect(readSpecs(db, 1)).toHaveLength(1)
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM spec_screen_mockups')
        .get() as { n: number }
      expect(row.n).toBe(0)
    })

    it('writes no mockup_prompt_sha on the spec_proposed row', async () => {
      // The metric's shape is part of the contract: a field naming a prompt
      // that no longer runs would be permanently misleading in an append-only
      // table.
      await authorSpec(deps(fake().client), INPUT)
      const proposed = metrics().find((m) => m.event === 'spec_proposed')
      expect(proposed).toBeDefined()
      expect(proposed!.data).not.toHaveProperty('mockup_prompt_sha')
    })
  })
})
