import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import type { PlatformDb } from '@/lib/db/platform'

// Fix wave item 5: routeFor's '/login' branch (authenticated -> /unlock,
// unlocked -> '/') was dead code — nothing ever called requireState with
// '/login' as the pathname, so tests asserting on it were exercising logic
// no real request path reached. app/(auth)/login/page.tsx now calls
// requireState('/login') for real, which is what these tests check. Same
// idiom as tests/routing/middleware.test.ts's requireState group and
// tests/routing/root.test.ts: a fresh PLATFORM_DB and vi.resetModules()
// per test, and a redirect() mock that throws (tests/routing/userSpace.
// test.ts's idiom) since real redirect() never returns.
//
// tsconfig.json's "jsx": "preserve" plus vitest's esbuild transform means
// the anonymous case (the only one that actually renders JSX, since the
// other two redirect before reaching it) needs `React` on the global
// object — see the identical comment in tests/routing/userSpace.test.ts.
beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const redirectMock = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`)
})
const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
const cookieGet = vi.fn((name: string) =>
  name === 'stairwell_session' ? cookieSlot.value : undefined,
)

vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirectMock(path),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-loginpage-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  redirectMock.mockClear()
  cookieGet.mockClear()
  cookieSlot.value = undefined
  db = undefined
})

afterEach(() => {
  db?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
})

async function renderLoginPage() {
  const { default: LoginPage } = await import('@/app/(auth)/login/page')
  return LoginPage({ searchParams: Promise.resolve({}) })
}

/**
 * The onboarding promise, pinned sentence by sentence.
 *
 * architecture-overview.md section 4 requires this paragraph to be written
 * down where a friend can see it. It is a promise made to a person, not copy —
 * so it should not be able to drift through an unrelated edit without someone
 * deciding to change it. If one of these stops being true, the right outcome
 * is a red test and a conversation, not a silent diff.
 *
 * The last two arrived with step 6a, when real per-user data became something
 * that could exist: the first bounds what recording engagement reveals
 * (dashboard_write carries a slug and a panel, never a value), the second
 * states the cost of deriving the key from the password and storing it
 * nowhere.
 */
describe('/login onboarding promise', () => {
  const PROMISED = [
    'My tools run on fake data.',
    "I won't open your transactions.",
    "Everything's deleted when the pilot ends.",
    'I can see when you use it — which days you open it and log things — but not what you log.',
    "If you forget your password, your logged data is gone forever — I can't recover it, on purpose, because I can't read it either.",
  ]

  it.each(PROMISED)('says: %s', async (sentence) => {
    const { getDb } = await import('@/lib/db/instance')
    db = getDb()

    const element = await renderLoginPage()
    // JSX escapes apostrophes as &apos; in source; the rendered tree carries
    // the real characters, so compare against the tree rather than the file.
    const text = JSON.stringify(element).replace(/&apos;|&#39;/g, "'")

    expect(text).toContain(sentence)
  })
})

describe('/login page guard', () => {
  it('lets an anonymous visitor reach the form (no redirect)', async () => {
    const { getDb } = await import('@/lib/db/instance')
    db = getDb()

    const result = await renderLoginPage()

    expect(redirectMock).not.toHaveBeenCalled()
    expect(result).toBeTruthy()
  })

  it('sends an authenticated-but-locked session to /unlock instead of re-showing the form', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { SESSION_COOKIE } = await import('@/lib/session/cookie')
    db = getDb()
    const id = await createAccount(db, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    cookieSlot.value = { value: sid }
    cookieGet.mockImplementation((name: string) =>
      name === SESSION_COOKIE ? cookieSlot.value : undefined,
    )

    await expect(renderLoginPage()).rejects.toThrow('NEXT_REDIRECT:/unlock')

    expect(redirectMock).toHaveBeenCalledWith('/unlock')
  })

  it("sends an unlocked session to '/', not back into a second login — and that resolves onward to the slug, not back to /login", async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { putKey } = await import('@/lib/session/keymap')
    const { SESSION_COOKIE } = await import('@/lib/session/cookie')
    db = getDb()
    const id = await createAccount(db, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }
    cookieGet.mockImplementation((name: string) =>
      name === SESSION_COOKIE ? cookieSlot.value : undefined,
    )

    // Hop 1: /login, unlocked -> routeFor sends it to '/'.
    await expect(renderLoginPage()).rejects.toThrow('NEXT_REDIRECT:/')
    expect(redirectMock).toHaveBeenCalledWith('/')
    redirectMock.mockClear()

    // Hop 2: '/' itself resolves the same unlocked session onward to its
    // slug (app/page.tsx), not back to /login. If it went back to /login,
    // hop 1 and hop 2 together would be an infinite loop; asserting the
    // actual second hop's target proves it terminates instead.
    const { default: Home } = await import('@/app/page')
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/devone')
    expect(redirectMock).not.toHaveBeenCalledWith('/login')
    expect(redirectMock).toHaveBeenCalledWith('/devone')
  })
})
