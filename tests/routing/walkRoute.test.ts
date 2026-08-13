// tests/routing/walkRoute.test.ts
//
// The order of the four checks is the security property. resolveState()
// itself calls getKey() internally (see lib/session/resolve.ts), so "no key
// was fetched" can never be an assertion this suite can make — it would be
// false the moment resolveState runs, whether or not check 1 short-circuits.
// Instead the lock test asserts that canSeeUserSpace (check 2) is never
// called, alongside the response status and the absence of the encrypted
// file: a route that opened the file and refused afterwards would look
// identical from the outside on status and file-existence alone, and would
// still be wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }))

const loaderSlot: { value: unknown } = { value: undefined }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => loaderSlot.value,
  registeredSlugs: () => ['devtwo'],
}))

// canSeeUserSpace and accountIdFor delegate to the real implementations, so
// every test but the lock test sees real behaviour. The spies are declared
// here, outside the factory, and the factory only calls mockImplementation
// on them — vi.resetModules() in beforeEach re-runs the factory on the next
// dynamic import, but it re-targets these same persistent vi.fn identities
// rather than replacing them, so call counts survive until mockClear().
const canSeeUserSpaceSpy = vi.fn()
const accountIdForSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>(
      '@/lib/auth/authorize',
    )
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  accountIdForSpy.mockImplementation(actual.accountIdFor)
  return {
    ...actual,
    canSeeUserSpace: canSeeUserSpaceSpy,
    accountIdFor: accountIdForSpy,
  }
})

const SCHEMA = `CREATE TABLE IF NOT EXISTS walks (
  day TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);`

let dir: string
let handle: PlatformDb | undefined
let accountId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-walk-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  mkdirSync(join(dir, 'users', 'devtwo'), { recursive: true })
  writeFileSync(join(dir, 'users', 'devtwo', 'schema.sql'), SCHEMA)
  vi.resetModules()
  cookieGet.mockClear()
  canSeeUserSpaceSpy.mockClear()
  accountIdForSpy.mockClear()
  cookieSlot.value = undefined
  loaderSlot.value = async () => ({ default: () => null })
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  delete process.env.USERS_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** Sign devtwo in. `lock` withholds the key, as a restart would. */
async function arrange(opts: { lock?: boolean; slug?: string } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: opts.slug ?? 'devtwo',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) putKey(sid, Buffer.alloc(32, 7))
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/walk/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

/**
 * dayKey is pure and does not depend on any mocked module, but it lives in
 * route.ts alongside imports of the mocked '@/lib/auth/authorize'. A static
 * top-level `import { dayKey } from '...'` would force route.ts to be
 * evaluated during vi.mock's hoisting pass — before the module-scope spy
 * declarations below run — and throw a TDZ error. A dynamic import, used
 * only inside test bodies, defers that evaluation until after setup.
 */
async function importDayKey() {
  return (await import('@/app/api/users/[user]/walk/route')).dayKey
}

function walkRows(dbPath: string, key: Buffer) {
  // Opened directly rather than through the route's own opener, so the test
  // proves the row is really on disk under that key.
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(dbPath)
  db.pragma("cipher='chacha20'")
  db.key(key)
  try {
    return db.prepare('SELECT day FROM walks ORDER BY day').all() as { day: string }[]
  } finally {
    db.close()
  }
}

describe('dayKey', () => {
  it('yields the LOCAL calendar day, and diverges from ISO/UTC off-UTC', async () => {
    const dayKey = await importDayKey()
    // Two fixed local instants, chosen to straddle midnight from each side:
    // a late evening (23:30) and an early morning (00:30) on the same
    // nominal local date. dayKey must report that same local date for both,
    // regardless of the host's timezone.
    const evening = new Date(2026, 7, 12, 23, 30, 0).getTime() // Aug is month 7 (0-based)
    const morning = new Date(2026, 7, 12, 0, 30, 0).getTime()
    expect(dayKey(evening)).toBe('2026-08-12')
    expect(dayKey(morning)).toBe('2026-08-12')

    // Pinning that dayKey is NOT `new Date(at).toISOString().slice(0, 10)`:
    // a late-evening local instant rolls onto the NEXT UTC day when local
    // time is BEHIND UTC (getTimezoneOffset() > 0, e.g. the Americas); an
    // early-morning local instant rolls onto the PREVIOUS UTC day when
    // local time is AHEAD of UTC (getTimezoneOffset() < 0, e.g.
    // Asia/Tokyo). Exactly one of the two diverges for any real non-UTC
    // timezone, which is why the branch is picked from the host's own
    // offset rather than hardcoded. At UTC itself (offset === 0) neither
    // instant can diverge — the two equality checks above are the only
    // assertions this test can make in that environment, and this branch
    // asserts nothing further. This is stated plainly rather than silently
    // passing: the divergence check below is only discriminating off-UTC.
    const offsetMinutes = new Date().getTimezoneOffset()
    if (offsetMinutes > 0) {
      expect(dayKey(evening)).not.toBe(new Date(evening).toISOString().slice(0, 10))
    } else if (offsetMinutes < 0) {
      expect(dayKey(morning)).not.toBe(new Date(morning).toISOString().slice(0, 10))
    }
  })
})

describe('POST /api/users/[user]/walk', () => {
  it('writes today exactly once, however many times it is tapped', async () => {
    const POST = await arrange()
    const first = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
    const second = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(first.status).toBe(303)
    expect(second.status).toBe(303)
    const rows = walkRows(join(dir, 'users', 'devtwo', 'devtwo.db'), Buffer.alloc(32, 7))
    expect(rows).toHaveLength(1)
    const dayKey = await importDayKey()
    expect(rows[0]?.day).toBe(dayKey(Date.now()))
  })

  it('refuses a LOCKED session without reaching check 2 or touching the file', async () => {
    const POST = await arrange({ lock: true })
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(403)
    // The property that matters in step 6a: check 1 must short-circuit
    // before check 2 (ownership) ever runs. canSeeUserSpace is the earliest
    // call a locked session must never reach.
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    // A locked session has no key, so the file must not be opened — not
    // merely not written.
    expect(existsSync(join(dir, 'users', 'devtwo', 'devtwo.db'))).toBe(false)
  })

  it('404s a non-owner and creates nothing', async () => {
    const POST = await arrange({ slug: 'devone' })
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(404)
    expect(existsSync(join(dir, 'users', 'devtwo', 'devtwo.db'))).toBe(false)
  })

  it('404s a slug with no registered dashboard, so no file can be conjured', async () => {
    loaderSlot.value = undefined
    const POST = await arrange()
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(404)
    expect(existsSync(join(dir, 'users', 'devtwo', 'devtwo.db'))).toBe(false)
  })

  it('records dashboard_write with a slug and a panel and NO value', async () => {
    // The permanent metrics policy. "They tapped" and "they walked the dog"
    // are the same fact here, so the row must carry neither the day nor a
    // count — see architecture-overview.md section 4 and the promise sentence
    // it makes true.
    const POST = await arrange()
    await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .get() as { data: string } | undefined
    expect(row).toBeDefined()
    const data = JSON.parse(row!.data) as Record<string, unknown>
    expect(data).toEqual({ slug: 'devtwo', panel: 'walked_today' })
    expect(JSON.stringify(data)).not.toContain('20')
  })

  it('redirects host-relative, never with an absolute origin', async () => {
    // The app runs behind a proxy: an absolute Location built from request.url
    // names the internal origin and every local check still passes.
    const POST = await arrange()
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
    expect(response.headers.get('location')).toBe('/devtwo')
  })
})
