import type { TranscriptRow } from '@/lib/db/appendOnly'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/**
 * Transcript rows to API messages.
 *
 * History is the account's whole transcript, not just the current
 * conversation: goals surface over weeks (architecture-overview.md section 5),
 * so the agent has to remember earlier conversations.
 */
export function toMessages(rows: TranscriptRow[]): ChatMessage[] {
  const mapped = rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.body }))

  const firstUser = mapped.findIndex((m) => m.role === 'user')
  return firstUser === -1 ? [] : mapped.slice(firstUser)
}
