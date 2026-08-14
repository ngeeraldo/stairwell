// lib/chat/timeline.ts

/**
 * The conversation, as one ordered list.
 *
 * onboarding-ux-spec.md: "A proposal card is a persisted chat message: it
 * lives in the transcript in conversation order … scrollback shows every
 * proposal exactly where it happened." And: "The user's confirmation is a
 * transcript event too."
 *
 * NOTHING NEW IS PERSISTED TO SATISFY THAT (onboarding ledger D5, D5a). Both
 * facts are already permanent rows — `specs` and `spec_confirmations` — each
 * with its own timestamp. Writing them into `transcripts` as well would put a
 * second, un-deletable copy of them in the one table this project calls
 * sacred, with columns that cannot be widened. So the merge happens at READ
 * time, here, and the rows stay exactly where they are.
 *
 * The defect this fixes is real and was easy to miss: cards used to render in
 * a region BELOW the entire transcript, so a friend who proposed something on
 * Tuesday and chatted through Thursday found it at the bottom, detached from
 * the conversation that produced it. The confirmation was worse — it showed as
 * the card changing state at the moment it was OFFERED, and those two
 * timestamps can be days apart.
 *
 * Deliberately free of React and of anything server-only: ChatPanel is a
 * client component and the admin pane is a server one, and both render from
 * this.
 */

export type TimelineItem<Turn, Proposal> =
  | { kind: 'turn'; at: number; turn: Turn }
  | { kind: 'proposal'; at: number; proposal: Proposal }
  | { kind: 'confirmation'; at: number; version: number }

/**
 * Ties break in the order the facts can occur: a turn, then the proposal that
 * turn raised its hand for, then a confirmation of it.
 *
 * This matters more than it looks. `specs.at` and the assistant transcript row
 * are written milliseconds apart in one request and can land on the same
 * millisecond, and a card that sorted ABOVE the reply that produced it would
 * read as the agent answering a question nobody had asked yet.
 */
const RANK = { turn: 0, proposal: 1, confirmation: 2 } as const

export function buildTimeline<Turn, Proposal>(input: {
  turns: { at: number; turn: Turn }[]
  proposals: { at: number; proposal: Proposal }[]
  confirmations: { at: number; version: number }[]
}): TimelineItem<Turn, Proposal>[] {
  // Assembled in REVERSE of the order ties should resolve in, deliberately.
  //
  // Array#sort is stable, so building turns-then-proposals-then-confirmations
  // would produce the right tie order all by itself — and RANK below would be
  // dead code that reddened no test if it were deleted, which a drill duly
  // showed. Building it the other way round makes RANK the mechanism rather
  // than a comment about a coincidence, and means the rule survives someone
  // reordering these three spreads.
  const items: TimelineItem<Turn, Proposal>[] = [
    ...input.confirmations.map((c) => ({
      kind: 'confirmation' as const,
      at: c.at,
      version: c.version,
    })),
    ...input.proposals.map((p) => ({
      kind: 'proposal' as const,
      at: p.at,
      proposal: p.proposal,
    })),
    ...input.turns.map((t) => ({ kind: 'turn' as const, at: t.at, turn: t.turn })),
  ]

  // A stable sort (guaranteed since ES2019), so items that tie on both `at`
  // and rank keep the order they were given — which for turns is transcript
  // order, the only order that is meaningful for them.
  return items.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind])
}
