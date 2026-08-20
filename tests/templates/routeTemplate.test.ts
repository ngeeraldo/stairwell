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
//
// TWO SEPARATE THINGS ARE PINNED BELOW, and they are not interchangeable.
// The CODE test locates the four `if` checks by the statement each one
// actually executes (resolveState/canSeeUserSpace/dashboardLoaderFor/the
// accountId-and-key guard) and asserts their positions in the file are
// strictly increasing — that is the actual security property, and it is the
// one that fails if somebody reorders the real `if` blocks. The DOCBLOCK test
// asserts the four numbered phrases in the top comment stay in the order they
// claim to describe — a real but narrower guarantee: this file's comments are
// load-bearing (a copier reads the docblock before the body), so a docblock
// that stops matching the code it describes is its own defect, but it is NOT
// a stand-in for pinning the code. A docblock thirty lines above the body can
// go stale while every `if` below it is reordered and the docblock test would
// never notice — which is exactly why the code test exists as its own,
// separately-named assertion rather than being trusted to cover both.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const TEMPLATE = resolve(__dirname, '..', '..', 'platform', 'templates', 'route', 'route.ts.tmpl')
const text = readFileSync(TEMPLATE, 'utf8')

/** Plain substring count — no regex, so callers never have to escape one. */
function occurrences(needle: string): number {
  return text.split(needle).length - 1
}

/** Asserts each phrase appears exactly once and returns their indices, in the order given. */
function orderedIndices(phrases: string[]): number[] {
  return phrases.map((phrase) => {
    expect(occurrences(phrase), `expected exactly one occurrence of: ${phrase}`).toBe(1)
    return text.indexOf(phrase)
  })
}

function assertStrictlyIncreasing(indices: number[], label: (i: number) => string): void {
  for (let i = 1; i < indices.length; i++) {
    expect(indices[i], `${label(i)} must appear after ${label(i - 1)}`).toBeGreaterThan(
      indices[i - 1]!,
    )
  }
}

describe('platform/templates/route/route.ts.tmpl, the write-route worked example', () => {
  it('runs the four checks IN ORDER — pins the CODE, not the comments', () => {
    // This is the actual security property. Each match string is the
    // statement the check executes, not prose about it, so a reorder of the
    // real `if` blocks moves the match itself and this goes red — a
    // reordered but untouched docblock thirty lines above cannot save it.
    // Each pattern is chosen to appear exactly once in the file — orderedIndices
    // asserts that per pattern — so an index can't accidentally resolve to
    // some other mention (e.g. the import line, or a comment referencing it).
    const checks = [
      'resolveState(',
      'canSeeUserSpace(',
      'dashboardLoaderFor(',
      'accountId === undefined || !key',
    ]
    const indices = orderedIndices(checks)
    assertStrictlyIncreasing(indices, (i) => `check ${i + 1} (${checks[i]})`)
  })

  it('states the four ordered checks in the docblock — pins the NARRATIVE', () => {
    // A narrower, separate guarantee from the test above: the top comment's
    // own four-item enumeration stays in the order it claims. Worth pinning
    // on its own because this file's comments are load-bearing — a copier
    // reads the docblock first — but this alone does NOT prove the code
    // below still runs in that order; see the code test above for that.
    const phrases = [
      'unlocked — not merely authenticated',
      'ownership — 404, never 403',
      'a registered dashboard — otherwise any authenticated slug',
      'only then: key, open, write, close',
    ]
    const indices = orderedIndices(phrases)
    assertStrictlyIncreasing(indices, (i) => `docblock item ${i + 1}`)
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

  it('names no friend and no friend-specific route — it outlives users/', () => {
    // The stated reason this file lives under platform/ (its own docblock) is
    // that everything under users/ is deleted at pilot end, so a doc pointing
    // into a folder that no longer exists goes dead. A template that names a
    // slug, or a sibling route that only exists to serve one, breaks that on
    // the same day. The `pee` sweep above is the same rule for the folder this
    // file was copied FROM; this one is the rule for every other folder.
    expect(text).not.toMatch(/\brun\d+\b/i)
    expect(text).not.toMatch(/\bdevone\b/i)
    expect(text).not.toMatch(/\bdevtwo\b/i)
    // 'the walk route' named app/api/users/[user]/walk/route.ts. Both it and
    // devtwo are still here today; the route exists to serve devtwo alone, so
    // it GOES WITH devtwo at pilot end — which is this sweep's whole
    // justification, not a claim that either is already gone. The comments
    // that cited it now describe the shape (a day-keyed table) instead of the
    // instance.
    expect(text).not.toMatch(/walk/i)
  })

  it('answers a fetch-initiated write with 204, and says so in the docblock', () => {
    // Item 1 of the final whole-branch review: the docblock used to tell a
    // copier that WriteAction "expects an ordinary 2xx or a redirect", which
    // is precisely what the 204/303 split forbids on the fetch path. The CODE
    // test above pins writeAnswer; this pins the PROSE a copier reads first,
    // for the same reason the four-checks narrative is pinned separately from
    // the four checks.
    expect(text).toMatch(/must NOT be answered with a redirect/)
    expect(text).not.toMatch(/expects an ordinary 2xx or a redirect/)
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
