// lib/chat/context.ts
import type { PlatformDb } from '@/lib/db/platform'
import { hasConfirmedSpec } from '@/lib/db/specs'

/**
 * The run kind stamped on every metrics row (architecture-overview.md line
 * 136: "interview, planning, tweak runs").
 */
export type ChatContext = 'interview' | 'tweak'

/**
 * Which kind of run this turn is.
 *
 * Replaces step 2's hardcoded 'interview', which was correct only until spec
 * confirmation existed (step-2 ledger residual 5). This is the field that
 * answers how much cost goes into winning someone over versus keeping them.
 *
 * Going forward only. metrics is append-only and rows already written say
 * 'interview' permanently — which is correct, because every turn written so
 * far genuinely was one.
 *
 * The boundary is CONFIRMATION, not proposal: a spec that was offered and not
 * accepted has not ended the interview.
 */
export function contextFor(db: PlatformDb, accountId: number): ChatContext {
  return hasConfirmedSpec(db, accountId) ? 'tweak' : 'interview'
}
