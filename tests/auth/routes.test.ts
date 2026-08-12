// tests/auth/routes.test.ts
//
// The three route handlers (app/api/{login,unlock,logout}/route.ts) are
// where the security-relevant wiring actually happens — cookie flags,
// key-drop on logout, the "login does not unlock" boundary — and
// tests/auth/flow.test.ts only covers the underlying login()/unlock()
// functions, not the handlers themselves. This file closes that gap.
//
// Follows the idiom in tests/routing/middleware.test.ts's `requireState`
// group: mock next/headers' cookies(), and give every test its own
// mkdtempSync PLATFORM_DB plus vi.resetModules() so getDb()'s process-wide
// singleton never falls back to platform/dev/synthetic.db, and so that
// putKey/getKey (both called via dynamic import, post-reset, exactly like
// the route handler's own internal imports) share one fresh in-memory key
// map with the handler under test rather than a stale one left over from a
// previous test or the file's static imports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session/store'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
const cookieGet = vi.fn((name: string) =>
  name === SESSION_COOKIE ? cookieSlot.value : undefined,
)

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

let dir: string
let handle: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-routes-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  cookieGet.mockClear()
  cookieSlot.value = undefined
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
  // Undo the per-test keymap spy set up by the wrong-credentials test below.
  // Unconditional because doUnmock on an unmocked path is a no-op, and leaving
  // it registered would hand the spy to whichever test ran next.
  vi.doUnmock('@/lib/session/keymap')
})

function loginRequest(slug: string, password: string) {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    body: new URLSearchParams({ slug, password }),
  })
}

function unlockRequest(password: string) {
  return new Request('http://localhost/api/unlock', {
    method: 'POST',
    body: new URLSearchParams({ password }),
  })
}

/**
 * Redirect Locations must be RELATIVE, and that is a deployment requirement,
 * not a style preference.
 *
 * These routes used to build `new URL(path, request.url)`. `request.url` is the
 * server's own view of the request, which behind a reverse proxy is the
 * loopback address it is bound to — NOT the host the browser asked for.
 * Measured live at https://app.stairwell.run, proxied by Caddy to
 * 127.0.0.1:3000: `GET /` answered `location: https://localhost:3000/login`,
 * and `POST /api/login` answered `location: https://localhost:3000/...`. Every
 * redirect in the auth flow sent the browser to a host that does not exist for
 * it, so login, unlock and logout were all unusable through the proxy.
 *
 * Setting the Host header does not help — verified directly against the origin
 * on the droplet, an explicit `Host: app.stairwell.run` still produced
 * `localhost:3000`. Next honours `X-Forwarded-Proto` for the scheme but does
 * not take the host from `Host` or `X-Forwarded-Host`, so there is no absolute
 * form that is correct here.
 *
 * A relative Location (RFC 7231 section 7.1.2) is resolved by the client
 * against the request URI, so it is correct behind any proxy, or none. Asserting
 * the exact string alone would not pin this: `toBe('http://localhost/nico')`
 * passed for years while the deployed behaviour was broken. The shape checks
 * are what actually catch a regression to an absolute URL.
 */
