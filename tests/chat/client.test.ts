// tests/chat/client.test.ts
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import {
  PROPOSE_TOOL,
  PROPOSE_TOOL_NAME,
  SDK_NONSTREAMING_MAX_TOKENS,
  SPEC_MAX_TOKENS,
  SPEC_TIMEOUT_MS,
  anthropicClient,
} from '@/lib/chat/client'

/**
 * The narrowest fake that satisfies anthropicClient's credential guard.
 *
 * `create` throws by default and every propose() fake below leaves it that
 * way. That is deliberate: propose() MUST use the streaming endpoint, because
 * a non-streaming call at SPEC_MAX_TOKENS is rejected by the real SDK before
 * it opens a socket (see the last test in this file). Faking `create` is what
 * hid that bug through an entire branch — the fake answered a call the real
 * SDK would have refused, so the suite was green while every live proposal
 * failed. Any regression to non-streaming now reddens instead.
 */
function fakeSdk(over: Record<string, unknown> = {}) {
  return {
    apiKey: 'sk-test-FAKE',
    authToken: null,
    beta: {
      messages: {
        create: async () => {
          throw new Error('propose() must stream — see fakeSdk in this file')
        },
        stream: () => ({ finalMessage: async () => ({}) }),
      },
    },
    ...over,
  }
}

/** An sdk whose authoring stream resolves to `message`. */
function streamingSdk(
  message: Record<string, unknown>,
  spy?: (body: Record<string, unknown>, opts: Record<string, unknown>) => void,
) {
  return fakeSdk({
    apiKey: 'sk-test-FAKE',
    authToken: null,
    beta: {
      messages: {
        create: async () => {
          throw new Error('propose() must stream — see fakeSdk in this file')
        },
        stream: (body: Record<string, unknown>, opts: Record<string, unknown>) => {
          spy?.(body, opts)
          return { finalMessage: async () => message }
        },
      },
    },
  })
}

/** An sdk whose authoring stream rejects with `error`. */
function failingSdk(error: unknown) {
  return fakeSdk({
    apiKey: 'sk-test-FAKE',
    authToken: null,
    beta: {
      messages: {
        create: async () => {
          throw new Error('propose() must stream — see fakeSdk in this file')
        },
        stream: () => ({
          finalMessage: async () => {
            throw error
          },
        }),
      },
    },
  })
}

const CALL = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

