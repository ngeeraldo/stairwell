// tests/chat/panel.test.ts
import { describe, expect, it } from 'vitest'
import { parseNdjson } from '@/app/[user]/ChatPanel'

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
