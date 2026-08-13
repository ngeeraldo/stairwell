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
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

// --- the two seams under test ---------------------------------------------
type Loader = (() => Promise<{ default: (p: unknown) => unknown }>) | undefined
const loaderSlot: { value: Loader } = { value: undefined }
const loaderFor = vi.fn((_slug: string): Loader => loaderSlot.value)
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: (slug: string) => loaderFor(slug),
  registeredSlugs: () => [],
}))

type Data = { source: 'synthetic' | 'none'; db: unknown }
const dataSlot: { value: Data } = { value: { source: 'none', db: undefined } }
const openUserDbMock = vi.fn((_slug: string): Data => dataSlot.value)
vi.mock('@/lib/db/userDb', () => ({
  openUserDb: (slug: string) => openUserDbMock(slug),
}))

const SLUG = 'devone'

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

    const json = JSON.stringify(element)
    expect(json).toContain('Nothing here yet')
    expect(json).not.toContain('SYNTHETIC DATA')
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

    const json = JSON.stringify(element)
    expect(json).toContain('SYNTHETIC DATA')
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
    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
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
    expect(metricData('dashboard_error')).toEqual({
      slug: SLUG,
      message: 'panel query blew up TEST',
    })
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
})
