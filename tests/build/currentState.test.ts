// tests/build/currentState.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CurrentStateError,
  currentStatePath,
  parseCurrentState,
  readCurrentState,
} from '@/lib/build/currentState'

// Repo root, the same way tests/scripts/newDashboard.test.ts locates it — this
// file lives two levels under it (tests/build/).
const REPO = resolve(__dirname, '..', '..')

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

  it('reads from process.env.USERS_DIR when usersDir is not provided', () => {
    // Tests the seam that lets the app point all user modules at a temp tree
    // during test runs. See deploy/required-env: USERS_DIR is not listed there.
    const dir = tree({ 'sam/current.md': GOOD })
    const prevUsersDir = process.env.USERS_DIR
    try {
      process.env.USERS_DIR = dir
      expect(readCurrentState('sam')?.version).toBe(3)
    } finally {
      if (prevUsersDir === undefined) delete process.env.USERS_DIR
      else process.env.USERS_DIR = prevUsersDir
    }
  })

  it('prefers an explicit usersDir argument over process.env.USERS_DIR', () => {
    // When both are set, the argument wins. This is the precedence the code promises.
    const dir1 = tree({ 'sam/current.md': GOOD })
    const dir2 = tree({ 'other/current.md': '' })
    const prevUsersDir = process.env.USERS_DIR
    try {
      process.env.USERS_DIR = dir2
      expect(readCurrentState('sam', dir1)?.version).toBe(3)
    } finally {
      if (prevUsersDir === undefined) delete process.env.USERS_DIR
      else process.env.USERS_DIR = prevUsersDir
    }
  })
})

describe('platform/templates/dashboard/current.md.tmpl', () => {
  it('parses once __SLUG__ is substituted', () => {
    // Nothing else in the suite ever loads this file — it is copied by hand
    // at docs/runbook-ai.md §3.2, not by scripts/new-dashboard.sh, so no
    // scaffold test exercises it either. A heading typo in it would sit
    // unnoticed until a builder hit the throw live, mid-build. sed's own
    // substitution (`s/__SLUG__/.../g`, scripts/new-dashboard.sh) is mirrored
    // with a plain string replace here rather than shelling out to sed, since
    // the point is proving the CONTENT parses, not proving sed works.
    const raw = readFileSync(
      resolve(REPO, 'platform/templates/dashboard/current.md.tmpl'),
      'utf8',
    )
    const filled = raw.replace(/__SLUG__/g, 'sam')
    expect(() => parseCurrentState(filled)).not.toThrow()
  })
})