function expectRelativeRedirect(response: Response, target: string) {
  const location = response.headers.get('location')
  expect(location).toBe(target)
  expect(location, 'Location must be host-relative').toMatch(/^\//)
  expect(
    location,
    'an absolute Location points at the internal bind address behind a proxy',
  ).not.toMatch(/^[a-z]+:\/\//i)
}

// A brand-new login used to ask for the password twice — once here, then again
// at /unlock — because this route issued the session and redirected without
// deriving the key, despite having had the password in hand a moment earlier.
// It now derives at login and goes straight to /<slug>.
//
// The collapse is only half of what these tests pin. The other half is that
// /unlock is UNCHANGED: it exists for the re-lock path (a deploy, or the 12h
// ceiling expiring), which is the common case and always was a single prompt.
// A change that smoothed login while quietly breaking the two-tier lock would
// be a bad trade, so the last test here is the one that matters most.
describe('POST /api/login', () => {
  it('redirects straight to /<slug> with the key already derived — one password prompt, not two', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { getKey } = await import('@/lib/session/keymap')
    handle = getDb()
    await createAccount(handle, { slug: 'nico', role: 'user', password: 'pw' })

    const { POST } = await import('@/app/api/login/route')
    const response = await POST(loginRequest('nico', 'pw'))

    expect(response.status).toBe(303)
    expectRelativeRedirect(response, '/nico')

    const cookie = response.cookies.get(SESSION_COOKIE)
    expect(cookie).toBeDefined()
    // The session id itself, never logged or asserted verbatim here — only
    // its presence and length are checked.
    expect(cookie!.value.length).toBeGreaterThan(0)
    expect(cookie!.httpOnly).toBe(COOKIE_OPTIONS.httpOnly)
    expect(cookie!.secure).toBe(COOKIE_OPTIONS.secure)
    expect(cookie!.sameSite?.toString().toLowerCase()).toBe(COOKIE_OPTIONS.sameSite)
    expect(cookie!.path).toBe(COOKIE_OPTIONS.path)
    expect(cookie!.maxAge).toBe(COOKIE_OPTIONS.maxAge)

    // The point of the whole change: the session issued above is already
    // unlocked, so /unlock is not in the way of a fresh login.
    expect(getKey(cookie!.value)).toBeDefined()
  })

  it('sends each account to its OWN space, so the redirect is not a hardcoded slug', async () => {
    // Deliberately a different slug from every other test in this file. With
    // only the 'nico' case above, an implementation redirecting to a literal
    // '/nico' — or to a literal '/unlock' replaced by a literal '/nico' —
    // would pass and the bug would ship.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { getKey } = await import('@/lib/session/keymap')
    handle = getDb()
    await createAccount(handle, {
      slug: 'devtwo',
      role: 'user',
      password: 'pw2',
    })

    const { POST } = await import('@/app/api/login/route')
    const response = await POST(loginRequest('devtwo', 'pw2'))

    expect(response.status).toBe(303)
    expectRelativeRedirect(response, '/devtwo')
    expect(getKey(response.cookies.get(SESSION_COOKIE)!.value)).toBeDefined()
  })

  it('redirects to /login?error=1, sets NO session cookie, and derives NO key for wrong credentials', async () => {
    // A failed login creates no session, so there is no session id to probe
    // getKey with — watching the putKey call itself is the only way to see
    // that no derivation happened.
    //
    // Scoped with doMock rather than a file-level vi.mock deliberately.
    // Measured: a file-level vi.mock factory SURVIVES vi.resetModules(), so
    // the keymap module instance — and its key Map — would be shared by every
    // test in this file, silently defeating the per-test isolation the header
    // comment describes. doMock here plus doUnmock in afterEach keeps it:
    // verified that the following test gets the real keymap back and sees no
    // key left over from this one.
    const realKeymap = await import('@/lib/session/keymap')
    const putKeySpy = vi.fn(realKeymap.putKey)
    vi.doMock('@/lib/session/keymap', () => ({
      ...realKeymap,
      putKey: putKeySpy,
    }))
    // Reset before any other module is imported, so getDb()'s singleton is
    // created once after the mock is registered and the route handler shares
    // this test's database handle rather than opening a second one.
    vi.resetModules()

    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    handle = getDb()
    await createAccount(handle, { slug: 'nico', role: 'user', password: 'pw' })

    const { POST } = await import('@/app/api/login/route')
    const response = await POST(loginRequest('nico', 'wrong'))

    expect(response.status).toBe(303)
    expectRelativeRedirect(response, '/login?error=1')
    // This half matters most: a handler that set the cookie before checking
    // credentials would still pass a redirect-only assertion.
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined()
    // Now that login derives a key on the success path, the failure path must
    // not. A wrong password reaching deriveDbKey would spend an Argon2 pass on
    // key material for a request that is about to be rejected.
    expect(putKeySpy).not.toHaveBeenCalled()
  })

  it('leaves the re-lock path intact: losing the key sends the still-valid session back to /unlock', async () => {
    // THE assertion of this change. Deriving at login must not turn a session
    // into a standing unlock: architecture-overview.md commits to the key
    // living only in memory, so a restart has to leave the user logged in but
    // locked. dropKey is what a process restart looks like from the keymap's
    // point of view — the sessions row survives in SQLite, the key does not.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { dropKey, getKey } = await import('@/lib/session/keymap')
    const { readSession } = await import('@/lib/session/store')
    const { redirectTargetFor } = await import('@/lib/session/resolve')
    handle = getDb()
    await createAccount(handle, {
      slug: 'devone',
      role: 'user',
      password: 'pw1',
    })

    const { POST } = await import('@/app/api/login/route')
    const response = await POST(loginRequest('devone', 'pw1'))
    const sid = response.cookies.get(SESSION_COOKIE)!.value

    // Unlocked immediately after login: /devone is allowed straight through.
    expect(getKey(sid)).toBeDefined()
    expect(redirectTargetFor(handle, sid, '/devone')).toBeNull()

    dropKey(sid)

    // Still logged in — the session row is untouched by the key going away.
    expect(readSession(handle, sid)).toBeDefined()
    // But locked again — and now reaches its own space anyway: routeFor
    // lets a locked session through to /devone, and it's the page's data
    // region (see tests/routing/userSpace.test.ts's locked-owner test and
    // its unlocked-owner companion) that asks for the password again, not
    // this redirect.
    expect(getKey(sid)).toBeUndefined()
    expect(redirectTargetFor(handle, sid, '/devone')).toBeNull()
    // And /unlock itself stays reachable, so the single re-lock prompt works.
    expect(redirectTargetFor(handle, sid, '/unlock')).toBeNull()
  })
})

describe('POST /api/unlock', () => {
  it('redirects to /<slug> and getKey(sessionId) becomes defined for the correct password', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { getKey } = await import('@/lib/session/keymap')
    handle = getDb()
    const id = await createAccount(handle, {
      slug: 'nico',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(handle, id)
    cookieSlot.value = { value: sid }

    expect(getKey(sid)).toBeUndefined()

    const { POST } = await import('@/app/api/unlock/route')
    const response = await POST(unlockRequest('pw'))

    expect(response.status).toBe(303)
    expectRelativeRedirect(response, '/nico')
    expect(getKey(sid)).toBeDefined()
  })

  it('redirects to /unlock?error=1 and leaves the key absent for a wrong password', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { getKey } = await import('@/lib/session/keymap')
    handle = getDb()
    const id = await createAccount(handle, {
      slug: 'nico',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(handle, id)
    cookieSlot.value = { value: sid }

    const { POST } = await import('@/app/api/unlock/route')
    const response = await POST(unlockRequest('wrong'))

    expect(response.status).toBe(303)
    expectRelativeRedirect(response, '/unlock?error=1')
    expect(getKey(sid)).toBeUndefined()
  })
})

describe('POST /api/logout', () => {
  it('destroys the session row, drops the key from the in-memory map, and clears the cookie', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession, readSession } = await import('@/lib/session/store')
    const { putKey, getKey } = await import('@/lib/session/keymap')
    handle = getDb()
    const id = await createAccount(handle, {
      slug: 'nico',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(handle, id)
    putKey(sid, Buffer.alloc(32, 7))
    cookieSlot.value = { value: sid }

    expect(readSession(handle, sid)).toBeDefined()
    expect(getKey(sid)).toBeDefined()

    const { POST } = await import('@/app/api/logout/route')
    // No argument: the logout handler no longer takes a Request. It only ever
    // used it to build an absolute redirect from request.url, which is exactly
    // what lib/http/redirect.ts exists to stop. Next still calls it with one
    // at runtime; an extra argument to a zero-parameter function is harmless.
    const response = await POST()

    expect(response.status).toBe(303)
    expectRelativeRedirect(response, '/login')
    expect(readSession(handle, sid)).toBeUndefined()
    // The key drop is the one that protects a shared machine: a stale
    // in-memory key would let the next person at this browser skip /unlock.
    expect(getKey(sid)).toBeUndefined()

    const cleared = response.cookies.get(SESSION_COOKIE)
    expect(cleared).toBeDefined()
    expect(cleared!.value).toBe('')
  })
})
