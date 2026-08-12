import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk'
import type { ChatMessage } from './history'
import { SPEC_JSON_SCHEMA } from '@/lib/spec/schema'

export type Usage = {
  input: number
  output: number
  cache_read: number
  cache_creation: number
}

/**
 * What the request actually got, as opposed to what it asked for.
 *
 * Server-side refusal fallbacks mean the answering model can differ from
 * CHAT_MODEL. Cost and behaviour analysis reads the metrics log as ground
 * truth, so a fallback that silently changed the answering model would
 * corrupt exactly the retrospective the four counters exist to support.
 */
export type Served = {
  /** The model that produced the message, from the response's own `model`. */
  model_served: string
  /** True when at least one fallback hop fired on this turn. */
  fallback_fired: boolean
}

export type StreamResult = {
  usage: Usage
  /**
   * The resolved message's stop reason. Anything other than `end_turn` means
   * the reply is not a complete answer — a refusal returns HTTP 200 with an
   * empty content array, and `max_tokens` returns a truncated one.
   */
  stop_reason: string | null
  served: Served
  /** Names of the tools the resolved message asked to call. */
  tools_called: string[]
}

export type ProposeResult = {
  /** The parsed object, still unvalidated. lib/spec/schema.ts validates it. */
  input: unknown
  usage: Usage
  stop_reason: string | null
  served: Served
}

export type ChatClient = {
  stream(args: {
    system: string
    messages: ChatMessage[]
    signal: AbortSignal
    onText: (text: string) => void
    onUsage: (usage: Partial<Usage>) => void
    /**
     * Reported during the stream, not only at the end, for the same reason
     * onUsage is: a turn that errors after first output still has a real
     * answering model to record.
     */
    onServed: (served: Partial<Served>) => void
  }): Promise<StreamResult>
  propose(args: {
    system: string
    messages: ChatMessage[]
    signal: AbortSignal
  }): Promise<ProposeResult>
}

/** Configuration, not architecture — and stamped into every metrics row. */
export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-opus-5'
export const CHAT_EFFORT = 'medium' as const
/**
 * A ceiling, not a spend commitment.
 *
 * The earlier 8192 was justified as "far above any conversational turn". That
 * reasoning predates thinking being on by default on this model, and
 * max_tokens caps thinking PLUS visible text together — so a turn that thinks
 * hard could exhaust the budget before producing any text at all, and be
 * recorded as a reply. The request streams, so a high ceiling costs nothing
 * that is not actually generated.
 */
export const MAX_TOKENS = 64000

/** The hand-raise. No payload — see PROPOSE_TOOL below. */
export const PROPOSE_TOOL_NAME = 'propose_spec'

/**
 * A tool with an EMPTY input schema.
 *
 * The agent is not delivering a spec here, it is asking for one to be
 * written. Carrying no payload is what keeps stream() from having to
 * accumulate a 5KB mockup out of input_json_delta events alongside the text
 * it is already pushing to a friend's screen.
 */
export const PROPOSE_TOOL = {
  name: PROPOSE_TOOL_NAME,
  description:
    'Signal that the interview has enough to describe a dashboard. Takes no ' +
    'arguments. Calling this ends your turn; a preview is written and shown ' +
    'to the person as a card they can accept or push back on.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
}

/**
 * NOT MAX_TOKENS, and this difference is load-bearing.
 *
 * stream() runs at 64000 because streaming makes a high ceiling free. The
 * authoring call does not stream, and the SDK scales its own timeout UP for
 * large non-streaming max_tokens — so reusing 64000 here could hold a friend
 * on "putting together a preview" for the better part of an hour. This
 * ceiling is still far above a spec plus a mockup plus adaptive thinking.
 */
export const SPEC_MAX_TOKENS = 32000

/** What actually bounds the wait. A timeout is a visible failure; a hang is not. */
export const SPEC_TIMEOUT_MS = 180_000

