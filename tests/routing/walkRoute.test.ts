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
/**
 * `headers` is stubbed alongside `cookies` because lib/metrics/deviceClass.ts
 * reads the User-Agent as its fallback when no stairwell_dc cookie exists
 * (onboarding ledger D4). An empty header map is the honest fixture — it is
 * exactly what a request with neither cookie nor UA looks like — and it
 * resolves to 'desktop', which is what the device_class assertions below
 * expect.
 */
const emptyHeaders = { get: () => null }

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => emptyHeaders,
}))

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

/**
 * Capture stderr for one call. The logDbFailure line is the ONLY signal an
 * operator gets that tells a permissions failure from a corrupt file — the
 * metric deliberately carries a slug and a panel and nothing else — so the
 * call sites are pinned here, not just the helper in tests/db/failureLog.test.ts.
 * Without this, deleting the console.error from a catch reddens nothing.
 */
async function withStderr<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    return [await fn(), lines.join('\n')]
  } finally {
    spy.mockRestore()
  }
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
    return db.prepare('SELECT day, at FROM walks ORDER BY day').all() as {
      day: string
      at: number
    }[]
  } finally {
    db.close()
  }
}

describe('POST /api/users/[user]/walk', () => {
  it('writes today exactly once, however many times it is tapped', async () => {
    // Row COUNT alone is the weak form of "a double tap is a no-op": swapping
    // INSERT OR IGNORE for INSERT OR REPLACE keeps exactly one row while
    // rewriting `at`, and reddened nothing before this test also checked the
    // timestamp. The clock is driven deliberately so the second tap carries a
    // demonstrably different `at` — otherwise two taps in the same millisecond
    // would make the assertion vacuous.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 7, 13, 9, 0, 0))
      const firstInstant = Date.now()
      const POST = await arrange()
      const first = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
      const dbPath = join(dir, 'users', 'devtwo', 'devtwo.db')
      const afterFirst = walkRows(dbPath, Buffer.alloc(32, 7))

      // Same local day, an hour later: a replacing write would move `at`.
      vi.setSystemTime(new Date(2026, 7, 13, 10, 0, 0))
      const secondInstant = Date.now()
      expect(secondInstant).not.toBe(firstInstant)

      const second = await POST(new Request('http://x', { method: 'POST' }), params('devtwo'))
      const afterSecond = walkRows(dbPath, Buffer.alloc(32, 7))

      expect(first.status).toBe(303)
      expect(second.status).toBe(303)
      expect(afterSecond).toHaveLength(1)
      expect(afterSecond[0]?.day).toBe(dayKey(secondInstant))
      // The row the FIRST tap wrote is the row that is still there, untouched.
      expect(afterSecond[0]?.at).toBe(afterFirst[0]?.at)
      expect(afterSecond[0]?.at).toBe(firstInstant)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a bodyless 500 and records dashboard_write_error when the WRITE itself throws', async () => {
    // The open had a catch; the INSERT below it had only a finally. A full
    // disk, a SQLITE_BUSY outliving the driver's timeout, or — once 6b changes
    // a schema an existing file was frozen at — a missing table threw straight
    // out of POST. The friend would get Next's default error page in response
    // to a form submit, with no dashboard, no chat surface and no way back but
    // the browser's back button, and NO metric row, so the operator could not
    // see it either.
    //
    // Forced through the real code path rather than by mocking the opener: a
    // trigger in this user's own schema aborts the insert, so the open
    // succeeds and the write is what fails. That is the shape of every case
    // above.
    writeFileSync(
      join(dir, 'users', 'devtwo', 'schema.sql'),
      `${SCHEMA}
       CREATE TRIGGER IF NOT EXISTS refuse_writes BEFORE INSERT ON walks
       BEGIN SELECT RAISE(ABORT, 'SIMULATED WRITE FAILURE TEST'); END;`,
    )

    const POST = await arrange()
    const [response, stderr] = await withStderr(() =>
      POST(new Request('http://x', { method: 'POST' }), params('devtwo')),
    )

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('')

    // The operator's only handle on WHICH failure this was. A trigger abort is
    // SQLITE_CONSTRAINT_TRIGGER; a full disk would be SQLITE_FULL. Neither is
    // distinguishable from the metric row, which is the point.
    expect(stderr).toContain('dashboard_write_error')
    expect(stderr).toContain('devtwo')
    expect(stderr).toContain('SQLITE_CONSTRAINT_TRIGGER')
    // ...and the planted abort message is not in the log either.
    expect(stderr).not.toContain('SIMULATED')

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    expect(row).toBeDefined()
    // Slug and panel, never the exception text — the abort message is the
    // planted string above, and it must not reach the append-only column.
    expect(JSON.parse(row!.data)).toEqual({
      slug: 'devtwo',
      panel: 'walked_today',
      device_class: 'desktop',
    })
    expect(row!.data).not.toContain('SIMULATED')

    // And no success row: a failed tap must not look like a logged day.
    expect(
      handle!.prepare("SELECT 1 FROM metrics WHERE event = 'dashboard_write'").get(),
    ).toBeUndefined()
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
    expect(data).toEqual({
      slug: 'devtwo',
      panel: 'walked_today',
      device_class: 'desktop',
    })
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
    const [response, stderr] = await withStderr(() =>
      POST(new Request('http://x', { method: 'POST' }), params('devtwo')),
    )

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('')

    // Named, so a wrong key is diagnosable as a wrong key rather than as an
    // anonymous 500.
    expect(stderr).toContain('WrongKeyError')

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    expect(row).toBeDefined()
    const data = JSON.parse(row!.data) as Record<string, unknown>
    // Slug and panel, never the error message: the metrics policy is a slug
    // and a panel and never a value, and the wrong-key message could carry
    // more than that.
    expect(data).toEqual({
      slug: 'devtwo',
      panel: 'walked_today',
      device_class: 'desktop',
    })

    expect(
      handle!.prepare("SELECT 1 FROM metrics WHERE event = 'dashboard_write'").get(),
    ).toBeUndefined()
  })
})
