// tests/spec/sandbox.test.ts
//
// The one property that must hold at EVERY site rendering model-authored
// HTML, including sites added later. Its own file for that reason: an
// assertion buried in a render test covers the site it was written for and
// nothing else.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Every file under app/ that renders mockup_html into the DOM. */
const SITES = ['app/[user]/ChatPanel.tsx']

/**
 * Files that mention mockup_html without rendering it — they read it, pass it
 * along, or type it. Listed explicitly so the sweep below can tell "does not
 * render" from "renders and nobody checked".
 */
const NON_RENDERING = ['app/[user]/page.tsx']

describe('mockup HTML is rendered sealed off', () => {
  it.each(SITES)('%s uses an empty sandbox and never allow-scripts', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    expect(source).toContain('sandbox=""')
    expect(source).not.toContain('allow-scripts')
    expect(source).not.toContain('allow-same-origin')
  })

  it('every file under app/ that touches mockup_html is accounted for', () => {
    // A new render site nobody added to SITES is exactly the gap this file
    // exists to close, and it is invisible to a per-site assertion. Grep the
    // tree rather than trusting the list.
    const found = execFileSync('git', ['grep', '-l', 'mockup_html', '--', 'app'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
      .split('\n')
      .filter((line) => line !== '')
      .sort()

    expect(found).toEqual([...SITES, ...NON_RENDERING].sort())
  })
})
