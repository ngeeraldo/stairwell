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
      return { usage: USAGE, stop_reason: 'end_turn', served: SERVED }
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
        ...result,
      }
    },
  }
}

/** A client that streams one chunk, then the caller aborts. */
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
      return { usage: USAGE, stop_reason: 'end_turn', served: SERVED }
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
    const deps = { db, client: fakeClient(['Keep an ', 'eye on rent.']), now: () => 1_000 }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('completed')
    const rows = readTranscript(db, 1)
    expect(rows.map((r) => [r.role, r.body])).toEqual([
      ['user', 'what should I watch?'],
      ['assistant', 'Keep an eye on rent.'],
    ])
  })

  it('stamps both rows with the same conversation_id and the prompt sha', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000 }
    await runTurn(deps, input())

    const rows = readTranscript(db, 1)
    expect(rows[0]!.conversation_id).toBe(rows[1]!.conversation_id)
    expect(rows[0]!.session_id).toBe('sess-1')
    expect(rows[0]!.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
    expect(rows[1]!.prompt_sha).toBe(rows[0]!.prompt_sha)
  })

  it('logs one chat_turn metric carrying all four counters', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000 }
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
    const deps = { db, client: fakeClient(['a', 'b']), now: () => 1_000 }
    await runTurn(deps, input({ onText: (t: string) => seen.push(t) }))
    expect(seen).toEqual(['a', 'b'])
  })

  it('records the resolved usage on completion, not the in-stream accumulator', async () => {
    const deps = { db, client: divergingUsageClient(), now: () => 1_000 }
    await runTurn(deps, input())

    const [m] = metrics()
    expect(m!.event).toBe('chat_turn')
    expect(m!.data.output).toBe(7)
  })

  it('starts a new conversation after the gap and keeps one inside it', async () => {
    const client = fakeClient(['ok'])
    await runTurn({ db, client, now: () => 0 }, input())
    await runTurn({ db, client, now: () => 60_000 }, input())
    await runTurn({ db, client, now: () => 60_000 + 31 * 60 * 1000 }, input())

    const ids = readTranscript(db, 1).map((r) => r.conversation_id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(ids[3]) // first exchange and second exchange
    expect(ids[4]).not.toBe(ids[0]) // third, past the gap
  })
})

describe('runTurn — abort', () => {
  it('appends NO assistant row', async () => {
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000 }
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
    const deps = { db, client: abortingClient(controller), now: () => 1_000 }
    await runTurn(deps, input({ signal: controller.signal }))

    const [m] = metrics()
    expect(m!.event).toBe('stream_aborted')
    expect(m!.data).toMatchObject({ input: 100, output: 3, context: 'interview' })
    expect(m!.data.delivered_chars).toBe('half a rep'.length)
  })
})

describe('runTurn — API error', () => {
  it('appends no assistant row and logs chat_error, not stream_aborted', async () => {
    const deps = { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000 }
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
    const deps = { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000 }
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
      { db, client: failingClient(429, 'rate_limit_error'), now: () => 1_000 },
      input(),
    )
    await runTurn(
      { db, client: failingClient(529, 'overloaded_error'), now: () => 2_000 },
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
    const deps = { db, client: silentClient(), now: () => 1_000 }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).not.toBe('completed')
    const rows = readTranscript(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('user')
  })

  it('logs chat_empty_reply carrying the stop reason and all four counters', async () => {
    const deps = { db, client: silentClient(), now: () => 1_000 }
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
        return { usage: USAGE, stop_reason: 'end_turn', served: SERVED }
      },
    }

    const outcome = await runTurn({ db, client, now: () => 1_000 }, input())

    expect(outcome.kind).toBe('completed')
    expect(sent.every((m) => m.content.trim() !== '')).toBe(true)
    expect(sent).toEqual([
      { role: 'user', content: 'an earlier question' },
      { role: 'user', content: 'what should I watch?' },
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
        }
      },
    }

    await runTurn({ db, client, now: () => 1_000 }, input())

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
    }

    await runTurn({ db, client, now: () => 1_000 }, input())

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
    }

    await runTurn({ db, client, now: () => 1_000 }, input())

    const [m] = metrics()
    expect(m!.data).toMatchObject({
      model_served: CHAT_MODEL,
      fallback_fired: false,
    })
  })
})
