// tests/chat/panel.test.ts
import { describe, expect, it } from 'vitest'
import { parseNdjson, pendingTurns } from '@/app/[user]/ChatPanel'

describe('parseNdjson', () => {
  it('parses whole lines and keeps the trailing partial', () => {
    const { lines, rest } = parseNdjson('{"t":"a"}\n{"t":"b"}\n{"t":"par')
    expect(lines).toEqual([{ t: 'a' }, { t: 'b' }])
    expect(rest).toBe('{"t":"par')
  })

  it('returns nothing when no line is complete yet', () => {
    const { lines, rest } = parseNdjson('{"t":"incomp')
    expect(lines).toEqual([])
    expect(rest).toBe('{"t":"incomp')
  })

  it('recognises the terminal done line', () => {
    const { lines } = parseNdjson('{"t":"x"}\n{"done":true}\n')
    expect(lines).toEqual([{ t: 'x' }, { done: true }])
  })

  it('ignores a blank line rather than throwing', () => {
    // A stream that ends with "\n\n" must not crash the reader mid-reply.
    const { lines } = parseNdjson('{"t":"x"}\n\n')
    expect(lines).toEqual([{ t: 'x' }])
  })
})

describe('pendingTurns — what a retry re-sends', () => {
  it('binds the source text to the turn, not to a shared slot', () => {
    // Every interrupted turn renders its OWN retry button. When the source
    // lived in a single component-level ref, two interrupted turns on screen
    // meant the older button re-sent the newer message — writing a permanent
    // transcript row the user never asked to send. Each assistant turn must
    // therefore carry the message that produced it.
    const turns = [...pendingTurns('first'), ...pendingTurns('second')]
    const retryable = turns.filter((t) => t.role === 'assistant')

    expect(retryable.map((t) => t.source)).toEqual(['first', 'second'])
    expect(retryable[0]!.source).not.toBe(retryable[1]!.source)
  })

  it('appends the user message and an empty assistant turn to stream into', () => {
    expect(pendingTurns('what should I watch?')).toEqual([
      { role: 'user', body: 'what should I watch?' },
      { role: 'assistant', body: '', source: 'what should I watch?' },
    ])
  })
})
