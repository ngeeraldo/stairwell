// tests/users/plaidSurface.test.ts
//
// EVERY FINANCE DASHBOARD RENDERS THE SHARED BANK MANAGEMENT SURFACE.
//
// This test exists because a doc line was not enough, and we know that because
// a doc line already failed. docs/dashboard-build-rules.md §9.5 LISTED the
// Plaid controls as components available to a builder. The run11 builder wired
// up exactly what that friend's spec asked for and no more, and shipped a
// screen a friend could connect a bank to once and never manage again — no way
// to add a second, see when it last updated, reconnect a broken one, or remove
// it. Nothing was violated. There was nothing to violate.
//
// So the requirement is a sweep now (2026-08-21 plan, D4).
//
// ── THE CONDITION IS A FILE, NOT A JUDGEMENT ────────────────────────────────
//
// A folder is "a finance dashboard" if it vendored a `_module_plaid`
// migration. Nothing here has to decide whether a dashboard is financial in
// spirit, which is the kind of question a sweep answers badly and
// inconsistently. If a folder holds the Plaid envelope, its friend can connect
// a bank, and a friend who can connect a bank can always manage it.
//
// ── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────────────
//
// Where the surface goes on the page, what surrounds it, or what the rest of
// the dashboard looks like. Those are the builder's, and the spec's. This
// asserts only that the friend is not left without a way out.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const USERS_DIR = resolve(__dirname, '..', '..', 'users')

/** Folders that vendored the Plaid envelope, and so belong to a friend with a bank. */
function financeFolders(): string[] {
  return readdirSync(USERS_DIR).filter((slug) => {
    const migrations = resolve(USERS_DIR, slug, 'migrations')
    return (
      existsSync(migrations) && readdirSync(migrations).some((f) => f.includes('_module_plaid'))
    )
  })
}

describe('every dashboard with a bank can manage it', () => {
  it('has at least one finance folder, or this sweep proves nothing', () => {
    expect(financeFolders().length).toBeGreaterThan(0)
  })

  it.each(financeFolders())('users/%s renders the shared source list', (slug) => {
    const dashboard = resolve(USERS_DIR, slug, 'dashboard.tsx')
    expect(existsSync(dashboard)).toBe(true)
    const source = readFileSync(dashboard, 'utf8')

    // Imported from lib/ui, not reimplemented. A folder that grew its own bank
    // list would pass a "renders something" check while drifting from every
    // other friend's — which is the fork the shared-module rule forbids
    // (CLAUDE.md > Schema & module rules), applied to the UI.
    expect({ slug, imports: /from '@\/lib\/ui\/PlaidSources'/.test(source) }).toEqual({
      slug,
      imports: true,
    })
    expect({ slug, renders: /<PlaidSources\b/.test(source) }).toEqual({ slug, renders: true })
  })
})
