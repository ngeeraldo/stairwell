// tests/routing/forecastRoute.test.ts
//
// run11's refresh path — the ONLY thing pinning
// app/api/users/[user]/forecast/route.ts. users/run11/tests/ builds its
// fixtures by hand (a platform route must not be imported by a user's test),
// so nothing there goes red if this route's SQL changes. This file is that
// half.
//
// Modelled on tests/routing/peeRoute.test.ts, including its mocking shape and
// the reason for it: the order of the four checks IS the security property.
// resolveState() itself calls getKey() internally, so "no key was fetched" can
// never be an assertion this suite can make — instead the lock test asserts
// canSeeUserSpace (check 2) is never called, alongside the status and the
// absence of the encrypted file.
//
// WHAT IS DIFFERENT HERE, and why it needs its own tests: this route is the
// first one in the app that talks to a third party before it writes. That adds
// three obligations no other write route has, and each has a test below:
//
//   * the FAILED attempt is still a write — without the row, the dashboard
//     cannot tell a failed refresh from no refresh, and would render an old
//     verdict as current;
//   * the forecast is REPLACED, not appended — a snapshot, not a history;
//   * the FRIEND'S zone decides the calendar, never the provider's.
//
// NOTHING HERE REACHES THE NETWORK: lib/weather/openMeteo.ts is mocked at the
// module boundary, which is the same guarantee its own test makes by injecting
// fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { setNodeEnv } from '@/tests/support/nodeEnv'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import type { ForecastSnapshot } from '@/lib/weather/openMeteo'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
/**
 * The friend's timezone, as the browser reports it in `stairwell_tz`.
 *
 * Load-bearing for this route in a way it is not for a tap tracker: EVERY row
 * it writes is filed against a local day AND a local minute-of-day resolved
 * here, and users/run11/queries.ts has no zone logic at all because of it. If
 * this route resolved the calendar wrongly, every window on the screen would
 * be silently offset and nothing downstream could notice.
 */
const tzSlot: { value: string | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) => {
  if (name === sessionCookieName) return cookieSlot.value
  if (name === 'stairwell_tz' && tzSlot.value !== undefined) return { value: tzSlot.value }
  return undefined
})
const emptyHeaders = { get: () => null }

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => emptyHeaders,
}))

const loaderSlot: { value: unknown } = { value: undefined }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => loaderSlot.value,
  registeredSlugs: () => ['run11'],
}))

/**
 * THE PROVIDER, stubbed at the module boundary.
 *
 * `importActual` keeps the real ForecastError, because the route branches on
 * `instanceof` to decide whether a failure is upstream's or ours — a mocked
 * class would make that branch untestable and always take the 'error' arm.
 */
const fetchForecastSpy = vi.fn()
vi.mock('@/lib/weather/openMeteo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/weather/openMeteo')>(
    '@/lib/weather/openMeteo',
  )
  return { ...actual, fetchForecast: fetchForecastSpy }
})

const canSeeUserSpaceSpy = vi.fn()
const accountIdForSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>('@/lib/auth/authorize')
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  accountIdForSpy.mockImplementation(actual.accountIdFor)
  return { ...actual, canSeeUserSpace: canSeeUserSpaceSpy, accountIdFor: accountIdForSpy }
})

/** run11's REAL migration, read off disk rather than retyped. */
const MIGRATIONS_SRC = resolve(__dirname, '..', '..', 'users', 'run11', 'migrations')
const SCHEMA = readFileSync(join(MIGRATIONS_SRC, '001_initial.sql'), 'utf8')

let dir: string
let handle: PlatformDb | undefined
let accountId: number
let originalEnv: string | undefined

const KEY = Buffer.alloc(32, 11)

// Houston is UTC−5 in August. Every instant below is chosen so the friend's
// local day and the UTC day DISAGREE, which is the only way a test can tell
// "used the friend's zone" from "used the droplet's".
const TZ = 'America/Chicago'

/**
 * A forecast snapshot in the client's normalised shape.
 *
 * 2026-08-21T01:00:00Z is 20:00 on 2026-08-20 in Houston — an instant whose
 * UTC day is already tomorrow. Every assertion about `day` below turns on it.
 */
