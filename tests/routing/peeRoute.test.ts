// tests/routing/peeRoute.test.ts
//
// run9's write path — the ONLY thing pinning app/api/users/[user]/pee/route.ts.
// users/run9/tests/write.test.ts reproduces the route's two statements by hand
// (a platform route must not be imported by a user's test), so nothing there
// goes red if this route's SQL changes. This file is that half.
//
// Modelled on tests/routing/walkRoute.test.ts, including its mocking shape and
// the reason for it: the order of the four checks IS the security property.
// resolveState() itself calls getKey() internally, so "no key was fetched" can
// never be an assertion this suite can make — instead the lock test asserts
// canSeeUserSpace (check 2) is never called, alongside the status and the
// absence of the encrypted file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { setNodeEnv } from '@/tests/support/nodeEnv'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
// Safe as a static import, unlike the route module below: lib/time/dayKey.ts
// imports nothing, so evaluating it during vi.mock's hoisting pass touches no
// spy declared further down this file.
import { dayKey } from '@/lib/time/dayKey'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
/**
 * The friend's timezone, as the browser reports it in `stairwell_tz`.
 *
 * Undefined by default, so every test that does not care about zones gets the
 * UTC fallback and stays deterministic on any machine. The one test that DOES
 * care sets it — and for run9 that test is load-bearing in a way it is not for
 * any user's own suite: `pee_logs.day` is resolved HERE and stored, so this
 * route is the only place a zone is ever consulted. Every query in
 * users/run9/queries.ts takes a day key as a parameter and never touches a
 * zone at all.
 */
const tzSlot: { value: string | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) => {
  if (name === sessionCookieName) return cookieSlot.value
  if (name === 'stairwell_tz' && tzSlot.value !== undefined) return { value: tzSlot.value }
  return undefined
})
/**
 * `headers` is stubbed alongside `cookies` because lib/metrics/deviceClass.ts
 * reads the User-Agent as its fallback when no stairwell_dc cookie exists. An
 * empty header map is the honest fixture and resolves to 'desktop'.
 */
const emptyHeaders = { get: () => null }

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => emptyHeaders,
}))

const loaderSlot: { value: unknown } = { value: undefined }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => loaderSlot.value,
  registeredSlugs: () => ['run9'],
}))

// The spies are declared outside the factory and the factory only calls
// mockImplementation on them: vi.resetModules() re-runs the factory on the
// next dynamic import, but re-targets these same identities rather than
// replacing them, so call counts survive until mockClear().
const canSeeUserSpaceSpy = vi.fn()
const accountIdForSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>('@/lib/auth/authorize')
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  accountIdForSpy.mockImplementation(actual.accountIdFor)
  return { ...actual, canSeeUserSpace: canSeeUserSpaceSpy, accountIdFor: accountIdForSpy }
})

/**
 * run9's REAL migration, read off disk rather than retyped.
 *
 * walkRoute.test.ts inlines devtwo's schema as a string, which was fine when a
 * user's shape was one CREATE TABLE that had not changed in months. Reading
 * the file means this suite exercises the shape run9.db is actually created
 * under — if 002 ever lands, this fixture follows it instead of quietly
 * testing a shape that no longer exists.
 */
const MIGRATIONS_SRC = resolve(__dirname, '..', '..', 'users', 'run9', 'migrations')
const SCHEMA = readFileSync(join(MIGRATIONS_SRC, '001_initial.sql'), 'utf8')

let dir: string
let handle: PlatformDb | undefined
let accountId: number
let originalEnv: string | undefined

const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-pee-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  // The ENCRYPTED write path is what this suite is about — the one that runs
  // against run9's real data on the droplet. lib/db/userData.ts sends dev to
  // synthetic.db instead, so without saying `production` these tests would
  // quietly exercise a different database than the one they describe.
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')
  mkdirSync(join(dir, 'users', 'run9', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'users', 'run9', 'migrations', '001_initial.sql'), SCHEMA)
  writeFileSync(
    join(dir, 'users', 'run9', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: [{ number: 1, sha256: createHash('sha256').update(SCHEMA).digest('hex') }],
    }),
  )
  vi.resetModules()
  cookieGet.mockClear()
  canSeeUserSpaceSpy.mockClear()
  accountIdForSpy.mockClear()
  cookieSlot.value = undefined
  tzSlot.value = undefined
  loaderSlot.value = async () => ({ default: () => null })
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  setNodeEnv(originalEnv)
  delete process.env.USERS_DIR
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Sign run9 in. `lock` withholds the key, as a restart would; `migrate: false`
 * withholds the migration a real login would have run.
 *
 * Everywhere else the default models production: by the time a tap arrives the
 * friend unlocked, so the runner ran and their table is there. The route never
 * migrates and must not — shape changes belong to the one place that takes a
 * backup first.
 */
