// tests/scripts/dev.test.ts
//
// Route DISCOVERY for the dev warm-up. The network half of scripts/dev.ts is
// not tested here — CLAUDE.md > Testing forbids the default suite from
// reaching one — but discovery is the half that can silently go wrong, and it
// fails in the worst possible way: warming a stale list looks identical to
// warming a complete one, right up until a friend's flow 403s mid-connect.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiRoutePaths, pagePaths } from '@/scripts/warmPaths'
import { registeredSlugs } from '@/lib/dashboard/registry'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-warm-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function route(...segments: string[]): void {
  const full = join(dir, ...segments)
  mkdirSync(full, { recursive: true })
  writeFileSync(join(full, 'route.ts'), 'export async function POST() {}')
}

describe('apiRoutePaths', () => {
  it('finds a nested route', () => {
    route('users', '[user]', 'plaid', 'connect')
    expect(apiRoutePaths(dir)).toEqual(['/api/users/warmup/plaid/connect'])
  })

  it('replaces every dynamic segment, so the path actually matches', () => {
    // Next compiles a route as soon as a request MATCHES its pattern. A
    // literal '[user]' in the URL would match nothing and compile nothing,
    // while still looking like a successful warm-up.
    route('a', '[one]', 'b', '[two]')
    expect(apiRoutePaths(dir)).toEqual(['/api/a/warmup/b/warmup'])
  })

  it('handles a catch-all segment', () => {
    route('files', '[...path]')
    expect(apiRoutePaths(dir)).toEqual(['/api/files/warmup'])
  })

  it('ignores files that are not route handlers', () => {
    route('real')
    mkdirSync(join(dir, 'helpers'), { recursive: true })
    writeFileSync(join(dir, 'helpers', 'shared.ts'), 'export const x = 1')
    expect(apiRoutePaths(dir)).toEqual(['/api/real'])
  })

  it('returns a stable, sorted list', () => {
    route('zebra')
    route('alpha')
    expect(apiRoutePaths(dir)).toEqual(['/api/alpha', '/api/zebra'])
  })
})

describe('against this repo’s real app/api tree', () => {
  // The assertion that actually protects the flow: discovery must find the
  // routes that exist TODAY, including every Plaid one. A regression here is
  // how the warm-up would quietly stop covering the thing it was built for.
  const paths = apiRoutePaths(resolve(__dirname, '..', '..', 'app', 'api'))

  it('finds all three Plaid connection routes', () => {
    expect(paths).toContain('/api/users/warmup/plaid/link-token')
    expect(paths).toContain('/api/users/warmup/plaid/connect')
    expect(paths).toContain('/api/users/warmup/plaid/disconnect')
  })

  it('finds the auth routes too, since they compile mid-flow as well', () => {
    expect(paths).toContain('/api/login')
    expect(paths).toContain('/api/unlock')
  })

  it('finds every route.ts under app/api, not a hand-kept subset', () => {
    // If this number moves, a route was added or removed — which is fine. What
    // is not fine is discovery finding FEWER routes than exist on disk.
    expect(paths.length).toBeGreaterThanOrEqual(12)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('pagePaths — discovered, never listed', () => {
  const pages = pagePaths(resolve(__dirname, '..', '..', 'app'))

  it('covers /plaid/oauth, the page that caused this to be rewritten', () => {
    // This function used to warm only registered DASHBOARDS. /plaid/oauth is
    // not a dashboard, so it was never warmed — and loading it during an OAuth
    // bank connection compiled it for the first time, wiped the keymap, and
    // 403'd the exchange seconds later, at the very end of a flow that had
    // otherwise worked.
    expect(pages).toContain('/plaid/oauth')
  })

  it('strips route groups, which do not appear in the URL', () => {
    // app/(auth)/login/page.tsx is served at /login. Warming '/(auth)/login'
    // would 404 and compile nothing while looking like it had worked.
    expect(pages).toContain('/login')
    expect(pages).toContain('/unlock')
    expect(pages.some((p) => p.includes('('))).toBe(false)
  })

  it('collapses dynamic segments so the path actually matches a route', () => {
    expect(pages).toContain('/warmup')
    expect(pages.some((p) => p.includes('['))).toBe(false)
  })

  it('skips app/api, which apiRoutePaths owns and POSTs to instead', () => {
    expect(pages.some((p) => p.startsWith('/api/'))).toBe(false)
  })
})

describe('dashboard slugs are warmed on top of the pages', () => {
  it('every registered dashboard has a page to warm', () => {
    // pagePaths warms app/[user]/page.tsx under a PLACEHOLDER slug, which
    // compiles the page but not the dashboard component — that arrives through
    // a dynamic import in lib/dashboard/registry.ts which only runs for a slug
    // actually registered. So both lists are needed and neither covers the
    // other. Unlocking redirects straight to `/<slug>`, so without this a new
    // dashboard compiles at the exact moment a key has just been created.
    const slugs = registeredSlugs()
    expect(slugs.length).toBeGreaterThan(0)
    expect(slugs).toContain('plaidtest')
  })
})
