// tests/routing/dashboardRegion.test.ts
//
// The data region of app/[user]/page.tsx. Ownership, 404-vs-403 and the
// proposal card are covered in tests/routing/userSpace.test.ts; this file
// covers only what the page does once it has decided the visitor is the
// owner.
//
// The registry and the resolver are mocked here rather than pointed at real
// files, so a test can produce a THROWING dashboard and a missing database on
// demand — neither of which the real tree can be made to do without leaving
// junk in users/.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PLACEHOLDER_CARD } from '@/lib/copy/onboarding'
import type { PlatformDb } from '@/lib/db/platform'

// Same reason as tests/routing/userSpace.test.ts: vitest's esbuild transform
// emits classic React.createElement calls for "jsx": "preserve".
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
const redirectMock = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`)
})
vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
  redirect: (path: string) => redirectMock(path),
}))

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

// --- the two seams under test ---------------------------------------------
type Loader = (() => Promise<{ default: (p: unknown) => unknown }>) | undefined
const loaderSlot: { value: Loader } = { value: undefined }
const loaderFor = vi.fn((_slug: string): Loader => loaderSlot.value)
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: (slug: string) => loaderFor(slug),
  registeredSlugs: () => [],
  // This file is about the DATA region, not the shell; a dashboard exists in
  // every test here that matters, and the boolean only decides whether the
  // chat starts open.
  hasDashboard: () => true,
}))

type Data = { source: 'synthetic' | 'none'; db: unknown }
const dataSlot: { value: Data } = { value: { source: 'none', db: undefined } }
const openUserDbMock = vi.fn((_slug: string): Data => dataSlot.value)
vi.mock('@/lib/db/userDb', () => ({
  openUserDb: (slug: string) => openUserDbMock(slug),
}))

/**
 * A local stand-in, not the real class: this module is mocked, so
 * app/[user]/page.tsx's `error instanceof WrongKeyError` check resolves
 * against THIS export, not lib/db/encryptedUserDb.ts's real one. Structurally
 * equivalent is enough — nothing beyond `instanceof` matters to the page.
 */
class WrongKeyError extends Error {
  constructor(slug: string) {
    super(`${slug}.db exists but did not open with this session's key`)
    this.name = 'WrongKeyError'
  }
}

const encryptedSlot: {
  /**
   * Whether the friend's encrypted database holds any TABLES.
   *
   * It used to be `exists`, and the rename is the whole of onboarding ledger
   * D3 in one word. Since S2 creates the file when the password is set, every
   * invited friend HAS a file from day one — so existence stopped meaning
   * "has data", and the render path asks about tables instead. A fixture that
   * still said `exists` would let the empty-database case go untested while
   * looking covered.
   */
  hasTables: boolean
  rows: unknown[]
  throwOnOpen: 'wrong_key' | 'other' | undefined
  /** Throw from the hasTables PREDICATE rather than from the open. */
  throwOnHasTables: boolean
} = {
  hasTables: false,
  rows: [],
  throwOnOpen: undefined,
  throwOnHasTables: false,
}
// A real vi.fn(), not a no-op stub: drill 3 (task-3 fix round) showed the
// no-op let a missing db.close() pass silently. Asserting this was called
// converts that residual into a real, pinned assertion.
const closeMock = vi.fn()
// Argument-aware ON PURPOSE. The previous form took no parameters and the
// vi.mock factory called it as `() => openEncryptedMock()`, which discarded
// everything the page passed — so `{ readonly: true }` at the call site was
// invisible to every test in this file, and dropping it there left the whole
// suite green while every render opened the friend's real database WRITABLE
// and re-executed schema.sql. The implementation-side flag was drilled in fix
// round 1; the CALLER was not. It is now.
const openEncryptedMock = vi.fn((_slug?: unknown, _key?: unknown, _options?: unknown) => {
  if (encryptedSlot.throwOnOpen === 'wrong_key') {
    throw new WrongKeyError(SLUG)
  }
  if (encryptedSlot.throwOnOpen === 'other') {
    // A recognisable, obviously-fake fragment. The fix-round-2 drill checks
    // this string reaches metrics NOWHERE — not in the parsed payload and
    // not in the raw stored column — because a non-WrongKeyError exception
    // from openEncryptedUserDb is exactly the case the untyped `.message`
    // capture used to let through uninspected.
    throw new Error('REAL ACCOUNT NUMBER 4111 5551 2222 TEST')
  }
  return {
    prepare: () => ({ all: () => encryptedSlot.rows, get: () => encryptedSlot.rows[0] }),
    close: closeMock,
  }
})
vi.mock('@/lib/db/encryptedUserDb', () => ({
  encryptedUserDbHasTables: () => {
    if (encryptedSlot.throwOnHasTables) throw new WrongKeyError(SLUG)
    return encryptedSlot.hasTables
  },
  openEncryptedUserDb: (...args: unknown[]) => openEncryptedMock(...args),
  WrongKeyError,
}))