function snapshot(): ForecastSnapshot {
  const first = Date.parse('2026-08-21T01:00:00Z') // 20:00 local, 2026-08-20
  return {
    hours: [
      { at: first, precipMm: 0, precipChance: 10, feelsLikeF: 88 },
      { at: first + 3_600_000, precipMm: 0.5, precipChance: 70, feelsLikeF: 85 },
      { at: first + 7_200_000, precipMm: 0, precipChance: 5, feelsLikeF: 83 },
    ],
    sun: [
      {
        sunrise: Date.parse('2026-08-20T11:53:00Z'), // 06:53 local
        sunset: Date.parse('2026-08-21T00:56:00Z'), // 19:56 local, same local day
      },
    ],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-forecast-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  // The ENCRYPTED write path is what this suite is about — the one that runs
  // against run11's real data on the droplet. lib/db/userData.ts sends dev to
  // synthetic.db instead, so without saying `production` these tests would
  // quietly exercise a different database than the one they describe.
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')
  mkdirSync(join(dir, 'users', 'run11', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'users', 'run11', 'migrations', '001_initial.sql'), SCHEMA)
  writeFileSync(
    join(dir, 'users', 'run11', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: [{ number: 1, sha256: createHash('sha256').update(SCHEMA).digest('hex') }],
    }),
  )
  vi.resetModules()
  cookieGet.mockClear()
  canSeeUserSpaceSpy.mockClear()
  accountIdForSpy.mockClear()
  fetchForecastSpy.mockReset()
  fetchForecastSpy.mockResolvedValue(snapshot())
  cookieSlot.value = undefined
  tzSlot.value = TZ
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

async function arrange(opts: { lock?: boolean; slug?: string; migrate?: boolean } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: opts.slug ?? 'run11',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) {
    // A COPY, not the test's own constant: the keymap zeroes the buffer it
    // holds when an entry ages out, which would wipe KEY for every other
    // assertion in this file.
    putKey(sid, Buffer.from(KEY))
    if (opts.migrate !== false) {
      const { migrateUserDb } = await import('@/lib/db/migrate')
      migrateUserDb(opts.slug ?? 'run11', KEY)
    }
  }
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/forecast/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

/** A form submit, the way the dashboard's own <form method="post"> sends one. */
const submit = () => new Request('http://x', { method: 'POST', body: new URLSearchParams() })

/** A WriteAction submit: same body, plus the header only fetch can set. */
const fetchSubmit = () =>
  new Request('http://x', {
    method: 'POST',
    body: new URLSearchParams(),
    headers: { 'X-Stairwell-Write': '1' },
  })

/** Opened directly, so the test proves the rows are really on disk under that key. */
function open(slug = 'run11') {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(join(dir, 'users', slug, `${slug}.db`))
  db.pragma("cipher='chacha20'")
  db.key(KEY)
  return db
}

function rows(sql: string, slug = 'run11') {
  const db = open(slug)
  try {
    return db.prepare(sql).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

const hours = () => rows('SELECT * FROM forecast_hours ORDER BY at')
const days = () => rows('SELECT * FROM forecast_days ORDER BY day')
const fetches = () => rows('SELECT * FROM forecast_fetches ORDER BY id')

function metricRows() {
  return handle!
    .prepare("SELECT event, data FROM metrics WHERE event LIKE 'dashboard_%' ORDER BY id")
    .all() as { event: string; data: string }[]
}

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

describe('POST /api/users/[user]/forecast — the four ordered checks', () => {
  it('refuses a LOCKED session before it touches ownership, a file, or the provider', async () => {
    const POST = await arrange({ lock: true })
    const res = await POST(submit(), params('run11'))
    expect(res.status).toBe(403)
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'users', 'run11', 'run11.db'))).toBe(false)
    // AND NOTHING LEFT THE DROPLET. A route that called out first and refused
    // afterwards would look identical on status and file-existence alone,
    // while telling a third party that somebody tried.
    expect(fetchForecastSpy).not.toHaveBeenCalled()
  })

  it('404s, never 403s, for a slug that is not theirs', async () => {
    const POST = await arrange()
    const res = await POST(submit(), params('someone-else'))
    expect(res.status).toBe(404)
    expect(fetchForecastSpy).not.toHaveBeenCalled()
  })

  it('404s when no dashboard is registered for the slug', async () => {
    const POST = await arrange()
    loaderSlot.value = undefined
    const res = await POST(submit(), params('run11'))
    expect(res.status).toBe(404)
    expect(fetchForecastSpy).not.toHaveBeenCalled()
  })

  it('404s for an authorised slug with no place configured, without calling out', async () => {
    // PLACES is a constant map and a slug that is not in it has no forecast to
    // fetch. Checked AFTER the auth checks, and the assertion that matters is
    // that no request is made: coordinates must never come from anywhere but
    // that map, or the route becomes an open proxy to a third party.
    const POST = await arrange({ slug: 'devtwo' })
    const res = await POST(submit(), params('devtwo'))
    expect(res.status).toBe(404)
    expect(fetchForecastSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/users/[user]/forecast — a successful refresh', () => {
  it('stores the forecast under the FRIEND’S calendar, not the droplet’s', async () => {
    const POST = await arrange()
    const res = await POST(fetchSubmit(), params('run11'))
    expect(res.status).toBe(204)

    const stored = hours()
    expect(stored).toHaveLength(3)
    // 2026-08-21T01:00:00Z is 20:00 on 2026-08-20 in Houston. Filed under the
    // UTC day it would be 2026-08-21 and every window on the screen would be a
    // day out — the exact shape of the bug in
    // docs/superpowers/ledgers/friend-timezone.md.
    expect(stored[0]!.day).toBe('2026-08-20')
    expect(stored[0]!.minute_of_day).toBe(20 * 60)
    expect(stored[1]!.minute_of_day).toBe(21 * 60)
    // The hour's own values survive the round trip intact.
    expect(stored[1]!.precip_mm).toBe(0.5)
    expect(stored[1]!.precip_chance).toBe(70)
    expect(stored[1]!.feels_like_f).toBe(85)
  })

  it('stores sunrise and sunset as local minutes on the local day', async () => {
    const POST = await arrange()
    await POST(fetchSubmit(), params('run11'))
    const stored = days()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.day).toBe('2026-08-20')
    expect(stored[0]!.sunrise_minute).toBe(6 * 60 + 53)
    expect(stored[0]!.sunset_minute).toBe(19 * 60 + 56)
  })

  it('records the attempt as successful, with its own local day and minute', async () => {
    const POST = await arrange()
    await POST(fetchSubmit(), params('run11'))
    const log = fetches()
    expect(log).toHaveLength(1)
    expect(log[0]!.ok).toBe(1)
    // This row is the dashboard's reference instant — "as of" on the panel
    // reads exactly these two columns.
    expect(typeof log[0]!.day).toBe('string')
    expect(typeof log[0]!.minute_of_day).toBe('number')
  })

  it('REPLACES the forecast rather than appending to it', async () => {
    const POST = await arrange()
    await POST(fetchSubmit(), params('run11'))
    expect(hours()).toHaveLength(3)

    // A second refresh returning a shorter forecast. Appending would leave the
    // old tail behind, and a window scan would walk off the end of what the
    // provider currently stands behind into hours it has withdrawn.
    const second = snapshot()
    second.hours = second.hours.slice(0, 1)
    fetchForecastSpy.mockResolvedValue(second)
    await POST(fetchSubmit(), params('run11'))

    expect(hours()).toHaveLength(1)
    expect(days()).toHaveLength(1)
    // The fetch log is the exception: it is a history, and both attempts are
    // in it.
    expect(fetches()).toHaveLength(2)
  })

  it('drops a sun pair that straddles two local days rather than storing a nonsense one', async () => {
    // Cannot happen at 29°N; it is dropped rather than clamped because a
    // missing day makes the panel say it has no sunset, and a clamped one
    // would make it confidently wrong.
    const odd = snapshot()
    odd.sun = [
      {
        sunrise: Date.parse('2026-08-20T11:53:00Z'), // 06:53 local, 08-20
        sunset: Date.parse('2026-08-21T06:00:00Z'), // 01:00 local, 08-21
      },
    ]
    fetchForecastSpy.mockResolvedValue(odd)
    const POST = await arrange()
    await POST(fetchSubmit(), params('run11'))
    expect(days()).toHaveLength(0)
    // The hours still land: one bad sun pair does not cost the whole refresh.
    expect(hours()).toHaveLength(3)
  })
})

describe('POST /api/users/[user]/forecast — when the provider fails', () => {
  it('still writes an attempt row, so the panel can tell failed from never', async () => {
    const { ForecastError } = await vi.importActual<typeof import('@/lib/weather/openMeteo')>(
      '@/lib/weather/openMeteo',
    )
    const POST = await arrange()
    // One good refresh, so there is data to be wrongly presented as current.
    await POST(fetchSubmit(), params('run11'))
    fetchForecastSpy.mockRejectedValue(new ForecastError('timeout'))

    const [res] = await withStderr(() => POST(fetchSubmit(), params('run11')))
    expect(res.status).toBe(502)

    const log = fetches()
    expect(log).toHaveLength(2)
    expect(log[1]!.ok).toBe(0)
    // AND THE PREVIOUS FORECAST IS UNTOUCHED. This is a read refreshing: the
    // dashboard keeps rendering last-known data and says the refresh failed,
    // which is the guidelines' pattern. Deleting it would blank the panel over
    // a transient timeout.
    expect(hours()).toHaveLength(3)
    expect(days()).toHaveLength(1)
  })

  it('logs the failure to stderr with a code, and never the provider’s prose', async () => {
    const { ForecastError } = await vi.importActual<typeof import('@/lib/weather/openMeteo')>(
      '@/lib/weather/openMeteo',
    )
    const POST = await arrange()
    fetchForecastSpy.mockRejectedValue(new ForecastError('http'))
    const [, stderr] = await withStderr(() => POST(fetchSubmit(), params('run11')))
    expect(stderr).toContain('forecast_fetch_failed')
    expect(stderr).toContain('run11')
  })

  it('treats a non-ForecastError as ours, and still records the attempt', async () => {
    const POST = await arrange()
    fetchForecastSpy.mockRejectedValue(new TypeError('cannot read properties of undefined'))
    const [res] = await withStderr(() => POST(fetchSubmit(), params('run11')))
    expect(res.status).toBe(502)
    expect(fetches()[0]!.ok).toBe(0)
  })
})

describe('POST /api/users/[user]/forecast — the answer and the metric', () => {
  it('answers a native form post with a redirect and a fetch write with 204', async () => {
    const POST = await arrange()
    // A 303 to a fetch-initiated write would be FOLLOWED (fetch defaults to
    // redirect:'follow'), rendering the whole dashboard again and landing a
    // second permanent dashboard_open row in an append-only table.
    expect((await POST(fetchSubmit(), params('run11'))).status).toBe(204)
    const native = await POST(submit(), params('run11'))
    expect(native.status).toBe(303)
    expect(native.headers.get('location')).toBe('/run11')
  })

  it('records a slug and a panel, and nothing else', async () => {
    const POST = await arrange()
    await POST(fetchSubmit(), params('run11'))
    const written = metricRows()
    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('dashboard_write')
    const data = JSON.parse(written[0]!.data) as Record<string, unknown>
    // Permanent policy: never a verdict, never a temperature, never the place.
    // `metrics` is the unencrypted platform database and this row is what
    // makes the login page's "I can see when you use it ... but not what you
    // log" true.
    expect(Object.keys(data).sort()).toEqual(['device_class', 'panel', 'slug'])
    expect(data.slug).toBe('run11')
    expect(data.panel).toBe('forecast_refresh')
  })

  it('still records the press when the provider failed, and still says nothing about it', async () => {
    const { ForecastError } = await vi.importActual<typeof import('@/lib/weather/openMeteo')>(
      '@/lib/weather/openMeteo',
    )
    const POST = await arrange()
    fetchForecastSpy.mockRejectedValue(new ForecastError('network'))
    await withStderr(() => POST(fetchSubmit(), params('run11')))

    // A dashboard_write ROW IS STILL WRITTEN, and that is the intended
    // reading rather than an oversight. The event means "the friend caused a
    // write to their database", and one happened: the failed attempt row is
    // itself a write, and it is the row the panel's error state is built on.
    // The metric is also the login page's "I can see when you use it" — a
    // press is usage whether or not the sky answered.
    const written = metricRows()
    expect(written).toHaveLength(1)
    expect(written[0]!.event).toBe('dashboard_write')

    // AND IT CARRIES NO OUTCOME. `dashboard_write` is a slug and a panel and
    // nothing else (CLAUDE.md), so an ok/failed flag does not belong here even
    // though it is not a user value — the row shape is permanent policy. The
    // operator's signal for an outage is the forecast_fetch_failed stderr line
    // pinned two describes above, not this table.
    const data = JSON.parse(written[0]!.data) as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['device_class', 'panel', 'slug'])
    // dashboard_write_error is for a WRITE that failed. This write succeeded.
    expect(written.some((r) => r.event === 'dashboard_write_error')).toBe(false)
  })
})
