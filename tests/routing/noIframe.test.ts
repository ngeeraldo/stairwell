// tests/routing/noIframe.test.ts
//
// A standing tripwire, independent of the mockup loop that used to justify
// it. tests/spec/sandbox.test.ts swept every `<iframe` under app/ because an
// iframe was how model-generated HTML reached a person — MockupDialog.tsx's
// full-screen dialog and the admin portal's Mockup tab, both loading a
// stored `mockup_html` document from a session-authed route behind a
// Content-Security-Policy (lib/spec/banner.ts's CSP_META, plus a header on
// each serving route). That whole file was deleted alongside those sites, as
// of the mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task
// 6) — its per-site sandbox-attribute checks and its route-CSP checks were
// genuinely about the mockup loop, and went with it.
//
// This ONE arm was never about mockups specifically: it is a sweep of app/
// for the literal string `<iframe`, and what it protects outlives any one
// feature. Having just deleted the CSP guard that made rendering
// model-authored HTML in an iframe safe, this is what would notice if
// rendering model-generated HTML to a person ever comes back on some future
// surface — without its own guard reappearing alongside it. Zero iframes
// under app/ is the expected state now; a future PR that adds one is not
// forbidden outright (a legitimate, non-model-content iframe is
// conceivable), but its arrival has to be a decision someone makes here,
// not a silent add nobody notices.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'

describe('no HTML-rendering surface under app/ goes unnoticed', () => {
  it('has no <iframe> anywhere under app/', () => {
    // --untracked so a brand-new file is caught by a local run before it is
    // ever staged, not just in CI after the fact — the same idiom
    // tests/spec/sandbox.test.ts used before it was deleted.
    //
    // `git grep` exits 1 (not 0) when it finds NOTHING, and execFileSync
    // throws on any non-zero exit — so the passing case here is the one that
    // throws. Caught and translated into an empty match list; any OTHER exit
    // code (a real git error) is left to propagate rather than silently
    // read as "no iframes".
    let found: string[] = []
    try {
      found = execFileSync('git', ['grep', '-l', '--untracked', '<iframe', '--', 'app'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      })
        .split('\n')
        .filter((line) => line !== '')
    } catch (error) {
      const e = error as { status?: number }
      if (e.status !== 1) throw error
    }

    expect(found, `<iframe> found under app/ in: ${found.join(', ')}`).toEqual([])
  })
})
