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
// Safe as a static import, unlike the route module below: lib/time/dayKey.ts
// imports nothing, so evaluating it during vi.mock's hoisting pass touches no
// spy declared further down this file. Its own timezone tests live in
// tests/time/dayKey.test.ts; it is imported here only to check that the row
// the route wrote carries the day the route was asked for.
import { dayKey } from '@/lib/time/dayKey'

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

describe('POST /api/users/[user]/walk', () => {
  it('writes today exactly once, however many times it is tapped', async () => {
    const POST = await arrange()
    const first = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
    const second = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(first.status).toBe(303)
    expect(second.status).toBe(303)
    const rows = walkRows(join(dir, 'users', 'devtwo', 'devtwo.db'), Buffer.alloc(32, 7))
    expect(rows).toHaveLength(1)
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

  it('returns a bodyless 500 and records dashboard_write_error when the encrypted open fails, instead of throwing', async () => {
    // Pre-create devtwo.db under a DIFFERENT key, unmocked and for real, so
    // the route's own open — with the session's real key — hits
    // WrongKeyError from lib/db/encryptedUserDb.ts: same failure mode as a
    // corrupt file, from the opener's point of view. Before the task-3 fix
    // round, openEncryptedUserDb sat outside any try/catch in the route and
    // this would have been a bare 500 with a stack instead.
    const { openEncryptedUserDb } = await import('@/lib/db/encryptedUserDb')
    const seed = openEncryptedUserDb('devtwo', Buffer.alloc(32, 9))
    seed.close()

    const POST = await arrange()
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('')

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    expect(row).toBeDefined()
    const data = JSON.parse(row!.data) as Record<string, unknown>
    // Slug and panel, never the error message: the metrics policy is a slug
    // and a panel and never a value, and the wrong-key message could carry
    // more than that.
    expect(data).toEqual({ slug: 'devtwo', panel: 'walked_today' })

    expect(
      handle!.prepare("SELECT 1 FROM metrics WHERE event = 'dashboard_write'").get(),
    ).toBeUndefined()
  })
})
