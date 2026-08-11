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

/**
 * The conversation a message written at `now` belongs to.
 *
 * Called ONCE per exchange, when the user turn is appended. The assistant turn
 * reuses the returned value verbatim rather than recomputing — see the design
 * spec section 2.3.
 */
export function conversationIdFor(
  db: PlatformDb,
  accountId: number,
  now: number,
): string {
  const last = lastTranscriptRow(db, accountId)
  if (!last) return randomBytes(16).toString('hex')
  if (now - last.at > CONVERSATION_GAP_MS) return randomBytes(16).toString('hex')
  return last.conversation_id
}
