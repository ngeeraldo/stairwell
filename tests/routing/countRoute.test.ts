// tests/routing/countRoute.test.ts
//
// run8's write path. The four ordered checks are shared with the walk route
// and are pinned there in full (tests/routing/walkRoute.test.ts) — the lock
// short-circuit, the 404-not-403 for a non-owner, and the unregistered-slug
// case are re-asserted here rather than assumed, because this is a SEPARATE
// route file and a copied check that lost its order would look identical from
// the outside until it mattered.
//
// What is genuinely this route's own, and is why it exists at all:
//   - a delta, which walk/ has no concept of
//   - a floor at zero, enforced inside the INSERT rather than around it
//   - a day the request cannot name, because minus adjusts TODAY only
//   - a metric that carries neither the delta nor the count
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { setNodeEnv } from '@/tests/support/nodeEnv'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import { dayKey } from '@/lib/time/dayKey'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
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
  registeredSlugs: () => ['run8'],
}))

const canSeeUserSpaceSpy = vi.fn()
const accountIdForSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>('@/lib/auth/authorize')
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  accountIdForSpy.mockImplementation(actual.accountIdFor)
  return { ...actual, canSeeUserSpace: canSeeUserSpaceSpy, accountIdFor: accountIdForSpy }
})

// run8's real 001, inlined. A copy rather than a read of the user folder: this
// suite is about the ROUTE's behaviour against a shape, and reading the live
// file would make it fail for reasons belonging to a different commit.
const SCHEMA = `CREATE TABLE pee_events (
  id    INTEGER PRIMARY KEY,
  day   TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  at    INTEGER NOT NULL,
  delta INTEGER NOT NULL CHECK (delta IN (-1, 1))
);`

let dir: string
let handle: PlatformDb | undefined
let originalEnv: string | undefined