const SLUG = 'devone'

/**
 * The one sentence on the dashboard addressed to the PERSON rather than to
 * whoever is demonstrating it.
 *
 * Held as a constant and asserted verbatim, the way
 * tests/routing/loginPage.test.ts pins the onboarding promises, because it is
 * copy that carries a commitment: the sample below looks like a real record,
 * and the friend's first tap replaces 77% / nine walked days with 3% / one.
 * Someone who mistook the sample for their own would read that as having lost
 * something. It must appear WITH the banner and never without it — over real
 * data it would be a lie about their own history.
 */
const SAMPLE_NOTICE =
  "This sample history isn't yours. Your own record starts empty, with your first tap."


let pageDir: string
let handle: PlatformDb | undefined
let accountId: number

/** Log devone in, unlocked unless `lock` is set, and return the page module. */
async function arrange(opts: { lock?: boolean } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: SLUG,
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) putKey(sid, Buffer.alloc(32, 1))
  cookieSlot.value = { value: sid }
  const { default: UserSpace } = await import('@/app/[user]/page')
  return UserSpace
}

function metricEvents(): string[] {
  return (
    handle!.prepare('SELECT event FROM metrics ORDER BY id').all() as {
      event: string
    }[]
  ).map((r) => r.event)
}

function metricData(event: string): Record<string, unknown> | undefined {
  const row = handle!
    .prepare('SELECT data FROM metrics WHERE event = ? ORDER BY id DESC LIMIT 1')
    .get(event) as { data: string | null } | undefined
  return row?.data ? (JSON.parse(row.data) as Record<string, unknown>) : undefined
}

/**
 * The raw stored column, not the parsed object — proves a string never
 * touched the actual append-only bytes, rather than merely being absent from
 * the keys an `.toEqual` happened to check.
 */
function rawMetricData(event: string): string | null {
  const row = handle!
    .prepare('SELECT data FROM metrics WHERE event = ? ORDER BY id DESC LIMIT 1')
    .get(event) as { data: string | null } | undefined
  return row?.data ?? null
}

/** A real read-only handle over a throwaway file, for the rendering cases. */
function realDb(): unknown {
  const path = join(pageDir, 'devone-synthetic.db')
  const seed = new Database(path)
  seed.exec('CREATE TABLE transactions (merchant TEXT NOT NULL)')
  seed
    .prepare('INSERT INTO transactions (merchant) VALUES (?)')
    .run('COFFEE PALACE TEST')
  seed.close()
  return new Database(path, { readonly: true, fileMustExist: true })
}

