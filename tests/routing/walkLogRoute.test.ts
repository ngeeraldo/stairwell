// tests/routing/walkLogRoute.test.ts
//
// run11's walk-log write path — the ONLY thing pinning
// app/api/users/[user]/walk-log/route.ts. users/run11/tests/walkLog.test.ts
// reproduces the route's INSERT and DELETE by hand (a platform route must not
// be imported by a user's test), so nothing there goes red if this route's SQL
// changes. This file is that half.
//
// Modelled on tests/routing/peeLogRoute.test.ts, including its mocking shape
// and the reason for it: the order of the four checks IS the security
// property. resolveState() itself calls getKey() internally, so "no key was
// fetched" can never be an assertion this suite can make — instead the lock
// test asserts canSeeUserSpace (check 2) is never called, alongside the status
// and the absence of the encrypted file.
//
// ─── WHAT MAKES THIS ROUTE DIFFERENT, AND WHY THIS FILE IS LONGER ──────────
//
// Every other write route in this app files its row under `dayKey(now, tz)`
// and nothing the caller sends can move it. This one takes the DAY from the
// request, because spec v2's marking model is "tapping today's square marks
// today, and back-filling a missed day is the same tap on that earlier
// square". That makes `day` the only friend-supplied value any write route in
// this repo writes into a database — and it is a PRIMARY KEY, so a malformed
// one is not a bad row that can be fixed later, it is a row nothing can ever
// address again. The validation block below is therefore the centre of this
// file, not an afterthought.
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
 * UTC fallback and stays deterministic on any machine. The tests that DO care
 * are load-bearing here in a particular way: this route consults the zone for
 * exactly ONE thing — deciding what counts as the future — and it must reach
 * the same answer app/[user]/page.tsx reaches when it hands the dashboard
 * `today`, or the calendar's today square and the route's idea of today are
 * different days.
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
  registeredSlugs: () => ['run11'],
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
 * run11's REAL migrations, read off disk rather than retyped, so this suite
 * exercises the shape run11.db is actually created under. BOTH files: walk_log
 * arrives in 002, so a fixture that applied only 001 would prove nothing about
 * the table this route writes to.
 */
const MIGRATIONS_SRC = resolve(__dirname, '..', '..', 'users', 'run11', 'migrations')
const MIGRATIONS = ['001_initial.sql', '002_walk_log_and_settings.sql'].map((name) => ({
  name,
  number: Number(name.slice(0, 3)),
  sql: readFileSync(join(MIGRATIONS_SRC, name), 'utf8'),
}))

let dir: string
let handle: PlatformDb | undefined
let accountId: number
let originalEnv: string | undefined

const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-walk-log-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  // The ENCRYPTED write path is what this suite is about — the one that runs
  // against run11's real data on the droplet. lib/db/userData.ts sends dev to
  // synthetic.db instead, so without saying `production` these tests would
  // quietly exercise a different database than the one they describe.
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')
  mkdirSync(join(dir, 'users', 'run11', 'migrations'), { recursive: true })
  for (const m of MIGRATIONS) {
    writeFileSync(join(dir, 'users', 'run11', 'migrations', m.name), m.sql)
  }
  writeFileSync(
    join(dir, 'users', 'run11', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: MIGRATIONS.map((m) => ({
        number: m.number,
        sha256: createHash('sha256').update(m.sql).digest('hex'),
      })),
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
 * Sign run11 in. `lock` withholds the key, as a restart would; `migrate: false`
 * withholds the migration a real login would have run.
 *
 * Everywhere else the default models production: by the time a tap arrives the
 * friend unlocked, so the runner ran and their tables are there. The route
 * never migrates and must not — shape changes belong to the one place that
 * takes a backup first.
 */
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
    // A COPY, not the test's own constant. The keymap ZEROES the buffer it
    // holds when an entry ages out, so handing it KEY directly wipes the
    // constant every other assertion in this file decrypts with.
    putKey(sid, Buffer.from(KEY))
    if (opts.migrate !== false) {
      const { migrateUserDb } = await import('@/lib/db/migrate')
      migrateUserDb(opts.slug ?? 'run11', KEY)
    }
  }
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/walk-log/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

/** A form submit, the way the dashboard's own <form method="post"> sends one. */
function submit(
  fields: Record<string, string> | undefined,
  headers?: Record<string, string>,
): Request {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields ?? {})) body.set(k, v)
  return new Request('http://x', { method: 'POST', body, headers })
}

