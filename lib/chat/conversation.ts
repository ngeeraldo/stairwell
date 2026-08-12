import { randomBytes } from 'node:crypto'
import type { PlatformDb } from '@/lib/db/platform'
import { lastTranscriptRow } from '@/lib/db/appendOnly'

/**
 * The conversation boundary: a new conversation starts on the first message
 * after this much silence.
 *
 * Not invented here — architecture-overview.md line 126 already defines it
 * for the step-3 ntfy alerts ("first message after 30+ min silence"). One
 * primitive serves both, so step 3's alert reduces to "conversation_id is
 * new" rather than a second rule that can drift from this one.
 */
export const CONVERSATION_GAP_MS = 30 * 60 * 1000

export type ConversationRef = {
  id: string
  /**
   * True when this call MINTED the id rather than reusing one. This is the
   * step-3 alert trigger in its entirety: "a conversation started" and "a
   * conversation_id was minted" are the same event, deliberately, so there is
   * no second rule that can drift from this one (design spec §4.1).
   */
  started: boolean
}

/**
 * The conversation a message written at `now` belongs to, and whether that
 * conversation is new.
 *
 * Called ONCE per exchange, when the user turn is appended. The assistant turn
 * reuses the returned value verbatim rather than recomputing — see the design
 * spec section 2.3.
 */
export function conversationIdFor(
  db: PlatformDb,
  accountId: number,
  now: number,
): ConversationRef {
  const last = lastTranscriptRow(db, accountId)
  const fresh = (): ConversationRef => ({
    id: randomBytes(16).toString('hex'),
    started: true,
  })
  if (!last) return fresh()
  if (now - last.at > CONVERSATION_GAP_MS) return fresh()
  return { id: last.conversation_id, started: false }
}
