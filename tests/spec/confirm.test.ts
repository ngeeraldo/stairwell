// tests/spec/confirm.test.ts
//
// The confirm endpoint is the only thing that turns a proposal into a
// promise. Follows tests/chat/route.test.ts's module-mocking setup: stub
// next/headers, point PLATFORM_DB at a temp file, vi.resetModules() per
// test, then dynamically import the route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

// Carried finding from Task 1: confirmSpec (lib/db/specs.ts) throws when a
// (specId, accountId) pair does not belong together. The route's own 404
// check should make that unreachable, but this flag lets one test force the
// throw anyway, to prove the route does not let it become an unhandled 500.
const forceConfirmThrow = { value: false }
vi.mock('@/lib/db/specs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/specs')>()
  return {
    ...actual,
    confirmSpec: (...args: Parameters<typeof actual.confirmSpec>) => {
      if (forceConfirmThrow.value) {
        throw new Error(
          'forced: does not belong to account (carried finding, Task 1)',
        )
      }
      return actual.confirmSpec(...args)
    },
  }
})

let dir: string
let handle: PlatformDb | undefined

// Captured the same way tests/alerts/leak.test.ts captures a fake fetch —
// except the route wires the alerter to globalThis.fetch directly, so here
// the capture point is a stubbed global rather than a constructor argument.
//
// Resolves on a macrotask (setTimeout), not a same-tick microtask. This is
// NOT what makes lastMetric()'s assertions correct — that is now the job of
// lastMetric() filtering by event (see below), and is proven
// timing-independent because it also passes with a same-tick resolve. This
// timing is kept only because it is the more faithful double on its own
// terms: a real ntfy.sh round trip is always slower than the microtask
// chain `post()`'s own awaits drain through, and there IS no production
// race for the macrotask choice to paper over — the route appends
// `spec_confirmed` with a synchronous better-sqlite3 `.run()` before
// `alerter(...)` is even invoked, so the metric is always written first
// regardless of how fast the alert's own write lands. The capture into
// `seenFetch` still happens synchronously at call time, so alertBodies()
// is correct immediately after `post()` resolves either way.
let seenFetch: { url: string; init: RequestInit | undefined }[] = []
const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
  seenFetch.push({ url: String(url), init })
  return new Promise<Response>((resolve) => {
    setTimeout(() => resolve(new Response('1', { status: 200 })), 0)
  })
}) as unknown as typeof globalThis.fetch

const accountIds = new Map<string, number>()
const sessionsBySlug = new Map<string, string>()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-confirmroute-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  // Loudly fake — no real ntfy.sh topic. fetch is stubbed below regardless,
  // so no test ever reaches the network even though a topic is present.
  process.env.NTFY_TOPIC = 'TEST-TOPIC-CONFIRM'
  vi.resetModules()
  vi.stubGlobal('fetch', fakeFetch)
  cookieGet.mockClear()
  cookieSlot.value = undefined
  seenFetch = []
  accountIds.clear()
  sessionsBySlug.clear()
  forceConfirmThrow.value = false
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  delete process.env.NTFY_TOPIC
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function ensureDb(): Promise<PlatformDb> {
  if (!handle) {
    const { getDb } = await import('@/lib/db/instance')
    handle = getDb()
  }
  return handle
}

/** Create (or reuse) an account for `slug`, returning its id. No session. */
async function ensureAccountId(slug: string): Promise<number> {
  const db = await ensureDb()
  let id = accountIds.get(slug)
  if (id === undefined) {
    const { createAccount } = await import('@/lib/auth/accounts')
    id = await createAccount(db, { slug, role: 'user', password: 'pw' })
    accountIds.set(slug, id)
  }
  return id
}

/**
 * Create (or reuse) a session for `slug`, putting a key in it iff `unlocked`.
 * A session is created once per slug per test and reused, so a test that
 * wants a genuinely LOCKED session must not have unlocked that slug earlier
 * in the same test (seedSpec deliberately never unlocks).
 */
async function sessionFor(slug: string, unlocked: boolean): Promise<string> {
  const db = await ensureDb()
  const accountId = await ensureAccountId(slug)
  let sid = sessionsBySlug.get(slug)
  if (!sid) {
    const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
    sessionCookieName = SESSION_COOKIE
    sid = createSession(db, accountId)
    sessionsBySlug.set(slug, sid)
  }
  if (unlocked) {
    const { putKey } = await import('@/lib/session/keymap')
    putKey(sid, Buffer.alloc(32, 1))
  }
  return sid
}

type PostOpts = { session?: 'none'; as?: string; locked?: boolean }

