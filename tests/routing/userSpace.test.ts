// tests/routing/userSpace.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlatformDb } from '@/lib/db/platform'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { PLACEHOLDER_CARD } from '@/lib/copy/onboarding'
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

// devone gains a real dashboard in step 5. This file tests AUTHORISATION —
// 404-vs-403, admin-is-not-an-override — and
// tests/routing/dashboardRegion.test.ts owns the data region. Stub the
// registry empty here so these assertions do not move every time a dashboard
// is added to or removed from the repo.
/**
 * `hasDashboard` decides the shell's one boolean (chat open until a dashboard
 * is deployed, collapsed after — onboarding-ux-spec.md S3), so it is a SLOT
 * rather than a constant: two tests below need opposite answers from it.
 *
 * It is deliberately independent of `dashboardLoaderFor` in this mock even
 * though the real one derives from it, so a test can set up "a dashboard is
 * deployed" without also having to supply a loader that renders one.
 */
const registrySlot = { hasDashboard: false }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => undefined,
  registeredSlugs: () => [],
  hasDashboard: () => registrySlot.hasDashboard,
}))

/**
 * The whole page as markup.
 *
 * The page returns a <Shell>, so `element.type` is a component and
 * `JSON.stringify` shows props rather than text. Rendering is the only way to
 * assert on what a person actually sees — and asserting on the serialised
 * props instead is the mistake the unified-loop ledger records finding in the
 * admin tests ("assertions matching serialized props rather than rendered
 * output").
 */