beforeEach(() => {
  pageDir = mkdtempSync(join(tmpdir(), 'stairwell-dashregion-'))
  process.env.PLATFORM_DB = join(pageDir, 'synthetic.db')
  vi.resetModules()
  notFoundMock.mockClear()
  redirectMock.mockClear()
  cookieGet.mockClear()
  loaderFor.mockClear()
  openUserDbMock.mockClear()
  cookieSlot.value = undefined
  loaderSlot.value = undefined
  dataSlot.value = { source: 'none', db: undefined }
  handle = undefined
  encryptedSlot.hasTables = false
  encryptedSlot.rows = []
  encryptedSlot.throwOnOpen = undefined
  encryptedSlot.throwOnHasTables = false
  openEncryptedMock.mockClear()
  closeMock.mockClear()
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  rmSync(pageDir, { recursive: true, force: true })
})

describe('app/[user]/page.tsx data region', () => {
  it('shows the locked notice and never opens a database', async () => {
    // The order property, not just the output: in step 6 opening this file
    // needs a key the locked session does not have. A page that opened first
    // and hid the result afterwards would look identical here and be wrong
    // then, so the assertion is on the CALL, not on the markup.
    const UserSpace = await arrange({ lock: true })
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('Locked')
    expect(openUserDbMock).not.toHaveBeenCalled()
    expect(loaderFor).not.toHaveBeenCalled()
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('shows the not-built placeholder when no dashboard is registered', async () => {
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    // The placeholder CARD, not a sentence (onboarding-ux-spec.md S3). Its
    // exact copy is pinned in tests/copy/onboarding.test.ts; what matters here
    // is that this branch renders it and opens no database.
    const html = renderToStaticMarkup(element as React.ReactElement)
    expect(html).toContain(PLACEHOLDER_CARD.heading)
    expect(html).not.toContain('SYNTHETIC DATA')
    expect(openUserDbMock).not.toHaveBeenCalled()
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('says so when the dashboard exists but its data has not been generated', async () => {
    loaderSlot.value = async () => ({ default: () => null as never })
    dataSlot.value = { source: 'none', db: undefined }
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('has not been generated yet')
    expect(json).not.toContain('SYNTHETIC DATA')
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('renders the dashboard under a synthetic banner and records dashboard_open', async () => {
    const db = realDb()
    dataSlot.value = { source: 'synthetic', db }
    const seen: unknown[] = []
    loaderSlot.value = async () => ({
      default: (props: unknown) => {
        seen.push(props)
        return React.createElement('section', null, 'PANEL RENDERED TEST')
      },
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element).replace(/&apos;|&#39;/g, "'")
    expect(json).toContain('SYNTHETIC DATA')
    // Travels with the banner, always. JSX escapes the apostrophe in source;
    // the rendered tree carries the real character, so unescape before
    // comparing — same treatment as the login promises.
    expect(json).toContain(SAMPLE_NOTICE)
    expect(json).toContain('PANEL RENDERED TEST')
    // The dashboard got its own slug and the exact handle the page resolved —
    // this is the wiring assertion, not just "some component rendered".
    // Identity (toBe) on the handle, not deep equality: a Database instance
    // is a native object and toEqual on one compares nothing meaningful.
    expect(seen).toHaveLength(1)
    expect((seen[0] as { slug: string }).slug).toBe(SLUG)
    expect((seen[0] as { db: unknown }).db).toBe(db)
    expect(loaderFor).toHaveBeenCalledWith(SLUG)
    expect(openUserDbMock).toHaveBeenCalledWith(SLUG)
    expect(metricEvents()).toContain('dashboard_open')
    // EXACT shape, not a subset match. dashboard_open carries a slug, a
    // source and a device class and nothing else — the permanent policy is
    // that metrics never carry user values, and an exact assertion is what
    // makes an added field a decision somebody had to come here and make.
    // device_class is 'desktop' because this fixture has neither the
    // stairwell_dc cookie nor a User-Agent (onboarding ledger D4).
    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
      device_class: 'desktop',
    })
  })

  it('degrades a throwing dashboard instead of 500ing the whole page', async () => {
    // Bespoke per-user code is the least-reviewed code in the repo. The chat
    // surface above this region is how the friend TELLS Nico it broke, so it
    // must survive.
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => {
        throw new Error('panel query blew up TEST')
      },
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('This dashboard failed to load')
    expect(json).not.toContain('PANEL RENDERED TEST')
    expect(notFoundMock).not.toHaveBeenCalled()
    // A failed render is not an open.
    expect(metricEvents()).toContain('dashboard_error')
    expect(metricEvents()).not.toContain('dashboard_open')
    // The panel-throw catch (renderDashboard) is bound by the same policy as
    // the encrypted-open catch: a bounded `kind`, never the thrown message.
    // WrongKeyError cannot come from here, so 'error' is the only kind this
    // path can ever record.
    expect(metricData('dashboard_error')).toEqual({
      slug: SLUG,
      kind: 'error',
      device_class: 'desktop',
    })
    expect(rawMetricData('dashboard_error')).not.toContain('panel query blew up TEST')
  })

  it('degrades a loader that fails to import at all', async () => {
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => {
      throw new Error('module not found TEST')
    }
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('This dashboard failed to load')
    expect(metricEvents()).toContain('dashboard_error')
  })

  it('reads the encrypted database and drops the banner once real data exists', async () => {
    encryptedSlot.hasTables = true
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'REAL PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('REAL PANEL TEST')
    // The banner is the ONLY thing distinguishing a screen of sample data from
    // a screen of the friend's own. It must go when the data is real.
    expect(json).not.toContain('SYNTHETIC DATA')
    // ...and neither does the sample notice. Over the friend's own data it
    // would be a false statement about their history, which is worse than
    // saying nothing.
    expect(json.replace(/&apos;|&#39;/g, "'")).not.toContain(SAMPLE_NOTICE)
    expect(openEncryptedMock).toHaveBeenCalled()
    // THE RENDER PATH OPENS READ-ONLY. Asserted at the CALL SITE, because the
    // flag has two halves and only one of them was pinned: fix round 1 drilled
    // the implementation (removing `readonly: true` from openEncryptedUserDb
    // reddens one test), but nothing watched whether the page still asked for
    // it. Dropping the option here left 640/640 green. If it goes, every
    // dashboard render opens the friend's real database writable AND
    // re-executes schema.sql — a render becomes a migrator, which the step-6a
    // ledger's residual 2 says must not happen before 6b designs migration.
    expect(openEncryptedMock).toHaveBeenCalledWith(SLUG, expect.anything(), {
      readonly: true,
    })
    // A handle is scoped to one key and a key to one session — caching it
    // process-wide is the bug step 5's ledger warns against, so the request
    // must close what it opened.
    expect(closeMock).toHaveBeenCalled()
  })

  it('degrades instead of 500ing the whole route when a wrong key is presented', async () => {
    // Before the task-3 fix round, openEncryptedUserDb sat outside the try,
    // so this throw would propagate past dashboardRegion with no error.tsx
    // anywhere in app/ — taking the chat panel and logout button down with
    // it, which is exactly the surface a friend uses to report the
    // dashboard broke.
    encryptedSlot.hasTables = true
    encryptedSlot.throwOnOpen = 'wrong_key'
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'UNREACHED PANEL TEST'),
    })
    const UserSpace = await arrange()
    const stderr: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '))
    })
    let element: unknown
    try {
      element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })
    } finally {
      errSpy.mockRestore()
    }

    const json = JSON.stringify(element)
    expect(json).toContain('This dashboard failed to load')
    // The chat panel and logout button survive — the page degraded, it did
    // not 500 the whole route.
    expect(json).toContain('Log out')
    expect(metricEvents()).toContain('dashboard_error')
    // `kind` is a closed two-value set on purpose, so the stderr line is the
    // only thing that tells an operator WHICH failure this was. Pinned at the
    // call site: deleting the console.error from this catch reddened nothing
    // before this assertion existed.
    expect(stderr.join('\n')).toContain('WrongKeyError')
    expect(stderr.join('\n')).toContain(SLUG)
    expect(metricEvents()).not.toContain('dashboard_open')
    expect(metricData('dashboard_error')).toEqual({
      slug: SLUG,
      kind: 'wrong_key',
      device_class: 'desktop',
    })
  })

  it('never writes an opening error message into metrics, even a non-WrongKeyError one', async () => {
    // Fix-round-2 drill: this is the test that actually pins the policy
    // (nothing user-derived goes into metrics, ever), rather than pinning
    // one expected payload. openEncryptedUserDb can throw something other
    // than WrongKeyError (a permissions error, a different driver failure,
    // ...) and the untyped `error.message` capture this replaced would have
    // committed that raw text permanently to an append-only, unencrypted
    // table — see step 5's ledger residual 6.
    encryptedSlot.hasTables = true
    encryptedSlot.throwOnOpen = 'other'
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'UNREACHED PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('This dashboard failed to load')
    expect(metricData('dashboard_error')).toEqual({
      slug: SLUG,
      kind: 'error',
      device_class: 'desktop',
    })
    // The raw stored column, not just the parsed object's keys: the
    // recognisable fragment must never have touched the append-only bytes.
    const raw = rawMetricData('dashboard_error')
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('REAL ACCOUNT NUMBER')
    expect(raw).not.toContain('4111')
  })

  it('keeps the synthetic banner while no real database exists', async () => {
    encryptedSlot.hasTables = false
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'SAMPLE PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('SYNTHETIC DATA')
    expect(openEncryptedMock).not.toHaveBeenCalled()
  })

  it('shows the SYNTHETIC dashboard when the real database exists but is EMPTY', async () => {
    // The case this whole task exists for (onboarding ledger D3). Every
    // invited friend is in this state for days: the file was created when they
    // set their password, and nothing has written to it yet.
    //
    // Read as real, it would send the dashboard's first SELECT into the catch
    // and render "This dashboard failed to load" — PERMANENTLY, because the
    // read-only handle can never create the tables and the friend has no
    // control that would. So the assertion is not just "banner present": it is
    // also that the failure text is absent, because that is the actual defect.
    encryptedSlot.hasTables = false
    dataSlot.value = { source: 'synthetic', db: realDb() }
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'SAMPLE PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('SYNTHETIC DATA')
    expect(json).toContain('SAMPLE PANEL TEST')
    expect(json).not.toContain('This dashboard failed to load')
    expect(metricData('dashboard_open')).toMatchObject({ source: 'synthetic' })
  })

  it('degrades rather than 500ing when the TABLE CHECK itself hits a wrong key', async () => {
    // The predicate opens the file, so it can throw exactly like the open can.
    // Uncaught, it would escape dashboardRegion into the route's default error
    // boundary and take the chat panel and logout button with it — the surface
    // a friend needs in order to report that their dashboard broke.
    encryptedSlot.throwOnHasTables = true
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'REAL PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('This dashboard failed to load')
    expect(metricData('dashboard_error')).toMatchObject({ kind: 'wrong_key' })
    // The catch returns an ELEMENT rather than throwing, which is the point:
    // the page keeps rendering, so the chat panel and the logout form around
    // this region survive. (Asserted structurally rather than by looking for
    // the panel's text — ChatPanel is a client component and serialises as a
    // module reference here, not as its rendered output.)
    expect(element).toBeTruthy()
    expect(JSON.stringify(element)).toContain('/api/logout')
  })

  it('opens NEITHER database for a locked session', async () => {
    encryptedSlot.hasTables = true
    const UserSpace = await arrange({ lock: true })
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('Locked')
    expect(openEncryptedMock).not.toHaveBeenCalled()
    expect(openUserDbMock).not.toHaveBeenCalled()
  })
})
