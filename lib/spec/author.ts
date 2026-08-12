// lib/spec/author.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { insertSpec, readSpecs } from '@/lib/db/specs'
import { toMessages } from '@/lib/chat/history'
import { SPEC_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import type { ChatContext } from '@/lib/chat/context'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  ChatStreamError,
  UNKNOWN_ERROR,
  type ChatClient,
  type Served,
  type Usage,
} from '@/lib/chat/client'
import { parseSpecInput, type SpecPayload } from './schema'

export type Proposal = {
  id: number
  version: number
  payload: SpecPayload
  mockup_html: string
}

export type AuthorDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  context: ChatContext
}

export type AuthorInput = {
  accountId: number
  conversationId: string
  signal: AbortSignal
}

/** Honest defaults for a call that failed before the API reported anything. */
const NO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }

/**
 * Write one proposal, or record why it could not be written.
 *
 * Returns undefined on every failure path rather than throwing: this runs
 * AFTER the chat turn's assistant row is already appended, and a failed
 * preview must not retroactively turn a delivered reply into a failed turn.
 */
export async function authorSpec(
  deps: AuthorDeps,
  input: AuthorInput,
): Promise<Proposal | undefined> {
  const { db, client, now, context } = deps
  const { text: system, sha: promptSha } = loadPrompt(SPEC_PROMPT)

  const base = {
    model: CHAT_MODEL,
    effort: CHAT_EFFORT,
    prompt_sha: promptSha,
    context,
  }
  const served: Served = { model_served: CHAT_MODEL, fallback_fired: false }

  const history = toMessages(readTranscript(db, input.accountId))
  const last = history[history.length - 1]
  // Appended ONLY when the last message is an assistant turn. On the usual
  // path the agent said something before calling the tool, so the call needs
  // a user message to answer. On the no-text path the friend's own message is
  // already last and a second user turn buys nothing. Ending on a user
  // message is the only invariant this needs.
  //
  // Never written to transcripts: it is a call-time construct, not a thing
  // the friend said (design spec section 4.4).
  const messages =
    last?.role === 'assistant'
      ? [...history, { role: 'user' as const, content: 'Write the spec now.' }]
      : history

  let result
  try {
    result = await client.propose({ system, messages, signal: input.signal })
  } catch (error) {
    if (input.signal.aborted) {
      appendMetric(db, {
        accountId: input.accountId,
        event: 'spec_aborted',
        at: now(),
        data: { ...NO_USAGE, ...base, ...served },
      })
      return undefined
    }
    appendMetric(db, {
      accountId: input.accountId,
      event: 'spec_error',
      at: now(),
      data: {
        ...NO_USAGE,
        ...base,
        ...served,
        ...(error instanceof ChatStreamError ? error.shape : UNKNOWN_ERROR),
      },
    })
    return undefined
  }

  let parsed
  try {
    parsed = parseSpecInput(result.input)
  } catch (error) {
    // A schema-constrained REQUEST is not a guarantee about the row that
    // reaches an append-only table. This validator is the last gate.
    appendMetric(db, {
      accountId: input.accountId,
      event: 'spec_error',
      at: now(),
      data: {
        ...result.usage,
        ...base,
        ...result.served,
        kind: 'malformed_spec',
        status: null,
        type: error instanceof Error ? error.message : null,
      },
    })
    return undefined
  }

  const id = insertSpec(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    promptSha,
    payload: parsed.payload,
    mockupHtml: parsed.mockupHtml,
    at: now(),
  })
  // Read back rather than counting: version is derived from position, and
  // this is the one place that must agree with what the admin pane renders.
  const version = readSpecs(db, input.accountId).find((s) => s.id === id)!.version

  appendMetric(db, {
    accountId: input.accountId,
    event: 'spec_proposed',
    at: now(),
    data: { ...result.usage, ...base, ...result.served, spec_id: id, version },
  })

  return { id, version, payload: parsed.payload, mockup_html: parsed.mockupHtml }
}
