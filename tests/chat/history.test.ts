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
      { role: 'user', content: 'second question' },
      { role: 'user', content: 'third question' },
      { role: 'user', content: 'fourth question' },
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

  it('keeps consecutive same-role turns rather than merging them', () => {
    // A retry appends a second user row with the same text (design spec
    // section 6.1). The API accepts consecutive same-role messages, and the
    // transcript is a record of what happened — merging would edit history.
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'again' }),
        row({ id: 2, role: 'user', body: 'again' }),
      ]),
    ).toHaveLength(2)
  })
})
