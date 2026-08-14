// tests/chat/timeline.test.ts
//
// onboarding-ux-spec.md: a proposal card "lives in the transcript in
// conversation order", and "the user's confirmation is a transcript event
// too". Both facts are already permanent rows with their own timestamps
// (`specs`, `spec_confirmations`), so the ordering is computed at read time
// and NOTHING NEW IS WRITTEN — onboarding ledger D5 and D5a.
import { describe, expect, it } from 'vitest'
import { buildTimeline } from '@/lib/chat/timeline'

type T = { body: string }
type P = { id: number }

const turn = (body: string, at: number) => ({ at, turn: { body } })
const proposal = (id: number, at: number) => ({ at, proposal: { id } })
const confirmation = (version: number, at: number) => ({ at, version })

function shape(items: ReturnType<typeof buildTimeline<T, P>>): string[] {
  return items.map((item) => {
    if (item.kind === 'turn') return `turn:${item.turn.body}`
    if (item.kind === 'proposal') return `card:${item.proposal.id}`
    return `confirmed:v${item.version}`
  })
}

function build(input: {
  turns?: { at: number; turn: T }[]
  proposals?: { at: number; proposal: P }[]
  confirmations?: { at: number; version: number }[]
}) {
  return buildTimeline<T, P>({
    turns: input.turns ?? [],
    proposals: input.proposals ?? [],
    confirmations: input.confirmations ?? [],
  })
}

describe('proposals in conversation order', () => {
  it('puts a proposal between the turns it happened between', () => {
    // The defect this fixes: cards used to render below the WHOLE transcript,
    // so a proposal made on Tuesday sat at the bottom of Thursday's
    // conversation, detached from the exchange that produced it.
    const items = build({
      turns: [turn('before', 100), turn('after', 300)],
      proposals: [proposal(1, 200)],
    })
    expect(shape(items)).toEqual(['turn:before', 'card:1', 'turn:after'])
  })

  it('places two proposals each at its own moment', () => {
    const items = build({
      turns: [turn('a', 100), turn('b', 300), turn('c', 500)],
      proposals: [proposal(1, 200), proposal(2, 400)],
    })
    expect(shape(items)).toEqual(['turn:a', 'card:1', 'turn:b', 'card:2', 'turn:c'])
  })

  it('puts a proposal that just arrived at the end', () => {
    // A card streamed in mid-session carries the server's `at`, which is later
    // than everything already on screen. That is the only honest position for
    // something that just happened.
    const items = build({
      turns: [turn('a', 100), turn('b', 200)],
      proposals: [proposal(9, 999)],
    })
    expect(shape(items)).toEqual(['turn:a', 'turn:b', 'card:9'])
  })
})

describe('confirmations as events', () => {
  it('appears at ITS OWN timestamp, not at the proposal’s', () => {
    // The two can be days apart: a friend can be offered something on Tuesday
    // and decide on Friday. Rendering the decision where the offer was made
    // puts it in the wrong conversation.
    const items = build({
      turns: [turn('tuesday', 100), turn('friday', 500)],
      proposals: [proposal(1, 200)],
      confirmations: [confirmation(1, 600)],
    })
    expect(shape(items)).toEqual([
      'turn:tuesday',
      'card:1',
      'turn:friday',
      'confirmed:v1',
    ])
  })

  it('shows BOTH the offer and the acceptance', () => {
    // Not one replacing the other. The card is the record of what was offered;
    // the event is the record of the decision, and the scrollback is the
    // app's version history.
    const items = build({
      proposals: [proposal(1, 100)],
      confirmations: [confirmation(1, 200)],
    })
    expect(shape(items)).toEqual(['card:1', 'confirmed:v1'])
  })

  it('keeps several confirmations in the order they were made', () => {
    const items = build({
      confirmations: [confirmation(2, 300), confirmation(1, 100)],
    })
    expect(shape(items)).toEqual(['confirmed:v1', 'confirmed:v2'])
  })
})

describe('ties', () => {
  it('breaks them turn, then proposal, then confirmation', () => {
    // `specs.at` and the assistant transcript row are written milliseconds
    // apart in one request and CAN land on the same millisecond. A card
    // sorting above the reply that produced it would read as the agent
    // answering a question nobody had asked yet.
    const items = build({
      turns: [turn('reply', 100)],
      proposals: [proposal(1, 100)],
      confirmations: [confirmation(1, 100)],
    })
    expect(shape(items)).toEqual(['turn:reply', 'card:1', 'confirmed:v1'])
  })

  it('keeps turns that tie exactly in the order they were given', () => {
    // Transcript order is the only meaningful order for two rows with the same
    // timestamp, and Array#sort has been stable since ES2019.
    const items = build({ turns: [turn('first', 100), turn('second', 100)] })
    expect(shape(items)).toEqual(['turn:first', 'turn:second'])
  })
})

describe('the empty case', () => {
  it('is empty, not undefined', () => {
    expect(build({})).toEqual([])
  })
})
