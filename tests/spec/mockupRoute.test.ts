// tests/spec/mockupRoute.test.ts
//
// One serving route for the card preview and the full-screen dialog
// (onboarding ledger D14). A version number is a small integer and therefore
// guessable, so most of this file is about who may read what.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'stairwell_session' ? cookieSlot.value : undefined),
  }),
  headers: async () => ({ get: () => null }),
}))

const MOCKUP = '<!doctype html><html><body><h1>COFFEE PALACE TEST</h1></body></html>'

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-mockup-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  cookieSlot.value = undefined
  db = undefined
})

afterEach(() => {
  db?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
})

/** An account with one spec, and a session for it. */
async function seed(options: { unlocked?: boolean; role?: 'user' | 'admin' } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  const { insertSpec } = await import('@/lib/db/specs')
  db = getDb()

  const id = await createAccount(db, {
    slug: options.role === 'admin' ? 'nico' : 'devtwo',
    role: options.role ?? 'user',
    password: 'TEST-NOT-A-REAL-PASSWORD',
  })
  insertSpec(db, {
    accountId: id,
    conversationId: 'conv-1',
    promptSha: 'deadbeef',
    payload: { title: 'x' },
    mockupHtml: MOCKUP,
    at: 1000,
  })
  const sid = createSession(db, id)
  if (options.unlocked !== false) putKey(sid, Buffer.alloc(32, 1))
  cookieSlot.value = { value: sid }
  return { id, sid }
}

async function get(version: string): Promise<Response> {
  const { GET } = await import('@/app/mockup/[version]/route')
  return GET(new Request(`http://localhost/mockup/${version}`), {
    params: Promise.resolve({ version }),
  })
}

describe('GET /mockup/<version>', () => {
  it('serves the stored bytes, exactly, as a document', async () => {
    await seed()
    const response = await get('1')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe(MOCKUP)
  })

  it('serves a LOCKED session too — a mockup is chat surface, not data', async () => {
    // The spec flow lives entirely inside the surface that keeps working when
    // the key is gone (architecture-overview.md line 59), and a friend must be
    // able to look at a proposal and confirm it after a deploy re-locked them.
    await seed({ unlocked: false })
    expect((await get('1')).status).toBe(200)
  })

  it('401s an anonymous request', async () => {
    const { getDb } = await import('@/lib/db/instance')
    db = getDb()
    expect((await get('1')).status).toBe(401)
  })

  it('404s another account’s version', async () => {
    // The lookup is scoped to the caller's own account, so there is no query
    // here that could return somebody else's row. 404, never 403 — the same
    // rule canSeeUserSpace follows, for the same reason.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { putKey } = await import('@/lib/session/keymap')
    const { insertSpec } = await import('@/lib/db/specs')
    db = getDb()

    const owner = await createAccount(db, {
      slug: 'devtwo',
      role: 'user',
      password: 'TEST-NOT-A-REAL-PASSWORD',
    })
    insertSpec(db, {
      accountId: owner,
      conversationId: 'c',
      promptSha: 'd',
      payload: { title: 'x' },
      mockupHtml: MOCKUP,
      at: 1000,
    })
    const other = await createAccount(db, {
      slug: 'devone',
      role: 'user',
      password: 'TEST-NOT-A-REAL-PASSWORD',
    })
    const sid = createSession(db, other)
    putKey(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }

    const response = await get('1')
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
  })

  it('404s a version that does not exist', async () => {
    await seed()
    expect((await get('99')).status).toBe(404)
  })

  it('404s a version that is not a positive integer', async () => {
    await seed()
    for (const bad of ['0', '-1', 'abc', '1.5', '']) {
      expect((await get(bad)).status, `version '${bad}'`).toBe(404)
    }
  })

  it('404s an admin — they read a friend’s mockup through the admin route', async () => {
    await seed({ role: 'admin' })
    expect((await get('1')).status).toBe(404)
  })

  it('is never cached, and declares itself sandboxed', async () => {
    // no-store because this is per-account content behind a session, and a
    // shared cache holding one would be the worst kind of leak. The CSP is
    // for the friend who opens the URL directly, with no iframe around it.
    await seed()
    const response = await get('1')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
