// tests/templates/dashboardTemplate.test.ts
//
// PINS platform/templates/dashboard/dashboard.tsx.tmpl's component-rule
// comment. Every new dashboard is scaffolded from this file
// (./scripts/new-dashboard.sh), so its docblock is the first thing a builder
// reads about what a dashboard may compose.
//
// This test exists because of a real defect, not a hypothetical one:
// docs/dashboard-build-rules.md and docs/runbook-ai.md used to state
// "compose only host elements — never a nested function component"
// absolutely, contradicted by every dashboard's own <Card> and <Button>.
// Fix round 1 of the 2026-08-20 client-side-write-actions docs task replaced
// that absolute rule with the three-arm component rule (presentational
// trusted, data-computing sanctioned/guarded, interaction controls
// sanctioned/default) everywhere EXCEPT this file — the exact file the
// deleted doc bullet had cited as the rule's source, so removing the doc
// text left the rule alive at the place the doc pointed to. Nothing else in
// the suite reads this file's prose (`.tmpl` is not compiled), so a content
// sweep, in the style of tests/templates/routeTemplate.test.ts, is what
// would catch the absolute rule creeping back in.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const TEMPLATE = resolve(
  __dirname,
  '..',
  '..',
  'platform',
  'templates',
  'dashboard',
  'dashboard.tsx.tmpl',
)
const text = readFileSync(TEMPLATE, 'utf8')

describe('platform/templates/dashboard/dashboard.tsx.tmpl, the scaffold every dashboard is copied from', () => {
  it('states the three-arm component rule, not the deleted absolute one', () => {
    expect(text).toMatch(/THE COMPONENT RULE HAS THREE ARMS/)
    expect(text).toMatch(/TRUSTED/)
    expect(text).toMatch(/SANCTIONED/)
    expect(text).toMatch(/DEFAULT for every write/)
  })

  it('never re-states "compose only host elements" as an absolute rule', () => {
    // The exact phrase this fix round deleted — case-insensitive, because
    // the rule has shipped under two castings: the TEMPLATE's own upper-cased
    // "COMPOSE ONLY HOST ELEMENTS" (verify at
    // 135831f:platform/templates/dashboard/dashboard.tsx.tmpl:27 — the
    // template's line 27, not this test file's; this test file did not exist
    // yet at that commit) and the sentence-cased "Compose only host elements"
    // that docs/dashboard-build-rules.md:175 and docs/runbook-ai.md:218
    // carried before task 8 replaced both (verify at 135831f^). A casing
    // change must not be what lets either version back in.
    expect(text).not.toMatch(/compose only host elements/i)
  })

  it('cites docs/dashboard-build-rules.md §3 as where the full rule lives', () => {
    expect(text).toMatch(/docs\/dashboard-build-rules\.md §3/)
  })

  it('still ships the WriteAction default it describes', () => {
    // The three-arm rule names interaction controls as arm 3 and the
    // default for every write; the template's own worked write-control
    // example below the docblock is what makes that concrete.
    expect(text).toMatch(/WriteAction/)
  })
})
