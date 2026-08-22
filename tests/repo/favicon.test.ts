// tests/repo/favicon.test.ts
//
// The tab icon. `*.svg` is exempt from the pre-commit test gate by path
// (.githooks/pre-commit), so this file is here because the property is worth
// pinning, not because a gate demanded it: an icon that reaches for a remote
// asset would be the only outbound fetch in a page this app renders, and it
// would fail silently — a missing favicon looks exactly like a favicon that
// has not loaded yet.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ICON = join(process.cwd(), 'app', 'icon.svg')

describe('app/icon.svg', () => {
  it('exists where Next looks for it', () => {
    // app/icon.svg is a file convention: Next serves it and writes the <link>
    // itself, fingerprinted. A hand-written <link> in layout.tsx would be a
    // second place the filename lives, free to drift from the first.
    expect(existsSync(ICON)).toBe(true)
  })

  it('scales, rather than being pinned to one size', () => {
    // A viewBox is what lets one file answer for a 16px tab, a 32px bookmark
    // and whatever a phone decides to ask for.
    expect(readFileSync(ICON, 'utf8')).toMatch(/viewBox="0 0 32 32"/)
  })

  it('fetches nothing', () => {
    const svg = readFileSync(ICON, 'utf8')

    expect(svg).not.toMatch(/<image\b/)
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
  })
})
