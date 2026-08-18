// lib/chat/draftAnnouncement.ts
//
// One model call: a build's friend-facing notes in, the sentence that lands in
// their chat out.
//
// It THROWS on every failure and writes nothing. The caller
// (scripts/announce-deploy.ts) decides what to do — refuse, or fall back to the
// fixed sentence under --plain. A silent fallback inside here would produce a
// normal-looking announcement that never read the notes, which is the failure
// nobody would notice.
//
// The client is a parameter, like lib/chat/turn.ts's (CLAUDE.md > Testing).
import type { FriendFacingNotes } from '@/lib/build/notes'
import type { ChatClient, Served, Usage } from './client'
import type { ChatMessage } from './history'
import { ANNOUNCE_PROMPT, loadPrompt } from './prompt'

/**
 * A ceiling on the body, not a target. The message goes into an append-only
 * transcript and is read on a phone; a drafting call that returns an essay has
 * misunderstood the job, and a permanent essay is worse than a refusal Nico
 * sees at a terminal and re-runs.
 */
export const MAX_ANNOUNCEMENT_CHARS = 600

/**
 * One field, so the reply cannot arrive wrapped in prose or a markdown fence —
 * the same reasoning as MOCKUP_JSON_SCHEMA. This body is written verbatim into
 * a transcript that rejects DELETE.
 */
export const ANNOUNCE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const

export type DraftInput = {
  notes: FriendFacingNotes
  /** The confirmed version's change_summary — what they asked for. */
  changeSummary: string
  /** The tail of their conversation, so the draft can omit what they know. */
  recent: ChatMessage[]
  signal: AbortSignal
}

export type DraftResult = {
  message: string
  usage: Usage
  served: Served
  /** announce-v1.md's hash, stamped on the transcript row. */
  promptSha: string
}

export class AnnouncementDraftError extends Error {
  constructor(message: string) {
    super(`announcement draft: ${message}`)
    this.name = 'AnnouncementDraftError'
  }
}

/**
 * The notes go in as JSON under an explicit label rather than being pasted in
 * as prose. `built_differently` is routinely EMPTY, and an empty string in a
 * prose block reads as a heading with nothing under it — which is exactly the
 * shape that invites a model to fill it. An explicit `""` is a stated fact.
 */
function userContent(input: DraftInput): string {
  return (
    'The version they confirmed, in their words:\n\n' +
    `${input.changeSummary}\n\n` +
    "The builder's notes on what actually shipped:\n\n" +
    `${JSON.stringify(input.notes, null, 2)}\n\n` +
    'Write the message now.'
  )
}

export async function draftAnnouncement(
  deps: { client: ChatClient },
  input: DraftInput,
): Promise<DraftResult> {
  const prompt = loadPrompt(ANNOUNCE_PROMPT)

  const result = await deps.client.propose({
    system: prompt.text,
    // The recent conversation FIRST, so the draft can tell what they already
    // know; the notes last, as the thing to act on. A trailing user message is
    // also what the API wants to answer.
    messages: [...input.recent, { role: 'user', content: userContent(input) }],
    signal: input.signal,
    schema: ANNOUNCE_JSON_SCHEMA,
  })

  const raw = result.input
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AnnouncementDraftError('reply is not an object')
  }
  const message = (raw as { message?: unknown }).message
  if (typeof message !== 'string') {
    throw new AnnouncementDraftError('reply has no message string')
  }

  const trimmed = message.trim()
  // lib/chat/announce.ts refuses a blank body because ONE such row 400s every
  // later turn for that account, forever. Catching it here means the refusal
  // happens before anything is written rather than inside the transaction.
  if (trimmed === '') throw new AnnouncementDraftError('message is empty')
  if (trimmed.length > MAX_ANNOUNCEMENT_CHARS) {
    throw new AnnouncementDraftError(
      `message is too long (${trimmed.length} chars, ceiling ${MAX_ANNOUNCEMENT_CHARS})`,
    )
  }

  return {
    message: trimmed,
    usage: result.usage,
    served: result.served,
    promptSha: prompt.sha,
  }
}
