import type { TranscriptRow } from '@/lib/db/appendOnly'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/**
 * Transcript rows to API messages.
 *
 * History is the account's whole transcript, not just the current
 * conversation: goals surface over weeks (architecture-overview.md section 5),
 * so the agent has to remember earlier conversations.
 *
 * Empty and whitespace-only bodies are dropped. The Messages API rejects empty
 * text content, so one such row would 400 every subsequent turn for that
 * account — forever, because transcripts is append-only and the row cannot be
 * deleted. runTurn no longer writes one, but a row written before that fix
 * cannot be ruled out, so this is the permanent recovery valve: it degrades
 * "account permanently broken" to "one blank turn missing from history".
 */
export function toMessages(rows: TranscriptRow[]): ChatMessage[] {
  const mapped = rows
    .filter(
      (r) =>
        (r.role === 'user' || r.role === 'assistant') && r.body.trim() !== '',
    )
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.body }))

  const firstUser = mapped.findIndex((m) => m.role === 'user')
  return firstUser === -1 ? [] : mapped.slice(firstUser)
}
