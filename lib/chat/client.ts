import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage } from './history'

export type Usage = {
  input: number
  output: number
  cache_read: number
  cache_creation: number
}

export type ChatClient = {
  stream(args: {
    system: string
    messages: ChatMessage[]
    signal: AbortSignal
    onText: (text: string) => void
    onUsage: (usage: Partial<Usage>) => void
  }): Promise<Usage>
}

/** Configuration, not architecture — and stamped into every metrics row. */
export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-opus-5'
export const CHAT_EFFORT = 'medium' as const
/**
 * Far above any conversational turn, so this bounds a runaway without risking
 * a truncated reply.
 */
export const MAX_TOKENS = 8192

/**
 * The Anthropic SDK behind the narrow interface above.
 *
 * Adaptive thinking is left at the model default rather than disabled: on this
 * model disabling it risks internal tags leaking into visible output, and the
 * reply goes straight to a friend.
 */
export function anthropicClient(sdk: Anthropic = new Anthropic()): ChatClient {
  return {
    async stream({ system, messages, signal, onText, onUsage }) {
      const stream = sdk.messages.stream(
        {
          model: CHAT_MODEL,
          max_tokens: MAX_TOKENS,
          output_config: { effort: CHAT_EFFORT },
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
        } else if (event.type === 'message_delta') {
          onUsage({ output: event.usage.output_tokens })
        }
      })
      stream.on('text', onText)

      const final = await stream.finalMessage()
      return {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cache_read: final.usage.cache_read_input_tokens ?? 0,
        cache_creation: final.usage.cache_creation_input_tokens ?? 0,
      }
    },
  }
}