/**
 * Server-side refusal fallbacks: a declined request is re-run on another model
 * inside the same call, so the friend gets an answer instead of an interrupted
 * marker. The scalar `"default"` form routes by refusal category rather than
 * pinning a model list, and is gated by this beta flag on the beta messages
 * endpoint. (The older array form takes a DIFFERENT flag,
 * `server-side-fallback-2026-06-01`; pairing either flag with the other form
 * is a 400.)
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const

/**
 * A stream failure, normalized away from the SDK's class hierarchy.
 *
 * lib/chat/turn.ts deliberately does not import the Anthropic SDK, so the
 * mapping from SDK error class to a stable discriminator happens here and
 * crosses the boundary as plain data.
 */
export type ErrorShape = {
  /**
   * A stable discriminator derived by `instanceof`, NOT from `.name`: no class
   * in the SDK's hierarchy assigns `name`, so every one of them inherits
   * `Error.prototype.name === "Error"`. Not from `constructor.name` either —
   * that is minifier-fragile in a Next production build.
   */
  kind: string
  /** HTTP status where the SDK exposes one; null for connection failures. */
  status: number | null
  /** The API's own `error.type` discriminator, where the response carried one. */
  type: string | null
}

export const UNKNOWN_ERROR: ErrorShape = {
  kind: 'unknown',
  status: null,
  type: null,
}

export class ChatStreamError extends Error {
  readonly shape: ErrorShape

  constructor(shape: ErrorShape, message: string) {
    super(message)
    this.name = 'ChatStreamError'
    this.shape = shape
  }
}

/** Thrown at client construction so a total outage never reaches the stream. */
export class MissingCredentialError extends Error {
  constructor() {
    super('No Anthropic credential resolved (ANTHROPIC_API_KEY is unset).')
    this.name = 'MissingCredentialError'
  }
}

/**
 * Ordered most-specific-first, because the hierarchy nests:
 * APIConnectionTimeoutError extends APIConnectionError extends APIError, and
 * every status class extends APIError.
 */
function kindOf(error: unknown): string {
  if (error instanceof APIUserAbortError) return 'aborted'
  if (error instanceof APIConnectionTimeoutError) return 'connection_timeout'
  if (error instanceof APIConnectionError) return 'connection'
  if (error instanceof BadRequestError) return 'bad_request'
  if (error instanceof AuthenticationError) return 'authentication'
  if (error instanceof PermissionDeniedError) return 'permission_denied'
  if (error instanceof NotFoundError) return 'not_found'
  if (error instanceof ConflictError) return 'conflict'
  if (error instanceof UnprocessableEntityError) return 'unprocessable_entity'
  if (error instanceof RateLimitError) return 'rate_limit'
  if (error instanceof InternalServerError) return 'internal_server'
  if (error instanceof APIError) return 'api_error'
  if (error instanceof AnthropicError) return 'sdk_error'
  if (error instanceof Error) return 'unknown_error'
  return 'unknown'
}

export function describeError(error: unknown): ErrorShape {
  return {
    kind: kindOf(error),
    status:
      error instanceof APIError && typeof error.status === 'number'
        ? error.status
        : null,
    type: error instanceof APIError ? (error.type ?? null) : null,
  }
}

/**
 * The Anthropic SDK behind the narrow interface above.
 *
 * Adaptive thinking is left at the model default rather than disabled: on this
 * model disabling it risks internal tags leaking into visible output, and the
 * reply goes straight to a friend.
 */
