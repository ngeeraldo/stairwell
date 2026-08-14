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
 *
 * Consecutive same-role rows are folded into ONE message, bodies joined with a
 * blank line, for exactly the same reason and at exactly the same cost.
 * Operator announcements (lib/chat/announce.ts) append an assistant row of
 * their own, and a normal turn already ends on one — so the first announcement
 * to an account makes the next turn's history read
 * [..., assistant(reply), assistant(announcement), user(new)]. Anthropic's own
 * documentation is self-contradictory about that shape: the TypeScript guide
 * says consecutive same-role messages are combined into a single turn, the
 * error-codes reference lists them as a cause of 400. It cannot be settled
 * from here, and the two outcomes are wildly asymmetric — if the 400 reading
 * is the live one, the FIRST announcement permanently breaks that account's
 * chat, every later turn 400s, and `transcripts` rejects DELETE, so there is
 * no recovery. Folding costs one blank line between two things the same
 * speaker said; not folding risks an unrecoverable account. It is the same
 * bet, on the same table, as the blank-body filter above.
 *
 * THE FOLD IS PERMANENT — unified-loop ledger, D17. It is NOT a workaround
 * waiting on that documentation question to be settled. If someone later
 * confirms the API merges same-role runs on its own, that makes this agree
 * with the API; it does not make it redundant, because deleting it would hand
 * a permanent, unrecoverable failure mode to a third party's implementation
 * detail that nobody versioned. Record the answer next to D17 and leave this
 * alone. More producers of same-role runs are already arriving —
 * scripts/ask-user.ts writes operator rows too — and this is the one place
 * that shape gets normalised.
 *
 * Nothing here edits history: the rows stay exactly as written and the panel
 * still renders every one of them separately (app/[user]/page.tsx). This
 * shapes only the REQUEST.
 *
 * The fold runs AFTER the blank filter, and the order is load-bearing: a blank
 * row sitting between two assistant rows would otherwise keep them apart here
 * and then be dropped, handing the API the consecutive pair anyway.
 */
export function toMessages(rows: TranscriptRow[]): ChatMessage[] {
  const mapped = rows
    .filter(
      (r) =>
        (r.role === 'user' || r.role === 'assistant') && r.body.trim() !== '',
    )
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.body }))

  const folded: ChatMessage[] = []
  for (const message of mapped) {
    const previous = folded[folded.length - 1]
    if (previous && previous.role === message.role) {
      // Replaced rather than mutated: `mapped`'s objects are fresh, but a
      // reducer that mutates in place is one refactor away from mutating a
      // caller's array.
      folded[folded.length - 1] = {
        role: previous.role,
        content: `${previous.content}\n\n${message.content}`,
      }
      continue
    }
    folded.push(message)
  }

  const firstUser = folded.findIndex((m) => m.role === 'user')
  return firstUser === -1 ? [] : folded.slice(firstUser)
}
