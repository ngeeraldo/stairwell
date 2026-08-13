import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

// '/' has no content of its own — it dispatches by session state
// (fix wave, item 5). It used to redirect unconditionally to /login, which
// let an already-unlocked user re-submit the login form and start a second
// session while the first stayed alive. These tests exercise the real
// per-state dispatch against a real database, the same pattern used for
// lib/session/guard.ts's requireState in tests/routing/middleware.test.ts's
// group A: a fresh PLATFORM_DB and vi.resetModules() per test so
// lib/db/instance.ts's getDb() singleton never falls back to the repo's
// own platform/dev/synthetic.db.
//
// redirect() throws in real Next.js — it never returns — so the mock
// throws too (tests/routing/userSpace.test.ts's idiom). A mock that just
// records and returns would let a mis-guarded Home() "fall through" past a
// redirect and a test checking only toHaveBeenCalledWith would not catch
// it.
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
  dir = mkdtempSync(join(tmpdir(), 'stairwell-root-'))
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

describe('app shell (/)', () => {
  it('sends an anonymous visitor (no cookie) to /login', async () => {
    const { getDb } = await import('@/lib/db/instance')
    db = getDb()

    const { default: Home } = await import('@/app/page')
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/login')

    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('sends an authenticated-but-locked session to /unlock', async () => {
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

    const { default: Home } = await import('@/app/page')
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/unlock')

    expect(redirectMock).toHaveBeenCalledWith('/unlock')
  })

  it('sends an unlocked session to its own slug, not back to /login', async () => {
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

    const { default: Home } = await import('@/app/page')
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/devone')

    // This is the exact bug: the old code redirected here unconditionally
    // to /login, which would have let an unlocked user start a second
    // session while the first one stayed alive.
    expect(redirectMock).not.toHaveBeenCalledWith('/login')
    expect(redirectMock).toHaveBeenCalledWith('/devone')
  })

  it('sends an unlocked admin session to /admin, never to /<slug> — an admin has no user space', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { putKey } = await import('@/lib/session/keymap')
    const { SESSION_COOKIE } = await import('@/lib/session/cookie')
    db = getDb()
    const id = await createAccount(db, { slug: 'nico', role: 'admin', password: 'pw' })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }
    cookieGet.mockImplementation((name: string) =>
      name === SESSION_COOKIE ? cookieSlot.value : undefined,
    )

    const { default: Home } = await import('@/app/page')
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/admin')

    expect(redirectMock).toHaveBeenCalledWith('/admin')
    expect(redirectMock).not.toHaveBeenCalledWith('/nico')
  })
})
