// tests/routing/userSpace.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import type { PlatformDb } from '@/lib/db/platform'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { login } from '@/lib/auth/flow'
import { canSeeUserSpace, isAdmin } from '@/lib/auth/authorize'

// tsconfig.json sets "jsx": "preserve" for Next's own SWC compiler, which
// auto-injects the JSX runtime import. vitest's esbuild transform instead
// falls back to the classic transform (bare `React.createElement(...)`
// calls with no import) for that setting, so the two page components would
// throw `ReferenceError: React is not defined` the moment their JSX runs —
// purely a test-environment gap, unrelated to the components' own logic.
// Exposing React globally (test file only; no project config touched) lets
// the unqualified `React` reference in the compiled output resolve. Scoped
// with vi.stubGlobal/unstubAllGlobals rather than a bare assignment so the
// mutation doesn't leak past this file's own test run.
beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- Mocks for the two page components (groups C and D below). Real
// next/navigation notFound()/redirect() both THROW to unwind the render —
// they never return. A mock that merely records the call and returns
// normally would let a component "fall through" past the guard and keep
// rendering, and a test that only checked `toHaveBeenCalled()` would still
// pass while that security property was broken. So both mocks throw, each
// with a distinct sentinel message, so a test can tell "the component threw
// via notFound()" apart from "the component threw via redirect()" apart
// from "the component threw for some unrelated reason" — the last of those
// must NOT make an unauthorised-case test pass.
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

// Following the idiom in tests/routing/middleware.test.ts's `requireState`
// group: cookieGet checks its `name` argument against the real
// SESSION_COOKIE constant, rather than returning a fixed value regardless of
// the key asked for.
const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-authz-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  await createAccount(db, { slug: 'devone', role: 'user', password: 'pw' })
  await createAccount(db, { slug: 'devtwo', role: 'user', password: 'pw' })
  await createAccount(db, { slug: 'nico', role: 'admin', password: 'pw' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('user space authorization', () => {
  it('lets a user see their own space', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(canSeeUserSpace(db, sid!, 'devone')).toBe(true)
  })

  it('does not let a user see another user space', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(canSeeUserSpace(db, sid!, 'devtwo')).toBe(false)
  })

  it('does not let an admin browse user spaces either', async () => {
    // The admin portal is read-only over transcripts and specs. It is not a
    // back door into a user dashboard.
    const sid = await login(db, 'nico', 'pw')
    expect(canSeeUserSpace(db, sid!, 'devone')).toBe(false)
  })

  it('treats an unknown slug the same as a forbidden one', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(canSeeUserSpace(db, sid!, 'ghost')).toBe(false)
  })

  it('refuses with no session', () => {
    expect(canSeeUserSpace(db, undefined, 'devone')).toBe(false)
  })

  it('fails closed when both session and slug are absent (defence in depth)', () => {
    // canSeeUserSpace's signature requires slug: string, so an undefined
    // slug can't happen through the App Router today (params.user is always
    // a non-empty string) — but this is an exported security primitive
    // whose entire job is to fail closed, for whatever caller reaches it
    // next. The bug this pins: `accountFor(db, sessionId)?.slug === slug`
    // evaluates `undefined === undefined` -> true whenever there is no
    // session AND the caller passes no slug, exactly backwards for a
    // function whose contract is "no session -> false, always."
    expect(
      canSeeUserSpace(db, undefined, undefined as unknown as string),
    ).toBe(false)
  })
})

describe('admin authorization', () => {
  it('admits the admin account', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(isAdmin(db, sid!)).toBe(true)
  })

  it('refuses a dev user', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(isAdmin(db, sid!)).toBe(false)
  })

  it('refuses with no session', () => {
    expect(isAdmin(db, undefined)).toBe(false)
  })
})