function writeSchema(sql: string) {
  writeFileSync(join(dir, 'users', 'run8', 'migrations', '001_initial.sql'), sql)
  writeFileSync(
    join(dir, 'users', 'run8', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: [{ number: 1, sha256: createHash('sha256').update(sql).digest('hex') }],
    }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-count-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  // The ENCRYPTED path is what this suite is about. lib/db/userData.ts sends
  // dev to synthetic.db, so without `production` these would quietly exercise
  // a different database than the one they describe.
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')
  mkdirSync(join(dir, 'users', 'run8', 'migrations'), { recursive: true })
  writeSchema(SCHEMA)
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

async function arrange(opts: { lock?: boolean; slug?: string; migrate?: boolean } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  const accountId = await createAccount(handle, {
    slug: opts.slug ?? 'run8',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) {
    const key = Buffer.alloc(32, 7)
    putKey(sid, key)
    if (opts.migrate !== false) {
      // What a real unlocked session has already been through: the runner
      // fires when the key appears, so by the time a tap arrives the database
      // exists and holds its tables. The route never migrates.
      const { migrateUserDb } = await import('@/lib/db/migrate')
      migrateUserDb(opts.slug ?? 'run8', key)
    }
  }
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/count/route')
  return POST
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

const params = (user: string) => ({ params: Promise.resolve({ user }) })

/** A form POST, the way the dashboard's own two forms submit. */
function press(delta: string): Request {
  const body = new FormData()
  body.set('delta', delta)
  return new Request('http://x', { method: 'POST', body })
}

function events(dbPath: string, key: Buffer) {
  // Opened directly rather than through the route's own opener, so the test
  // proves the rows are really on disk under that key.
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(dbPath)
  db.pragma("cipher='chacha20'")
  db.key(key)
  try {
    return db.prepare('SELECT day, at, delta FROM pee_events ORDER BY id').all() as {
      day: string
      at: number
      delta: number
    }[]
  } finally {
    db.close()
  }
}

const DB_PATH = () => join(dir, 'users', 'run8', 'run8.db')
const KEY = () => Buffer.alloc(32, 7)

describe('POST /api/users/[user]/count', () => {
  it('writes +1 for a plus and accumulates rather than replacing', async () => {
    const POST = await arrange()
    await POST(press('1'), params('run8'))
    await POST(press('1'), params('run8'))

    const rows = events(DB_PATH(), KEY())
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.delta)).toEqual([1, 1])
  })

  it('writes -1 for a minus once there is something to take back', async () => {
    const POST = await arrange()
    await POST(press('1'), params('run8'))
    const response = await POST(press('-1'), params('run8'))

    expect(response.status).toBe(303)
    expect(events(DB_PATH(), KEY()).map((r) => r.delta)).toEqual([1, -1])
  })

  it('writes NOTHING for a minus at zero, and still redirects', async () => {
    // run8's confirmed answer: a day may not go below zero. Proven by the row
    // being absent rather than by a clamp on read — the guard is a subquery
    // inside the INSERT, so there is no window between deciding and writing.
    //
    // And a 303, not a 4xx: pressing minus on a zero is the friend saying
    // "undo" when there is nothing to undo. The honest answer is the unchanged
    // screen, not an error page mid-tap.
    const POST = await arrange()
    const response = await POST(press('-1'), params('run8'))

    expect(response.status).toBe(303)
    expect(events(DB_PATH(), KEY())).toHaveLength(0)
  })

  it('refuses the minus that would cross zero, not the one that reaches it', async () => {
    const POST = await arrange()
    await POST(press('1'), params('run8'))
    await POST(press('-1'), params('run8')) // lands on 0
    await POST(press('-1'), params('run8')) // refused

    const rows = events(DB_PATH(), KEY())
    expect(rows.map((r) => r.delta)).toEqual([1, -1])
    expect(rows.reduce((sum, r) => sum + r.delta, 0)).toBe(0)
  })

  it('treats anything that is not exactly "-1" as a plus', async () => {
    // The parse is a whitelist of one string. A malformed or absent delta
    // becoming a plus is the safe failure: it logs a trip that may not have
    // happened, which the friend can undo with the button beside it. The
    // alternative — an unrecognised value silently subtracting — destroys a
    // record they cannot get back.
    const POST = await arrange()
    await POST(press('banana'), params('run8'))
    await POST(new Request('http://x', { method: 'POST' }), params('run8'))

    expect(events(DB_PATH(), KEY()).map((r) => r.delta)).toEqual([1, 1])
  })

  it('files the tap under the FRIEND’S day, not the droplet’s', async () => {
    // The droplet runs UTC. A tap at 21:03 in New York is 01:03Z, and filing
    // it under the server's day would put it on tomorrow — the bug
    // lib/time/dayKey.ts exists to close, which cost devtwo a real row.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-17T01:03:00Z'))
      tzSlot.value = 'America/New_York'
      const POST = await arrange()
      await POST(press('1'), params('run8'))

      const rows = events(DB_PATH(), KEY())
      expect(rows[0]!.day).toBe('2026-08-16')
      expect(rows[0]!.day).toBe(dayKey(Date.now(), 'America/New_York'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the request no way to name a day at all', async () => {
    // run8 confirmed that minus adjusts TODAY only. That is honoured by the
    // route never reading a date, rather than by validating one it was sent —
    // a client-supplied day would also be a second opinion about the friend's
    // calendar.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-16T12:00:00Z'))
      const POST = await arrange()
      const body = new FormData()
      body.set('delta', '1')
      body.set('date', '2020-01-01')
      body.set('day', '2020-01-01')
      await POST(new Request('http://x', { method: 'POST', body }), params('run8'))

      expect(events(DB_PATH(), KEY())[0]!.day).toBe('2026-08-16')
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a slug and a panel, and never the delta or the count', async () => {
    // The permanent metrics policy. "How many times run8 went today" is
    // exactly what the login page promises is not recorded, and `metrics` is
    // the unencrypted platform database. Which BUTTON was pressed is that same
    // fact at one remove: a row carrying delta=-1 would let anyone reading the
    // table count a friend's corrections.
    const POST = await arrange()
    await POST(press('1'), params('run8'))
    await POST(press('-1'), params('run8'))

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .all() as { data: string }[]

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(JSON.parse(row.data)).toEqual({
        slug: 'run8',
        panel: 'today_counter',
        device_class: 'desktop',
      })
      expect(row.data).not.toContain('delta')
      expect(row.data).not.toContain('2026-')
    }
  })

  it('still records the metric for a minus that wrote nothing', async () => {
    // Deliberate, and matching the walk route rather than this route's own
    // first instinct. walk/ uses INSERT OR IGNORE, so a second tap on an
    // already-walked day changes no row and records dashboard_write anyway.
    //
    // The row means "the friend used a control on this panel", not "a row
    // landed". That is the reading the login page's promise rests on — "I can
    // see when you use it … but not what you log" — and it is the only reading
    // available here without recording the outcome, which would leak whether
    // their count was at zero.
    //
    // The event's NAME argues the other way, and that tension is real. Two
    // routes doing the same job disagreeing about it would be worse than
    // either answer.
    const POST = await arrange()
    await POST(press('-1'), params('run8'))

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .all() as { data: string }[]
    expect(rows).toHaveLength(1)
    // And it is indistinguishable from a successful one: nothing in the row
    // says whether the tap took effect.
    expect(JSON.parse(rows[0]!.data)).toEqual({
      slug: 'run8',
      panel: 'today_counter',
      device_class: 'desktop',
    })
  })

  it('returns a bodyless 500 and records dashboard_write_error when the write throws', async () => {
    // Forced through the real code path: a trigger in this user's own schema
    // aborts the insert, so the open succeeds and the WRITE is what fails.
    // Without a catch here the friend gets Next's default error page in
    // response to a form submit, and no metric row, so the operator cannot
    // see it either.
    writeSchema(`${SCHEMA}
       CREATE TRIGGER refuse_writes BEFORE INSERT ON pee_events
       BEGIN SELECT RAISE(ABORT, 'SIMULATED WRITE FAILURE TEST'); END;`)

    const POST = await arrange()
    const [response, stderr] = await withStderr(() => POST(press('1'), params('run8')))

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('')
    expect(stderr).toContain('dashboard_write_error')
    expect(stderr).toContain('run8')

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    expect(JSON.parse(row!.data)).toEqual({
      slug: 'run8',
      panel: 'today_counter',
      device_class: 'desktop',
    })
    // The error's own text could quote what was being written; it must not
    // reach the append-only column.
    expect(row!.data).not.toContain('SIMULATED')

    expect(
      handle!.prepare("SELECT 1 FROM metrics WHERE event = 'dashboard_write'").get(),
    ).toBeUndefined()
  })

  it('refuses a LOCKED session without reaching check 2 or touching the file', async () => {
    const POST = await arrange({ lock: true })
    const response = await POST(press('1'), params('run8'))

    expect(response.status).toBe(403)
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    expect(existsSync(DB_PATH())).toBe(false)
  })

  it('404s a non-owner and creates nothing', async () => {
    const POST = await arrange({ slug: 'devone' })
    const response = await POST(press('1'), params('run8'))

    expect(response.status).toBe(404)
    expect(existsSync(DB_PATH())).toBe(false)
  })

  it('404s a slug with no registered dashboard, so no file can be conjured', async () => {
    loaderSlot.value = undefined
    const POST = await arrange({ migrate: false })
    const response = await POST(press('1'), params('run8'))

    expect(response.status).toBe(404)
    expect(existsSync(DB_PATH())).toBe(false)
  })
})