/** A WriteAction submit: same body, plus the header only fetch can set. */
function fetchSubmit(fields: Record<string, string>): Request {
  return submit(fields, { 'X-Stairwell-Write': '1' })
}

/**
 * Opened directly rather than through the route's own opener, so the test
 * proves the rows are really on disk under that key.
 */
function walkRows(slug = 'run11') {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(join(dir, 'users', slug, `${slug}.db`))
  db.pragma("cipher='chacha20'")
  db.key(KEY)
  try {
    return db.prepare('SELECT day, at FROM walk_log ORDER BY day').all() as {
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
 * metric deliberately carries a slug and a panel and nothing else.
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

/** Today, in whatever zone this test has set. The route computes the same one. */
function today(): string {
  return dayKey(Date.now(), tzSlot.value)
}

/** `n` days before today, in the same zone. */
function ago(n: number): string {
  return dayKey(Date.now() - n * 86_400_000, tzSlot.value)
}

describe('POST /api/users/[user]/walk-log — the four ordered checks', () => {
  it('refuses a LOCKED session before it touches ownership or a file', async () => {
    const POST = await arrange({ lock: true })
    const res = await POST(submit({ action: 'mark', day: today() }), params('run11'))
    expect(res.status).toBe(403)
    // Check 2 was never reached: a route that opened the file and refused
    // afterwards would look identical on status and file-existence alone.
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'users', 'run11', 'run11.db'))).toBe(false)
  })

  it('404s, never 403s, for a slug that is not theirs', async () => {
    // A 403 would confirm that the other account exists.
    const POST = await arrange()
    const res = await POST(submit({ action: 'mark', day: today() }), params('someone-else'))
    expect(res.status).toBe(404)
  })

  it('404s when no dashboard is registered for the slug', async () => {
    // Otherwise any authenticated slug could cause an encrypted file to be
    // created for a user who has no dashboard at all.
    const POST = await arrange()
    loaderSlot.value = undefined
    const res = await POST(submit({ action: 'mark', day: today() }), params('run11'))
    expect(res.status).toBe(404)
    expect(walkRows()).toHaveLength(0)
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
      params('run11'),
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /api/users/[user]/walk-log — the action field', () => {
  it('400s on a missing action, writing nothing', async () => {
    const POST = await arrange()
    const res = await POST(submit({ day: today() }), params('run11'))
    expect(res.status).toBe(400)
    expect(walkRows()).toHaveLength(0)
  })

  it('400s on an action it does not know', async () => {
    const POST = await arrange()
    for (const action of ['add', 'remove', 'drop', '']) {
      expect(
        (await POST(submit({ action, day: today() }), params('run11'))).status,
        `action=${action}`,
      ).toBe(400)
    }
    expect(walkRows()).toHaveLength(0)
  })

  it('400s rather than 500s on a body that is not a form at all', async () => {
    // formData() throws on a malformed body. Uncaught, that is Next's default
    // error page in response to a form submit — the friend leaves the
    // dashboard and has no way back but the browser's back button.
    const POST = await arrange()
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        body: '{"action":"mark"}',
        headers: { 'content-type': 'application/json' },
      }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    expect(walkRows()).toHaveLength(0)
  })
})

describe('POST /api/users/[user]/walk-log — the day field, which is the caller’s', () => {
  it('400s on a missing day', async () => {
    const POST = await arrange()
    expect((await POST(submit({ action: 'mark' }), params('run11'))).status).toBe(400)
    expect(walkRows()).toHaveLength(0)
  })

  it('400s on anything that is not the SHAPE of a day key', async () => {
    const POST = await arrange()
    for (const day of [
      '',
      'today',
      '2026-8-1',
      '26-08-01',
      '2026-08-01T00:00:00Z',
      '2026-08-01 ',
      "2026-08-01'; DROP TABLE walk_log; --",
    ]) {
      expect(
        (await POST(submit({ action: 'mark', day }), params('run11'))).status,
        `day=${JSON.stringify(day)}`,
      ).toBe(400)
    }
    expect(walkRows()).toHaveLength(0)
  })

  it('400s on a well-shaped day that is not a real date', async () => {
    // THE CHECK A REGEX ALONE MISSES. `2026-02-30` matches the pattern
    // perfectly and `Date` silently rolls it forward to March 2nd — which
    // would file a mark on a day the friend never tapped, under a primary key
    // nothing can later address as the day he meant.
    const POST = await arrange()
    for (const day of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31']) {
      expect(
        (await POST(submit({ action: 'mark', day }), params('run11'))).status,
        `day=${day}`,
      ).toBe(400)
    }
    expect(walkRows()).toHaveLength(0)
  })

  it('400s on a FUTURE day, which the calendar cannot even offer', async () => {
    // spec v2: "Future days should not be markable." A mark is a record that a
    // walk happened. The calendar renders future squares with no control at
    // all, so this is unreachable through the dashboard — it is here because a
    // disabled control is an affordance, not a rule, and the no-JS path posts
    // whatever the form holds.
    const POST = await arrange()
    const tomorrow = dayKey(Date.now() + 86_400_000, undefined)
    expect((await POST(submit({ action: 'mark', day: tomorrow }), params('run11'))).status).toBe(
      400,
    )
    expect(walkRows()).toHaveLength(0)
  })

  it('accepts TODAY — the boundary is strict, not off by one', async () => {
    const POST = await arrange()
    const res = await POST(submit({ action: 'mark', day: today() }), params('run11'))
    expect(res.status).toBe(303)
    expect(walkRows().map((r) => r.day)).toEqual([today()])
  })

  it('BACK-FILLS an earlier day, which is half of what the calendar is for', async () => {
    // "back-filling a missed day is the same tap on that earlier square."
    const POST = await arrange()
    await POST(submit({ action: 'mark', day: ago(4) }), params('run11'))
    await POST(submit({ action: 'mark', day: ago(1) }), params('run11'))
    expect(walkRows().map((r) => r.day)).toEqual([ago(4), ago(1)].sort())
  })

  it('decides "the future" in the FRIEND’S calendar, not the droplet’s', async () => {
    // The bug the timezone ledger is about, in the one place this route can
    // still make it: the droplet is UTC, and 01:30Z on the 20th is still the
    // 19th in New York. A route that judged the future against UTC would
    // refuse a friend in New York the right to mark his own today — the exact
    // square the calendar rings and invites him to tap.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 20, 1, 30)))
      tzSlot.value = 'America/New_York'
      const POST = await arrange()
      const res = await POST(submit({ action: 'mark', day: '2026-08-19' }), params('run11'))
      expect(res.status).toBe(303)
      expect(walkRows().map((r) => r.day)).toEqual(['2026-08-19'])
      // And the UTC day, which is genuinely still in his future, is refused.
      expect(dayKey(Date.now(), 'UTC')).toBe('2026-08-20')
      expect(
        (await POST(submit({ action: 'mark', day: '2026-08-20' }), params('run11'))).status,
      ).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('POST /api/users/[user]/walk-log — marking and unmarking', () => {
  it('treats a second mark of the same day as the SAME FACT, not a second row', async () => {
    // spec v2: "One walk per day is all that's recorded." A table keyed by day
    // records a fact ABOUT a day, so INSERT OR IGNORE is right here where it
    // would be wrong on run10's pee log, whose taps are occurrences.
    const POST = await arrange()
    const day = today()
    const first = await POST(submit({ action: 'mark', day }), params('run11'))
    const second = await POST(submit({ action: 'mark', day }), params('run11'))
    expect(first.status).toBe(303)
    expect(second.status).toBe(303)
    const rows = walkRows()
    expect(rows).toHaveLength(1)
    // The FIRST mark's instant survives: a second tap is a no-op, not an
    // overwrite.
    expect(rows[0]!.at).toBeGreaterThan(0)
  })

  it('unmarks a day, so a mis-tap is recoverable', async () => {
    // spec v2 asks for this by name, and it is the opposite call from run10's,
    // whose spec asks for a tap and nothing that takes one back.
    const POST = await arrange()
    const day = today()
    await POST(submit({ action: 'mark', day }), params('run11'))
    expect(walkRows()).toHaveLength(1)
    const res = await POST(submit({ action: 'unmark', day }), params('run11'))
    expect(res.status).toBe(303)
    expect(walkRows()).toHaveLength(0)
  })

  it('unmarks ONLY the day it was given', async () => {
    // A DELETE with a wrong or missing WHERE would clear a friend's whole
    // history on one mis-tap, and there is no undo for that anywhere in this
    // system.
    const POST = await arrange()
    for (const day of [ago(2), ago(1), today()]) {
      await POST(submit({ action: 'mark', day }), params('run11'))
    }
    await POST(submit({ action: 'unmark', day: ago(1) }), params('run11'))
    expect(walkRows().map((r) => r.day)).toEqual([ago(2), today()].sort())
  })

  it('treats unmarking an unmarked day as a no-op, not an error', async () => {
    // His intent is "this day should not be marked"; whether it already was is
    // not something he should have to be right about.
    const POST = await arrange()
    const res = await POST(submit({ action: 'unmark', day: ago(3) }), params('run11'))
    expect(res.status).toBe(303)
    expect(walkRows()).toHaveLength(0)
  })

  it('stores `at` as the instant of the MARK, on the day the caller named', async () => {
    // The two are deliberately allowed to disagree: a back-filled day carries
    // the instant it was entered, not an invented one inside the day itself.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 20, 12, 0, 0)))
      const stamped = Date.now()
      const POST = await arrange()
      await POST(submit({ action: 'mark', day: '2026-08-14' }), params('run11'))
      const row = walkRows()[0]!
      expect(row.day).toBe('2026-08-14')
      expect(row.at).toBe(stamped)
      expect(dayKey(row.at, 'UTC')).not.toBe(row.day)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('POST /api/users/[user]/walk-log — how it answers (lib/http/redirect.ts writeAnswer)', () => {
  it('answers a fetch-initiated write with 204, never a redirect the browser would follow', async () => {
    // A 303 here would be followed by fetch's default redirect:'follow',
    // rendering the whole dashboard again and appending a SECOND
    // dashboard_open row before router.refresh() adds a third.
    const POST = await arrange()
    const res = await POST(fetchSubmit({ action: 'mark', day: today() }), params('run11'))
    expect(res.status).toBe(204)
    expect(res.headers.get('location')).toBeNull()
    expect(walkRows()).toHaveLength(1)
  })

  it('sends a native form post back to the WALK LOG screen, not the decider', async () => {
    // The no-JS path WriteAction degrades to. Landing a friend who just tapped
    // a calendar square back on the decider would look like the tap undid
    // itself — this route is the only one in the repo whose redirect names a
    // screen, and that is why.
    const POST = await arrange()
    const res = await POST(submit({ action: 'mark', day: today() }), params('run11'))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/run11?screen=walk_log')
  })
})

describe('POST /api/users/[user]/walk-log — metrics and failures', () => {
  it('records a slug and a panel, and NEVER the day', async () => {
    // The permanent metrics policy, and it matters more here than anywhere
    // else in this repo: the day is the one thing the caller sent, and it is a
    // fact about the friend's life. `metrics` is the unencrypted platform
    // database, and this row is what makes the login page's "I can see when
    // you use it ... but not what you log" true.
    const POST = await arrange()
    const day = ago(3)
    await POST(submit({ action: 'mark', day }), params('run11'))
    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .get() as { data: string }
    expect(JSON.parse(row.data)).toEqual({
      slug: 'run11',
      panel: 'walk_log_mark',
      device_class: 'desktop',
    })
    // Said twice on purpose: the day must not appear anywhere in the row, not
    // under a key this assertion happened not to name.
    expect(row.data).not.toContain(day)
  })

  it('names marking and unmarking as DIFFERENT panels', async () => {
    // A query grouping metric rows by panel needs to tell them apart. A single
    // reused name would make "he logged 40 walks" and "he corrected 40
    // mis-taps" the same row.
    const POST = await arrange()
    const day = today()
    await POST(submit({ action: 'mark', day }), params('run11'))
    await POST(submit({ action: 'unmark', day }), params('run11'))
    const panels = (
      handle!
        .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write' ORDER BY id")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data).panel)
    expect(panels).toEqual(['walk_log_mark', 'walk_log_unmark'])
  })

  it('returns a bodyless 500 and records dashboard_write_error when the WRITE throws', async () => {
    // A full disk, a SQLITE_BUSY outliving the driver's timeout, or a missing
    // table. Without the catch the friend gets Next's default error page in
    // response to a form submit — no dashboard, no chat surface, no way back —
    // and no metric row, so it is invisible to the operator too. Modelled by
    // withholding the migration, so the table genuinely is not there.
    const POST = await arrange({ migrate: false })
    const [res, stderr] = await withStderr(() =>
      POST(submit({ action: 'mark', day: today() }), params('run11')),
    )

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    // Slug and panel, never the driver's message: a constraint violation can
    // quote a column's contents, and this table is unencrypted.
    expect(JSON.parse(row!.data)).toEqual({
      slug: 'run11',
      panel: 'walk_log_mark',
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
