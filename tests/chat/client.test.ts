// tests/chat/client.test.ts
import { describe, expect, it } from 'vitest'
import {
  PROPOSE_TOOL,
  PROPOSE_TOOL_NAME,
  SPEC_MAX_TOKENS,
  SPEC_TIMEOUT_MS,
  anthropicClient,
} from '@/lib/chat/client'

/** The narrowest fake that satisfies anthropicClient's credential guard. */
function fakeSdk(over: Record<string, unknown> = {}) {
  return {
    apiKey: 'sk-test-FAKE',
    authToken: null,
    beta: { messages: { create: async () => ({}), stream: () => ({}) } },
    ...over,
  }
}

describe('propose()', () => {
  it('asks for structured output and returns the parsed object', async () => {
    let seen: Record<string, unknown> | undefined
    let options: Record<string, unknown> | undefined
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async (body: Record<string, unknown>, opts: Record<string, unknown>) => {
            seen = body
            options = opts
            return {
              content: [{ type: 'text', text: '{"title":"TEST"}' }],
              stop_reason: 'end_turn',
              model: 'claude-opus-5',
              usage: { input_tokens: 10, output_tokens: 4 },
            }
          },
          stream: () => ({}),
        },
      },
    })

    const result = await anthropicClient(sdk as never).propose({
      system: 'author a spec',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    })

    expect(result.input).toEqual({ title: 'TEST' })
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input).toBe(10)

    // The bounded-wait guarantee. Without both of these a wedged authoring
    // call holds a friend on "putting together a preview" for the better
    // part of an hour, because the SDK scales its own timeout UP for large
    // non-streaming max_tokens.
    expect(seen!.max_tokens).toBe(SPEC_MAX_TOKENS)
    expect(options!.timeout).toBe(SPEC_TIMEOUT_MS)
    expect((seen!.output_config as Record<string, unknown>).format).toBeDefined()
  })

  it('wraps an SDK failure as a ChatStreamError with a usable kind', async () => {
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async () => {
            throw new Error('boom')
          },
          stream: () => ({}),
        },
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
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
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async () => ({
            content: [{ type: 'text', text: 'sorry, no' }],
            stop_reason: 'end_turn',
            model: 'claude-opus-5',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          stream: () => ({}),
        },
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'ChatStreamError', shape: { kind: 'unparsable_spec' } })
  })

  it('fails on a truncated reply even when the truncated JSON happens to parse', async () => {
    // The gate cannot be "JSON.parse didn't throw": a max_tokens cutoff can
    // land on a syntactically complete object that is simply missing later
    // fields. stop_reason must be checked BEFORE attempting to parse, so
    // this is reported as truncated rather than silently accepted or
    // mis-reported as a parse failure.
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async () => ({
            content: [{ type: 'text', text: '{"title":"TEST"}' }],
            stop_reason: 'max_tokens',
            model: 'claude-opus-5',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          stream: () => ({}),
        },
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'ChatStreamError', shape: { kind: 'truncated_spec' } })
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
