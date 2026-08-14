import { describe, expect, it } from 'vitest'
import type { TranscriptRow } from '@/lib/db/appendOnly'
import { toMessages } from '@/lib/chat/history'

function row(over: Partial<TranscriptRow>): TranscriptRow {
  return {
    id: 1,
    account_id: 1,
    session_id: 's',
    conversation_id: 'c',
    prompt_sha: 'p',
    role: 'user',
    body: 'hi',
    at: 0,
    ...over,
  }
}

describe('toMessages', () => {
  it('maps rows to role/content pairs in order', () => {
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'one' }),
        row({ id: 2, role: 'assistant', body: 'two' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
  })

  it('drops rows with a role the API does not accept', () => {
    expect(toMessages([row({ role: 'system', body: 'nope' })])).toEqual([])
  })

  it('drops leading assistant rows', () => {
    // The API rejects a conversation whose first message is from the
    // assistant. Our own write path cannot produce that today (the user turn
    // is always appended first), but history is read from a table that keeps
    // rows forever, so this stays defensive rather than trusting the invariant.
    expect(
      toMessages([
        row({ id: 1, role: 'assistant', body: 'orphan' }),
        row({ id: 2, role: 'user', body: 'real start' }),
      ]),
    ).toEqual([{ role: 'user', content: 'real start' }])
  })

  it('drops empty and whitespace-only bodies, keeping the rest in order', () => {
    // The recovery valve for C1. The Messages API rejects empty text content,
    // so ONE such row would 400 every subsequent turn for that account —
    // permanently, because transcripts is append-only and the row cannot be
    // deleted. runTurn no longer writes one; this makes a row that was
    // already written survivable rather than fatal.
    //
    // The three user questions the dropped assistant rows used to separate
    // arrive as ONE folded message, which is the second valve doing its job:
    // dropping a blank row is what put them next to each other in the first
    // place. Every word survives, in order, which is the property this test
    // has always been about.
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'first question' }),
        row({ id: 2, role: 'assistant', body: 'first answer' }),
        row({ id: 3, role: 'user', body: 'second question' }),
        row({ id: 4, role: 'assistant', body: '' }),
        row({ id: 5, role: 'user', body: 'third question' }),
        row({ id: 6, role: 'assistant', body: '  \t\n ' }),
        row({ id: 7, role: 'user', body: 'fourth question' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question\n\nthird question\n\nfourth question' },
    ])
  })

  it('does not let an empty leading row count as the first user turn', () => {
    // The leading-assistant trim runs on the filtered list, so an empty user
    // row cannot anchor the slice and smuggle an assistant turn to the front.
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: '   ' }),
        row({ id: 2, role: 'assistant', body: 'orphan' }),
        row({ id: 3, role: 'user', body: 'real start' }),
      ]),
    ).toEqual([{ role: 'user', content: 'real start' }])
  })

  it('folds consecutive user rows into one message', () => {
    // A retry appends a second user row with the same text (design spec
    // section 6.1), so this pair is producible today. The transcript keeps
    // both rows — nothing here edits history; only the API request is folded.
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'again' }),
        row({ id: 2, role: 'user', body: 'again' }),
      ]),
    ).toEqual([{ role: 'user', content: 'again\n\nagain' }])
  })

  it('folds consecutive assistant rows into one message', () => {
    // The announcement case. An operator announcement (lib/chat/announce.ts)
    // appends an assistant row straight after a turn that already ended on
    // one, so the very next turn rebuilds history as
    // [..., assistant(reply), assistant(announcement), user(new)].
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'what should I track?' }),
        row({ id: 2, role: 'assistant', body: 'here is a thought' }),
        row({ id: 3, role: 'assistant', body: 'Your dashboard is live: a streak.' }),
        row({ id: 4, role: 'user', body: 'nice' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'what should I track?' },
      { role: 'assistant', content: 'here is a thought\n\nYour dashboard is live: a streak.' },
      { role: 'user', content: 'nice' },
    ])
  })

  it('leaves alternating rows alone', () => {
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'one' }),
        row({ id: 2, role: 'assistant', body: 'two' }),
        row({ id: 3, role: 'user', body: 'three' }),
        row({ id: 4, role: 'assistant', body: 'four' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ])
  })

  it('folds across a blank row — the filter runs first, so a blank cannot split a fold', () => {
    // Order matters and is the whole point: if the fold ran on the RAW rows,
    // a blank row sitting between two assistant rows would keep them apart,
    // then the blank filter would drop it and hand the API the consecutive
    // pair anyway — the exact shape both of these valves exist to prevent.
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'start' }),
        row({ id: 2, role: 'assistant', body: 'first' }),
        row({ id: 3, role: 'user', body: '   ' }),
        row({ id: 4, role: 'assistant', body: 'second' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'first\n\nsecond' },
    ])
  })

  it('folds a run of three', () => {
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'a' }),
        row({ id: 2, role: 'user', body: 'b' }),
        row({ id: 3, role: 'user', body: 'c' }),
      ]),
    ).toEqual([{ role: 'user', content: 'a\n\nb\n\nc' }])
  })
})
