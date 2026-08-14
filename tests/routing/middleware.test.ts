import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { createSession, SESSION_COOKIE } from '@/lib/session/store'
import { putKey } from '@/lib/session/keymap'
import {
  resolveState,
  routeFor,
  redirectTargetFor,
  isUserSpacePath,
} from '@/lib/session/resolve'
import { middleware, config } from '@/middleware'

// Mocks for lib/session/guard.ts's requireState (group A below). Following
// the pattern in this same directory's root.test.ts: mock the Next.js
// server APIs rather than the module under test.
//
// cookieGet checks its `name` argument against the real SESSION_COOKIE
// constant rather than returning a fixed value regardless of the key asked
// for — otherwise a "reads the wrong cookie name" bug in guard.ts would
// slip past every test in group A undetected.
const redirectMock = vi.fn()
const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
const cookieGet = vi.fn((name: string) =>
  name === SESSION_COOKIE ? cookieSlot.value : undefined,
)

vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirectMock(path),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-route-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveState', () => {
  it('is anonymous with no cookie', () => {
    expect(resolveState(db, undefined)).toBe('anonymous')
  })

  it('is anonymous with an unknown session id', () => {
    expect(resolveState(db, 'nope')).toBe('anonymous')
  })

  it('is authenticated with a session but no key', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    expect(resolveState(db, sid)).toBe('authenticated')
  })

  it('is unlocked with a session and a key', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 1))
    expect(resolveState(db, sid)).toBe('unlocked')
  })
})

describe('routeFor', () => {
  it('sends anonymous users to login', () => {
    expect(routeFor('anonymous', '/nico')).toBe('/login')
    expect(routeFor('anonymous', '/admin')).toBe('/login')
  })

  it('lets anonymous users reach login', () => {
    expect(routeFor('anonymous', '/login')).toBeNull()
  })

  it('lets a locked session reach a user space, but not a deeper path', () => {
    // architecture-overview.md line 59: the chat surface keeps working across
    // the tweak loop while data panels ask for the password again. The lock
    // moved down to the panel layer, so the page itself is reachable.
    expect(routeFor('authenticated', '/nico')).toBeNull()
    expect(routeFor('authenticated', '/nico/settings')).toBe('/unlock')
  })

  it('lets authenticated users reach unlock and admin', () => {
    expect(routeFor('authenticated', '/unlock')).toBeNull()
    expect(routeFor('authenticated', '/admin')).toBeNull()
  })

  it('lets unlocked users through', () => {
    expect(routeFor('unlocked', '/nico')).toBeNull()
    expect(routeFor('unlocked', '/admin')).toBeNull()
  })

  it('sends logged-in users away from login', () => {
    expect(routeFor('authenticated', '/login')).toBe('/unlock')
    expect(routeFor('unlocked', '/login')).toBe('/')
  })

  it('still distinguishes an admin path from a same-named user slug', () => {
    // Regression guard for the '/adminbob' bug. It used to be expressible as
    // "/adminbob -> /unlock", but now that locked sessions may reach a user
    // space BOTH return null at one segment, so that assertion would pass
    // without distinguishing anything. Two segments still separates them:
    // '/admin/settings' is an admin subpath, '/adminbob/settings' is neither
    // admin nor a user space.
    expect(routeFor('authenticated', '/admin/settings')).toBeNull()
    expect(routeFor('authenticated', '/adminbob/settings')).toBe('/unlock')
    expect(routeFor('anonymous', '/adminbob')).toBe('/login')
  })

  it('does not treat reserved paths as user spaces', () => {
    expect(isUserSpacePath('/login')).toBe(false)
    expect(isUserSpacePath('/unlock')).toBe(false)
    expect(isUserSpacePath('/admin')).toBe(false)
    expect(isUserSpacePath('/api')).toBe(false)
    expect(isUserSpacePath('/')).toBe(false)
    expect(isUserSpacePath('/devone')).toBe(true)
  })

  it('still lets locked users reach real admin subpaths', () => {
    expect(routeFor('authenticated', '/admin/settings')).toBeNull()
  })
})

