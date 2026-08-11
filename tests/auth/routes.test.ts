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

function logoutRequest() {
  return new Request('http://localhost/api/logout', { method: 'POST' })
}

describe('POST /api/login', () => {
  it('redirects to /unlock and sets the session cookie with the real COOKIE_OPTIONS flags for correct credentials', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    handle = getDb()
    await createAccount(handle, { slug: 'nico', role: 'user', password: 'pw' })

    const { POST } = await import('@/app/api/login/route')
    const response = await POST(loginRequest('nico', 'pw'))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost/unlock')

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
  })

  it('redirects to /login?error=1 and sets NO session cookie for wrong credentials', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    handle = getDb()
    await createAccount(handle, { slug: 'nico', role: 'user', password: 'pw' })

    const { POST } = await import('@/app/api/login/route')
    const response = await POST(loginRequest('nico', 'wrong'))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      'http://localhost/login?error=1',
    )
    // This half matters most: a handler that set the cookie before checking
    // credentials would still pass a redirect-only assertion.
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined()
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
    expect(response.headers.get('location')).toBe('http://localhost/nico')
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
    expect(response.headers.get('location')).toBe(
      'http://localhost/unlock?error=1',
    )
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
    const response = await POST(logoutRequest())

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost/login')
    expect(readSession(handle, sid)).toBeUndefined()
    // The key drop is the one that protects a shared machine: a stale
    // in-memory key would let the next person at this browser skip /unlock.
    expect(getKey(sid)).toBeUndefined()

    const cleared = response.cookies.get(SESSION_COOKIE)
    expect(cleared).toBeDefined()
    expect(cleared!.value).toBe('')
  })
})
