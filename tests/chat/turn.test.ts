// tests/chat/turn.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIError } from '@anthropic-ai/sdk'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import {
  CHAT_MODEL,
  ChatStreamError,
  describeError,
  type ChatClient,
  type StreamResult,
} from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

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
  signal: new AbortController().signal,
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
  it('appends no assistant row and logs chat_error, not stream_aborted', async () => {
    const deps = { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('error')
    expect(readTranscript(db, 1)).toHaveLength(1)
    const [m] = metrics()
    expect(m!.event).toBe('chat_error')
    expect(m!.data).toMatchObject({ context: 'interview' })
  })

  it('records a kind that is not the constant "Error", plus status and type', async () => {
    // The whole purpose of this field (design spec section 2.5): it is what
    // distinguishes a rate limit from a refusal from a timeout when the
    // week-3 numbers get read.
    const deps = { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000, context: 'interview' as const, alert: noAlert, authorSpec: fakeAuthorSpec}
    await runTurn(deps, input())

    const [m] = metrics()
    expect(m!.data.kind).not.toBe('Error')
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

    const kinds = metrics().map((m) => m.data.kind)
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

    const [m] = metrics()
    expect(m!.event).toBe('chat_error')
    expect(m!.data).toMatchObject({
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

    const [m] = metrics()
    expect(m!.data).toMatchObject({
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
    await runTurn(deps, input())
    expect(calls).toEqual([])
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
    mockup_html: '<!doctype html>',
  }

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
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
    )
    const [event] = metrics().map((r) => r.event)
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
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
        { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
      )
      expect(outcome.proposal).toBeUndefined()
      expect(outcome.proposalFailed).toBe(true)
    })

    it('is false (or absent) when authoring succeeded', async () => {
      const outcome = await runTurn(
        { db, client: toolClient('one moment', ['propose_spec']), now: () => 1_000, context: 'interview', alert: noAlert, authorSpec: async () => PROPOSAL },
        { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
        { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
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
        { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
      )
      expect(outcome.kind).toBe('empty')
      expect(outcome.proposal).toBeUndefined()
      expect(outcome.proposalFailed).toBe(true)
    })
  })
})
