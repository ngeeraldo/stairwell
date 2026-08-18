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
import { TIME_ZONE_COOKIE } from '@/lib/metrics/deviceClass'
import { dayKey } from '@/lib/time/dayKey'

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
/**
 * The friend's timezone, as the root layout's inline script would have left
 * it. Undefined by default, which is a real request shape — the very first
 * one of a session, before the script has run — and resolves to UTC.
 */
const tzSlot: { value: string | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) => {
  if (name === sessionCookieName) return cookieSlot.value
  if (name === TIME_ZONE_COOKIE && tzSlot.value) return { value: tzSlot.value }
  return undefined
})
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
//
// `screens` is optional here on PURPOSE, and no longer for the reason task 22
// gave — as of task 23, `lib/dashboard/contract.ts`'s real `DashboardModule`
// requires it, and every registered dashboard declares one. This local
// `Loader` type is DELIBERATELY WIDER than that real type, because
// 'renders no tab strip when the dashboard has not declared screens yet'
// below needs to construct a module with no `screens` at all — the shape a
// real, registry-typed dashboard can no longer take, but one
// `renderDashboard`'s own `screens === undefined` branch still handles as
// defense in depth (see the comment on that branch in app/[user]/page.tsx
// and on `DashboardModule` in lib/dashboard/contract.ts). Tightening this
// fixture to match the real required type would make that test impossible to
// write, not just harder — there would be no way to construct the module the
// test needs.
type Loader =
  | (() => Promise<{
      default: (p: unknown) => unknown
      screens?: { id: string; title: string; order: number }[]
    }>)
  | undefined
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
  openEncryptedUserDb: (...args: unknown[]) => openEncryptedMock(...args),
  WrongKeyError,
}))

/**
 * Which world the page thinks it is in.
 *
 * The render path no longer chooses between two databases — there is no
 * fallback. It asks lib/db/userData.ts for THE user database and renders it,
 * and that module's only input is NODE_ENV. So the fixture that used to say
 * "does the real one have tables" now says "is this dev", and the banner
 * follows from it rather than from what the friend has logged.
 */
const worldSlot: { dev: boolean } = { dev: true }

