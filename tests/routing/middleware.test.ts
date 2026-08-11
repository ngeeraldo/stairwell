import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { createSession, SESSION_COOKIE } from '@/lib/session/store'
import { putKey } from '@/lib/session/keymap'
import { resolveState, routeFor, redirectTargetFor } from '@/lib/session/resolve'
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

  it('sends authenticated users to unlock', () => {
    expect(routeFor('authenticated', '/nico')).toBe('/unlock')
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

  it('does not treat a slug that merely starts with "admin" as the admin space', () => {
    // Regression: '/adminbob'.startsWith('/admin') is true, which used to
    // let an authenticated-but-locked session reach a same-named user slug
    // without ever passing /unlock. This is the exact leak the two-tier
    // lock exists to prevent.
    expect(routeFor('authenticated', '/adminbob')).toBe('/unlock')
  })

  it('still lets locked users reach real admin subpaths', () => {
    expect(routeFor('authenticated', '/admin/settings')).toBeNull()
  })
})

describe('redirectTargetFor', () => {
  it('sends a locked session away from a user space', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    // This is the two-tier lock holding. Without it, a session that survived
    // a deploy reaches the dashboard without re-entering the password.
    expect(redirectTargetFor(db, sid, '/a')).toBe('/unlock')
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

  it('sends a locked (authenticated, no key) session asking for a user space to /unlock', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess } = await import('@/lib/session/store')
    handle = getDb()
    const id = await createAcct(handle, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    cookieSlot.value = { value: sid }

    const { requireState } = await import('@/lib/session/guard')
    await requireState('/a')

    expect(redirectMock).toHaveBeenCalledWith('/unlock')
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

  it('lets a locked session reach /unlock itself', async () => {
    // All the tests above pass '/a' as the pathname, so on their own they
    // cannot tell a correct requireState from one that ignores its
    // argument and hardcodes '/a'. This exercises the pathname plumbing:
    // the same locked session that gets bounced from '/a' must NOT be
    // bounced from '/unlock'.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess } = await import('@/lib/session/store')
    handle = getDb()
    const id = await createAcct(handle, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    cookieSlot.value = { value: sid }

    const { requireState } = await import('@/lib/session/guard')
    await requireState('/unlock')

    expect(redirectMock).not.toHaveBeenCalled()
  })
})

// --- B: a wrong matcher silently disables the middleware everywhere, a
// failure no other test would notice.
describe('middleware', () => {
  it('redirects a cookie-less request to /login', () => {
    const request = new NextRequest('http://localhost/nico')
    const response = middleware(request)
    // Relative, not absolute: an absolute Location is built from the
    // server's own bind address, which behind Caddy is 127.0.0.1:3000.
    // Measured live at app.stairwell.run before the fix:
    // `location: https://localhost:3000/login`. See the long comment on
    // expectRelativeRedirect in tests/auth/routes.test.ts.
    const location = response.headers.get('location')
    expect(location).toBe('/login')
    expect(location).toMatch(/^\//)
    expect(location).not.toMatch(/^[a-z]+:\/\//i)
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
    // Relative, not absolute: an absolute Location is built from the
    // server's own bind address, which behind Caddy is 127.0.0.1:3000.
    // Measured live at app.stairwell.run before the fix:
    // `location: https://localhost:3000/login`. See the long comment on
    // expectRelativeRedirect in tests/auth/routes.test.ts.
    const location = response.headers.get('location')
    expect(location).toBe('/login')
    expect(location).toMatch(/^\//)
    expect(location).not.toMatch(/^[a-z]+:\/\//i)
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
