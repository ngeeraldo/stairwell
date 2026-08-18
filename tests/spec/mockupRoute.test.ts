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
import { BANNER_MARKER } from '@/lib/spec/banner'

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
async function seed(options: { unlocked?: boolean; role?: 'user' | 'admin'; mockupHtml?: string } = {}) {
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
    mockupHtml: options.mockupHtml ?? MOCKUP,
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
  it('serves the stored bytes as a document, plus the banner', async () => {
    // CHANGED 2026-08-14. This used to assert byte-for-byte equality, which
    // was right while every value in a mockup was "£000.00" and could not be
    // mistaken for real data. Mockups carry plausible numbers now, so the
    // banner is the only thing distinguishing a preview from a dashboard —
    // and it is applied HERE rather than asked of the model, because "the
    // model always complies" is not a guarantee and a route is.
    //
    // The stored document still arrives intact; it just arrives labelled.
    await seed()
    const response = await get('1')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain(MOCKUP.replace(/^<!doctype html><html><body>/i, '').replace(/<\/body><\/html>$/i, ''))
    expect(html).toContain(BANNER_MARKER)
  })

  it('injects a banner into a stored document that has none', async () => {
    // THE FIXTURE-STRIPPING TEST Nico asked for, and the reason it lives at the
    // route rather than beside the pure function: the question that matters is
    // whether the bytes a FRIEND receives carry the banner when the stored
    // document does not. That is the exact shape of the original mistake — the
    // banner in earlier screenshots came from fixture HTML, so a guard looked
    // present that had never been applied to generated output.
    await seed({ mockupHtml: '<!doctype html><html><body><p>Feels like 91°</p></body></html>' })
    const html = await (await get('1')).text()

    expect(html).toContain(BANNER_MARKER)
    // Ahead of the plausible number — the thing that could be mistaken for real.
    expect(html.indexOf(BANNER_MARKER)).toBeLessThan(html.indexOf('Feels like'))
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
    //
    // Task 25: `sandbox` restricts scripts/forms/navigation; the three
    // directives appended after it are the fetch-blocking half — see the
    // route's own comment for the full rationale (Nico's pinned policy:
    // default-src 'none'; style-src 'unsafe-inline'; img-src data:).
    await seed()
    const response = await get('1')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  // Task 25's red test: a fixture shaped exactly like the leak this guard
  // exists for — a stored mockup whose HTML carries a real outbound
  // reference to a third party. The route does not rewrite the stored bytes
  // (that is lib/spec/mockupCompose.ts's job, at COMPOSE time, tested in
  // tests/spec/mockupCompose.test.ts) — its only lever is the header that
  // tells a friend's own browser not to fetch it. Deleting the appended CSP
  // directives from the route (reverting to the old bare `'sandbox'` value)
  // turns this test red, which is the point: a guard nobody has watched fail
  // is a guard nobody should trust.
  it('forbids the CSP from allowing an external image the stored mockup carries', async () => {
    await seed({
      mockupHtml:
        '<!doctype html><html><body><img src="https://cdn.example.test/leak.png"></body></html>',
    })
    const response = await get('1')
    const csp = response.headers.get('content-security-policy')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).toContain('img-src data:')
    // The negative half, and the one that actually catches a regression: an
    // `img-src` directive that grew an `https:` source would still contain
    // `data:` and pass a purely positive assertion.
    expect(csp).not.toContain('https:')
    expect(csp).not.toContain('http:')
  })
})
