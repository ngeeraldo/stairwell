// tests/routing/noGoTempRoute.test.ts
//
// run11's other write path — the ONLY thing pinning
// app/api/users/[user]/no-go-temp/route.ts. users/run11/tests/noGoTemp.test.ts
// reproduces the upsert by hand (a platform route must not be imported by a
// user's test) and pins the two files' duplicated bounds against each other;
// this file is the half that runs the real route.
//
// Modelled on tests/routing/peeLogRoute.test.ts, including its mocking shape
// and the reason for it: the order of the four checks IS the security
// property.
//
// ─── WHAT IS ACTUALLY AT RISK HERE ─────────────────────────────────────────
//
// This route stores the number the verdict is judged against, so a bug in it
// is not a lost row — it is a friend reading "Go" on a screen whose control
// says something else, or a screen stuck at a temperature its own buttons
// cannot move. That is why the tests below care about the STEP being computed
// from the stored row rather than sent, and about the clamp holding at both
// ends however the request arrived.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { setNodeEnv } from '@/tests/support/nodeEnv'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import {
  DEFAULT_HEAT_NO_GO_F,
  HEAT_NO_GO_MAX_F,
  HEAT_NO_GO_MIN_F,
  HEAT_NO_GO_STEP_F,
} from '@/users/run11/queries'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) => {
  if (name === sessionCookieName) return cookieSlot.value
  return undefined
})
/**
 * `headers` is stubbed alongside `cookies` because lib/metrics/deviceClass.ts
 * reads the User-Agent as its fallback when no stairwell_dc cookie exists.
 *
 * NO stairwell_tz slot here, unlike the walk-log route's suite: this route
 * consults no timezone at all. A setting is not an event, so nothing it writes
 * is filed under a calendar day and there is no zone for it to get wrong.
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

const canSeeUserSpaceSpy = vi.fn()
const accountIdForSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>('@/lib/auth/authorize')
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  accountIdForSpy.mockImplementation(actual.accountIdFor)
  return { ...actual, canSeeUserSpace: canSeeUserSpaceSpy, accountIdFor: accountIdForSpy }
})

/** run11's REAL migrations — walk_settings arrives in 002. */
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
  dir = mkdtempSync(join(tmpdir(), 'stairwell-no-go-temp-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  // The ENCRYPTED write path is what this suite is about — the one that runs
  // against run11's real data on the droplet.
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
    // holds when an entry ages out.
    putKey(sid, Buffer.from(KEY))
    if (opts.migrate !== false) {
      const { migrateUserDb } = await import('@/lib/db/migrate')
      migrateUserDb(opts.slug ?? 'run11', KEY)
    }
  }
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/no-go-temp/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

function submit(fields: Record<string, string>, headers?: Record<string, string>): Request {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return new Request('http://x', { method: 'POST', body, headers })
}

function fetchSubmit(fields: Record<string, string>): Request {
  return submit(fields, { 'X-Stairwell-Write': '1' })
}

/** Opened directly, so the test proves the row is really on disk under the key. */
function settingsRows(slug = 'run11') {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(join(dir, 'users', slug, `${slug}.db`))
  db.pragma("cipher='chacha20'")
  db.key(KEY)
  try {
    return db.prepare('SELECT id, heat_no_go_f, set_at FROM walk_settings ORDER BY id').all() as {
      id: number
      heat_no_go_f: number
      set_at: number
    }[]
  } finally {
    db.close()
  }
}

/** The stored value, or undefined if he has never set one. */
function stored(): number | undefined {
  return settingsRows()[0]?.heat_no_go_f
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

describe('POST /api/users/[user]/no-go-temp — the four ordered checks', () => {
  it('refuses a LOCKED session before it touches ownership or a file', async () => {
    const POST = await arrange({ lock: true })
    const res = await POST(submit({ action: 'raise' }), params('run11'))
    expect(res.status).toBe(403)
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'users', 'run11', 'run11.db'))).toBe(false)
  })

  it('404s, never 403s, for a slug that is not theirs', async () => {
    const POST = await arrange()
    expect((await POST(submit({ action: 'raise' }), params('someone-else'))).status).toBe(404)
  })

  it('404s when no dashboard is registered for the slug', async () => {
    const POST = await arrange()
    loaderSlot.value = undefined
    expect((await POST(submit({ action: 'raise' }), params('run11'))).status).toBe(404)
    expect(settingsRows()).toHaveLength(0)
  })

  it('refuses an unauthenticated caller WITHOUT parsing its body', async () => {
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

describe('POST /api/users/[user]/no-go-temp — the action field', () => {
  it('400s on a missing or unknown action, writing nothing', async () => {
    const POST = await arrange()
    for (const body of [{}, { action: '' }, { action: 'set' }, { action: 'add' }]) {
      expect(
        (await POST(submit(body as Record<string, string>), params('run11'))).status,
        JSON.stringify(body),
      ).toBe(400)
    }
    expect(settingsRows()).toHaveLength(0)
  })

  it('400s rather than 500s on a body that is not a form at all', async () => {
    const POST = await arrange()
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        body: '{"action":"raise"}',
        headers: { 'content-type': 'application/json' },
      }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    expect(settingsRows()).toHaveLength(0)
  })

  it('IGNORES a value the caller sends — the direction is the whole payload', async () => {
    // The route computes the new number from the row it finds, so a body
    // carrying a target is not merely rejected, it is not read at all. Sending
    // one must not move the number anywhere but one step.
    const POST = await arrange()
    await POST(submit({ action: 'raise', value: '105', heat_no_go_f: '105' }), params('run11'))
    expect(stored()).toBe(DEFAULT_HEAT_NO_GO_F + HEAT_NO_GO_STEP_F)
  })
})

describe('POST /api/users/[user]/no-go-temp — stepping', () => {
  it('starts from the DEFAULT on the very first press, not from zero', async () => {
    // There is no row to read yet — a migration never seeds one — so the first
    // press has to know what the screen was showing. Pressing + on a screen
    // reading 90 must store 91.
    const POST = await arrange()
    const res = await POST(submit({ action: 'raise' }), params('run11'))
    expect(res.status).toBe(303)
    expect(stored()).toBe(91)
    expect(DEFAULT_HEAT_NO_GO_F).toBe(90)
  })

  it('steps down from the default too', async () => {
    const POST = await arrange()
    await POST(submit({ action: 'lower' }), params('run11'))
    expect(stored()).toBe(89)
  })

  it('accumulates one degree a press, from the STORED value each time', async () => {
    // The race this shape exists to prevent is two presses each computing from
    // a value the other has already replaced. Sequentially it shows up as a
    // number that does not accumulate.
    const POST = await arrange()
    for (let i = 0; i < 4; i += 1) await POST(submit({ action: 'raise' }), params('run11'))
    expect(stored()).toBe(94)
    await POST(submit({ action: 'lower' }), params('run11'))
    expect(stored()).toBe(93)
  })

  it('keeps exactly ONE row however many times it is pressed', async () => {
    // 002's CHECK (id = 1) makes this a property of the shape, and the upsert
    // is what keeps the route from meeting it as an error. A second row would
    // mean a read somewhere had to decide which one wins.
    const POST = await arrange()
    for (let i = 0; i < 3; i += 1) await POST(submit({ action: 'raise' }), params('run11'))
    const rows = settingsRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(1)
  })

  it('moves set_at with the value', async () => {
    const POST = await arrange()
    await POST(submit({ action: 'raise' }), params('run11'))
    const first = settingsRows()[0]!.set_at
    expect(first).toBeGreaterThan(0)
  })

  it('CLAMPS at the top and stays there, rather than refusing', async () => {
    // The dashboard disables the control at the ends, but a disabled button is
    // an affordance and this is the rule — the no-JS path has no such guard.
    // Clamping rather than 400ing means the friend who somehow gets here still
    // ends on a number his own buttons can move.
    const POST = await arrange()
    const presses = HEAT_NO_GO_MAX_F - DEFAULT_HEAT_NO_GO_F + 5
    for (let i = 0; i < presses; i += 1) await POST(submit({ action: 'raise' }), params('run11'))
    expect(stored()).toBe(HEAT_NO_GO_MAX_F)
    // And it can still come back down: the clamp is a ceiling, not a latch.
    await POST(submit({ action: 'lower' }), params('run11'))
    expect(stored()).toBe(HEAT_NO_GO_MAX_F - HEAT_NO_GO_STEP_F)
  })

  it('CLAMPS at the bottom the same way', async () => {
    const POST = await arrange()
    const presses = DEFAULT_HEAT_NO_GO_F - HEAT_NO_GO_MIN_F + 5
    for (let i = 0; i < presses; i += 1) await POST(submit({ action: 'lower' }), params('run11'))
    expect(stored()).toBe(HEAT_NO_GO_MIN_F)
  })
})

describe('POST /api/users/[user]/no-go-temp — how it answers, and what it records', () => {
  it('answers a fetch-initiated write with 204, never a redirect', async () => {
    const POST = await arrange()
    const res = await POST(fetchSubmit({ action: 'raise' }), params('run11'))
    expect(res.status).toBe(204)
    expect(res.headers.get('location')).toBeNull()
    expect(stored()).toBe(91)
  })

  it('sends a native form post back to the decider, where the control lives', async () => {
    const POST = await arrange()
    const res = await POST(submit({ action: 'raise' }), params('run11'))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/run11')
  })

  it('records a slug and a panel, and NEVER the temperature', async () => {
    // A threshold someone picked for their own dog is a preference about their
    // life, and `metrics` is the unencrypted platform database. The direction
    // is carried by the panel name, a constant chosen by the builder.
    const POST = await arrange()
    await POST(submit({ action: 'raise' }), params('run11'))
    await POST(submit({ action: 'lower' }), params('run11'))
    const rows = (
      handle!
        .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write' ORDER BY id")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data))
    expect(rows).toEqual([
      { slug: 'run11', panel: 'no_go_temp_raise', device_class: 'desktop' },
      { slug: 'run11', panel: 'no_go_temp_lower', device_class: 'desktop' },
    ])
    // No number anywhere in either row, under any key.
    for (const row of rows) expect(JSON.stringify(row)).not.toMatch(/9[01]/)
  })

  it('returns a bodyless 500 and records dashboard_write_error when the WRITE throws', async () => {
    // Modelled by withholding the migration, so walk_settings genuinely is not
    // there. Without the catch the friend gets Next's default error page in
    // response to a form submit, and no metric row makes it visible to the
    // operator.
    const POST = await arrange({ migrate: false })
    const [res, stderr] = await withStderr(() => POST(submit({ action: 'raise' }), params('run11')))

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write_error'")
      .get() as { data: string } | undefined
    expect(JSON.parse(row!.data)).toEqual({
      slug: 'run11',
      panel: 'no_go_temp_raise',
      device_class: 'desktop',
    })
    expect(stderr).not.toBe('')
    expect(
      handle!.prepare("SELECT 1 FROM metrics WHERE event = 'dashboard_write'").get(),
    ).toBeUndefined()
  })
})