// --- C & D: the page components are the adapter layer where the
// 404-vs-403 property is actually realised. canSeeUserSpace/isAdmin being
// correct does not prove the page calls them, checks their result, or stops
// executing afterward — Task 11's requireState (an equivalent untested
// adapter) shipped a real bug that its tested delegate could not have
// caught. Each test gets its own mkdtempSync PLATFORM_DB and a fresh module
// graph (vi.resetModules), matching tests/routing/middleware.test.ts's
// `requireState` group, so getDb()'s process-wide singleton never falls
// back to platform/dev/synthetic.db in the repo working tree.
describe('app/[user]/page.tsx (UserSpace)', () => {
  let pageDir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    pageDir = mkdtempSync(join(tmpdir(), 'stairwell-userpage-'))
    process.env.PLATFORM_DB = join(pageDir, 'synthetic.db')
    vi.resetModules()
    notFoundMock.mockClear()
    redirectMock.mockClear()
    cookieGet.mockClear()
    cookieSlot.value = undefined
    handle = undefined
  })

  afterEach(() => {
    handle?.close()
    delete process.env.PLATFORM_DB
    rmSync(pageDir, { recursive: true, force: true })
  })

  it('renders the owner\'s own space', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    const { putKey: putK } = await import('@/lib/session/keymap')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    putK(sid, Buffer.alloc(32, 1)) // unlocked, so requireState lets it through
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    const element = await UserSpace({ params: Promise.resolve({ user: 'devone' }) })

    expect(notFoundMock).not.toHaveBeenCalled()
    expect(redirectMock).not.toHaveBeenCalled()
    // Real content came back, not undefined and not a notFound()/redirect()
    // short-circuit: the rendered <main> actually contains the owner's slug.
    expect(element.type).toBe('main')
    expect(JSON.stringify(element)).toContain('devone')
  })

  it('404s for another user\'s space (wrong owner)', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    const { putKey: putK } = await import('@/lib/session/keymap')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const oneId = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    await createAcct(handle, { slug: 'devtwo', role: 'user', password: 'pw' })
    const sid = createSess(handle, oneId)
    putK(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'devtwo' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('404s for an unknown slug, same as a forbidden one', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    const { putKey: putK } = await import('@/lib/session/keymap')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    putK(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'ghost' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('sends a locked non-owner to /unlock before ever checking ownership', async () => {
    // Locked (authenticated, no key) session for devone, requesting
    // devtwo's space. requireState must bounce this to /unlock — the
    // two-tier lock is enforced upstream of canSeeUserSpace, so a locked
    // session never even gets to find out whether it owns the slug it
    // asked for.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const oneId = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    await createAcct(handle, { slug: 'devtwo', role: 'user', password: 'pw' })
    const sid = createSess(handle, oneId) // no putKey: locked
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'devtwo' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/unlock')

    expect(redirectMock).toHaveBeenCalledWith('/unlock')
    expect(notFoundMock).not.toHaveBeenCalled()
  })

  it('sends a locked owner to /unlock too — the lock does not care whether you own the slug', async () => {
    // Same locked state, but this time the requester DOES own the slug.
    // Without this test, "locked non-owner -> /unlock" alone can't rule out
    // a component that only bounces locked sessions when they're *not* the
    // owner (which would silently let a locked owner reach their own
    // dashboard without ever unlocking).
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSess(handle, id) // no putKey: locked
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'devone' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/unlock')

    expect(redirectMock).toHaveBeenCalledWith('/unlock')
    expect(notFoundMock).not.toHaveBeenCalled()
  })

  it('404s an unlocked admin session browsing a user space — admin is not an override, at the page layer', async () => {
    // The unit-level "does not let an admin browse user spaces either"
    // test covers canSeeUserSpace directly; this covers the same property
    // through the actual page component, the same way the wrong-owner and
    // unknown-slug tests above do for ordinary users.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    const { putKey: putK } = await import('@/lib/session/keymap')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const adminId = await createAcct(handle, { slug: 'nico', role: 'admin', password: 'pw' })
    const sid = createSess(handle, adminId)
    putK(sid, Buffer.alloc(32, 1)) // unlocked
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'devone' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('never reaches notFound() with no session — requireState redirects to /login first', async () => {
    // UserSpace calls requireState() before canSeeUserSpace(). With no
    // cookie at all, resolveState is 'anonymous' and routeFor sends it to
    // /login — the two-tier guard intercepts upstream of the 404 check.
    // This is correct behaviour, not a bug: asserting notFound() here would
    // be testing for the wrong mechanism. What matters for the security
    // property is that no content was returned either way.
    const { getDb } = await import('@/lib/db/instance')
    const { SESSION_COOKIE } = await import('@/lib/session/store')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    cookieSlot.value = undefined

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'devone' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/login')

    expect(redirectMock).toHaveBeenCalledWith('/login')
    expect(notFoundMock).not.toHaveBeenCalled()
  })
})

describe('app/admin/page.tsx (AdminPortal)', () => {
  let pageDir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    pageDir = mkdtempSync(join(tmpdir(), 'stairwell-adminpage-'))
    process.env.PLATFORM_DB = join(pageDir, 'synthetic.db')
    vi.resetModules()
    notFoundMock.mockClear()
    redirectMock.mockClear()
    cookieGet.mockClear()
    cookieSlot.value = undefined
    handle = undefined
  })

  afterEach(() => {
    handle?.close()
    delete process.env.PLATFORM_DB
    rmSync(pageDir, { recursive: true, force: true })
  })

  it('renders for the admin account', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    await createAcct(handle, { slug: 'devtwo', role: 'user', password: 'pw' })
    const adminId = await createAcct(handle, { slug: 'nico', role: 'admin', password: 'pw' })
    const sid = createSess(handle, adminId)
    cookieSlot.value = { value: sid }

    const { default: AdminPortal } = await import('@/app/admin/page')
    const element = await AdminPortal()

    expect(notFoundMock).not.toHaveBeenCalled()
    expect(element.type).toBe('main')
    const json = JSON.stringify(element)
    expect(json).toContain('devone')
    expect(json).toContain('devtwo')
  })

  it('404s for a non-admin (dev user) session — admin is not an override', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    cookieSlot.value = { value: sid }

    const { default: AdminPortal } = await import('@/app/admin/page')
    await expect(AdminPortal()).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
  })

  it('404s with no session at all', async () => {
    // Unlike the user-space page, AdminPortal never calls requireState — it
    // only reads the platform database, so a session-less request reaches
    // isAdmin()/notFound() directly rather than being intercepted upstream.
    const { getDb } = await import('@/lib/db/instance')
    const { SESSION_COOKIE } = await import('@/lib/session/store')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    cookieSlot.value = undefined

    const { default: AdminPortal } = await import('@/app/admin/page')
    await expect(AdminPortal()).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(redirectMock).not.toHaveBeenCalled()
  })
})
