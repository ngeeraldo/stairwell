// lib/chat/turn.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import type { ChatContext } from './context'
import { conversationIdFor } from './conversation'
import { toMessages } from './history'
import { loadPrompt } from './prompt'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  ChatStreamError,
  PROPOSE_TOOL_NAME,
  UNKNOWN_ERROR,
  type ChatClient,
  type Served,
  type StreamResult,
  type Usage,
} from './client'
import type { AuthorInput, Proposal } from '@/lib/spec/author'

export type TurnDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  /**
   * Resolved by the caller and passed in, not computed here: turn.ts takes
   * its collaborators as parameters so the suite can drive every path, and
   * this is one of them.
   */
  context: ChatContext
  /**
   * Fired when this turn STARTS a conversation. Declared as returning void
   * on purpose: the real implementation is async and fire-and-forget
   * (lib/alerts/ntfy.ts), and this type is what stops a future edit from
   * awaiting it and putting a push notification on the critical path of a
   * friend's chat turn.
   */
  alert: (accountId: number) => void
  /**
   * Injected so the suite can drive the completion rule without a second
   * fake client — the same reason `client` is a parameter.
   */
  authorSpec: (input: AuthorInput) => Promise<Proposal | undefined>
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
  proposal?: Proposal
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
  const { db, client, now, context, alert, authorSpec } = deps
  const at = now()
  const { text: system, sha: promptSha } = loadPrompt()

  // Computed once, here. The assistant row reuses it rather than recomputing
  // the gap against a clock that has moved.
  const { id: conversationId, started } = conversationIdFor(
    db,
    input.accountId,
    at,
  )

  const stamp = {
    accountId: input.accountId,
    sessionId: input.sessionId,
    conversationId,
    promptSha,
  }

  appendTranscript(db, { ...stamp, role: 'user', body: input.body, at })

  // AFTER the write, because the alert asserts a conversation started and an
  // insert that threw means none did. BEFORE the stream, because the model's
  // latency is not something a phone should wait on — and because a turn that
  // errors still means a friend showed up, which is when the signal is worth
  // the most.
  //
  // Deliberately not wrapped in a try: the alerter owns its own safety and
  // provably neither throws nor rejects. A try here would instead swallow a
  // wiring mistake — an alert that never fires would look exactly like an
  // alert that fired.
  if (started) alert(input.accountId)

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
    context,
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

  // THE COMPLETION RULE, restated in full because transcripts is append-only
  // and this cannot be corrected later (design spec section 4.3).
  //
  // Step 2's rule — anything other than end_turn is chat_empty_reply — was
  // correct only in a world with no tools. A propose_spec call stops with
  // 'tool_use' and lands squarely on it.
  //
  // Text and proposal are evaluated INDEPENDENTLY. A turn that calls the tool
  // without saying anything first still proposes, and still writes no
  // assistant row: an empty body in an append-only table breaks every later
  // turn for that account, and that hazard does not soften because a tool was
  // also called.
  const proposed = final.tools_called.includes(PROPOSE_TOOL_NAME)
  const usable =
    delivered.trim() !== '' &&
    (final.stop_reason === 'end_turn' || final.stop_reason === 'tool_use')

  if (!usable && !proposed) {
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

  if (usable) {
    appendTranscript(db, { ...stamp, role: 'assistant', body: delivered, at: now() })
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_turn',
      at: now(),
      data: { ...final.usage, ...base, ...final.served },
    })
  }

  const proposal = proposed
    ? await authorSpec({
        accountId: input.accountId,
        conversationId,
        signal: input.signal,
      })
    : undefined

  return { kind: usable ? 'completed' : 'empty', proposal }
}
