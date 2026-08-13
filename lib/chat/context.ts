// lib/chat/context.ts
import type { PlatformDb } from '@/lib/db/platform'
import { hasConfirmedSpec } from '@/lib/db/specs'

/**
 * The run kind stamped on every metrics row (architecture-overview.md line
 * 136: "interview, planning, tweak runs").
 */
export type ChatContext = 'interview' | 'tweak'

/**
 * Which ERA this turn belongs to, for the cost log. NOT a pipeline branch:
 * nothing reads this to decide behaviour, and after the unified proposal loop
 * there is only one loop to branch to. It answers architecture-overview line
 * 136's question — how much cost goes into winning someone over versus
 * keeping them — and the boundary is still CONFIRMATION, because a spec that
 * was offered and not accepted has not ended the interview.
 *
 * The value 'tweak' is kept rather than renamed even though the tweak/build
 * distinction is gone everywhere else: metrics is append-only and cannot be
 * migrated, so a rename would split one series across two spellings for a
 * wording change. See the unified-loop ledger, D11.
 */
export function contextFor(db: PlatformDb, accountId: number): ChatContext {
  return hasConfirmedSpec(db, accountId) ? 'tweak' : 'interview'
}