vi.mock('@/lib/db/userData', () => ({
  isDevData: () => worldSlot.dev,
  // Argument-aware, for the same reason openEncryptedMock is: a factory that
  // discarded its arguments made `{ readonly: true }` invisible at the call
  // site once already, and every render opened a friend's real database
  // writable while the suite stayed green.
  openUserDataForRead: (...args: unknown[]) => openEncryptedMock(...args),
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
  tzSlot.value = undefined
  loaderSlot.value = undefined
  dataSlot.value = { source: 'none', db: undefined }
  handle = undefined
  worldSlot.dev = true
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

  it('degrades when the database cannot be opened at all', async () => {
    // This replaces "its data has not been generated yet", which was the
    // synthetic path's own not-found branch. There is no synthetic path in
    // production any more, and no branch to report: a database that will not
    // open is a failure, and the friend gets the honest sentence rather than a
    // reassuring one about generation that would never become true on its own.
    loaderSlot.value = async () => ({ default: () => null as never })
    encryptedSlot.throwOnOpen = 'other'
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('This dashboard failed to load')
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('renders the dashboard under a synthetic banner in DEV and records dashboard_open', async () => {
    // The banner now follows the WORLD, not the friend's data. In dev
    // synthetic.db is the user database, so everything on screen is fake and
    // says so; in production there is nothing to warn about because what is
    // rendered is theirs.
    worldSlot.dev = true
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
    expect((seen[0] as { db: unknown }).db).toBeDefined()
    expect(loaderFor).toHaveBeenCalledWith(SLUG)
    // The page asked the ONE resolver, and asked it read-only. Both halves
    // matter: dropping the flag at this call site once left the whole suite
    // green while every render held a writable handle on a friend's data.
    expect(openEncryptedMock).toHaveBeenCalledWith(SLUG, expect.anything())
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

  // --- Part D, task 22: the platform's tab chrome ---------------------------
  //
  // The tab strip is server-rendered anchors on `?screen=`, built from the
  // DASHBOARD's own declared `screens` list (never the spec, never a second
  // source). These tests exercise the two rulings task 22 makes: one screen
  // (or none declared yet, which is every dashboard on this branch today)
  // renders no strip at all, and an out-of-order `screens` array is sorted by
  // its own `order` field rather than array position.
  const TWO_SCREENS = [
    // Declared out of order on purpose: 'money' comes first in the array but
    // has the HIGHER order, so a test that defaulted to array position
    // instead of reading `order` would pass on an accidentally-sorted
    // fixture and fail here.
    { id: 'money', title: 'Money', order: 2 },
    { id: 'morning', title: 'Morning', order: 1 },
  ]

  function screenEchoingLoader(screens?: typeof TWO_SCREENS): Loader {
    return async () => ({
      default: (props: unknown) =>
        React.createElement('p', null, `SCREEN:${(props as { screen?: string }).screen}`),
      screens,
    })
  }

  it('renders a tab link per declared screen, titled and ordered from the screens array, defaulting to the lowest order', async () => {
    loaderSlot.value = screenEchoingLoader(TWO_SCREENS)
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const html = renderToStaticMarkup(element as React.ReactElement)
    expect(html).toContain('>Money<')
    expect(html).toContain('>Morning<')
    expect(html).toContain('href="?screen=money"')
    expect(html).toContain('href="?screen=morning"')
    // Default is the LOWEST order, not the first array entry — 'money' is
    // declared first but has the higher order.
    expect(html).toContain('SCREEN:morning')
    // The active tab, and only the active tab, is marked. There is exactly
    // one aria-current in the whole tree, and it sits on Morning's anchor.
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-current="page"[^>]*>Morning</)
  })

  it('honours a requested ?screen= and marks that one active instead of the default', async () => {
    loaderSlot.value = screenEchoingLoader(TWO_SCREENS)
    const UserSpace = await arrange()
    const element = await UserSpace({
      params: Promise.resolve({ user: SLUG }),
      searchParams: Promise.resolve({ screen: 'money' }),
    })

    const html = renderToStaticMarkup(element as React.ReactElement)
    expect(html).toContain('SCREEN:money')
    expect(html).toMatch(/aria-current="page"[^>]*>Money</)
  })

  it('falls back to the default screen for an unknown ?screen= rather than failing the render', async () => {
    // A URL is user input — a typo, a stale bookmark, a dropped tab — and
    // must not 404 or 500 the page. It lands on the same default the page
    // would show with no ?screen= at all.
    loaderSlot.value = screenEchoingLoader(TWO_SCREENS)
    const UserSpace = await arrange()
    const element = await UserSpace({
      params: Promise.resolve({ user: SLUG }),
      searchParams: Promise.resolve({ screen: 'nope' }),
    })

    const html = renderToStaticMarkup(element as React.ReactElement)
    expect(html).toContain('SCREEN:morning')
    expect(metricEvents()).toContain('dashboard_open')
    expect(metricEvents()).not.toContain('dashboard_error')
  })

  it('renders no tab strip at all for a single declared screen', async () => {
    // A single tab is chrome that explains nothing (Part D ruling).
    loaderSlot.value = screenEchoingLoader([{ id: 'main', title: 'Main', order: 1 }])
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const html = renderToStaticMarkup(element as React.ReactElement)
    expect(html).not.toContain('<nav')
    expect(html).toContain('SCREEN:main')
  })

  it('renders no tab strip when the dashboard has not declared screens yet', async () => {
    // Every dashboard registered on this branch today falls in exactly this
    // case — task 22 introduces the contract without migrating any of the
    // four onto it. That must stay a visual no-op, not a broken render.
    loaderSlot.value = screenEchoingLoader(undefined)
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const html = renderToStaticMarkup(element as React.ReactElement)
    expect(html).not.toContain('<nav')
    expect(html).toContain('SCREEN:undefined')
  })

  it('degrades, rather than 500ing, a registered dashboard that explicitly declares zero screens', async () => {
    // Different in kind from "not declared yet": a module that HAS opted
    // into the contract and exports `screens: []` has gotten it wrong. That
    // is the real defect activeScreen's throw exists to catch, and it is
    // caught the same way any other throwing Dashboard() call already is.
    loaderSlot.value = screenEchoingLoader([])
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(JSON.stringify(element)).toContain('This dashboard failed to load')
    expect(metricEvents()).toContain('dashboard_error')
    expect(metricEvents()).not.toContain('dashboard_open')
  })

  it('records screen_order — the position, never the screen id — on dashboard_open', async () => {
    // CLAUDE.md's metrics bound forbids a friend-derived id in this table
    // (screen ids come from the same slug rule as a panel id); an integer
    // order distinguishes tabs and names nothing.
    loaderSlot.value = screenEchoingLoader(TWO_SCREENS)
    const UserSpace = await arrange()
    await UserSpace({
      params: Promise.resolve({ user: SLUG }),
      searchParams: Promise.resolve({ screen: 'money' }),
    })

    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
      device_class: 'desktop',
      screen_order: 2,
    })
    expect(rawMetricData('dashboard_open')).not.toContain('money')
  })

  it('writes one dashboard_open row per render with no dedup, even across two "tab switches"', async () => {
    // Nico's ruling: the log stays raw and append-only; "an open" is a
    // definition applied when the log is READ, never a write-time decision.
    // No throttling, no conditional write.
    loaderSlot.value = screenEchoingLoader(TWO_SCREENS)
    const UserSpace = await arrange()
    await UserSpace({ params: Promise.resolve({ user: SLUG }) })
    await UserSpace({
      params: Promise.resolve({ user: SLUG }),
      searchParams: Promise.resolve({ screen: 'money' }),
    })

    expect(metricEvents().filter((e) => e === 'dashboard_open')).toHaveLength(2)
  })

  it("hands the dashboard the day in the FRIEND'S zone, not the server's", async () => {
    // The read half of the bug this branch exists for. The write half is
    // covered in tests/routing/walkRoute.test.ts; this is the assertion that
    // the page RESOLVES a day rather than leaving each dashboard to derive
    // one — because if it did not, every dashboard would derive it from the
    // droplet's clock and quietly disagree with what was stored.
    //
    // Not compared against a literal: the test runs at whatever instant it
    // runs at, so the oracle is dayKey(now) in the same zone. What makes it
    // discriminating is the SECOND zone — one request, two zones, and at the
    // instants where they disagree only a page that actually reads the cookie
    // can produce both answers.
    dataSlot.value = { source: 'synthetic', db: realDb() }
    const seen: unknown[] = []
    loaderSlot.value = async () => ({
      default: (props: unknown) => {
        seen.push(props)
        return React.createElement('section', null, 'PANEL RENDERED TEST')
      },
    })

    // One arrange, two requests. arrange() creates the account, so calling it
    // twice trips accounts.slug UNIQUE — and two requests against ONE page
    // module is the more honest fixture anyway: the zone is read per request,
    // not captured when the module loads.
    const UserSpace = await arrange()

    tzSlot.value = 'Pacific/Kiritimati'
    await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    tzSlot.value = 'Pacific/Niue'
    await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(seen).toHaveLength(2)
    const east = seen[0] as { today: string; timeZone: string | undefined }
    const west = seen[1] as { today: string; timeZone: string | undefined }
    expect(east.timeZone).toBe('Pacific/Kiritimati')
    expect(west.timeZone).toBe('Pacific/Niue')
    expect(east.today).toBe(dayKey(Date.now(), 'Pacific/Kiritimati'))
    expect(west.today).toBe(dayKey(Date.now(), 'Pacific/Niue'))
    // +14 and -11: 25 hours apart, so these two are a different calendar day
    // from each other for all but one hour in twenty-five. Asserting they
    // differ outright would be flaky in that hour; asserting each against its
    // own zone is not, and the pair still cannot both be satisfied by a page
    // that ignores the cookie and formats one day for everybody.
    expect(east.today >= west.today).toBe(true)
  })

  it('falls back to UTC when the zone cookie has not been written yet', async () => {
    // The first render of a session, inherently — the script that writes the
    // cookie has not run when the server builds the very first page. Recorded
    // as a residual rather than fixed: it costs one render, at most one day
    // of skew, on a page that has nothing to write yet.
    dataSlot.value = { source: 'synthetic', db: realDb() }
    const seen: unknown[] = []
    loaderSlot.value = async () => ({
      default: (props: unknown) => {
        seen.push(props)
        return React.createElement('section', null, 'PANEL RENDERED TEST')
      },
    })
    const UserSpace = await arrange()
    await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const props = seen[0] as { today: string; timeZone: string | undefined }
    expect(props.timeZone).toBeUndefined()
    expect(props.today).toBe(dayKey(Date.now(), 'UTC'))
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

  it('reads the encrypted database and drops the banner in PRODUCTION', async () => {
    // "once real data exists" was the old rule and is gone: production serves
    // the friend's own database whether or not they have logged anything, so
    // the banner's condition is the world, not the row count.
    worldSlot.dev = false
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
    //
    // The flag now lives inside lib/db/userData.ts rather than at this call
    // site, so what is asserted here is that the page went through the ONE
    // resolver — and tests/db/userData.test.ts asserts that resolver's handle
    // actually refuses a write, in both worlds. Two halves again, pinned in
    // two places, because they still fail independently.
    expect(openEncryptedMock).toHaveBeenCalledWith(SLUG, expect.anything())
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
    // The rest of the shell survives — the page degraded, it did not 500 the
    // whole route.
    //
    // This used to assert the string 'Log out', which worked only because the
    // form was a child of the `content` prop. The form now lives in the
    // shell's `footer` (it is platform chrome, not the last row of the
    // friend's dashboard), and this element tree is unrendered — Shell's body
    // never runs — so that string is legitimately gone from it. The property
    // worth pinning here was never the button's words; it was that the page
    // still hands the shell a complete set of regions on the failure path.
    // Where the footer ACTUALLY renders is asserted in
    // tests/routing/shell.test.tsx, which mounts the component.
    const shell = element as { props?: Record<string, unknown> }
    expect(shell.props?.chat).toBeDefined()
    expect(shell.props?.content).toBeDefined()
    expect(shell.props?.footer).toBeDefined()
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

  it('renders an EMPTY database rather than substituting anyone else’s data', async () => {
    // What replaced onboarding ledger D3's dead end, and the reason every
    // dashboard is now required to render on zero rows.
    //
    // The old shape of this test asserted the opposite: an empty real database
    // meant "show the synthetic one under a banner", because reading it as
    // real sent the first SELECT into the catch and stranded the friend on
    // "This dashboard failed to load" forever. That was a way around the
    // problem. The way through it is that an empty database is an ordinary
    // state a dashboard has to handle — so the friend sees their own empty
    // dashboard, with no banner, and nothing pretends to be their history.
    worldSlot.dev = false
    encryptedSlot.rows = []
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'EMPTY PANEL TEST'),
    })
    const UserSpace = await arrange()
    const element = await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    const json = JSON.stringify(element)
    expect(json).toContain('EMPTY PANEL TEST')
    expect(json).not.toContain('This dashboard failed to load')
    expect(json).not.toContain('SYNTHETIC DATA')
    expect(metricData('dashboard_open')).toMatchObject({ source: 'real' })
  })

  it('opens ONE database, never two', async () => {
    // There used to be a predicate that opened the file to ask whether it had
    // tables, and then an open. Two opens meant two things that could throw,
    // and the predicate's throw had its own catch. Both are gone: the page
    // asks the resolver once.
    worldSlot.dev = false
    loaderSlot.value = async () => ({
      default: () => React.createElement('section', null, 'REAL PANEL TEST'),
    })
    const UserSpace = await arrange()
    await UserSpace({ params: Promise.resolve({ user: SLUG }) })

    expect(openEncryptedMock).toHaveBeenCalledTimes(1)
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
