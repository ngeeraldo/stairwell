// lib/chat/turn.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import type { ChatContext } from './context'
import { conversationIdFor, personArrived } from './conversation'
import { toMessages } from './history'
import { applyConfirmationNote, confirmationNote } from './confirmations'
import { OPENER_ALREADY_SENT, openerAlreadySent } from './opening'
import { readConfirmations } from '@/lib/db/specs'
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
  /**
   * What the friend typed — or `null` for a turn the PRODUCT started rather
   * than the person.
   *
   * The only such turn today is a confirmation: pressing "Build this" used to
   * record the decision and say nothing, so the acknowledgment agent-v4
   * promises sat waiting for the friend's next message. It arrives immediately
   * now, which means a turn with no user message behind it. No user row is
   * written on that path — nobody typed anything, and `transcripts` cannot be
   * corrected later.
   */
  body: string | null
  /**
   * The HTTP request's signal. Governs the model STREAM and nothing after it:
   * a friend who closes the tab mid-reply gets no assistant row (see the
   * stream_aborted path), because a reply nobody received is not worth
   * persisting and the tokens are already spent either way.
   */
  signal: AbortSignal
  /**
   * The signal governing the AUTHORING call, deliberately separate from
   * `signal` above.
   *
   * These were one field until 2026-08-18, and that was the defect. A proposal
   * takes 47-97 seconds across two model calls, and 6 of 16 attempts died
   * because the browser's connection went away inside that window — Chrome
   * reporting ERR_NETWORK_CHANGED, i.e. the laptop's own wifi or VPN moving
   * under it. Every one of those aborts discarded work that was already
   * running and, on the worst of them, already billed, and handed the friend
   * nothing.
   *
   * A dropped connection is now a DELAY, not a loss: authoring runs to
   * completion, `specs` gets its row, and app/[user]/page.tsx serves the card
   * on the friend's next load. Nothing is lost that was paid for.
   *
   * Still a signal rather than nothing, because the abort path in
   * lib/spec/author.ts is correct and worth keeping for a caller that really
   * does want to cancel — a test, or a future scheduled context. The route
   * passes one that is never aborted.
   */
  authoringSignal: AbortSignal
  onText: (text: string) => void
  /**
   * Reports the crossing from writing the spec to drawing the preview, so the
   * panel can say which half of the wait a friend is in. See AuthorInput.
   */
  onStage?: (stage: 'mockup') => void
  /**
   * Fires once the assistant row and its chat_turn metric are COMMITTED, before
   * authoring starts.
   *
   * Exists so the panel can stop lying. `{done:true}` only arrives after the
   * whole turn including authoring, so a connection that dropped during the
   * preview looked identical to one that dropped before anything was written,
   * and the panel said "interrupted - not saved" about a reply that was sitting
   * in an append-only table. It said that in production on 2026-08-18 about
   * transcripts row 150.
   *
   * Deliberately fires only on the `usable` path, where an assistant row really
   * was appended. A turn that proposed without saying anything
   * (chat_proposed_no_reply) writes no assistant row, so nothing is claimed
   * saved.
   */
  onSaved?: () => void
}

