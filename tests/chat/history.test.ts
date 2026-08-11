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
