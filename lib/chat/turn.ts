// lib/chat/turn.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import { conversationIdFor } from './conversation'
import { toMessages } from './history'
import { loadPrompt } from './prompt'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  ChatStreamError,
  UNKNOWN_ERROR,
  type ChatClient,
  type Served,
  type StreamResult,
  type Usage,
} from './client'

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

export type TurnOutcome = {
  kind: 'completed' | 'aborted' | 'error' | 'empty'
}

/**
 * One chat exchange, and the rule for what gets written.
 *
 * The user turn is appended immediately; the assistant turn is appended ONLY
 * when the stream completes server-side AND actually delivered a complete
 * reply. An aborted, failed, or empty exchange therefore leaves a user row
 * with no reply — which is what actually happened. transcripts is
 * append-only, so this rule cannot be corrected after the fact; see the design
 * spec section 3.4.
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
  // Seeded with what was requested, then overwritten by what the API reports.
  // A turn that fails before message_start records the request's own model,
  // which is the truth available at that point.
  let served: Served = { model_served: CHAT_MODEL, fallback_fired: false }
  const base = {
    model: CHAT_MODEL,
    effort: CHAT_EFFORT,
    prompt_sha: promptSha,
    context: CHAT_CONTEXT,
  }

  let final: StreamResult
  try {
    final = await client.stream({
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
      onServed: (partial) => {
        served = { ...served, ...partial }
      },
    })
  } catch (error) {
    // No assistant row on either branch. The two events are kept apart
    // because they are different facts: an abort stopped a working stream, an
    // error is the API call failing. Both carry the counters accumulated so
    // far — a 529 or a dropped connection after 400 tokens of output has
    // real, billed counters, and a cost log that reports zero for it is
    // fiction.
    //
    // This catch wraps ONLY the stream call. A DB write failing after a
    // successful stream must NOT land here — chat_error means the API call
    // failed, not that a write failed afterward. Letting a post-stream write
    // failure propagate instead of being reclassified is what keeps this
    // append-only, uncorrectable label honest.
    if (input.signal.aborted) {
      // `served` is the same in-stream accumulator as `usage`: on this path
      // there is no resolved StreamResult (the stream threw), so this is the
      // only place the answering model is available. If onServed already
      // reported before the abort — the stream had started delivering and a
      // fallback may have already fired — this carries the real values. If
      // nothing was reported yet, this carries the seeded default (the
      // requested model, no fallback), which is the honest value for "not
      // known" rather than a fabricated one.
      appendMetric(db, {
        accountId: input.accountId,
        event: 'stream_aborted',
        at: now(),
        data: { ...usage, ...base, ...served, delivered_chars: delivered.length },
      })
      return { kind: 'aborted' }
    }

    // `kind` is what distinguishes a rate limit from a refusal from a timeout
    // when the week-3 numbers get read (design spec section 2.5). It is
    // derived in client.ts by `instanceof` against the SDK's error classes,
    // because none of them assigns `name` — reading `error.name` here made
    // this field the constant "Error" for every failure the SDK can raise.
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_error',
      at: now(),
      data: {
        ...usage,
        ...base,
        ...served,
        ...(error instanceof ChatStreamError ? error.shape : UNKNOWN_ERROR),
        delivered_chars: delivered.length,
      },
    })
    return { kind: 'error' }
  }

  // A refusal is NOT an exception: it returns HTTP 200 with an empty content
  // array and stop_reason "refusal", so the stream resolves normally having
  // delivered nothing. Writing that as an assistant row would put an empty
  // body in an append-only table, and toMessages would then send
  // {role:'assistant', content:''} on every later turn — which the Messages
  // API rejects, breaking the account permanently. A max_tokens stop is the
  // same hazard from the other direction: truncated output is not a complete
  // reply and must not be recorded as one.
  if (delivered.trim() === '' || final.stop_reason !== 'end_turn') {
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_empty_reply',
      at: now(),
      data: {
        ...final.usage,
        ...base,
        ...final.served,
        stop_reason: final.stop_reason,
        delivered_chars: delivered.length,
      },
    })
    return { kind: 'empty' }
  }

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
    data: { ...final.usage, ...base, ...final.served },
  })
  return { kind: 'completed' }
}