export function anthropicClient(sdk: Anthropic = new Anthropic()): ChatClient {
  // Verified against @anthropic-ai/sdk 0.116.0: the constructor does NOT throw
  // when no credential resolves — it builds a client with `apiKey: null` and
  // the first request goes out unauthenticated, failing 401 mid-stream after
  // the user's transcript row is already written. Checking here turns a total
  // outage into a 503 before anything is persisted.
  if (sdk.apiKey == null && sdk.authToken == null) {
    throw new MissingCredentialError()
  }

  return {
    async stream({ system, messages, signal, onText, onUsage, onServed }) {
      try {
        const stream = sdk.beta.messages.stream(
          {
            model: CHAT_MODEL,
            max_tokens: MAX_TOKENS,
            output_config: { effort: CHAT_EFFORT },
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            system: [
              {
                type: 'text',
                text: system,
                // The page-length prompt is resent on every turn. This is why
                // the metrics rows carry cache counters as well as input/output.
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages,
            tools: [PROPOSE_TOOL],
          },
          { signal },
        )

        // Usage arrives in two places: input and cache counts at message_start,
        // cumulative output at each message_delta. Reported as they arrive so an
        // aborted turn can still record real numbers instead of zeros.
        stream.on('streamEvent', (event) => {
          if (event.type === 'message_start') {
            const u = event.message.usage
            onUsage({
              input: u.input_tokens,
              cache_read: u.cache_read_input_tokens ?? 0,
              cache_creation: u.cache_creation_input_tokens ?? 0,
            })
            onServed({ model_served: event.message.model })
          } else if (event.type === 'message_delta') {
            onUsage({ output: event.usage.output_tokens })
          } else if (
            event.type === 'content_block_start' &&
            event.content_block.type === 'fallback'
          ) {
            // On a streaming request each switch point arrives as a `fallback`
            // content block; sticky routing is not consulted on streams, so
            // this and usage.iterations agree.
            onServed({ fallback_fired: true })
          }
        })
        stream.on('text', onText)

        const final = await stream.finalMessage()
        const served: Served = {
          model_served: final.model,
          fallback_fired:
            (final.usage.iterations ?? []).some(
              (entry) => entry.type === 'fallback_message',
            ) || final.content.some((block) => block.type === 'fallback'),
        }
        onServed(served)

        return {
          usage: {
            input: final.usage.input_tokens,
            output: final.usage.output_tokens,
            cache_read: final.usage.cache_read_input_tokens ?? 0,
            cache_creation: final.usage.cache_creation_input_tokens ?? 0,
          },
          stop_reason: final.stop_reason,
          served,
          tools_called: final.content
            .filter((block) => block.type === 'tool_use')
            .map((block) => (block as { name: string }).name),
        }
      } catch (error) {
        // Normalized here, where SDK knowledge already lives, so turn.ts never
        // has to know the SDK's class hierarchy to label a failure.
        throw new ChatStreamError(
          describeError(error),
          error instanceof Error ? error.message : String(error),
        )
      }
    },

    async propose({ system, messages, signal }) {
      try {
        const message = await sdk.beta.messages.create(
          {
            model: CHAT_MODEL,
            max_tokens: SPEC_MAX_TOKENS,
            output_config: {
              effort: CHAT_EFFORT,
              // Structured outputs rather than a forced tool: it constrains
              // the RESPONSE, so there is no tool_use block to extract and no
              // tool/thinking interaction to reason about. Same guarantee,
              // fewer moving parts (design spec section 4.1).
              format: { type: 'json_schema', schema: SPEC_JSON_SCHEMA },
            },
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            // Deliberately no cache_control on this system block: the
            // authoring prompt runs once per proposal, so a cache write
            // premium buys nothing.
            system: [{ type: 'text', text: system }],
            messages,
          },
          { signal, timeout: SPEC_TIMEOUT_MS },
        )

        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join('')

        let input: unknown
        try {
          input = JSON.parse(text)
        } catch {
          // A truncated or refused reply is NOT a spec. Failing here is what
          // keeps junk out of an append-only table.
          throw new ChatStreamError(
            { kind: 'unparsable_spec', status: null, type: null },
            `authoring call returned unparsable output (stop_reason ${message.stop_reason})`,
          )
        }

        return {
          input,
          usage: {
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
            cache_read: message.usage.cache_read_input_tokens ?? 0,
            cache_creation: message.usage.cache_creation_input_tokens ?? 0,
          },
          stop_reason: message.stop_reason,
          served: {
            model_served: message.model,
            fallback_fired:
              (message.usage.iterations ?? []).some(
                (entry) => entry.type === 'fallback_message',
              ) || message.content.some((block) => block.type === 'fallback'),
          },
        }
      } catch (error) {
        if (error instanceof ChatStreamError) throw error
        throw new ChatStreamError(
          describeError(error),
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  }
}