function markup(element: unknown): string {
  return renderToStaticMarkup(element as React.ReactElement)
}

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

  it('does not let an admin see their own slug either — an admin has no user space at all', async () => {
    // The case above only proves an admin can't browse SOMEONE ELSE'S space,
    // which was already false on slug mismatch alone. This is the actually
    // new property: 'nico' asking for '/nico' must also 404, because an
    // admin account has no user space of its own to browse.
    const sid = await login(db, 'nico', 'pw')
    expect(canSeeUserSpace(db, sid!, 'nico')).toBe(false)
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
    registrySlot.hasDashboard = false
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
    // short-circuit. The page is a <Shell> now, so this asserts on the
    // RENDERED output: both regions are present, and the chat surface — the
    // one a friend uses to report that something is broken — is one of them.
    const html = markup(element)
    expect(html).toContain('aria-label="Chat"')
    // The chat is OPEN on this fixture, and log out now renders only in the
    // collapsed rail — it is chrome, and it was crowding the composer. So the
    // way out of the surface asserted here is the toggle that leads to it.
    // Where log out actually renders, in each state, is pinned in
    // tests/routing/shell.test.tsx.
    expect(html).toContain('Hide chat')
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

  it('404s a locked non-owner, the same as an unlocked one', async () => {
    // The lock no longer intercepts upstream of the ownership check, so a
    // locked session asking for someone else's space now falls through to
    // canSeeUserSpace and 404s. No new information leaks: an unlocked
    // non-owner already got exactly this 404.
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
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('renders a locked owner\'s own space, with the data region locked', async () => {
    // This inverts the pre-step-2 behaviour deliberately. architecture-
    // overview.md line 59 is the spec: the chat surface keeps working across
    // the tweak loop, and data panels ask for the password again. Both halves
    // are asserted — reaching the page is only correct if the data region is
    // still withheld.
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
    const element = await UserSpace({ params: Promise.resolve({ user: 'devone' }) })

    expect(redirectMock).not.toHaveBeenCalled()
    expect(notFoundMock).not.toHaveBeenCalled()
    const html = markup(element)
    expect(html).toContain('Locked')
    expect(html).toContain('/unlock')
    // The chat surface survives the lock, which is the half of this that is
    // easy to lose: architecture-overview.md line 59 says it keeps working
    // while data panels ask for the password again.
    expect(html).toContain('aria-label="Chat"')
  })

  it('does not render the data region locked for an unlocked owner', async () => {
    // Without this, the test above passes for a page that shows "Locked" to
    // everybody — which would satisfy the letter of "data panels ask for the
    // password" while breaking the product.
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
    const element = await UserSpace({ params: Promise.resolve({ user: 'devone' }) })
    const html = markup(element)
    expect(html).not.toContain('Locked')
    // An unlocked owner with no dashboard sees the placeholder card, which is
    // the content area's whole job during the interview period.
    expect(html).toContain(PLACEHOLDER_CARD.heading)
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

  it('404s an unlocked admin visiting THEIR OWN slug — admin has no user space at all', async () => {
    // The existing wrong-owner test above proves an admin can't browse
    // SOMEONE ELSE'S space, which the page would 404 on slug mismatch alone
    // even for a regular user. This is the property that only an admin
    // account exercises: 'nico' hitting '/nico' must still 404, because an
    // admin has no user space, not even its own.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    const { putKey: putK } = await import('@/lib/session/keymap')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const adminId = await createAcct(handle, { slug: 'nico', role: 'admin', password: 'pw' })
    const sid = createSess(handle, adminId)
    putK(sid, Buffer.alloc(32, 1)) // unlocked
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'nico' }) }),
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

describe('the shell, from the page', () => {
  // Its own fixture, because `handle` and `pageDir` are scoped to the describe
  // above rather than to the file.
  let pageDir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    pageDir = mkdtempSync(join(tmpdir(), 'stairwell-shellpage-'))
    process.env.PLATFORM_DB = join(pageDir, 'synthetic.db')
    vi.resetModules()
    notFoundMock.mockClear()
    redirectMock.mockClear()
    cookieGet.mockClear()
    cookieSlot.value = undefined
    registrySlot.hasDashboard = false
    handle = undefined
  })

  afterEach(() => {
    handle?.close()
    delete process.env.PLATFORM_DB
    rmSync(pageDir, { recursive: true, force: true })
  })

  async function arrangeOwner() {
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
    return { id, render: () => UserSpace({ params: Promise.resolve({ user: 'devone' }) }) }
  }

  function shellProps(element: unknown): { chatOpenByDefault?: boolean } {
    return (element as { props: { chatOpenByDefault?: boolean } }).props
  }

  it('opens the chat by default while no dashboard is deployed', async () => {
    registrySlot.hasDashboard = false
    const { render } = await arrangeOwner()
    expect(shellProps(await render()).chatOpenByDefault).toBe(true)
  })

  it('collapses the chat by default once one is', async () => {
    // The inverse case, and the one that would be silently wrong if the
    // boolean were hardcoded: "chat open by default" passes both ways.
    registrySlot.hasDashboard = true
    const { render } = await arrangeOwner()
    expect(shellProps(await render()).chatOpenByDefault).toBe(false)
  })

  it('writes first_session_start ONCE, ever', async () => {
    // The guard reads an append-only table to decide whether to write to it,
    // which makes this the second metrics row in the codebase that is system
    // state rather than telemetry (onboarding ledger D8). Pruning it would
    // make a months-old account report a first session again.
    const { render } = await arrangeOwner()
    await render()
    await render()

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'first_session_start'")
      .all() as { data: string }[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.data)).toEqual({ device_class: 'desktop' })
  })

  it('writes it for a LOCKED session too — the shell is where they land either way', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    cookieSlot.value = { value: createSess(handle, id) } // no putKey: locked

    const { default: UserSpace } = await import('@/app/[user]/page')
    await UserSpace({ params: Promise.resolve({ user: 'devone' }) })

    expect(
      (handle.prepare(
        "SELECT COUNT(*) AS n FROM metrics WHERE event = 'first_session_start'",
      ).get() as { n: number }).n,
    ).toBe(1)
  })

  // ── page_view ─────────────────────────────────────────────────────────────
  //
  // The one event that means "the friend was here", whatever they landed on.
  // It exists because dashboard_open cannot answer that question on its own:
  // the placeholder branch returns before any metric is written, so a friend
  // checking every day while their v1 is being built left NO row anywhere —
  // and with a 30-day session, `login` would not fire either.
  function pageViews(): Record<string, unknown>[] {
    return (
      handle!
        .prepare("SELECT data FROM metrics WHERE event = 'page_view' ORDER BY id")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Record<string, unknown>)
  }

  it('writes a page_view on every render, unlike first_session_start', async () => {
    const { render } = await arrangeOwner()
    await render()
    await render()

    expect(pageViews()).toHaveLength(2)
  })

  it('writes one when no dashboard is deployed — the placeholder case', async () => {
    // THE GAP THIS EVENT CLOSES. dashboardRegion returns the placeholder card
    // before it can write a dashboard_open, so this render used to be
    // invisible to every retention read.
    registrySlot.hasDashboard = false
    const { render } = await arrangeOwner()
    await render()

    expect(pageViews()).toEqual([
      { device_class: 'desktop', unlocked: true, dashboard: 'placeholder' },
    ])
  })

  it('says so when a dashboard IS deployed', async () => {
    // The inverse, so the field cannot be a hardcoded constant that passes
    // both ways.
    registrySlot.hasDashboard = true
    const { render } = await arrangeOwner()
    await render()

    expect(pageViews()[0]).toMatchObject({ dashboard: 'built' })
  })

  it('writes one for a LOCKED session, and records that it was locked', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    cookieSlot.value = { value: createSess(handle, id) } // no putKey: locked

    const { default: UserSpace } = await import('@/app/[user]/page')
    await UserSpace({ params: Promise.resolve({ user: 'devone' }) })

    // A friend who comes back, cannot remember whether they are unlocked, and
    // bounces is still a friend who came back.
    expect(pageViews()).toEqual([
      { device_class: 'desktop', unlocked: false, dashboard: 'placeholder' },
    ])
  })

  it('carries no user values', async () => {
    // EXACT shape, not a subset match — the same bound dashboard_open is held
    // to. Session state and registry state only: no slug-derived id, no day,
    // no count, nothing the friend typed.
    const { render } = await arrangeOwner()
    await render()

    expect(Object.keys(pageViews()[0]!).sort()).toEqual([
      'dashboard',
      'device_class',
      'unlocked',
    ])
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
    // The listing query filters WHERE role = 'user'. Without that filter the
    // admin's own account would list itself alongside devone/devtwo — not a
    // boundary violation (an admin seeing their own row leaks nothing), but
    // nothing else pins that the filter stays in place.
    expect(json).not.toContain('nico')

    // The admin's only way out. Step 4 gave admin accounts no user space, and
    // app/[user]/page.tsx was where the logout control lived — so an admin was
    // left with no reachable logout at all, found from a browser mid-checkpoint
    // rather than by any test. A POST form specifically: /api/logout answers
    // POST only, so a link would 405.
    expect(json).toContain('/api/logout')
    expect(json).toContain('post')
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
