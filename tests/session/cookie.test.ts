// tests/session/cookie.test.ts
//
// lib/session/cookie.ts exists specifically so middleware.ts (Edge Runtime)
// can read SESSION_COOKIE without pulling in lib/session/store.ts's
// `node:crypto` import — see lib/session/cookie.ts's own comment for the
// `next build` failure this fixes. A static scan is the only thing that
// pins this property going forward: nothing about vitest (which never
// bundles for the Edge Runtime) or `tsc --noEmit` would catch a future
// `node:` import landing back in this file.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { COOKIE_OPTIONS, SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/session/cookie'

describe('cookie config', () => {
  it('exports the expected constants', () => {
    expect(SESSION_COOKIE).toBe('stairwell_session')
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(COOKIE_OPTIONS.maxAge).toBe(SESSION_TTL_MS / 1000)
  })

  // lib/http/redirect.ts is on middleware.ts's allowlist above, so it reaches
  // the edge bundle and needs the same scan cookie.ts gets. Without this, the
  // allowlist entry would be a hole: an allowlisted module is trusted, and
  // nothing else checks what it imports.
  it('has no node: import and no require() anywhere in lib/http/redirect.ts', () => {
    const source = readFileSync('lib/http/redirect.ts', 'utf8')
    expect(source.length).toBeGreaterThan(0)
    expect(
      source,
      'lib/http/redirect.ts must stay importable from the Edge Runtime',
    ).not.toMatch(/from\s+['"]node:|require\(/)
  })

  it('has no node: import and no require() anywhere in lib/session/cookie.ts', () => {
    const source = readFileSync('lib/session/cookie.ts', 'utf8')
    // Matches both `from 'node:x'` and bare-specifier Node builtins like
    // `from 'crypto'`/`from 'fs'` would also be worth catching, but the
    // concrete regression this file exists to prevent is the `node:`-scheme
    // form (that's what tripped webpack's edge bundler in lib/session/store.ts),
    // so that's what's pinned here, plus require() for completeness.
    const offending = /from\s+['"]node:|require\(/
    expect(
      source,
      'lib/session/cookie.ts must stay importable from the Edge Runtime',
    ).not.toMatch(offending)
  })
})

describe('middleware edge-safety', () => {
  it("imports only from an edge-safe allowlist (direct imports only, not a full transitive module-graph walk)", () => {
    // This is deliberately shallow: it checks middleware.ts's own import
    // specifiers against an allowlist, not what those modules themselves
    // import. That shallow check is exactly what would have caught the
    // original regression, though — middleware.ts's own import line named
    // '@/lib/session/store', a module that (one hop away) pulls in
    // `node:crypto`. A true transitive check would need a real bundler or
    // AST-based module-graph walk, which is out of scope for a unit test;
    // this test plus tests/session/cookie.test.ts's node:-import scan on
    // '@/lib/session/cookie' together cover the two hops that actually
    // exist in this file today, but a THIRD hop (allowlisted module A
    // importing not-independently-scanned module B which imports
    // `node:fs`) would NOT be caught by either test.
    const source = readFileSync('middleware.ts', 'utf8')
    const importRe = /^import\s+[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm
    const specifiers: string[] = []
    let match: RegExpExecArray | null
    while ((match = importRe.exec(source))) {
      specifiers.push(match[1]!)
    }
    // An empty match set would make the loop below assert nothing and pass
    // silently — guard against a regex that stopped matching (e.g. after a
    // reformat to a different import style).
    expect(specifiers.length).toBeGreaterThan(0)

    const allowlist = new Set([
      'next/server',
      '@/lib/session/cookie',
      // Added when middleware's absolute redirect was replaced by a relative
      // one (see lib/http/redirect.ts for the live failure that motivated it).
      // Edge-safe: its only import is next/server, and the node:-scan below
      // covers it alongside cookie.ts.
      '@/lib/http/redirect',
    ])
    for (const spec of specifiers) {
      expect(
        allowlist.has(spec),
        `middleware.ts imports '${spec}', which is not on the edge-safe allowlist`,
      ).toBe(true)
    }
  })
})