async function arrange(opts: { lock?: boolean; slug?: string; migrate?: boolean } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: opts.slug ?? 'run9',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) {
    // A COPY, not the test's own constant. The keymap ZEROES the buffer it
    // holds when an entry ages out (lib/session/keymap.ts's `entry.key.fill(0)`),
    // so handing it KEY directly wipes the constant every other assertion in
    // this file decrypts with — which presents as "file is not a database"
    // from peeRows, several lines away from the clock change that caused it.
    putKey(sid, Buffer.from(KEY))
    if (opts.migrate !== false) {
      const { migrateUserDb } = await import('@/lib/db/migrate')
      migrateUserDb(opts.slug ?? 'run9', KEY)
    }
  }
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/pee/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

/** A form submit, the way the dashboard's own <form method="post"> sends one. */
function submit(action?: string, headers?: Record<string, string>): Request {
  const body = new URLSearchParams()
  if (action !== undefined) body.set('action', action)
  return new Request('http://x', { method: 'POST', body, headers })
}

/** A WriteAction submit: same body, plus the header only fetch can set. */
function fetchSubmit(action?: string): Request {
  return submit(action, { 'X-Stairwell-Write': '1' })
}

/**
 * Opened directly rather than through the route's own opener, so the test
 * proves the rows are really on disk under that key.
 */
function peeRows(slug = 'run9') {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(join(dir, 'users', slug, `${slug}.db`))
  db.pragma("cipher='chacha20'")
  db.key(KEY)
  try {
    return db.prepare('SELECT id, day, at FROM pee_logs ORDER BY id').all() as {
      id: number
      day: string
      at: number
    }[]
  } finally {
    db.close()
  }
}

