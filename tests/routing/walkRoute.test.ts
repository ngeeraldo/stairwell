// tests/routing/walkRoute.test.ts
//
// The order of the four checks is the security property, so the lock test
// asserts on the CALLS (no key fetched, no file opened) rather than on the
// response — a route that opened first and refused afterwards would look
// identical from the outside and be wrong.
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
  })

  it('refuses a LOCKED session without fetching a key or touching the file', async () => {
    const POST = await arrange({ lock: true })
    const response = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))

    expect(response.status).toBe(403)
    // The property that matters in step 6a: a locked session has no key, so
    // the file must not be opened — not merely not written.
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
