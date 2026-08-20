// tests/templates/routeTemplate.test.ts
//
// PINS platform/templates/route/route.ts.tmpl — the write-route worked
// example docs/dashboard-build-rules.md and platform's own scaffold cite
// once users/devtwo/tests/write.test.ts and app/api/users/[user]/pee/route.ts
// stop being pointed at (everything under users/ is deleted at pilot end).
//
// NOTHING ELSE IN THE SUITE READS THIS FILE. `.tmpl` is not compiled by
// `tsc` or `next build`, `tests/users/conventions.test.ts` sweeps only
// `users/<slug>/`, and `tests/users/noLocalDay.test.ts`'s SHIPPED list covers
// only `dashboard.tsx.tmpl`/`queries.ts.tmpl`. `scripts/new-dashboard.sh`
// never copies `platform/templates/route/` either — a builder copies this
// file BY HAND when a spec needs a write path. So the four ordered auth
// checks that make this file safe to copy — a security property, not a
// style choice — rest entirely on human review discipline unless something
// here notices the text rotting. This is that something: a content sweep in
// the style of tests/users/noLocalDay.test.ts, reading the template's own
// text and asserting on it, not executing it.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const TEMPLATE = resolve(__dirname, '..', '..', 'platform', 'templates', 'route', 'route.ts.tmpl')
const text = readFileSync(TEMPLATE, 'utf8')

describe('platform/templates/route/route.ts.tmpl, the write-route worked example', () => {
  it('states the four ordered checks, IN ORDER', () => {
    // Order is the property being pinned. A test that only checked presence
    // would still pass on a file with checks 2 and 3 swapped — these four
    // phrases are the docblock's own enumeration of the order, so asserting
    // their indices are strictly increasing is asserting the order itself,
    // not just that all four words showed up somewhere.
    const phrases = [
      'unlocked — not merely authenticated',
      'ownership — 404, never 403',
      'a registered dashboard — otherwise any authenticated slug',
      'only then: key, open, write, close',
    ]
    const indices = phrases.map((phrase) => {
      const index = text.indexOf(phrase)
      expect(index, `expected to find: ${phrase}`).toBeGreaterThanOrEqual(0)
      return index
    })
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i], `check ${i + 1} must appear after check ${i}`).toBeGreaterThan(
        indices[i - 1]!,
      )
    }
  })

  it('answers with writeAnswer, never relativeRedirect', () => {
    // The one that matters most. relativeRedirect always 303s; writeAnswer
    // only 303s a native form post and answers a fetch-initiated write with
    // a bare 204. A template that drifted back to relativeRedirect would
    // teach the next builder to reintroduce exactly the bug this branch
    // fixed: fetch defaults to redirect:'follow', so the 303 gets followed,
    // the whole dashboard renders a SECOND time, and a second permanent
    // dashboard_open row lands in an append-only table that can never be
    // cleaned up.
    expect(text).toMatch(/writeAnswer\(request/)
    expect(text).not.toMatch(/relativeRedirect/)
  })

  it('keeps both catch blocks and their failure-reporting calls', () => {
    // A full disk, a wrong key, or a missing table must not become a bare
    // 500 with a stack trace and no metric row — see this file's own
    // comments on the open and the write. Two sites, two catches: the open
    // (openUserDataForWrite) and the write (the INSERT/DELETE). Each must
    // log to stderr (logDbFailure) AND record the failure where the operator
    // can see it (appendMetric), or a friend's write can fail silently and
    // invisibly at once.
    const catchCount = (text.match(/\}\s*catch\s*\(error\)\s*\{/g) ?? []).length
    expect(catchCount).toBe(2)
    expect((text.match(/logDbFailure\(/g) ?? []).length).toBe(2)
    expect((text.match(/appendMetric\(/g) ?? []).length).toBe(3) // 2 failure rows + 1 success row
  })

  it('leaks no pee-specific identifier through the generalisation', () => {
    // route.ts.tmpl was copied from app/api/users/[user]/pee/route.ts and
    // hand-generalised (pee_logs -> <TABLE>, the two panel literals ->
    // <panel_for_add>/<panel_for_remove>). This is the sweep that would
    // catch a copy-paste left half-finished — a stray 'pee_logs' or
    // 'pee_log'/'pee_correction' literal a future edit reintroduces.
    expect(text).not.toMatch(/pee/i)
  })

  it('names two distinct panel placeholders, not one repeated', () => {
    // A single placeholder reused on both branches of the ternary reads as a
    // no-op and gives a copier no signal that add and remove need different
    // panel names (they are two distinct events a metrics query groups by).
    expect(text).toMatch(/'<panel_for_add>'/)
    expect(text).toMatch(/'<panel_for_remove>'/)
    expect(text).not.toMatch(/const panel = action === 'add' \? '(.+)' : '\1'/)
  })

  it('generalises the table name consistently', () => {
    // Every reference to the write path's own table became the same
    // placeholder — a template that generalised the INSERT but missed a
    // DELETE would silently teach a copier to write to one table and read
    // from another.
    expect(text).not.toMatch(/pee_logs/)
    expect((text.match(/<TABLE>/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
