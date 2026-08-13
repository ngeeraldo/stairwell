// tests/dashboard/registry.test.ts
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dashboardLoaderFor, registeredSlugs } from '@/lib/dashboard/registry'
import { RESERVED_SLUGS, SLUG_PATTERN } from '@/lib/auth/slug'

// The REAL users/ tree, deliberately — this file's job is to catch a registry
// that has drifted from what is actually on disk, so it must not be pointed
// at a fixture.
const USERS = resolve(__dirname, '..', '..', 'users')

function foldersWithADashboard(): string[] {
  if (!existsSync(USERS)) return []
  return readdirSync(USERS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(USERS, name, 'dashboard.tsx')))
}

describe('dashboardLoaderFor', () => {
  // A bare DASHBOARDS[slug] lookup resolves these three off Object.prototype
  // and hands back a FUNCTION, which the page would then call as a module
  // loader. SLUG_PATTERN happens to exclude them today — that is a
  // coincidence of two unrelated rules, not a guarantee, and it is one
  // accepted slug away from being false.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'returns undefined for the inherited key %s',
    (key) => {
      expect(dashboardLoaderFor(key)).toBeUndefined()
    },
  )

  it('returns undefined for an unregistered slug', () => {
    expect(dashboardLoaderFor('nobody-has-this-slug')).toBeUndefined()
  })
})

describe('registry / disk agreement', () => {
  it('every registered slug has a dashboard.tsx on disk', () => {
    for (const slug of registeredSlugs()) {
      expect(existsSync(join(USERS, slug, 'dashboard.tsx'))).toBe(true)
    }
  })

  // The forgotten-line guard. scripts/new-dashboard.sh prints the registry
  // line rather than editing registry.ts, so this is what turns "forgot to
  // paste it" into a red suite instead of a blank page nobody notices.
  it('every dashboard.tsx on disk is registered', () => {
    expect([...registeredSlugs()].sort()).toEqual(foldersWithADashboard().sort())
  })

  it('every registered slug is a valid, non-reserved slug', () => {
    for (const slug of registeredSlugs()) {
      expect(SLUG_PATTERN.test(slug)).toBe(true)
      expect(RESERVED_SLUGS.has(slug)).toBe(false)
    }
  })
})
