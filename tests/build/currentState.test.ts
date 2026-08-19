// tests/build/currentState.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CurrentStateError,
  currentStatePath,
  parseCurrentState,
  readCurrentState,
} from '@/lib/build/currentState'

const GOOD = `---
slug: sam
version: 3
---

## What this is for
Keeping an eye on the weekly takeaway spend.

## Screens
One screen, "Spending".

## Panels
Weekly takeaway total. Counts the current week only, Monday to Sunday.

## What can be entered
Nothing by hand — everything is synced.

## Deliberately not included
A monthly view. Asked for and turned down: the week is the unit they think in.
`

const dirs: string[] = []
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'currentstate-'))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseCurrentState', () => {
  it('reads slug and version from frontmatter', () => {
    const state = parseCurrentState(GOOD)
    expect(state.slug).toBe('sam')
    expect(state.version).toBe(3)
  })

  it('hands the body through unsplit, frontmatter removed', () => {
    const state = parseCurrentState(GOOD)
    expect(state.body).toContain('## What this is for')
    expect(state.body).toContain('the week is the unit they think in')
    expect(state.body).not.toContain('slug: sam')
  })

  it('accepts version 0, meaning it predates the spec loop', () => {
    expect(parseCurrentState(GOOD.replace('version: 3', 'version: 0')).version).toBe(0)
  })

  it('rejects a negative or non-integer version', () => {
    expect(() => parseCurrentState(GOOD.replace('version: 3', 'version: -1'))).toThrow(
      CurrentStateError,
    )
    expect(() => parseCurrentState(GOOD.replace('version: 3', 'version: 2.5'))).toThrow(
      CurrentStateError,
    )
  })

  it('rejects a file with no frontmatter', () => {
    expect(() => parseCurrentState('## What this is for\nhi\n')).toThrow(CurrentStateError)
  })

  it('names a missing section rather than treating it as empty', () => {
    const missing = GOOD.replace(/## Deliberately not included[\s\S]*$/, '')
    expect(() => parseCurrentState(missing)).toThrow(/Deliberately not included/)
  })

  it('rejects a misspelled heading instead of silently dropping it', () => {
    // The failure this exists for: "## Delibrately not included" would leave
    // the real section absent and read as empty, and an empty refusal list is
    // exactly how the agent re-proposes something already turned down.
    expect(() => parseCurrentState(GOOD.replace('## Deliberately not included', '## Delibrately not included'))).toThrow(
      /Delibrately/,
    )
  })

  it('rejects a duplicated section', () => {
    expect(() => parseCurrentState(`${GOOD}\n## Screens\nagain\n`)).toThrow(/duplicate/)
  })

  it('accepts an empty section — an empty answer is a real answer', () => {
    const empty = GOOD.replace(
      'A monthly view. Asked for and turned down: the week is the unit they think in.',
      '',
    )
    expect(() => parseCurrentState(empty)).not.toThrow()
  })
})

describe('readCurrentState', () => {
  it('returns null when the file does not exist', () => {
    // NOT a throw, unlike readBuildNotes. A friend with no dashboard yet has
    // no file and must still be able to hold a conversation.
    const dir = tree({ 'sam/dashboard.tsx': '' })
    expect(readCurrentState('sam', dir)).toBeNull()
  })

  it('reads and parses a file that exists', () => {
    const dir = tree({ 'sam/current.md': GOOD })
    expect(readCurrentState('sam', dir)?.version).toBe(3)
  })

  it('throws on a malformed file rather than returning null', () => {
    // A file that exists but cannot be read is a builder error, not an absent
    // dashboard — silently degrading to null would feed the agent nothing
    // while the folder looks complete.
    const dir = tree({ 'sam/current.md': 'no frontmatter here' })
    expect(() => readCurrentState('sam', dir)).toThrow(CurrentStateError)
  })

  it('names the path it looked at', () => {
    expect(currentStatePath('sam', '/tmp/users')).toBe('/tmp/users/sam/current.md')
  })
})
