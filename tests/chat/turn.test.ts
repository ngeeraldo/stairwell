// tests/chat/turn.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIError } from '@anthropic-ai/sdk'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import { insertSpec } from '@/lib/db/specs'
import {
  CHAT_MODEL,
  ChatStreamError,
  describeError,
  type ChatClient,
  type StreamResult,
} from '@/lib/chat/client'
import { OPENER_ALREADY_SENT } from '@/lib/chat/opening'
import { CURRENT_STATE_BLOCK, runTurn } from '@/lib/chat/turn'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-turn-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const USAGE = { input: 100, output: 7, cache_read: 40, cache_creation: 0 }
const SERVED = { model_served: CHAT_MODEL, fallback_fired: false }

/** Most tests do not care about alerting; this keeps their deps honest. */
const noAlert = () => {}

/**
 * Most tests do not call propose_spec, so this must never be invoked. Tests
 * that DO exercise the propose_spec path supply their own authorSpec.
 */
const fakeAuthorSpec = async () => undefined

/** A client that replies with fixed chunks and reports usage as it goes. */
function fakeClient(chunks: string[]): ChatClient {
  return {
    async stream({ onText, onUsage, onServed }) {
      onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
      onServed({ model_served: CHAT_MODEL })
      for (const c of chunks) {
        onText(c)
        onUsage({ output: 7 })
      }
      return { usage: USAGE, stop_reason: 'end_turn', served: SERVED, tools_called: [] }
    },
    async propose() {
      throw new Error('unused')
    },
  }
}

/**
 * A client that resolves successfully having delivered nothing.
 *
 * This is the shape of a safety-classifier refusal: HTTP 200, an empty
 * content array, and `stop_reason: "refusal"`. It is NOT an exception, which
 * is exactly why it slipped through as a "successful" turn.
 */
function silentClient(
  over: Partial<StreamResult> & { text?: string } = {},
): ChatClient {
  const { text, ...result } = over
  return {
    async stream({ onText, onUsage, onServed }) {
      onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
      onServed({ model_served: CHAT_MODEL })
      if (text) onText(text)
      return {
        usage: USAGE,
        stop_reason: 'refusal',
        served: SERVED,
        tools_called: [],
        ...result,
      }
    },
    async propose() {
      throw new Error('unused')
    },
  }
}

/** A client that streams one chunk, then the caller aborts. Never reports
 * `onServed` — the abort happens before any model information arrived. */
function abortingClient(controller: AbortController): ChatClient {
  return {
    async stream({ onText, onUsage, signal }) {
      onUsage({ input: 100, cache_read: 0, cache_creation: 0 })
      onText('half a rep')
      onUsage({ output: 3 })
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      // `signal` is deliberately unused here; runTurn reads signal.aborted.
      void signal
    },
    async propose() {
      throw new Error('unused')
    },
  }
}

/**
 * A client that reports a fallback model via `onServed` — the same way
 * message_start / a fallback content block would mid-stream — and THEN the
 * caller aborts. Proves the abort path carries whatever was already known,
 * not the seeded default.
 */
function abortingClientAfterFallback(controller: AbortController): ChatClient {
  return {
    async stream({ onText, onUsage, onServed, signal }) {
      onUsage({ input: 100, cache_read: 0, cache_creation: 0 })
      onServed({ model_served: 'claude-opus-4-8', fallback_fired: true })
      onText('half a rep')
      onUsage({ output: 3 })
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      void signal
    },
    async propose() {
      throw new Error('unused')
    },
  }
}

/**
 * A client that fails the way the real one fails: with the normalized shape
 * lib/chat/client.ts produces from a real SDK error.
 *
 * The previous version of this fake threw a bare `new Error('rate limited')`,
 * whose `.name` genuinely IS 'Error' — so it asserted the defect it was
 * supposed to catch. `status` and `type` come from `describeError` rather than
 * being hand-written, so this fake cannot drift from the real mapping.
 */
function failingClient(
  status: number,
  apiType: string,
  { after = '' }: { after?: string } = {},
): ChatClient {
  const error = APIError.generate(
    status,
    { type: 'error', error: { type: apiType, message: 'from the API' } },
    undefined,
    new Headers(),
  )
  return {
    async stream({ onText, onUsage, onServed }) {
      onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
      onServed({ model_served: CHAT_MODEL })
      if (after) {
        onText(after)
        onUsage({ output: 12 })
      }
      throw new ChatStreamError(describeError(error), error.message)
    },
    async propose() {
      throw new Error('unused')
    },
  }
}

/**
 * A client whose in-stream usage accumulator DELIBERATELY diverges from its
 * resolved return value: `onUsage({ output: 99 })` fires after the last
 * chunk, but `stream()` resolves with `output: 7`. runTurn must record the
 * resolved value on `chat_turn`, not whatever the accumulator last saw — do
 * not "simplify" this fake to make the two agree, that would silently
 * remove the only coverage that pins `...final` over `...usage`.
 */
function divergingUsageClient(): ChatClient {
  return {
    async stream({ onText, onUsage, onServed }) {
      onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
      onServed({ model_served: CHAT_MODEL })
      onText('ok')
      onUsage({ output: 99 })
      return { usage: USAGE, stop_reason: 'end_turn', served: SERVED, tools_called: [] }
    },
    async propose() {
      throw new Error('unused')
    },
  }
}

/**
 * The one row with this event. Used by every failing-client test, because a
 * transient failure now writes a chat_stream_retry row FIRST (the stream is
 * retried once when nothing has been delivered yet), so `metrics()[0]` is no
 * longer the row those tests mean.
 */
