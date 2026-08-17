// tests/build/notes.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BuildNotesError,
  friendFacing,
  NotesMissingError,
  notesPath,
  parseBuildNotes,
  readBuildNotes,
} from '@/lib/build/notes'

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

// Every temp tree made below is tracked here and swept in afterAll, the same
// pattern tests/users/conventions.test.ts uses — a leaked mkdtempSync dir is a
// silent side effect on the machine running the suite, including the droplet.
const temps: string[] = []
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

function tempUsers(slug: string, file: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'stairwell-notes-'))
  temps.push(root)
  mkdirSync(join(root, slug, 'notes'), { recursive: true })
  writeFileSync(join(root, slug, 'notes', file), body)
  return root
}

describe('readBuildNotes', () => {
  it('reads users/<slug>/notes/v<n>.md', () => {
    const root = tempUsers('sam', 'v9.md', GOOD)
    expect(readBuildNotes('sam', 9, root).what_shipped).toContain('weekly total')
  })

  it('throws NotesMissingError naming the path it wanted', () => {
    const root = tempUsers('sam', 'v9.md', GOOD)
    expect(() => readBuildNotes('sam', 10, root)).toThrow(NotesMissingError)
    expect(() => readBuildNotes('sam', 10, root)).toThrow(/v10\.md/)
  })

  // Catches a notes file copied from another version and not re-headed.
  it('throws when frontmatter disagrees with the file it was found in', () => {
    const root = tempUsers('sam', 'v10.md', GOOD) // frontmatter says version 9
    expect(() => readBuildNotes('sam', 10, root)).toThrow(/frontmatter/)
  })

  it('throws when frontmatter names a different slug', () => {
    const root = tempUsers('kim', 'v9.md', GOOD) // frontmatter says sam
    expect(() => readBuildNotes('kim', 9, root)).toThrow(/frontmatter/)
  })

  it('builds the path from USERS_DIR when no root is passed', () => {
    expect(notesPath('sam', 9)).toMatch(/users[/\\]sam[/\\]notes[/\\]v9\.md$/)
  })
})
