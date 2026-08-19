// tests/spec/author.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { appendTranscript } from '@/lib/db/appendOnly'
import { insertSpec, readSpecs } from '@/lib/db/specs'
import { CHAT_MODEL, ChatStreamError, type ChatClient, type Usage } from '@/lib/chat/client'
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
 * `propose()` only ever sees the ONE call authorSpec now makes — the spec
 * (whole-surface or patch, by schema) — since the mockup-loop removal (plan
 * 2026-08-19-remove-the-mockup-loop, Task 4) deleted the second, per-screen
 * mockup call this fake used to also answer.
 */
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
    // Every call this fake ever records IS a spec call now — kept as its own
    // accessor (rather than pointing every existing call site at `calls`
    // directly) because that used to be a real distinction from the mockup
    // call and rewriting every one of this file's `client.specCalls()` sites
    // for no behaviour change would be pure churn.
    specCalls: () => calls,
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

/**
 * A spec for account 1, so currentSpec() has something to return — nothing
 * confirms any more, so the row existing is what makes it current (kept the
 * name `confirmed` rather than churning all 17 call sites; the fixture's
 * shape is unchanged, only the no-longer-needed confirmSpec call is gone).
 *
 * No longer also seeds a per-screen spec_screen_mockups fragment for each of
 * the payload's screens: that existed only because authorSpec used to read
 * carried-forward fragments off the account's current spec when drawing its
 * own mockup. As of the mockup-loop removal (plan
 * 2026-08-19-remove-the-mockup-loop, Task 4) authorSpec never reads that
 * table at all, so seeding it here would be fixture data nothing under test
 * consumes.
 */