function metricOf(event: string) {
  const found = metrics().filter((m) => m.event === event)
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${event} row, found ${found.length}`)
  }
  return found[0]!
}

function metrics() {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string | null
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data ?? 'null') }))
}

const input = (over: Partial<Parameters<typeof runTurn>[1]> = {}) => ({
  accountId: 1,
  sessionId: 'sess-1',
  body: 'what should I watch?',
  // No dashboard by default: most cases in this file are interview turns,
  // which is the state an account is in before anything is built.
  currentState: null,
  signal: new AbortController().signal,
  // Separate from `signal` on purpose — a test that wants to abort the model
  // stream should not silently also abort authoring, and vice versa. Overriding
  // one leaves the other live.
  authoringSignal: new AbortController().signal,
  onText: () => {},
  ...over,
})

describe('runTurn — completion', () => {
  it('appends the user turn and then the assistant turn', async () => {
    const deps = { db, client: fakeClient(['Keep an ', 'eye on rent.']), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('completed')
    const rows = readTranscript(db, 1)
    expect(rows.map((r) => [r.role, r.body])).toEqual([
      ['user', 'what should I watch?'],
      ['assistant', 'Keep an eye on rent.'],
    ])
  })

  it('stamps both rows with the same conversation_id and the prompt sha', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input())

    const rows = readTranscript(db, 1)
    expect(rows[0]!.conversation_id).toBe(rows[1]!.conversation_id)
    expect(rows[0]!.session_id).toBe('sess-1')
    expect(rows[0]!.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
    expect(rows[1]!.prompt_sha).toBe(rows[0]!.prompt_sha)
  })

  it('logs one chat_turn metric carrying all four counters', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input())

    expect(metrics()).toHaveLength(1)
    const [m] = metrics()
    expect(m!.event).toBe('chat_turn')
    expect(m!.data).toMatchObject({
      input: 100,
      output: 7,
      cache_read: 40,
      cache_creation: 0,
      model: 'claude-opus-5',
      effort: 'medium',
      context: 'interview',
    })
    expect(m!.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('streams text to the caller as it arrives', async () => {
    const seen: string[] = []
    const deps = { db, client: fakeClient(['a', 'b']), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input({ onText: (t: string) => seen.push(t) }))
    expect(seen).toEqual(['a', 'b'])
  })

  it('records the resolved usage on completion, not the in-stream accumulator', async () => {
    const deps = { db, client: divergingUsageClient(), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input())

    const [m] = metrics()
    expect(m!.event).toBe('chat_turn')
    expect(m!.data.output).toBe(7)
  })

  it('starts a new conversation after the gap and keeps one inside it', async () => {
    const client = fakeClient(['ok'])
    await runTurn({ db, client, now: () => 0, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())
    await runTurn({ db, client, now: () => 60_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())
    await runTurn({ db, client, now: () => 60_000 + 31 * 60 * 1000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())

    const ids = readTranscript(db, 1).map((r) => r.conversation_id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(ids[3]) // first exchange and second exchange
    expect(ids[4]).not.toBe(ids[0]) // third, past the gap
  })
})

describe('runTurn — abort', () => {
  it('appends NO assistant row', async () => {
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    const outcome = await runTurn(deps, input({ signal: controller.signal }))

    expect(outcome.kind).toBe('aborted')
    const rows = readTranscript(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('user')
  })

  it('logs stream_aborted with the counters known so far, not zeros', async () => {
    // The whole reason usage is reported during the stream rather than only at
    // the end: an aborted turn still cost input tokens, and a cost log that
    // records zero for it is fiction.
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input({ signal: controller.signal }))

    const [m] = metrics()
    expect(m!.event).toBe('stream_aborted')
    expect(m!.data).toMatchObject({ input: 100, output: 3, context: 'interview' })
    expect(m!.data.delivered_chars).toBe('half a rep'.length)
    // Ledger item 9, honest-default case: onServed never fired before the
    // abort, so nothing about the answering model is actually known yet.
    // Recording the seeded default (the requested model, no fallback) is the
    // honest value for "not known" — not a fabricated one.
    expect(m!.data.model_served).toBe(CHAT_MODEL)
    expect(m!.data.fallback_fired).toBe(false)
  })

  it('logs stream_aborted with model_served and fallback_fired reported before the abort', async () => {
    // Ledger item 9, known case: a fallback already fired mid-stream (reported
    // via onServed, the same in-stream accumulator usage/onUsage uses) before
    // the caller aborted. Those billed tokens were priced at the FALLBACK
    // model's rate, not CHAT_MODEL's, so the row must say so.
    const controller = new AbortController()
    const deps = { db, client: abortingClientAfterFallback(controller), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input({ signal: controller.signal }))

    const [m] = metrics()
    expect(m!.event).toBe('stream_aborted')
    expect(m!.data.model_served).toBe('claude-opus-4-8')
    expect(m!.data.fallback_fired).toBe(true)
    expect(m!.data.model_served).not.toBe(m!.data.model)
  })
})

describe('runTurn — API error', () => {
  it('retries a transient stream failure and delivers the reply', async () => {
    // 2026-08-18, hours after the mockup call got this: Anthropic returned
    // Overloaded on three consecutive chat calls and a friend saw three
    // "interrupted — not saved" markers and no reply. Same error class, and
    // the stream had no retry because the earlier fix only covered the mockup.
    let attempts = 0
    const client: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        attempts += 1
        if (attempts === 1) {
          throw new ChatStreamError(
            { kind: 'api_error', status: null, type: 'overloaded_error' },
            'Overloaded',
          )
        }
        onUsage({ input: 10, output: 3, cache_read: 0, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText('here you go')
        return {
          usage: { input: 10, output: 3, cache_read: 0, cache_creation: 0 },
          stop_reason: 'end_turn',
          served: { model_served: CHAT_MODEL, fallback_fired: false },
          tools_called: [],
        }
      },
      async propose() {
        throw new Error('unused')
      },
    }

    const outcome = await runTurn(
      { db, client, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec },
      input(),
    )

    expect(attempts).toBe(2)
    expect(outcome.kind).toBe('completed')
    expect(readTranscript(db, 1).map((r) => r.role)).toEqual(['user', 'assistant'])
    // The ridden-through outage is visible, and as its OWN event: a chat_error
    // row here would make an outage we survived look like one that reached the
    // friend.
    expect(metricOf('chat_stream_retry').data).toMatchObject({
      kind: 'api_error',
      type: 'overloaded_error',
    })
    expect(metrics().filter((m) => m.event === 'chat_error')).toHaveLength(0)
  })

  it('does NOT retry once text has already reached the screen', async () => {
    // The guard that matters. onText has already pushed every chunk to the
    // browser, and the panel APPENDS chunks — so a retry after even one chunk
    // replays the reply from the top and the friend reads it twice.
    const client = failingClient(529, 'overloaded_error', { after: 'half an ans' })
    let calls = 0
    const counting: ChatClient = {
      async stream(args) {
        calls += 1
        return client.stream(args)
      },
      async propose() {
        throw new Error('unused')
      },
    }

    await runTurn(
      { db, client: counting, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec },
      input(),
    )

    expect(calls).toBe(1)
    expect(metrics().filter((m) => m.event === 'chat_stream_retry')).toHaveLength(0)
  })

  it('does not retry a stream failure another attempt cannot fix', async () => {
    const client = failingClient(400, 'invalid_request_error')
    let calls = 0
    const counting: ChatClient = {
      async stream(args) {
        calls += 1
        return client.stream(args)
      },
      async propose() {
        throw new Error('unused')
      },
    }

    await runTurn(
      { db, client: counting, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec },
      input(),
    )

    expect(calls).toBe(1)
    expect(metricOf('chat_error').data.kind).toBe('bad_request')
  })

  it('appends no assistant row and logs chat_error, not stream_aborted', async () => {
    const deps = { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('error')
    expect(readTranscript(db, 1)).toHaveLength(1)
    const m = metricOf('chat_error')
    expect(m.data).toMatchObject({ context: 'interview' })
  })

  it('records a kind that is not the constant "Error", plus status and type', async () => {
    // The whole purpose of this field (design spec section 2.5): it is what
    // distinguishes a rate limit from a refusal from a timeout when the
    // week-3 numbers get read.
    const deps = { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input())

    const m = metricOf('chat_error')
    expect(m.data.kind).not.toBe('Error')
    expect(m!.data).toMatchObject({
      kind: 'rate_limit',
      status: 429,
      type: 'rate_limit_error',
    })
  })

  it('gives two different SDK error classes two DIFFERENT kinds', async () => {
    // A single-case test cannot catch a constant. These two must disagree, or
    // the field distinguishes nothing.
    await runTurn(
      { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec },
      input(),
    )
    await runTurn(
      { db, client: failingClient(529, 'overloaded_error'), now: () => 2_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec },
      input(),
    )

    // chat_error rows only: each of these failures is transient, so each turn
    // also wrote a chat_stream_retry carrying the SAME kind. Filtering keeps
    // this test about what it was written to check — that the field
    // distinguishes two SDK classes — rather than about retry bookkeeping.
    const kinds = metrics()
      .filter((m) => m.event === 'chat_error')
      .map((m) => m.data.kind)
    expect(kinds).toEqual(['rate_limit', 'internal_server'])
    expect(new Set(kinds).size).toBe(2)
  })

  it('keeps the counters that were really spent before the failure', async () => {
    // A 529 or a dropped connection after 400 tokens of output has real,
    // billed counters. Recording zero for them is fiction.
    const deps = {
      db,
      client: failingClient(529, 'overloaded_error', { after: 'partial answer' }),
      now: () => 1_000,
      context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec,
    }
    await runTurn(deps, input())

    const [m] = metrics()
    expect(m!.data).toMatchObject({
      input: 100,
      output: 12,
      cache_read: 40,
      cache_creation: 0,
    })
    expect(m!.data.delivered_chars).toBe('partial answer'.length)
  })
})

describe('describeError — SDK class to stable kind', () => {
  // Constructed through APIError.generate, the same factory the SDK itself
  // uses to turn a non-2xx response into a typed error, so these are the real
  // classes and not stand-ins.
  const from = (status: number, type: string) =>
    describeError(
      APIError.generate(
        status,
        { type: 'error', error: { type, message: 'x' } },
        undefined,
        new Headers(),
      ),
    )

  it('maps each status class to its own kind', () => {
    expect(from(400, 'invalid_request_error').kind).toBe('bad_request')
    expect(from(401, 'authentication_error').kind).toBe('authentication')
    expect(from(404, 'not_found_error').kind).toBe('not_found')
    expect(from(429, 'rate_limit_error').kind).toBe('rate_limit')
    expect(from(529, 'overloaded_error').kind).toBe('internal_server')
  })

  it('never returns the string "Error" for an SDK error', () => {
    // Every one of these classes inherits Error.prototype.name === "Error",
    // which is why the kind cannot be read off `.name`.
    for (const [status, type] of [
      [400, 'invalid_request_error'],
      [401, 'authentication_error'],
      [429, 'rate_limit_error'],
      [529, 'overloaded_error'],
    ] as const) {
      const error = APIError.generate(
        status,
        { type: 'error', error: { type, message: 'x' } },
        undefined,
        new Headers(),
      )
      expect(error.name).toBe('Error') // the defect this replaced
      expect(describeError(error).kind).not.toBe('Error')
    }
  })

  it('carries the status and the API type discriminator', () => {
    expect(from(429, 'rate_limit_error')).toEqual({
      kind: 'rate_limit',
      status: 429,
      type: 'rate_limit_error',
    })
  })

  it('reports a connection failure with a null status', () => {
    // APIConnectionError extends APIError but exposes no status, so the
    // instanceof order and the status guard both matter here.
    const shape = describeError(APIError.generate(undefined, undefined, 'down', undefined))
    expect(shape).toEqual({ kind: 'connection', status: null, type: null })
  })

  it('falls back rather than throwing on a non-SDK value', () => {
    expect(describeError(new Error('plain')).kind).toBe('unknown_error')
    expect(describeError('a string').kind).toBe('unknown')
  })
})

describe('runTurn — empty or incomplete reply', () => {
  it('writes NO assistant row when the model refuses', async () => {
    // A refusal returns HTTP 200 with an empty content array. Writing an
    // empty assistant body into an append-only table would 400 every later
    // turn for this account, forever, with no way to delete the row.
    const deps = { db, client: silentClient(), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).not.toBe('completed')
    const rows = readTranscript(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('user')
  })

  it('logs chat_empty_reply carrying the stop reason and all four counters', async () => {
    const deps = { db, client: silentClient(), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input())

    expect(metrics()).toHaveLength(1)
    const [m] = metrics()
    expect(m!.event).toBe('chat_empty_reply')
    expect(m!.data).toMatchObject({
      stop_reason: 'refusal',
      input: 100,
      output: 7,
      cache_read: 40,
      cache_creation: 0,
      model: CHAT_MODEL,
      effort: 'medium',
      context: 'interview',
    })
  })

  it('treats whitespace-only output as empty', async () => {
    const deps = {
      db,
      client: silentClient({ text: '   \n  ', stop_reason: 'end_turn' }),
      now: () => 1_000,
      context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec,
    }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).not.toBe('completed')
    expect(readTranscript(db, 1)).toHaveLength(1)
  })

  it('does not record a max_tokens stop as a complete reply', async () => {
    // Text WAS delivered here. Truncated output is not a complete answer, and
    // recording it as one puts a half-sentence in the permanent transcript.
    const deps = {
      db,
      client: silentClient({ text: 'I was cut off mid-', stop_reason: 'max_tokens' }),
      now: () => 1_000,
      context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec,
    }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).not.toBe('completed')
    expect(readTranscript(db, 1)).toHaveLength(1)
    const [m] = metrics()
    expect(m!.event).toBe('chat_empty_reply')
    expect(m!.data.stop_reason).toBe('max_tokens')
  })

  it('survives a poisoning row that was already written', async () => {
    // The recovery valve. An empty-body assistant row cannot be deleted, so
    // the only defence is that toMessages refuses to send it.
    //
    // The empty row sits AFTER a real user turn deliberately: placed first it
    // would be removed by the pre-existing leading-assistant trim, and this
    // test would pass without the empty-body filter existing at all.
    const seed = (at: number, role: string, body: string) =>
      appendTranscript(db, {
        accountId: 1,
        sessionId: 'sess-0',
        conversationId: 'conv-0',
        promptSha: 'abc123abc123',
        role,
        body,
        at,
      })
    seed(1, 'user', 'an earlier question')
    seed(2, 'assistant', '') // the poisoning row

    let sent: { role: string; content: string }[] = []
    const client: ChatClient = {
      async stream({ messages, onText, onUsage, onServed }) {
        sent = messages
        onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText('a real reply')
        return { usage: USAGE, stop_reason: 'end_turn', served: SERVED, tools_called: [] }
      },
      async propose() {
        throw new Error('unused')
      },
    }

    const outcome = await runTurn({ db, client, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())

    expect(outcome.kind).toBe('completed')
    expect(sent.every((m) => m.content.trim() !== '')).toBe(true)
    // One message, not two: dropping the poisoning row left two user rows
    // adjacent, and toMessages folds a same-role run into a single message
    // (see its docstring — the two valves are the same bet). Both questions
    // still reach the model, in order, which is what the recovery valve is
    // for.
    expect(sent).toEqual([
      { role: 'user', content: 'an earlier question\n\nwhat should I watch?' },
    ])
  })
})

describe('runTurn — served model and fallback', () => {
  it('records the model that actually answered when a fallback fired', async () => {
    // The owner's condition on opting into refusal fallbacks: a fallback that
    // silently changed the answering model would corrupt exactly the cost
    // retrospective the four counters exist to support.
    const client: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onServed({ model_served: 'claude-opus-4-8', fallback_fired: true })
        onText('answered by the fallback')
        return {
          usage: USAGE,
          stop_reason: 'end_turn',
          served: { model_served: 'claude-opus-4-8', fallback_fired: true },
          tools_called: [],
        }
      },
      async propose() {
        throw new Error('unused')
      },
    }

    await runTurn({ db, client, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())

    const [m] = metrics()
    expect(m!.event).toBe('chat_turn')
    expect(m!.data.model).toBe(CHAT_MODEL) // what was asked for
    expect(m!.data.model_served).toBe('claude-opus-4-8') // what answered
    expect(m!.data.fallback_fired).toBe(true)
    expect(m!.data.model_served).not.toBe(m!.data.model)
  })

  it('records the served model on chat_error too, from what the stream reported', async () => {
    const client: ChatClient = {
      async stream({ onUsage, onServed }) {
        onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
        onServed({ model_served: 'claude-opus-4-8', fallback_fired: true })
        throw new ChatStreamError(
          { kind: 'internal_server', status: 529, type: 'overloaded_error' },
          'overloaded',
        )
      },
      async propose() {
        throw new Error('unused')
      },
    }

    await runTurn({ db, client, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())

    const m = metricOf('chat_error')
    expect(m.data).toMatchObject({
      model_served: 'claude-opus-4-8',
      fallback_fired: true,
    })
  })

  it('reports the requested model when the stream failed before it knew', async () => {
    const client: ChatClient = {
      async stream() {
        throw new ChatStreamError(
          { kind: 'connection', status: null, type: null },
          'down',
        )
      },
      async propose() {
        throw new Error('unused')
      },
    }

    await runTurn({ db, client, now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec }, input())

    const m = metricOf('chat_error')
    expect(m.data).toMatchObject({
      model_served: CHAT_MODEL,
      fallback_fired: false,
    })
  })
})

describe('conversation-start alerting', () => {
  function alerted(over: { client?: ChatClient; now?: () => number } = {}) {
    const calls: number[] = []
    const deps = {
      db,
      client: over.client ?? fakeClient(['ok']),
      now: over.now ?? (() => 1_000),
      context: 'interview' as const, alert: (accountId: number) => calls.push(accountId),
      authorSpec: fakeAuthorSpec,
    }
    return { deps, calls }
  }

  it('alerts once, with the account id, when a conversation starts', async () => {
    const { deps, calls } = alerted()
    await runTurn(deps, input())
    expect(calls).toEqual([1])
  })

  it('does not alert on a continuation of an existing conversation', async () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-a',
      promptSha: 'sha',
      role: 'user',
      body: 'earlier',
      at: 900,
    })
    const { deps, calls } = alerted()
    const outcome = await runTurn(deps, input())
    expect(calls).toEqual([])
    // Positive check, added deliberately: `calls` staying empty is also what
    // an early-failing runTurn (thrown before the alert gate, say) would
    // produce, which would satisfy the assertion above having exercised
    // nothing. Pinning that the turn actually completed and logged its
    // chat_turn metric — same shape as "logs one chat_turn metric carrying
    // all four counters" above — is what makes the absence mean something.
    // The other absence-only alert test below ("does not alert on the
    // confirmation turn itself") carries the identical risk for the same
    // reason.
    expect(outcome.kind).toBe('completed')
    expect(metrics().map((m) => m.event)).toContain('chat_turn')
  })

  it('alerts BEFORE the model is called, not after the reply', async () => {
    // The signal is "a friend showed up", and it is worth more the sooner it
    // arrives. Ordering is asserted rather than assumed because moving the
    // call below the stream would still pass every other test here.
    const order: string[] = []
    const client: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        order.push('stream')
        onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText('ok')
        onUsage({ output: 7 })
        return { usage: USAGE, stop_reason: 'end_turn', served: SERVED, tools_called: [] }
      },
      async propose() {
        throw new Error('unused')
      },
    }
    const deps = {
      db,
      client,
      now: () => 1_000,
      context: 'interview' as const, alert: () => order.push('alert'),
      authorSpec: fakeAuthorSpec,
    }
    await runTurn(deps, input())
    expect(order).toEqual(['alert', 'stream'])
  })

  it('alerts on a friend\'s first words even though the opener spoke first', async () => {
    // THE REGRESSION, and the test that was missing.
    //
    // Every alert test in this file started from an EMPTY transcript, so
    // `started` and "a friend showed up" were indistinguishable — which is
    // precisely what stopped being true when the product learned to speak
    // first. The opener is a transcript row written at page render, so it
    // mints the conversation id; the friend then types inside the 30-minute
    // gap and conversationIdFor correctly reports no new conversation. The
    // phone stayed silent for the one event it exists for.
    //
    // Seeding the opener is the whole difference between this test and the
    // one above it.
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's',
      conversationId: 'c-opener',
      promptSha: 'abc123',
      role: 'assistant',
      body: 'Hey — I am here to build apps specifically tailored to you.',
      at: 900,
    })

    const { deps, calls } = alerted({ now: () => 1_000 })
    await runTurn(deps, input())
    expect(calls).toEqual([1])
  })

  it('does not alert twice when the friend keeps talking', async () => {
    // The other half: "first words" must mean first, not every turn. Without
    // this, the fix above would buzz a phone on every message.
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's',
      conversationId: 'c-opener',
      promptSha: 'abc123',
      role: 'assistant',
      body: 'opener',
      at: 900,
    })

    const { deps, calls } = alerted({ now: () => 1_000 })
    await runTurn(deps, input())
    await runTurn(deps, input({ body: 'and another thing' }))
    expect(calls).toEqual([1])
  })

  it('alerts when a friend comes back and speaks after the confirmation turn', async () => {
    // THE SAME BUG AS THE OPENER, ONE PRODUCT-INITIATED TURN LATER.
    //
    // `firstHumanWords` repaired exactly one instance of a general fault: a row
    // the PRODUCT wrote refreshes the 30-minute gap, so the friend's next words
    // are read as a continuation of a conversation they were not part of. The
    // opener was the instance that existed when that fix was written. The
    // confirmation acknowledgment is another, and it is not covered — this
    // account HAS spoken before, so firstHumanWords is false, and the
    // acknowledgment row is seconds old, so `started` is false too.
    //
    // The sequence is driven through runTurn rather than hand-seeded, so it is
    // runTurn's own behaviour being asserted: a conversation days ago, then a
    // product-initiated turn (runTurn's own body: null contract — see "does
    // not alert on the confirmation turn itself" below for what still calls
    // it, now that nothing in the app does), then the friend replying to what
    // the agent said.
    const DAY = 24 * 60 * 60 * 1000
    const monday = 1_000

    // Monday: a real exchange. This alerts, and that is not what is under test.
    await runTurn({ ...alerted().deps, now: () => monday }, input({ body: 'here is what I want' }))

    // Thursday: a product-initiated turn, called directly through runTurn —
    // body: null appends the agent's acknowledgment. Nothing in the app sends
    // this any more (the confirm button and route are gone); this test still
    // drives runTurn's own contract for one directly.
    const thursday = monday + 3 * DAY
    await runTurn({ ...alerted().deps, now: () => thursday }, input({ body: null }))

    // A minute later, they answer it. A person showed up, said something, and
    // has not been heard from in three days.
    const { deps, calls } = alerted({ now: () => thursday + 60_000 })
    await runTurn(deps, input({ body: 'looks great, one change' }))

    expect(calls).toEqual([1])
  })

  it('does not alert on the confirmation turn itself', async () => {
    // The other half, so the test above cannot be satisfied by alerting on
    // every product-initiated turn: nobody typed, so nobody showed up. (This
    // exercises runTurn's body: null path directly; nothing in the app sends
    // that trigger any more now that the confirm button and route are gone,
    // but runTurn's own contract for a product-initiated turn is still real
    // and still worth pinning.)
    const { deps, calls } = alerted({ now: () => 1_000 })
    const outcome = await runTurn(deps, input({ body: null }))
    expect(calls).toEqual([])
    // See the comment on "does not alert on a continuation of an existing
    // conversation" above: same vacuous-pass risk, same fix.
    expect(outcome.kind).toBe('completed')
    expect(metrics().map((m) => m.event)).toContain('chat_turn')
  })

  it('still alerts when the turn errors', async () => {
    // A friend who showed up and hit an outage is when the signal matters
    // most. Gating the alert on success would make an outage a silent phone
    // (design spec §3 D1).
    const { deps, calls } = alerted({
      client: failingClient(529, 'overloaded_error'),
    })
    const outcome = await runTurn(deps, input())
    expect(outcome.kind).toBe('error')
    expect(calls).toEqual([1])
  })

  it('still alerts when the reply is empty', async () => {
    // Same reasoning as the error case: a refusal or a truncated reply is a
    // friend who showed up and got nothing back.
    const { deps, calls } = alerted({ client: silentClient() })
    const outcome = await runTurn(deps, input())
    expect(outcome.kind).toBe('empty')
    expect(calls).toEqual([1])
  })
})

describe('the completion rule with propose_spec', () => {
  function toolClient(text: string, tools: string[]): ChatClient {
    return {
      async stream({ onText, onUsage, onServed }) {
        onUsage({ input: 100, cache_read: 0, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        if (text) onText(text)
        return {
          usage: USAGE,
          stop_reason: tools.length > 0 ? 'tool_use' : 'end_turn',
          served: SERVED,
          tools_called: tools,
        }
      },
      async propose() {
        throw new Error('unused')
      },
    }
  }

  const PROPOSAL = {
    id: 7,
    version: 1,
    at: 1_000_001,
    // The tagged union Proposal now carries, so a card streamed mid-turn and
    // a card rendered on page load have one shape. Legacy arm: that is what
    // lib/spec/author.ts still produces until the authoring switchover.
    spec: {
      kind: 'legacy' as const,
      payload: {
        title: 'T', summary: 's', background: 'b',
        panels: [{ name: 'n', shows: 's', why: 'w', source: 'plaid' as const }],
        manual_logging: [], open_questions: [],
      },
    },
    // mockup_html, preview_html and first are gone as of the mockup-loop
    // removal (plan 2026-08-19-remove-the-mockup-loop, Task 4) — this fixture
    // used to carry all three because it described a Proposal shape that no
    // longer exists. runTurn only ever passes a Proposal through unopened, so
    // nothing here depended on their VALUES, but keeping fields the real type
    // no longer has would describe a shape this fixture is not proving
    // anything about.
  }

  it('hands authoring a signal the request cannot abort', async () => {
    // THE REGRESSION THIS EXISTS FOR. Authoring used to receive input.signal,
    // so a laptop hopping wifi mid-preview (Chrome: ERR_NETWORK_CHANGED)
    // cancelled work that was already running and sometimes already billed.
    // 6 of 16 authoring attempts died that way. A dropped connection is now a
    // delay: authoring finishes and the row lands.
    const requestAborter = new AbortController()
    let authoringSignalWasAborted: boolean | undefined
    let sawSignal: AbortSignal | undefined

    const outcome = await runTurn(
      {
        db,
        client: toolClient('one moment', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async (i) => {
          // The connection dies partway through the authoring call.
          requestAborter.abort()
          sawSignal = i.signal
          authoringSignalWasAborted = i.signal.aborted
          return PROPOSAL
        },
      },
      input({ signal: requestAborter.signal }),
    )

    expect(authoringSignalWasAborted).toBe(false)
    expect(sawSignal).not.toBe(requestAborter.signal)
    // And the proposal really did come back, rather than being discarded.
    expect(outcome.kind).toBe('completed')
    expect(outcome.proposal).toEqual(PROPOSAL)
    expect(outcome.proposalFailed).toBeFalsy()
  })

  it('still cancels authoring when the AUTHORING signal is the one that aborts', async () => {
    // The abort path in lib/spec/author.ts is correct and stays reachable —
    // untying the two signals must not quietly make it dead code.
    const authoringAborter = new AbortController()
    authoringAborter.abort()
    let seenAborted: boolean | undefined

    await runTurn(
      {
        db,
        client: toolClient('one moment', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async (i) => {
          seenAborted = i.signal.aborted
          return undefined
        },
      },
      input({ authoringSignal: authoringAborter.signal }),
    )

    expect(seenAborted).toBe(true)
  })

  it('appends the assistant row AND proposes when both happened', async () => {
    let called = false
    const outcome = await runTurn(
      {
        db,
        client: toolClient('one moment', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => {
          called = true
          return PROPOSAL
        },
      },
      { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.kind).toBe('completed')
    expect(outcome.proposal).toEqual(PROPOSAL)
    expect(called).toBe(true)
    expect(readTranscript(db, 1).filter((r) => r.role === 'assistant')).toHaveLength(1)
  })

  it('proposes with NO assistant row when the tool call carried no text', async () => {
    // An empty body in an append-only table would 400 every later turn for
    // this account. That hazard does not soften because a tool was called.
    const outcome = await runTurn(
      {
        db,
        client: toolClient('', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => PROPOSAL,
      },
      { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.proposal).toEqual(PROPOSAL)
    expect(readTranscript(db, 1).filter((r) => r.role === 'assistant')).toHaveLength(0)
  })

  it('still records chat_empty_reply when there is neither text nor a tool', async () => {
    const outcome = await runTurn(
      {
        db,
        client: toolClient('', []),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => {
          throw new Error('must not be called')
        },
      },
      { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.kind).toBe('empty')
    expect(outcome.proposal).toBeUndefined()
  })

  it('still records the interview turn cost when it proposed without a usable reply', async () => {
    // A tool call with no text (or a tool-calling turn that got truncated)
    // writes no chat_turn and no chat_empty_reply — but real input and
    // thinking tokens were billed for the interview turn itself, separate
    // from whatever authorSpec bills for the authoring call. Those tokens
    // must not vanish from an append-only log just because the reply text
    // was empty.
    const outcome = await runTurn(
      {
        db,
        client: toolClient('', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => PROPOSAL,
      },
      { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
    )
    // No usable reply was delivered — `kind` reflects reply usability, not
    // proposal success, same as an ordinary text-less tool call.
    expect(outcome.kind).toBe('empty')

    const rows = metrics()
    expect(rows.map((r) => r.event)).toEqual(['chat_proposed_no_reply'])
    expect(rows[0]!.data).toMatchObject({
      // final.usage — the resolved USAGE constant toolClient() returns —
      // not the in-stream onUsage accumulator, same rule as chat_turn.
      input: USAGE.input,
      cache_read: USAGE.cache_read,
      cache_creation: USAGE.cache_creation,
      stop_reason: 'tool_use',
      delivered_chars: 0,
    })
  })

  it('uses a name distinct from both chat_turn and chat_empty_reply — three different facts', async () => {
    // A completed reply, a genuinely empty turn, and a text-less proposal
    // are three different facts about what happened. Grouping any two of
    // them under the same event name would make the metrics log unable to
    // tell them apart, permanently.
    await runTurn(
      { db, client: toolClient('', ['propose_spec']), now: () => 1_000, context: 'interview', alert: noAlert, authorSpec: async () => PROPOSAL },
      { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
    )
    const [event] = metrics().map((r) => r.event)
    // Positive first: an early-failing runTurn writes no metric row at all,
    // which would leave `event` undefined and satisfy both `.not.toBe` checks
    // below for free. Pinning the actual name (same value the sibling test
    // above checks with `.toEqual`) is what makes those checks mean anything.
    expect(event).toBe('chat_proposed_no_reply')
    expect(event).not.toBe('chat_turn')
    expect(event).not.toBe('chat_empty_reply')
  })

  it('still records the missing arm even when the reply text was truncated, not merely absent', async () => {
    // The other trigger the reviewer named: a tool-calling turn whose
    // stop_reason is not end_turn/tool_use (e.g. max_tokens) is `proposed
    // && !usable` even though text WAS delivered. Same missing-metric
    // hazard, different cause.
    const truncatedToolClient: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        onUsage({ input: 200, cache_read: 0, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText('one mom')
        return {
          usage: USAGE,
          stop_reason: 'max_tokens',
          served: SERVED,
          tools_called: ['propose_spec'],
        }
      },
      async propose() {
        throw new Error('unused')
      },
    }
    const outcome = await runTurn(
      { db, client: truncatedToolClient, now: () => 1_000, context: 'interview', alert: noAlert, authorSpec: async () => PROPOSAL },
      { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.kind).toBe('empty') // not usable: stop_reason is max_tokens
    expect(readTranscript(db, 1).filter((r) => r.role === 'assistant')).toHaveLength(0)

    const [row] = metrics()
    expect(row!.event).toBe('chat_proposed_no_reply')
    expect(row!.data).toMatchObject({ stop_reason: 'max_tokens', delivered_chars: 'one mom'.length })
  })

  describe('proposalFailed', () => {
    it('is true when the tool was called and authoring failed', async () => {
      const outcome = await runTurn(
        { db, client: toolClient('one moment', ['propose_spec']), now: () => 1_000, context: 'interview', alert: noAlert, authorSpec: async () => undefined },
        { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
      )
      expect(outcome.proposal).toBeUndefined()
      expect(outcome.proposalFailed).toBe(true)
    })

    it('is false (or absent) when authoring succeeded', async () => {
      const outcome = await runTurn(
        { db, client: toolClient('one moment', ['propose_spec']), now: () => 1_000, context: 'interview', alert: noAlert, authorSpec: async () => PROPOSAL },
        { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
      )
      expect(outcome.proposal).toEqual(PROPOSAL)
      expect(outcome.proposalFailed ?? false).toBe(false)
    })

    it('is false (or absent) on an ordinary turn that never called the tool', async () => {
      const outcome = await runTurn(
        { db, client: fakeClient(['ok']), now: () => 1_000, context: 'interview', alert: noAlert, authorSpec: fakeAuthorSpec },
        input(),
      )
      expect(outcome.kind).toBe('completed')
      expect(outcome.proposalFailed ?? false).toBe(false)
    })
  })

  describe('the belt-and-braces call-site guard', () => {
    // authorSpec's own contract (lib/spec/author.ts) is to never throw. This
    // guard exists for the case that contract does not hold — a bug in
    // authorSpec, or (as exercised here) a misbehaving dependency — so an
    // unanticipated throw still cannot kill a turn whose reply was already
    // delivered and appended to transcripts above.
    it('does not propagate when authorSpec throws, and still returns the delivered reply as completed', async () => {
      const outcome = await runTurn(
        {
          db,
          client: toolClient('one moment', ['propose_spec']),
          now: () => 1_000,
          context: 'interview',
          alert: noAlert,
          authorSpec: async () => {
            throw new Error('unexpectedly broken dependency')
          },
        },
        { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
      )
      expect(outcome.kind).toBe('completed')
      expect(outcome.proposal).toBeUndefined()
      expect(outcome.proposalFailed).toBe(true)
      // The reply text was real and must still be saved — a broken
      // authoring dependency must not retroactively erase a delivered turn.
      expect(readTranscript(db, 1).filter((r) => r.role === 'assistant')).toHaveLength(1)
    })

    it('does not propagate when authorSpec throws on the no-usable-text path either', async () => {
      const outcome = await runTurn(
        {
          db,
          client: toolClient('', ['propose_spec']),
          now: () => 1_000,
          context: 'interview',
          alert: noAlert,
          authorSpec: async () => {
            throw new Error('unexpectedly broken dependency')
          },
        },
        { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
      )
      expect(outcome.kind).toBe('empty')
      expect(outcome.proposal).toBeUndefined()
      expect(outcome.proposalFailed).toBe(true)
    })
  })

  // --- THE SEAM, not the unit. tests/chat/confirmations.test.ts proves the
  // note is built and placed correctly; nothing there proves runTurn actually
  // ASKS for it. That gap is the shape of the ChatPanel wiring gap recorded in
  // step-4 residual 1 — every piece correct, none of them connected — so it
  // gets a test that drives a whole turn and reads what the client received.
  describe('confirmations reaching the model', () => {
    /** Captures the request instead of asserting on a reply. */
    function capturingClient(seen: {
      system?: string
      messages?: { role: string; content: string }[]
    }): ChatClient {
      return {
        async stream({ system, messages, onText, onUsage, onServed }) {
          seen.system = system
          seen.messages = messages
          onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
          onServed({ model_served: CHAT_MODEL })
          onText('ok')
          return { usage: USAGE, stop_reason: 'end_turn', served: SERVED, tools_called: [] }
        },
        async propose() {
          throw new Error('unused')
        },
      }
    }

    // Nothing in the application writes spec_confirmations any more
    // (lib/db/specs.ts's confirmSpec is gone), but a friend who confirmed
    // something last month said a real thing, and the agent should still see
    // it — readConfirmations and the confirmation-note merge both survive.
    // Inserted directly, as tests/db/specs.test.ts's own fixtures now do.
    function confirmOne(at: number): void {
      const specId = insertSpec(db, {
        accountId: 1,
        conversationId: 'c1',
        promptSha: 'abc123',
        payload: { title: 'A dashboard' },
        mockupHtml: '<p>mock</p>',
        at,
      })
      db.prepare(
        'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
      ).run(specId, 1, at)
    }

    async function turn(seen: Parameters<typeof capturingClient>[0]) {
      await runTurn(
        { db, client: capturingClient(seen), now: () => 5_000, context: 'interview', alert: noAlert, authorSpec: fakeAuthorSpec },
        { accountId: 1, sessionId: 's', currentState: null, body: 'hi', signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
      )
    }

    it('tells the model a version was confirmed, and where', async () => {
      confirmOne(2_000)
      const seen: { system?: string; messages?: { role: string; content: string }[] } = {}
      await turn(seen)

      const last = seen.messages![seen.messages!.length - 1]!
      expect(last.role).toBe('system')
      expect(last.content).toContain('v1')
      // NEW, because no assistant row exists yet — the agent has not spoken
      // since the confirmation, so this is the turn it should respond on.
      expect(last.content).toContain('new since your last message')
    })

    it('says nothing at all when nothing has been confirmed', async () => {
      const seen: { system?: string; messages?: { role: string; content: string }[] } = {}
      await turn(seen)
      expect(seen.messages!.some((m) => m.role === 'system')).toBe(false)
    })

    it('tells the model it has already greeted this person', async () => {
      // THE OPENER-REPEATS BUG. The opener is the first transcript row and the
      // friend can see it — but toMessages drops a LEADING assistant row,
      // because the API rejects a conversation that starts with one. So the
      // model saw a history with no assistant turn, read "open with this,
      // verbatim", and greeted them a second time on their first reply.
      //
      // Keeping the row in the message list is the fix that looks obvious and
      // 400s every turn. The fact travels as system context instead.
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'c1',
        promptSha: 'abc123',
        role: 'assistant',
        body: 'Hey — I am here to build apps specifically tailored to you.',
        at: 500,
      })

      const seen: { system?: string; messages?: { role: string; content: string }[] } = {}
      await turn(seen)

      expect(seen.system).toContain('already been sent')
      // And the message list still starts with a user turn, which is the
      // constraint that made this necessary in the first place.
      expect(seen.messages![0]!.role).toBe('user')
    })

    it('says nothing about an opener to a friend who has not been greeted', async () => {
      const seen: { system?: string; messages?: { role: string; content: string }[] } = {}
      await turn(seen)
      expect(seen.system).not.toContain('already been sent')
    })

    it('runs a confirmation turn with no user row and no user message invented', async () => {
      // Pressing "Build this" used to record the decision and produce silence.
      // A confirmation turn has nobody typing, so no user row is written — and
      // the note becomes the trailing USER message, because a request ending on
      // an assistant turn is a prefill and the model rejects it.
      confirmOne(2_000)
      const seen: { system?: string; messages?: { role: string; content: string }[] } = {}
      await runTurn(
        { db, client: capturingClient(seen), now: () => 5_000, context: 'interview', alert: noAlert, authorSpec: fakeAuthorSpec },
        { accountId: 1, sessionId: 's', currentState: null, body: null, signal: new AbortController().signal, authoringSignal: new AbortController().signal, onText: () => {} },
      )

      const last = seen.messages![seen.messages!.length - 1]!
      expect(last.role).toBe('user')
      expect(last.content).toContain('v1')

      // Exactly one row written, and it is the reply — never a fabricated
      // "user" turn in a table that cannot be corrected.
      const rows = db
        .prepare('SELECT role FROM transcripts WHERE account_id = 1')
        .all() as { role: string }[]
      expect(rows.map((r) => r.role)).toEqual(['assistant'])
    })

    it('stops flagging it as new once the agent has spoken since', async () => {
      // THE FLIP, at the seam rather than in the unit. agent-v4 says "Respond
      // to it once" — if the note kept reading as fresh, the agent would be
      // invited to re-acknowledge a settled confirmation on every subsequent
      // turn, which is a different wrong behaviour from the one this whole
      // change set out to fix.
      confirmOne(2_000)
      appendTranscript(db, {
        accountId: 1,
        sessionId: 's',
        conversationId: 'c1',
        promptSha: 'abc123',
        role: 'assistant',
        body: 'Locked in — the build is on.',
        at: 3_000,
      })

      const seen: { system?: string; messages?: { role: string; content: string }[] } = {}
      await turn(seen)

      const last = seen.messages![seen.messages!.length - 1]!
      expect(last.role).toBe('system')
      expect(last.content).not.toContain('new since')
      expect(last.content).toContain('current confirmed version is v1')
    })

    it('records which channel carried the note', async () => {
      // The degraded path is otherwise invisible: chat keeps working and only
      // the agent's behaviour gets subtly worse. CHAT_MODEL defaults to a model
      // that supports the message channel, so this asserts the healthy value —
      // its job is to make a future swap show up as a changed metric.
      confirmOne(2_000)
      await turn({})
      const rows = metrics()
      expect(rows.some((m) => m.data.note_channel === 'messages')).toBe(true)
    })

    it('writes NO transcript row for the confirmation', async () => {
      // The whole point of merging at request time (onboarding ledger D5/D5a).
      // If this ever goes red, a permanent duplicate of a permanent fact is
      // being written into the sacred table and cannot be deleted.
      confirmOne(2_000)
      await turn({})
      const rows = db
        .prepare('SELECT role, body FROM transcripts WHERE account_id = 1')
        .all() as { role: string; body: string }[]
      expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user'])
      expect(rows.some((r) => r.body.includes('confirmed'))).toBe(false)
    })
  })
})

describe('current.md in the system prompt', () => {
  /** deps() built the same way every other test in this file builds it, just factored for this block. */
  function deps(over: { client?: ChatClient } = {}) {
    return {
      db,
      client: over.client ?? fakeClient(['ok']),
      now: () => 1_000,
      context: 'interview' as const,
      alert: noAlert,
      authorSpec: fakeAuthorSpec,
    }
  }

  /** Captures the system prompt the client actually received, same mechanism as capturingClient above. */
  function recordingClient(): ChatClient & { lastRequest?: { system: string } } {
    const client: ChatClient & { lastRequest?: { system: string } } = {
      async stream({ system, onText, onUsage, onServed }) {
        client.lastRequest = { system }
        onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText('ok')
        return { usage: USAGE, stop_reason: 'end_turn', served: SERVED, tools_called: [] }
      },
      async propose() {
        throw new Error('unused')
      },
    }
    return client
  }

  it('appends the dashboard description when one exists', async () => {
    const client = recordingClient()
    await runTurn(deps({ client }), input({ currentState: '## Panels\nA week chart.' }))
    expect(client.lastRequest!.system).toContain('A week chart.')
    expect(client.lastRequest!.system).toContain(CURRENT_STATE_BLOCK)
  })

  it('appends nothing at all when there is no dashboard yet', async () => {
    // The ordinary state of an account mid-interview. An empty labelled block
    // would tell the model there IS a dashboard and it is blank.
    const client = recordingClient()
    await runTurn(deps({ client }), input({ currentState: null }))
    expect(client.lastRequest!.system).not.toContain(CURRENT_STATE_BLOCK)
  })

  it('keeps the opener note when both apply', async () => {
    // Seeding the opener the same way the alerting tests above do, so
    // openerAlreadySent(rows) is really true rather than assumed.
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's',
      conversationId: 'c-opener',
      promptSha: 'abc123',
      role: 'assistant',
      body: 'Hey — I am here to build apps specifically tailored to you.',
      at: 900,
    })
    const client = recordingClient()
    await runTurn(
      deps({ client }),
      input({ currentState: '## Panels\nA week chart.' }),
    )
    expect(client.lastRequest!.system).toContain(OPENER_ALREADY_SENT)
    expect(client.lastRequest!.system).toContain('A week chart.')
  })
})
