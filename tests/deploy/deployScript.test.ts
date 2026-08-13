// tests/deploy/deployScript.test.ts
//
// A static scan, in the idiom of tests/deploy/service.test.ts: nothing in this
// repo can run deploy.sh, so the ordering property it must hold is pinned by
// reading it.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const script = readFileSync('deploy/deploy.sh', 'utf8')

describe('deploy/deploy.sh', () => {
  it('regenerates synthetic user databases', () => {
    expect(script).toContain('scripts/regen-synthetic.ts')
  })

  it('regenerates them BEFORE the test gate', () => {
    // users/*/synthetic.db is gitignored, so a fresh checkout has none. Tests
    // that run first would exercise the "data has not been generated yet"
    // path and pass, proving nothing about the deploy.
    const regen = script.indexOf('scripts/regen-synthetic.ts')
    const gate = script.indexOf('npx vitest run')
    expect(regen).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(-1)
    expect(regen).toBeLessThan(gate)
  })

  it('regenerates them AFTER npm ci', () => {
    // regen-synthetic.ts is run with `npx tsx`, which resolves `tsx` from
    // node_modules — moving this block above `npm ci` would still satisfy
    // the "before the test gate" ordering above while making every deploy
    // resolve `tsx` from the network (or fail outright on a clean checkout).
    //
    // Matched against the actual invocation LINE, not a bare indexOf('npm
    // ci'): the comment above step 2b already says "...BEFORE npm ci so a
    // missing variable...", earlier in the file than either the real `npm
    // ci` call or the regen block, so a plain substring search would find
    // that comment and pass no matter which order the real steps run in.
    const ciMatch = script.match(/^\s*npm ci\s*$/m)
    const regen = script.indexOf('scripts/regen-synthetic.ts')
    expect(ciMatch).not.toBeNull()
    expect(regen).toBeGreaterThan(-1)
    expect(ciMatch!.index!).toBeLessThan(regen)
  })

  it('aborts the deploy when regeneration fails', () => {
    // Guarded by `if ! ...; then ... exit 1; fi`, not by a bare call whose
    // failure `set -e` would... also catch, but silently, with no line saying
    // which step died in the deploy log.
    expect(script).toMatch(
      /if ! npx tsx scripts\/regen-synthetic\.ts; then[\s\S]{0,400}?exit 1/,
    )
  })
})