function confirmed(payload: unknown): number {
  return insertSpec(db, {
    accountId: 1,
    conversationId: 'conv-0',
    promptSha: 'abc123abc123',
    payload,
    mockupHtml: '<!doctype html><html><body>OLD</body></html>',
    at: 1,
  })
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
    // "Write the spec now.", the current-version block, and the retry message
    // are all call-time constructs, not things the friend said. Anything
    // reading the transcript must see only what happened.
    //
    // Seeded so the transcript ends on an assistant turn, which is the ONLY
    // case where the synthetic instruction actually gets constructed and sent
    // (see the messages-shape tests below), and driven through a REJECTED
    // first attempt so the retry message is constructed too.
    //
    // confirmed(CURRENT_V1) puts a current-shape spec on the account, which
    // is what makes the "current confirmed" text below exist to check for in
    // the first place (the v1 arm never renders those words) — but it ALSO
    // now selects patch mode (Task 13). The two drafts below were originally
    // whole-surface-shaped and, under patch mode, both failed to parse as a
    // patch at all: the test stayed green (it only asserts on `transcripts`,
    // which authorSpec never touches on any path) while silently exercising
    // "two failed attempts" instead of the "reject, retry, succeed" it
    // describes and its own comment claims. Fixed by making the drafts
    // PATCH-shaped instead, so the retry really does run, under the mode this
    // account now actually gets.
    seedConversation()
    confirmed(CURRENT_V1)

    const rejectedPatch = { ...GOOD_PATCH, ops: [] } // shape-valid, validator rejects it (empty ops)
    await authorSpec(deps(fake({ drafts: [rejectedPatch, GOOD_PATCH] }).client), INPUT)

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
    it('gives the writer the current version as JSON', async () => {
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
      // Nothing confirms any more, so this is now the ONLY thing that puts an
      // account in the empty arm: no spec at all. Previously a rejected
      // proposal was seeded here to prove currentSpec skipped it in favour of
      // the empty arm — that distinction is gone, because currentSpec no
      // longer asks about confirmation (lib/db/specs.ts). An account with a
      // spec, confirmed or not, now gets the "current version" arm instead —
      // see "gives the writer the current version as JSON" above.
      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = JSON.stringify(client.specCalls()[0]!.messages)
      expect(sent).toMatch(/no spec for this account/i)
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

  describe('lineage', () => {
    it('stores the server-supplied based_on_version, not a model-authored one', async () => {
      confirmed(CURRENT_V1)
      await authorSpec(deps(fake().client), INPUT)

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      expect(stored.kind).toBe('version')
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.based_on_version).toBe(1)
    })

    it('stores null based_on_version when there is no prior spec yet', async () => {
      await authorSpec(deps(fake().client), INPUT)

      const stored = readStoredSpec(readSpecs(db, 1)[0]!.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      expect(stored.version.based_on_version).toBeNull()
    })

    it('bases the next version on the newest proposal, confirmed or not', async () => {
      // currentSpec is the newest proposal, full stop — nothing confirms any
      // more, so there is no longer an "unconfirmed proposal" for it to skip.
      // This used to prove the OPPOSITE: that a proposal sitting on top of a
      // confirmed one was ignored. That distinction is gone by design (see
      // lib/db/specs.ts's currentSpec docstring).
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
      // Version 2 (the row just inserted above), not version 1.
      expect(stored.version.based_on_version).toBe(2)
    })

    it('reads the pointer at WRITE time, so a spec written mid-authoring is not missed', async () => {
      // The authoring call can run for three minutes. If some other write
      // lands a newer spec row while THIS call is still in flight — a second
      // conversation, a retry, anything — the row this function writes must
      // not name a base that stopped being current before the row existed:
      // `specs` rejects UPDATE, so the diff for that version is computed
      // against the wrong base forever.
      //
      // onCall fires while the spec call is in flight, which is exactly when
      // that race is live.
      confirmed(CURRENT_V1)
      let fired = false
      const client = fake({
        onCall: () => {
          if (fired) return
          fired = true
          confirmed({ ...CURRENT_V1, change_summary: 'a spec written while the first call was in flight' })
        },
      })

      await authorSpec(deps(client.client), INPUT)

      const rows = readSpecs(db, 1)
      expect(rows).toHaveLength(3)
      const written = rows[0]!
      expect(written.version).toBe(3)
      const stored = readStoredSpec(written.payload)
      if (stored.kind !== 'version') throw new Error('unreachable')
      // v2 — the version written mid-flight — not v1, which was current
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

  describe('the messages sent to propose()', () => {
    it('appends the synthetic "Write the spec now." message when the transcript ends on an assistant turn', async () => {
      seedConversation()

      const client = fake()
      await authorSpec(deps(client.client), INPUT)

      const sent = client.specCalls()[0]!.messages
      expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
      expect(sent[0]!.content).toBe('what should I track?')
      expect(sent[1]!.content).toBe('sure thing')
      expect(sent[2]!.content).toMatch(/no spec for this account/i)
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

    /** A current version with two panels, so a patch has something
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

    it('carries authoring_mode on a spec_aborted row too, not just spec_proposed', async () => {
      // The field is only worth having if EVERY row this function writes
      // carries it — a spec_aborted row with no mode would be a hole in the
      // series `metrics` can never backfill. `mode` is decided before the
      // attempt loop runs, so it is known by the time an abort can fire.
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
      expect(row!.data.authoring_mode).toBe('whole')
      // No patch was ever parsed on this path — null, not 0.
      expect(row!.data.ops_count).toBeNull()
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

    it('does not carry a previous attempt\'s ops_count onto a row that never parsed a patch', async () => {
      // Reproduces a real bug: `patch` is set once, on a successful
      // parsePatch, and was never reset per attempt. Attempt 1 here parses
      // fine and fails to APPLY (patch_failed, patch is set to one op).
      // Attempt 2 returns something that is not even patch-SHAPED, so
      // parsePatch throws before it ever assigns `patch` again — that row
      // must report ops_count: null, not attempt 1's leftover 1. A stale
      // count here is a permanently wrong row: `metrics` rejects UPDATE.
      confirmed(TWO_PANEL_CURRENT)
      const client = fake({ drafts: [GHOST_PATCH, {}] })
      const result = await authorSpec(deps(client.client), INPUT)

      expect(result).toBeUndefined()
      const errors = metrics().filter((r) => r.event === 'spec_error')
      expect(errors).toHaveLength(2)

      expect(errors[0]!.data.attempt).toBe(1)
      expect(errors[0]!.data.kind).toBe('patch_failed')
      expect(errors[0]!.data.ops_count).toBe(1)

      expect(errors[1]!.data.attempt).toBe(2)
      expect(errors[1]!.data.kind).toBe('malformed_spec')
      expect(errors[1]!.data.ops_count).toBeNull()
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

  describe('authorSpec no longer draws a mockup', () => {
    it('makes exactly ONE model call', async () => {
      // Two was the old shape: the spec, then the per-screen mockup. The second
      // call is what this task removes, and a count is the only assertion that
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