describe('redirectTargetFor', () => {
  it('lets a locked session reach a user space', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    // The two-tier lock still holds, but it no longer lives at this layer.
    // A session that survived a deploy now reaches the page — routeFor lets
    // it through — and it's the page's data region, not the route, that
    // re-asks for the password. See tests/routing/userSpace.test.ts:
    // "renders a locked owner's own space, with the data region locked" and
    // its companion "does not render the data region locked for an
    // unlocked owner", which together hold the property this test used to.
    expect(redirectTargetFor(db, sid, '/a')).toBeNull()
  })

  it('lets an unlocked session into a user space', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 1))
    expect(redirectTargetFor(db, sid, '/a')).toBeNull()
  })

  it('sends a cookie-less request to login', () => {
    expect(redirectTargetFor(db, undefined, '/a')).toBe('/login')
  })

  it('lets a locked session reach unlock', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    expect(redirectTargetFor(db, sid, '/unlock')).toBeNull()
  })
})

// --- A: requireState is where the two-tier lock is actually enforced. The
// brief calls this "a thin adapter... tested elsewhere," but the adapter
// itself can be wrong in ways the delegate can't catch: wrong cookie name,
// missing `await cookies()`, or never calling redirect at all. Each test
// here gets its own mkdtempSync PLATFORM_DB and a fresh module graph (via
// vi.resetModules) so lib/db/instance.ts's getDb() singleton never falls
// back to platform/dev/synthetic.db in the repo working tree.
describe('requireState', () => {
  let guardDir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    guardDir = mkdtempSync(join(tmpdir(), 'stairwell-guard-'))
    process.env.PLATFORM_DB = join(guardDir, 'synthetic.db')
    vi.resetModules()
    redirectMock.mockClear()
    cookieGet.mockClear()
    cookieSlot.value = undefined
    handle = undefined
  })

  afterEach(() => {
    handle?.close()
    delete process.env.PLATFORM_DB
    rmSync(guardDir, { recursive: true, force: true })
  })

  it('lets a locked session through to its own user space', async () => {
    // architecture-overview.md line 59: the chat surface keeps working across
    // the tweak loop while data panels ask for the password again. The lock
    // moved down to the panel layer, so requireState no longer bounces a
    // locked session away from its own user space.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess } = await import('@/lib/session/store')
    handle = getDb()
    const id = await createAcct(handle, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    cookieSlot.value = { value: sid }

    const { requireState } = await import('@/lib/session/guard')
    await requireState('/a')

    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('does not redirect an unlocked session asking for the same path', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess } = await import('@/lib/session/store')
    const { putKey: putK } = await import('@/lib/session/keymap')
    handle = getDb()
    const id = await createAcct(handle, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    putK(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }

    const { requireState } = await import('@/lib/session/guard')
    await requireState('/a')

    expect(redirectMock).not.toHaveBeenCalled()
  })

  it('sends a request with no cookie at all to /login', async () => {
    const { getDb } = await import('@/lib/db/instance')
    handle = getDb()
    cookieSlot.value = undefined

    const { requireState } = await import('@/lib/session/guard')
    await requireState('/a')

    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('lets a locked session reach /unlock itself, but not a deeper user-space path', async () => {
    // A locked session is now let through at the user-space page itself, so
    // '/a' no longer diverges from '/unlock' the way it used to — reusing
    // '/a' here would let a requireState that ignores its pathname argument
    // and hardcodes '/unlock' pass unnoticed, the same defect class the
    // '/adminbob' regression guard exists to catch. '/a/settings' still
    // diverges: it is one segment deeper than the user-space page, so it
    // still bounces to /unlock, proving the pathname argument is actually
    // plumbed through.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess } = await import('@/lib/session/store')
    handle = getDb()
    const id = await createAcct(handle, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    cookieSlot.value = { value: sid }

    const { requireState } = await import('@/lib/session/guard')
    await requireState('/a/settings')
    expect(redirectMock).toHaveBeenCalledWith('/unlock')

    redirectMock.mockClear()
    await requireState('/unlock')
    expect(redirectMock).not.toHaveBeenCalled()
  })
})

// --- B: a wrong matcher silently disables the middleware everywhere, a
// failure no other test would notice.
/**
 * The doors the onboarding flow had to open, and the ones it must not.
 *
 * A friend's very first link arrives with no session cookie at all, so
 * /invite/<token> has to be reachable from a cold browser or the whole flow
 * is a redirect to a login form for an account that does not exist yet.
 */
describe('paths a person with no session can reach', () => {
  it('lets an invite link through', () => {
    const response = middleware(new NextRequest('http://localhost/invite/sometoken'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('lets the forgot page through', () => {
    const response = middleware(new NextRequest('http://localhost/forgot'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('still bounces a path that merely STARTS with the word invite', () => {
    // The segment-boundary bug isAdminPath already guards against, in its new
    // home: `startsWith('/invite')` would open '/invitations' and anything
    // else someone adds later that happens to share the prefix.
    const response = middleware(new NextRequest('http://localhost/invitations'))
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })

  it('still bounces the bare /invite with no token', () => {
    const response = middleware(new NextRequest('http://localhost/invite'))
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })
})

describe('routeFor and the invite path', () => {
  it('lets an invite render in EVERY session state', () => {
    // A logged-in Nico opening a friend's link to check it must see the page,
    // not be bounced to /unlock. Nothing on the invite path reads user data,
    // so there is nothing for a lock to protect.
    for (const state of ['anonymous', 'authenticated', 'unlocked'] as const) {
      expect(routeFor(state, '/invite/sometoken')).toBeNull()
    }
  })

  it('lets an anonymous visitor reach /forgot', () => {
    expect(routeFor('anonymous', '/forgot')).toBeNull()
  })

  it('does not classify /forgot or /mockup as somebody user space', () => {
    // isUserSpacePath decides what a LOCKED session may reach. Without these
    // reserved, '/forgot' would look like a single-segment user page.
    expect(isUserSpacePath('/forgot')).toBe(false)
    expect(isUserSpacePath('/invite')).toBe(false)
    expect(isUserSpacePath('/mockup')).toBe(false)
    expect(isUserSpacePath('/nico')).toBe(true)
  })
})

describe('middleware', () => {
  it('redirects a cookie-less request to /login', () => {
    const request = new NextRequest('http://localhost/nico')
    const response = middleware(request)
    // ABSOLUTE here, unlike the route handlers, which use relative Locations.
    // Middleware has no choice: Next's middleware runtime parses this header as
    // a URL and throws ERR_INVALID_URL on a relative one, 500ing the request.
    // See lib/http/redirect.ts. The host comes from the proxy headers; with none
    // set (as here) it falls back to the request's own origin.
    const location = response.headers.get('location')
    expect(location).toBe('http://localhost/login')
    expect(new URL(location!).pathname).toBe('/login')
  })

  it('sends a cookie-less request to the EXTERNAL host, not the loopback origin', () => {
    // The regression this pins shipped to production: behind Caddy the Location
    // was https://localhost:3000/login, so a first-time visitor to
    // https://app.stairwell.run/ landed on a connection error. The two tests
    // either side of this one construct a NextRequest with no proxy headers, so
    // they cannot tell the fixed behaviour from the broken one — this is the one
    // that can.
    const request = new NextRequest('http://127.0.0.1:3000/nico', {
      headers: {
        host: 'app.stairwell.run',
        'x-forwarded-host': 'app.stairwell.run',
        'x-forwarded-proto': 'https',
      },
    })
    const response = middleware(request)
    expect(response.headers.get('location')).toBe(
      'https://app.stairwell.run/login',
    )
  })

  it('does not redirect a cookie-less request already at /login', () => {
    const request = new NextRequest('http://localhost/login')
    const response = middleware(request)
    expect(response.headers.get('location')).toBeNull()
  })

  it('passes through a request that has the session cookie', () => {
    const request = new NextRequest('http://localhost/nico', {
      headers: { cookie: `${SESSION_COOKIE}=abc` },
    })
    const response = middleware(request)
    expect(response.headers.get('location')).toBeNull()
  })

  it('gives a cookie-less API POST a 401, not a redirect', () => {
    // redirect() defaults to 307 (method-preserving) to /login, which has
    // no POST handler — the caller would see a 405 that says nothing about
    // the real problem (no session) instead of a 401 that does.
    const request = new NextRequest('http://localhost/api/unlock', {
      method: 'POST',
    })
    const response = middleware(request)
    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
  })

  it('gives a cookie-less API GET a 401 too, not just POST', () => {
    const request = new NextRequest('http://localhost/api/logout')
    const response = middleware(request)
    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
  })

  it('still redirects a cookie-less request to a non-API page', () => {
    // Guards against a fix that returns 401 for every path instead of only
    // /api/* — a page visitor with no cookie must still get the login page,
    // not a bare 401.
    const request = new NextRequest('http://localhost/nico')
    const response = middleware(request)
    expect(response.status).toBe(307)
    // ABSOLUTE here, unlike the route handlers, which use relative Locations.
    // Middleware has no choice: Next's middleware runtime parses this header as
    // a URL and throws ERR_INVALID_URL on a relative one, 500ing the request.
    // See lib/http/redirect.ts. The host comes from the proxy headers; with none
    // set (as here) it falls back to the request's own origin.
    const location = response.headers.get('location')
    expect(location).toBe('http://localhost/login')
    expect(new URL(location!).pathname).toBe('/login')
  })

  it('passes an API request through untouched when the session cookie is present', () => {
    const request = new NextRequest('http://localhost/api/unlock', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=abc` },
    })
    const response = middleware(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
  })
})

describe('config.matcher', () => {
  // Next.js compiles this matcher pattern as a full-path match. A bare
  // `new RegExp(pattern).test(path)` is NOT anchored, so it can find a
  // spurious match starting partway through the path (e.g. at the second
  // "/" in "/_next/static/chunk.js") and silently report a false
  // inclusion. Anchoring with ^...$ replicates how Next actually applies
  // it, while still exercising the live pattern rather than a hand-copied
  // string comparison.
  const pattern = new RegExp(`^${config.matcher[0]}$`)

  it('has exactly one matcher entry', () => {
    // Only matcher[0] is exercised by the tests below. Without this, a
    // second entry added later would go completely unasserted.
    expect(config.matcher).toHaveLength(1)
  })

  it('excludes next internals, favicon, and the login API route', () => {
    expect(pattern.test('/_next/static/chunk.js')).toBe(false)
    expect(pattern.test('/_next/image/foo.png')).toBe(false)
    expect(pattern.test('/favicon.ico')).toBe(false)
    expect(pattern.test('/api/login')).toBe(false)
  })

  it('includes ordinary app paths', () => {
    expect(pattern.test('/nico')).toBe(true)
    expect(pattern.test('/unlock')).toBe(true)
    expect(pattern.test('/')).toBe(true)
  })
})

// --- C: getDb() is a process-wide singleton; a test must never let it fall
// back to platform/dev/synthetic.db in the repo working tree.
describe('getDb', () => {
  let instDir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    instDir = mkdtempSync(join(tmpdir(), 'stairwell-instance-'))
    process.env.PLATFORM_DB = join(instDir, 'synthetic.db')
    vi.resetModules()
    handle = undefined
  })

  afterEach(() => {
    handle?.close()
    delete process.env.PLATFORM_DB
    rmSync(instDir, { recursive: true, force: true })
  })

  it('returns the same instance on repeated calls', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const first = getDb()
    const second = getDb()
    handle = first
    expect(second).toBe(first)
  })

  it('honours PLATFORM_DB', async () => {
    const { getDb } = await import('@/lib/db/instance')
    handle = getDb()
    expect(handle.name).toBe(join(instDir, 'synthetic.db'))
  })
})
