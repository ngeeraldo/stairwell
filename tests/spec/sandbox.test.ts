// tests/spec/sandbox.test.ts
//
// The one property that must hold at EVERY site that puts model-authored HTML
// on a screen, including sites added later. Its own file for that reason: an
// assertion buried in a render test covers the site it was written for and
// nothing else.
//
// THE SWEEP KEY CHANGED WITH THE MOCKUP ROUTE, and the reason is worth stating.
// It used to grep for `mockup_html`, which worked while every render site
// inlined the stored bytes with `srcDoc`. The card and the full-screen dialog
// load `/mockup/<version>` now (onboarding ledger D14), so they render
// model-authored HTML while never mentioning `mockup_html` at all — the old
// sweep would have gone quietly green over exactly the two new sites. It
// greps for `<iframe` instead, which is the thing that actually matters: an
// iframe is how untrusted markup reaches a person here, whatever supplies it.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Every file under app/ that renders an iframe. */
const SITES = [
  'app/[user]/ChatPanel.tsx',
  'app/[user]/MockupDialog.tsx',
  'app/admin/[user]/page.tsx',
]

describe('mockup HTML is rendered sealed off', () => {
  it.each(SITES)('%s uses an empty sandbox and never allow-scripts', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    expect(source).toContain('sandbox=""')
    expect(source).not.toContain('allow-scripts')
    expect(source).not.toContain('allow-same-origin')
  })

  it('every iframe under app/ is accounted for', () => {
    // A new render site nobody added to SITES is exactly the gap this file
    // exists to close, and it is invisible to a per-site assertion. Grep the
    // tree rather than trusting the list.
    // --untracked so a brand-new render site is caught by a local run before
    // it is ever staged, not just in CI after the fact.
    const found = execFileSync(
      'git',
      ['grep', '-l', '--untracked', '<iframe', '--', 'app'],
      { encoding: 'utf8', cwd: process.cwd() },
    )
      .split('\n')
      .filter((line) => line !== '')
      .sort()

    expect(found).toEqual([...SITES].sort())
  })

  it('the serving route seals it off for anyone who opens the URL directly', () => {
    // The iframe attribute protects the embedded case. A friend who opens
    // /mockup/3 in a tab has no iframe around it, and the CSP header is the
    // only thing left between model-authored markup and a same-origin
    // document — so it is asserted here, beside its sibling, rather than only
    // in the route's own tests.
    //
    // Task 25: `sandbox` grew three appended directives that block passive
    // GET requests (an <img src>, a <link href>, a CSS url()), which the
    // sandbox attribute alone never restricted. The literal changed shape —
    // single quotes to double, because the value now embeds `'none'` — so
    // this source-grep assertion is updated to match rather than left
    // pinning the string that shipped before this task.
    const source = readFileSync(
      resolve(process.cwd(), 'app/mockup/[version]/route.ts'),
      'utf8',
    )
    expect(source).toContain(
      `'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
    )
    expect(source).toContain("'x-content-type-options': 'nosniff'")
  })

  // Task 25: the admin route serves the same model-authored HTML to Nico,
  // through the same MockupDialog iframe (src={`/admin/mockup/...`}), so it
  // needs the identical seal — added here rather than folded into the test
  // above because the two routes are deliberately separate files (see
  // app/admin/mockup/[user]/[version]/route.ts's own comment on why) and a
  // sweep test should name each site it covers rather than imply one covers
  // both.
  it('the admin serving route seals it off identically', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/admin/mockup/[user]/[version]/route.ts'),
      'utf8',
    )
    expect(source).toContain(
      `'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
    )
    expect(source).toContain("'x-content-type-options': 'nosniff'")
  })
})