async function post(body: unknown, opts: PostOpts = {}) {
  await ensureDb()
  const { SESSION_COOKIE } = await import('@/lib/session/store')
  sessionCookieName = SESSION_COOKIE
  const { POST } = await import('@/app/api/spec/confirm/route')

  if (opts.session === 'none') {
    cookieSlot.value = undefined
  } else {
    const sid = await sessionFor(opts.as ?? 'devtwo', !opts.locked)
    cookieSlot.value = { value: sid }
  }

  return POST(
    new Request('http://localhost/api/spec/confirm', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
}

/**
 * Insert a spec proposal for `slug`'s account, returning its id. Never
 * unlocks a session — some tests (the LOCKED one) depend on that.
 */
async function seedSpec(slug: string): Promise<number> {
  const db = await ensureDb()
  const accountId = await ensureAccountId(slug)
  const { insertSpec } = await import('@/lib/db/specs')
  return insertSpec(db, {
    accountId,
    conversationId: 'conv-test',
    promptSha: 'sha-test-fake',
    payload: { fake: 'COFFEE PALACE TEST SPEC' },
    mockupHtml: '<html>COFFEE PALACE TEST MOCKUP</html>',
    at: Date.now(),
  })
}

function confirmationCount(specId: number): number {
  const row = handle!
    .prepare('SELECT COUNT(*) AS n FROM spec_confirmations WHERE spec_id = ?')
    .get(specId) as { n: number }
  return row.n
}

/**
 * The most recent metric row FOR THE GIVEN EVENT, not the last row in the
 * whole table. `spec_confirmed` and the alerter's own `alert_sent` /
 * `alert_failed` land in the same append-only table, and the alerter's
 * write is fire-and-forget — nothing in the route orders it relative to
 * when a test's assertions run. A query that ignored `event` would read
 * whichever metric happened to land last, which depends on alert timing
 * that this endpoint explicitly does not control.
 */
function lastMetric(event: string): { event: string; data: Record<string, unknown> } {
  const row = handle!
    .prepare('SELECT event, data FROM metrics WHERE event = ? ORDER BY id DESC LIMIT 1')
    .get(event) as { event: string; data: string | null } | undefined
  if (!row) throw new Error(`lastMetric: no '${event}' row in metrics`)
  return { event: row.event, data: row.data ? JSON.parse(row.data) : {} }
}

function alertBodies(): string[] {
  return seenFetch.map((s) => String(s.init?.body ?? ''))
}

describe('POST /api/spec/confirm', () => {
  it('401s an anonymous caller', async () => {
    // No session cookie at all.
    expect((await post({ specId: 1 }, { session: 'none' })).status).toBe(401)
  })

  it('400s a body with no numeric specId', async () => {
    expect((await post({ specId: 'seven' })).status).toBe(400)
  })

  it("404s another account's spec, never 403", async () => {
    // 404, matching canSeeUserSpace: a 403 confirms the row exists.
    const other = await seedSpec('devone')
    expect((await post({ specId: other }, { as: 'devtwo' })).status).toBe(404)
  })

  it('404s an id that does not exist', async () => {
    expect((await post({ specId: 9999 })).status).toBe(404)
  })

  it('409s a superseded proposal', async () => {
    // A stale tab is not bound by what the current page rendered.
    const first = await seedSpec('devtwo')
    await seedSpec('devtwo')
    expect((await post({ specId: first })).status).toBe(409)
  })

  it('confirms the newest proposal, records the metric, and fires the alert', async () => {
    const id = await seedSpec('devtwo')
    expect((await post({ specId: id })).status).toBe(200)
    expect(confirmationCount(id)).toBe(1)
    expect(lastMetric('spec_confirmed').event).toBe('spec_confirmed')
    expect(lastMetric('spec_confirmed').data.spec_id).toBe(id)
    expect(alertBodies()).toEqual(['devtwo confirmed a spec'])
  })

  it('is a no-op on a repeat confirm, not a second append', async () => {
    // Append-only makes a duplicate harmless but permanent, and "confirmed
    // twice" is not a fact about anything.
    const id = await seedSpec('devtwo')
    expect((await post({ specId: id })).status).toBe(200)
    expect((await post({ specId: id })).status).toBe(200)
    expect(confirmationCount(id)).toBe(1)
  })

  it('works while the session is locked', async () => {
    // The chat surface keeps working when the key is gone
    // (architecture-overview.md line 59), the spec flow lives inside it, and
    // confirming touches no user data.
    const id = await seedSpec('devtwo')
    expect((await post({ specId: id }, { locked: true })).status).toBe(200)
  })

  it('404s (not 500) when confirmSpec throws on a pair the 404 check should have caught', async () => {
    // Carried finding from Task 1: confirmSpec throws for a mismatched
    // (specId, accountId) pair. The route's own 404 check makes that
    // unreachable in practice, but the handler must not assume confirmSpec
    // is infallible — an unhandled throw here is a 500 to the friend at the
    // exact moment they press "Build this". The route's own comment treats
    // this path as "not found" (the mismatch's actual meaning), so pin the
    // specific status rather than merely "not 500" — a 400 or 200 here
    // would satisfy a looser assertion while contradicting the code's
    // stated intent.
    const id = await seedSpec('devtwo')
    forceConfirmThrow.value = true
    const res = await post({ specId: id })
    expect(res.status).toBe(404)
    expect(confirmationCount(id)).toBe(0)
  })
})