export type TurnOutcome = {
  kind: 'completed' | 'aborted' | 'error' | 'empty'
  proposal?: Proposal
  /**
   * True when the tool was called but no proposal came back — a genuine
   * authoring failure (already recorded by authorSpec's own spec_error /
   * spec_aborted metric) or an unanticipated throw caught here as a last
   * resort. Absent or false whenever the tool was never called, or when it
   * was called and a proposal was returned. Task 10 uses this to emit a
   * proposal-failure line to the friend.
   */
  proposalFailed?: boolean
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

  // Read BEFORE the user row is appended, because one of the questions below
  // is "has this person ever said anything", and the answer changes one line
  // later.
  const priorRows = readTranscript(db, input.accountId)

  // Computed once, here. The assistant row reuses it rather than recomputing
  // the gap against a clock that has moved.
  const { id: conversationId } = conversationIdFor(db, input.accountId, at)

  // WHETHER A PERSON SHOWED UP is asked of the person's own rows — see
  // personArrived, which carries the full account of why this is no longer
  // the same question as "was a conversation_id minted".
  //
  // Twice now, a row the PRODUCT wrote has stood between a friend arriving and
  // the phone buzzing: the opener at page render, and the acknowledgment
  // written when they press "Build this". Both refreshed the gap that the mint
  // is measured against. Asking when the FRIEND last spoke is immune to both,
  // and to whatever the product learns to say next.
  const arrived = personArrived(priorRows, at)

  const stamp = {
    accountId: input.accountId,
    sessionId: input.sessionId,
    conversationId,
    promptSha,
  }

  // Only when a person actually said something. An agent-initiated turn has
  // no user message to record, and inventing one would put words in their
  // mouth in a table that rejects UPDATE and DELETE.
  if (input.body !== null) {
    appendTranscript(db, { ...stamp, role: 'user', body: input.body, at })
  }

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
  // Not for an agent-initiated turn: the alert means "a friend showed up",
  // and a confirmation already has its own alert on the confirm route.
  if (arrived && input.body !== null) {
    alert(input.accountId)
  }

  // THE CONFIRMATION MERGE. Everything above builds the model's context from
  // `transcripts` alone, which is why the agent could not see that anyone had
  // ever pressed "Build this" — that fact lives in `spec_confirmations`. Read
  // and merged here, written nowhere (onboarding ledger D5/D5a); the same
  // read-time merge lib/chat/timeline.ts performs for the screen.
  const rows = readTranscript(db, input.accountId)
  const lastAssistantAt =
    rows.filter((r) => r.role === 'assistant').pop()?.at ?? null

  // The opener is in the transcript and on the friend's screen, but never in
  // the message list — toMessages drops a leading assistant row because the
  // API will not accept one first. Told here instead, or the model greets the
  // same person twice. See lib/chat/opening.ts.
  const systemWithOpener = openerAlreadySent(rows)
    ? `${system}\n\n${OPENER_ALREADY_SENT}`
    : system

  const merged = applyConfirmationNote(
    toMessages(rows),
    systemWithOpener,
    confirmationNote(readConfirmations(db, input.accountId), lastAssistantAt),
    CHAT_MODEL,
    input.body === null,
  )
  const messages = merged.messages

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
    // Which channel carried the confirmation note. 'system_prompt' is the
    // degraded path — see lib/chat/confirmations.ts. A channel name, never a
    // version or a timestamp or any content.
    note_channel: merged.channel,
  }

  let final: StreamResult
  try {
    final = await client.stream({
      // merged.system, not `system`: on a model without mid-conversation
      // system messages the note rides here instead of in the message list.
      system: merged.system,
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
    // AFTER both writes, never before: this tells the browser the exchange is
    // durable, so it must not be sent while that is still a prediction.
    input.onSaved?.()
  } else if (proposed) {
    // proposed && !usable: the agent raised its hand without delivering a
    // usable reply — either it said nothing before calling the tool, or the
    // tool-calling turn itself was truncated (stop_reason neither end_turn
    // nor tool_use). No assistant row either way, same as chat_empty_reply —
    // an empty body would break every later turn for this account. But real
    // input and thinking tokens were billed for THIS interview turn,
    // separate from whatever authorSpec bills for the authoring call below,
    // and those tokens must not vanish from an append-only log just because
    // the reply text was empty. A distinct event name — not chat_turn, not
    // chat_empty_reply — because a completed reply, a genuinely empty turn,
    // and a text-less proposal are three different facts.
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_proposed_no_reply',
      at: now(),
      data: {
        ...final.usage,
        ...base,
        ...final.served,
        stop_reason: final.stop_reason,
        delivered_chars: delivered.length,
      },
    })
  }

  let proposal: Proposal | undefined
  if (proposed) {
    try {
      proposal = await authorSpec({
        accountId: input.accountId,
        conversationId,
        // NOT input.signal — see authoringSignal's docstring. Passing the
        // request's signal here is what made a wifi hop destroy a proposal.
        signal: input.authoringSignal,
        onStage: input.onStage,
      })
    } catch {
      // Defense in depth. authorSpec's own contract (lib/spec/author.ts) is
      // to never throw and to record its own failure metric on every path —
      // this catch exists only for the case that contract does not hold (a
      // bug, or a misbehaving dependency), so an unanticipated throw still
      // cannot kill a turn whose reply was already delivered and appended
      // above.
      proposal = undefined
    }
  }
  const proposalFailed = proposed && proposal === undefined

  return { kind: usable ? 'completed' : 'empty', proposal, proposalFailed }
}
