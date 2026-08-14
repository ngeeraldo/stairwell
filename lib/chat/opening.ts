// lib/chat/opening.ts
//
// The agent speaks first. agent-v4.md: "You speak first. When the conversation
// begins, open with this, verbatim" — followed by the message as a blockquote.
// Until this module existed the chat opened EMPTY, so the prompt's instruction
// had nothing to act on: the model is only ever called in response to a user
// message, and there is no user message on the first render.
//
// THE WORDS ARE READ OUT OF THE PROMPT FILE, not retyped here. Two copies of
// an opener are two things that can drift, which is the same argument
// lib/copy/onboarding.ts makes about the promise block — except that here the
// prompt file is unambiguously the source, since the model is told to say it
// verbatim and `prompt_sha` stamps which version said it.
//
// NOT A MODEL CALL, deliberately. Asking the model to emit its own opener
// would cost an API round trip on the first render of every account, and would
// deliver "verbatim" only as reliably as sampling allows. The file already
// contains the exact bytes; reading them is both cheaper and more faithful.
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import type { PlatformDb } from '@/lib/db/platform'
import { conversationIdFor } from './conversation'
import { loadPrompt } from './prompt'

/**
 * The section the opener lives under.
 *
 * ANCHORED TO THE HEADING, never "the first blockquote in the file" — Nico's
 * condition, and it is the difference between a parse that is pinned to
 * meaning and one pinned to layout. agent-v4.md contains several blockquotes;
 * a positional parse would silently start returning a different one the first
 * time a version adds a quoted example above this section, and the failure
 * would be a friend greeted with the wrong words rather than an error.
 */
export const OPENING_HEADING = '## Your first message'

export class OpeningMessageError extends Error {
  constructor(detail: string) {
    super(`Cannot read the opening message from the agent prompt: ${detail}`)
    this.name = 'OpeningMessageError'
  }
}

/**
 * Pull the blockquote out of the section, or THROW.
 *
 * Loud, never empty. A silently-empty opener is the worst available outcome:
 * `transcripts` rejects DELETE, so a blank assistant row written at first
 * render is a permanent blank first impression for that account, and the chat
 * would look exactly like the bug this module fixes. Throwing means a red test
 * and a startup failure instead — both of which someone reads.
 */
export function parseOpeningMessage(promptText: string): string {
  const start = promptText.indexOf(OPENING_HEADING)
  if (start === -1) {
    throw new OpeningMessageError(`no '${OPENING_HEADING}' section`)
  }

  const after = promptText.slice(start + OPENING_HEADING.length)
  // The section ends at the next heading of the same level, or at EOF.
  const end = after.indexOf('\n## ')
  const section = end === -1 ? after : after.slice(0, end)

  const quoted = section
    .split('\n')
    .filter((line) => line.trimStart().startsWith('>'))
    // '> ' with the space, and a bare '>' for the blank lines between
    // paragraphs — which are what keep the two questions on separate lines.
    .map((line) => line.trimStart().replace(/^>\s?/, ''))

  if (quoted.length === 0) {
    throw new OpeningMessageError(`no blockquote under '${OPENING_HEADING}'`)
  }

  const body = quoted.join('\n').trim()
  if (body === '') {
    throw new OpeningMessageError(`the blockquote under '${OPENING_HEADING}' is empty`)
  }
  return body
}

/** The opener for the shipped prompt. Throws at call time if unparseable. */
export function openingMessage(): string {
  return parseOpeningMessage(loadPrompt().text)
}

/**
 * What the model is told once it has already greeted someone.
 *
 * THE BUG THIS FIXES: the opener is written as the first transcript row, shown
 * to the friend — and then dropped from the model's context, because
 * `toMessages` slices everything before the first USER row. The model saw a
 * conversation with no assistant turn in it, read "open with this, verbatim",
 * and obeyed a second time. The friend's first reply was answered with the
 * greeting they had already read.
 *
 * THE OBVIOUS FIX IS THE BROKEN ONE. Keeping the leading assistant row would
 * put it in front of the model, but the Messages API rejects a conversation
 * whose FIRST message is an assistant turn — that is what the slice is there
 * for. Taking it out trades a repeated greeting for a 400 on every turn, which
 * is the whole chat rather than one awkward line.
 *
 * So the fact travels as system context instead: the transcript keeps the row,
 * the friend keeps seeing it, and the model is told plainly that it has
 * already spoken. Nothing extra is persisted, and nothing about the message
 * list changes.
 */
export const OPENER_ALREADY_SENT =
  'Your opening message has already been sent to this person and is the first thing in their chat. Do not send it again, and do not begin your reply by restating it.'

/**
 * Whether this account has already been greeted.
 *
 * Asks the cheap structural question — is the first row an assistant row —
 * rather than comparing bodies against the current opener. Comparing text
 * would silently stop matching the day a new prompt version changes the
 * wording, and every account greeted under the old one would start being
 * greeted again.
 */
export function openerAlreadySent(rows: { role: string }[]): boolean {
  return rows[0]?.role === 'assistant'
}

/**
 * Write the opener once, before the friend has said anything.
 *
 * THE GUARD IS AN EMPTY TRANSCRIPT, not `first_session_start`. That metric is
 * load-bearing system state (onboarding ledger D8) and Nico's instruction was
 * to leave it untouched — reusing it as this guard would quietly give it a
 * second job, and the two can disagree: an account that reached the shell
 * before this module existed has the metric and an empty chat, and should
 * still be greeted. Emptiness is the honest question to ask, and it is
 * idempotent under concurrent renders in a way a metric-absence check is not.
 */
export function ensureOpeningMessage(
  db: PlatformDb,
  input: { accountId: number; sessionId: string; at: number },
): boolean {
  if (readTranscript(db, input.accountId).length > 0) return false

  const { text, sha } = loadPrompt()
  const body = parseOpeningMessage(text)
  const { id: conversationId } = conversationIdFor(db, input.accountId, input.at)

  appendTranscript(db, {
    accountId: input.accountId,
    sessionId: input.sessionId,
    conversationId,
    promptSha: sha,
    role: 'assistant',
    body,
    at: input.at,
  })
  return true
}
