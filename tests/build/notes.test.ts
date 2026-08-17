// tests/build/notes.test.ts
import { describe, expect, it } from 'vitest'
import { BuildNotesError, friendFacing, parseBuildNotes } from '@/lib/build/notes'

const GOOD = `---
slug: sam
version: 9
built_at: 2026-08-17
---

## What shipped
The takeaway panel now shows a weekly total.

## Built differently
Weekly rather than daily, because a daily total was almost always zero.

## Open
Nothing.

## Notes for the next build
queries.ts assumes the week starts Monday.
`

describe('parseBuildNotes', () => {
  it('reads frontmatter and all four sections', () => {
    const notes = parseBuildNotes(GOOD)
    expect(notes.slug).toBe('sam')
    expect(notes.version).toBe(9)
    expect(notes.built_at).toBe('2026-08-17')
    expect(notes.what_shipped).toBe('The takeaway panel now shows a weekly total.')
    expect(notes.built_differently).toContain('Weekly rather than daily')
    expect(notes.open).toBe('Nothing.')
    expect(notes.next_build).toContain('starts Monday')
  })

  it('allows an empty Built differently, Open, and Notes section', () => {
    const notes = parseBuildNotes(GOOD.replace('Nothing.', ''))
    expect(notes.open).toBe('')
  })

  it('throws when What shipped is empty — it is the announcement substance', () => {
    const text = GOOD.replace('The takeaway panel now shows a weekly total.', '')
    expect(() => parseBuildNotes(text)).toThrow(BuildNotesError)
  })

  it('throws on a missing section rather than defaulting it to empty', () => {
    const text = GOOD.replace('## Open\nNothing.\n\n', '')
    expect(() => parseBuildNotes(text)).toThrow(/## Open/)
  })

  // A typo'd heading would otherwise silently empty a real section.
  it('throws on an unknown heading', () => {
    const text = GOOD.replace('## Open', '## Opne')
    expect(() => parseBuildNotes(text)).toThrow(/Opne/)
  })

  it('throws on missing frontmatter', () => {
    expect(() => parseBuildNotes(GOOD.split('---\n')[2]!)).toThrow(BuildNotesError)
  })

  it('throws on a non-integer version', () => {
    expect(() => parseBuildNotes(GOOD.replace('version: 9', 'version: nine'))).toThrow(
      /version/,
    )
  })

  it('throws on a built_at that is not YYYY-MM-DD', () => {
    expect(() => parseBuildNotes(GOOD.replace('2026-08-17', '17/08/2026'))).toThrow(
      /built_at/,
    )
  })
})

describe('friendFacing', () => {
  // The structural bound the design rests on: the two builder-only sections
  // are not in the payload at all, so no prompt wording can leak them.
  it('carries What shipped and Built differently, and nothing else', () => {
    const out = friendFacing(parseBuildNotes(GOOD))
    expect(out).toEqual({
      what_shipped: 'The takeaway panel now shows a weekly total.',
      built_differently: 'Weekly rather than daily, because a daily total was almost always zero.',
    })
    expect(JSON.stringify(out)).not.toContain('Monday')
    expect(JSON.stringify(out)).not.toContain('Nothing.')
  })
})
