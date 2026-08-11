// lib/chat/turn.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import { conversationIdFor } from './conversation'
import { toMessages } from './history'
import { loadPrompt } from './prompt'
import { CHAT_EFFORT, CHAT_MODEL, type ChatClient, type Usage } from './client'

/**
 * The run kind recorded on every metrics row (architecture-overview.md line
 * 136: "interview, planning, tweak runs"). No spec exists until step 4, so
 * every turn in step 2 is an interview turn.
 */
export const CHAT_CONTEXT = 'interview' as const

export type TurnDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
}

export type TurnInput = {
  accountId: number
  sessionId: string
  body: string
  signal: AbortSignal
  onText: (text: string) => void
}

export type TurnOutcome = { kind: 'completed' | 'aborted' | 'error' }

/**
 * One chat exchange, and the rule for what gets written.
 *
 * The user turn is appended immediately; the assistant turn is appended ONLY
 * when the stream completes server-side. An aborted or failed exchange
 * therefore leaves a user row with no reply — which is what actually happened.
 * transcripts is append-only, so this rule cannot be corrected after the fact;
 * see the design spec section 3.4.
 */
export async function runTurn(
  deps: TurnDeps,
  input: TurnInput,
): Promise<TurnOutcome> {
  const { db, client, now } = deps
  const at = now()
  const { text: system, sha: promptSha } = loadPrompt()

  // Computed once, here. The assistant row reuses it rather than recomputing
  // the gap against a clock that has moved.
  const conversationId = conversationIdFor(db, input.accountId, at)

  const stamp = {
    accountId: input.accountId,
    sessionId: input.sessionId,
    conversationId,
    promptSha,
  }

  appendTranscript(db, { ...stamp, role: 'user', body: input.body, at })

  const messages = toMessages(readTranscript(db, input.accountId))

  let delivered = ''
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  const base = {
    model: CHAT_MODEL,
    effort: CHAT_EFFORT,
    prompt_sha: promptSha,
    context: CHAT_CONTEXT,
  }

  try {
    const final = await client.stream({
      system,
      messages,
      signal: input.signal,
      onText: (text) => {
        delivered += text
        input.onText(text)
      },
      onUsage: (partial) => {
        usage = { ...usage, ...partial }
      },
    })

    appendTranscript(db, {
      ...stamp,
      role: 'assistant',
      body: delivered,
      at: now(),
    })
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_turn',
      at: now(),
      data: { ...final, ...base },
    })
    return { kind: 'completed' }
  } catch (error) {
    // No assistant row on either branch. The two events are kept apart because
    // they are different facts: an abort has real token counts to record, an
    // error before first output has none.
    if (input.signal.aborted) {
      appendMetric(db, {
        accountId: input.accountId,
        event: 'stream_aborted',
        at: now(),
        data: { ...usage, ...base, delivered_chars: delivered.length },
      })
      return { kind: 'aborted' }
    }

    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_error',
      at: now(),
      data: {
        ...base,
        kind: error instanceof Error ? error.name : 'unknown',
        delivered_chars: delivered.length,
      },
    })
    return { kind: 'error' }
  }
}