/**
 * Capture stderr for one call. The logDbFailure line is the ONLY signal an
 * operator gets that tells a permissions failure from a corrupt file — the
 * metric deliberately carries a slug and a panel and nothing else — so the
 * call sites are pinned here, not just the helper in tests/db/failureLog.test.ts.
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

describe('POST /api/users/[user]/pee — the four ordered checks', () => {
  it('refuses a LOCKED session before it touches ownership or a file', async () => {
    const POST = await arrange({ lock: true })
    const res = await POST(submit('add'), params('run9'))
    expect(res.status).toBe(403)
    // Check 2 was never reached: a route that opened the file and refused
    // afterwards would look identical on status and file-existence alone.
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    // Nothing opened it and nothing created it. A route that opened the file
    // and refused afterwards would look identical on status alone.
    expect(existsSync(join(dir, 'users', 'run9', 'run9.db'))).toBe(false)
  })

  it('404s, never 403s, for a slug that is not theirs', async () => {
    // A 403 would confirm that the other account exists.
    const POST = await arrange()
    const res = await POST(submit('add'), params('someone-else'))
    expect(res.status).toBe(404)
  })

  it('404s when no dashboard is registered for the slug', async () => {
    // Otherwise any authenticated slug could cause an encrypted file to be
    // created for a user who has no dashboard at all.
    const POST = await arrange()
    loaderSlot.value = undefined
    const res = await POST(submit('add'), params('run9'))
    expect(res.status).toBe(404)
    expect(peeRows()).toHaveLength(0)
  })
})

describe('POST /api/users/[user]/pee — the action field', () => {
  it('400s on a missing action, writing nothing', async () => {
    const POST = await arrange()
    const res = await POST(submit(), params('run9'))
    expect(res.status).toBe(400)
    expect(peeRows()).toHaveLength(0)
  })

  it('400s on an action it does not know', async () => {
    const POST = await arrange()
    expect((await POST(submit('drop'), params('run9'))).status).toBe(400)
    expect((await POST(submit(''), params('run9'))).status).toBe(400)
    expect(peeRows()).toHaveLength(0)
  })

  it('400s rather than 500s on a body that is not a form at all', async () => {
    // formData() throws on a malformed body. Uncaught, that is Next's default
    // error page in response to a form submit — the friend leaves the
    // dashboard and has no way back but the browser's back button.
    const POST = await arrange()
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        body: '{"action":"add"}',
        headers: { 'content-type': 'application/json' },
      }),
      params('run9'),
    )
    expect(res.status).toBe(400)
    expect(peeRows()).toHaveLength(0)
  })

  it('refuses an unauthenticated caller WITHOUT parsing its body', async () => {
    // Parsing a body is work done on behalf of the caller. A locked session
    // gets none of it — the 403 arrives even though the body is unreadable.
    const POST = await arrange({ lock: true })
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        body: 'not-a-form',
        headers: { 'content-type': 'multipart/form-data; boundary=nope' },
      }),
      params('run9'),
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /api/users/[user]/pee — logging', () => {
  it('writes one row per tap, and NEVER deduplicates them', async () => {
    // The contrast with the walk route, which is INSERT OR IGNORE on a day
    // primary key. Here a second tap is a second occurrence and the whole
    // dashboard is a count of them.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0))
      const POST = await arrange()
      const first = await POST(submit('add'), params('run9'))
      vi.setSystemTime(new Date(2026, 7, 19, 10, 0, 0))
      const second = await POST(submit('add'), params('run9'))

      expect(first.status).toBe(303)
      expect(second.status).toBe(303)
      const rows = peeRows()
      expect(rows).toHaveLength(2)
      expect(rows[0]!.day).toBe(rows[1]!.day)
      // Distinct instants, and distinct ids — which is what makes "remove the
      // most recent" name exactly one row.
      expect(rows[0]!.at).not.toBe(rows[1]!.at)
      expect(rows[0]!.id).not.toBe(rows[1]!.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('files the row under the FRIEND’S day, not the droplet’s', async () => {
    // The bug this whole ledger is about: the droplet is UTC, and a tap at
    // 21:03 in New York is 01:03Z — stored as the next day before the fix
    // (docs/superpowers/ledgers/friend-timezone.md). One instant, two zones,
    // two different days: an assertion no host-clock implementation can pass,
    // and one that means the same thing on every machine that runs it.
    vi.useFakeTimers()
    try {
      // 01:30Z on the 20th — still the 19th in New York.
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 20, 1, 30)))
      const instant = Date.now()
      tzSlot.value = 'America/New_York'
      const POST = await arrange()
      await POST(submit('add'), params('run9'))

      expect(peeRows()[0]!.day).toBe('2026-08-19')
      expect(peeRows()[0]!.day).toBe(dayKey(instant, 'America/New_York'))
      expect(peeRows()[0]!.day).not.toBe(dayKey(instant, 'UTC'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stores `day` and `at` from ONE clock read, so they cannot straddle midnight', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 12, 0, 0)))
      const POST = await arrange()
      await POST(submit('add'), params('run9'))
      const row = peeRows()[0]!
      expect(row.day).toBe(dayKey(row.at, 'UTC'))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('POST /api/users/[user]/pee — correcting', () => {
  it('removes exactly one row, the most recent of today', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 9, 0, 0)))
      const POST = await arrange()
      await POST(submit('add'), params('run9'))
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 11, 0, 0)))
      await POST(submit('add'), params('run9'))
      const kept = peeRows()[0]!

      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 13, 0, 0)))
      const res = await POST(submit('remove'), params('run9'))

      expect(res.status).toBe(303)
      const rows = peeRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.at).toBe(kept.at)
    } finally {
      vi.useRealTimers()
    }
  })

  it('CANNOT take the count below zero, and does not error trying', async () => {
    // The spec's bound, enforced by the statement rather than by a
    // read-then-write that could race. The dashboard disables the control at
    // zero; this is the half that holds when a form is replayed.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 9, 0, 0)))
      const POST = await arrange()
      const res = await POST(submit('remove'), params('run9'))
      expect(res.status).toBe(303)
      expect(peeRows()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ONLY EVER AFFECTS TODAY, leaving yesterday’s rows alone', async () => {
    // A correction that fell through to the previous day when today was empty
    // would silently rewrite history the friend cannot see from this screen.
    //
    // The clock crosses midnight by NINETY MINUTES rather than by a day, and
    // that is load-bearing: lib/session/keymap.ts ages a key out after
    // IDLE_TTL_MS (4h), so a 24-hour jump makes this route return 403 and the
    // remove never runs at all — leaving both of the 18th's rows in place and
    // this test green for entirely the wrong reason. The 303 below is what
    // stops that from ever being silent again.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 18, 23, 0, 0)))
      const POST = await arrange()
      await POST(submit('add'), params('run9'))
      await POST(submit('add'), params('run9'))
      expect(peeRows().every((r) => r.day === '2026-08-18')).toBe(true)

      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 0, 30, 0)))
      const res = await POST(submit('remove'), params('run9'))

      // It RAN, and it deleted nothing.
      expect(res.status).toBe(303)
      const rows = peeRows()
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.day === '2026-08-18')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects the friend’s day when deciding what "today" means', async () => {
    // The remove path reads the same dayKey the add path writes. If the two
    // ever disagreed, a correction at 20:00 in New York would delete nothing
    // while the count above it showed rows.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 20, 1, 30)))
      tzSlot.value = 'America/New_York'
      const POST = await arrange()
      await POST(submit('add'), params('run9'))
      expect(peeRows()).toHaveLength(1)
      await POST(submit('remove'), params('run9'))
      expect(peeRows()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('POST /api/users/[user]/pee — how it answers (lib/http/redirect.ts writeAnswer)', () => {
  it('answers a fetch-initiated write with 204, never a redirect the browser would follow', async () => {
    // A 303 here would be followed by fetch's default redirect:'follow',
    // rendering the whole dashboard again and appending a SECOND
    // dashboard_open row before router.refresh() adds a third.
    const POST = await arrange()
    const res = await POST(fetchSubmit('add'), params('run9'))
    expect(res.status).toBe(204)
    expect(res.headers.get('location')).toBeNull()
    expect(peeRows()).toHaveLength(1)
  })

  it('still answers a native form post — no header — with the 303 redirect', async () => {
    const POST = await arrange()
    const res = await POST(submit('add'), params('run9'))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/run9')
  })
})

describe('POST /api/users/[user]/pee — metrics and failures', () => {
  it('records a slug and a panel, and NEVER a value', async () => {
    // The permanent metrics policy. "They logged" and "they went at 14:32" are
    // the same fact for this dashboard, and `metrics` is the unencrypted
    // platform database. This row is what makes the login page's "I can see
    // when you use it ... but not what you log" true.
    const POST = await arrange()
    await POST(submit('add'), params('run9'))
    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .get() as { data: string }
    const data = JSON.parse(row.data)
    expect(data).toEqual({ slug: 'run9', panel: 'pee_log', device_class: 'desktop' })
    // Nothing about WHAT was logged: no day, no count, no timestamp of the
    // occurrence, no row id.
    expect(Object.keys(data).sort()).toEqual(['device_class', 'panel', 'slug'])
  })

  it('names the correction as its own panel, still without a value', async () => {
    const POST = await arrange()
    await POST(submit('remove'), params('run9'))
    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .get() as { data: string }
    // A builder-chosen constant, not anything derived from what run9 logged.
    expect(JSON.parse(row.data)).toEqual({
      slug: 'run9',
      panel: 'pee_correction',
      device_class: 'desktop',
    })
  })

  it('returns a bodyless 500 and records dashboard_write_error when the WRITE throws', async () => {
    // A full disk, a SQLITE_BUSY outliving the driver's timeout, or a missing
    // table. Without the catch the friend gets Next's default error page in
    // response to a form submit — no dashboard, no chat surface, no way back —
    // and no metric row, so it is invisible to the operator too. Modelled by
    // withholding the migration, so the table genuinely is not there.
    const POST = await arrange({ migrate: false })
    const [res, stderr] = await withStderr(() => POST(submit('add'), params('run9')))

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    // Slug and panel, never the driver's message: a constraint violation can
    // quote a column's contents, and this table is unencrypted.
    expect(JSON.parse(row!.data)).toEqual({
      slug: 'run9',
      panel: 'pee_log',
      device_class: 'desktop',
    })
    // The stderr line is the operator's only way to tell this from a
    // permissions failure — the metric deliberately cannot say.
    expect(stderr).not.toBe('')
    // And no success row was written.
    expect(
      handle!.prepare("SELECT 1 FROM metrics WHERE event = 'dashboard_write'").get(),
    ).toBeUndefined()
  })
})