describe('propose()', () => {
  it('asks for structured output and returns the parsed object', async () => {
    let seen: Record<string, unknown> | undefined
    let options: Record<string, unknown> | undefined
    const sdk = streamingSdk(
      {
        content: [{ type: 'text', text: '{"title":"TEST"}' }],
        stop_reason: 'end_turn',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      (body, opts) => {
        seen = body
        options = opts
      },
    )

    const result = await anthropicClient(sdk as never).propose({
      ...CALL,
      system: 'author a spec',
      signal: new AbortController().signal,
    })

    expect(result.input).toEqual({ title: 'TEST' })
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input).toBe(10)

    expect(seen!.max_tokens).toBe(SPEC_MAX_TOKENS)
    expect(options!.timeout).toBe(SPEC_TIMEOUT_MS)
    expect((seen!.output_config as Record<string, unknown>).format).toBeDefined()
  })

  it('wraps an SDK failure as a ChatStreamError with a usable kind', async () => {
    await expect(
      anthropicClient(failingSdk(new Error('boom')) as never).propose({
        ...CALL,
        signal: new AbortController().signal,
      }),
      // The real discriminator must survive the catch, not be flattened to a
      // single label — the metrics log depends on telling a rate limit from
      // a refusal from a timeout, and `describeError` maps a bare Error to
      // 'unknown_error'.
    ).rejects.toMatchObject({ name: 'ChatStreamError', shape: { kind: 'unknown_error' } })
  })

  it('fails rather than returning junk when the reply is not JSON', async () => {
    // A non-JSON reply must surface as unparsable, not be written to an
    // append-only table as a spec. stop_reason is 'end_turn' so this
    // exercises the parse-failure branch specifically, not the truncation
    // check above it.
    const sdk = streamingSdk({
      content: [{ type: 'text', text: 'sorry, no' }],
      stop_reason: 'end_turn',
      model: 'claude-opus-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await expect(
      anthropicClient(sdk as never).propose({ ...CALL, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ name: 'ChatStreamError', shape: { kind: 'unparsable_spec' } })
  })

  it('carries the real usage and served model on an unparsable reply — the response was complete and billed', async () => {
    // The whole point of these two fields on ErrorShape: a reply that came
    // back complete and unparsable still cost real, billed tokens. A
    // spec_error row that reports zero for them would be fiction.
    const sdk = streamingSdk({
      content: [{ type: 'text', text: 'sorry, no' }],
      stop_reason: 'end_turn',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 7,
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({ ...CALL, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      shape: {
        kind: 'unparsable_spec',
        usage: { input: 123, output: 45, cache_read: 6, cache_creation: 7 },
        served: { model_served: 'claude-opus-4-8', fallback_fired: false },
      },
    })
  })

  it('fails on a truncated reply even when the truncated JSON happens to parse', async () => {
    // The gate cannot be "JSON.parse didn't throw": a max_tokens cutoff can
    // land on a syntactically complete object that is simply missing later
    // fields. stop_reason must be checked BEFORE attempting to parse, so
    // this is reported as truncated rather than silently accepted or
    // mis-reported as a parse failure.
    const sdk = streamingSdk({
      content: [{ type: 'text', text: '{"title":"TEST"}' }],
      stop_reason: 'max_tokens',
      model: 'claude-opus-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await expect(
      anthropicClient(sdk as never).propose({ ...CALL, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ name: 'ChatStreamError', shape: { kind: 'truncated_spec' } })
  })

  it('carries the real usage and served model on a truncated reply — max_tokens is the most expensive failure', async () => {
    const sdk = streamingSdk({
      content: [{ type: 'text', text: '{"title":"TEST"}' }],
      stop_reason: 'max_tokens',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 500,
        output_tokens: 32000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({ ...CALL, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      shape: {
        kind: 'truncated_spec',
        usage: { input: 500, output: 32000, cache_read: 0, cache_creation: 0 },
        served: { model_served: 'claude-opus-4-8', fallback_fired: false },
      },
    })
  })

  it('carries no usage on a pre-response failure — nothing was actually known', async () => {
    // The other half of the honesty rule: a failure with no response at all
    // (rate limit, connection, auth, ...) must NOT fabricate a usage or
    // served value. describeError never sets these fields, so this pins
    // that ChatStreamError does not invent them either.
    let caught: unknown
    try {
      await anthropicClient(failingSdk(new Error('boom')) as never).propose({
        ...CALL,
        signal: new AbortController().signal,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ shape: { kind: 'unknown_error' } })
    expect((caught as { shape: { usage?: unknown } }).shape.usage).toBeUndefined()
    expect((caught as { shape: { served?: unknown } }).shape.served).toBeUndefined()
  })

  it('streams, because the REAL SDK refuses a non-streaming call at SPEC_MAX_TOKENS', async () => {
    // The test the other seven structurally could not be. Every fake above
    // answers whatever propose() asks for, so none of them can notice that
    // the real SDK rejects this request shape outright. This drives the real
    // client and asserts the constraint we are designing around.
    //
    // No network: calculateNonstreamingTimeout throws inside the method body,
    // before any socket is opened, so this honours "chat tests never call the
    // live Anthropic API" — the key below is fake and is never sent anywhere.
    const real = new Anthropic({ apiKey: 'sk-ant-api03-FAKE-KEY-NEVER-SENT' })

    // SYNCHRONOUS, not a rejected promise: the guard runs in the method body
    // before the APIPromise is constructed. `.rejects` would not see it.
    expect(() =>
      real.beta.messages.create({
        model: 'claude-opus-5',
        max_tokens: SPEC_MAX_TOKENS,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toThrow(/Streaming is required/)

    // The boundary, pinned as a number rather than as a story. One token over
    // the ceiling throws; the ceiling itself is checked by arithmetic rather
    // than by a call, because a call at or under it proceeds to the network
    // and this suite never talks to the API.
    expect(SPEC_MAX_TOKENS).toBeGreaterThan(SDK_NONSTREAMING_MAX_TOKENS)
    expect(() =>
      real.beta.messages.create({
        model: 'claude-opus-5',
        max_tokens: SDK_NONSTREAMING_MAX_TOKENS + 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toThrow(/Streaming is required/)

    const tenMinutesMs = 600_000
    const impliedMs = (max: number) => (3_600_000 * max) / 128_000
    expect(impliedMs(SDK_NONSTREAMING_MAX_TOKENS)).toBeLessThanOrEqual(tenMinutesMs)
    expect(impliedMs(SDK_NONSTREAMING_MAX_TOKENS + 1)).toBeGreaterThan(tenMinutesMs)
  })
})

describe('PROPOSE_TOOL', () => {
  it('takes no arguments at all', () => {
    // The hand-raise carries no payload on purpose: that is what keeps a 5KB
    // mockup out of the same path that feeds the chat bubble.
    expect(PROPOSE_TOOL.name).toBe(PROPOSE_TOOL_NAME)
    expect(PROPOSE_TOOL.input_schema.properties).toEqual({})
    expect(PROPOSE_TOOL.input_schema.required).toEqual([])
  })
})
