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
import { parseSpecDraft, sealVersion } from '@/lib/spec/validate'
import type { Panel, SpecVersion } from '@/lib/spec/schema'

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

/**
 * Create (or reuse) an ADMIN session for `slug`. Kept separate from
 * sessionFor/ensureAccountId rather than adding a role parameter there:
 * every non-admin test in this file depends on those helpers minting a
 * 'user' account, and a role parameter threaded through both would risk a
 * default-value slip changing that for existing tests.
 */
async function sessionForAdmin(slug: string): Promise<string> {
  const db = await ensureDb()
  let id = accountIds.get(slug)
  if (id === undefined) {
    const { createAccount } = await import('@/lib/auth/accounts')
    id = await createAccount(db, { slug, role: 'admin', password: 'pw' })
    accountIds.set(slug, id)
  }
  let sid = sessionsBySlug.get(slug)
  if (!sid) {
    const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
    sessionCookieName = SESSION_COOKIE
    sid = createSession(db, id)
    sessionsBySlug.set(slug, sid)
  }
  return sid
}

type PostOpts = { session?: 'none'; as?: string; locked?: boolean; admin?: boolean }

async function post(body: unknown, opts: PostOpts = {}) {
  await ensureDb()
  const { SESSION_COOKIE } = await import('@/lib/session/store')
  sessionCookieName = SESSION_COOKIE
  const { POST } = await import('@/app/api/spec/confirm/route')

  if (opts.session === 'none') {
    cookieSlot.value = undefined
  } else if (opts.admin) {
    const sid = await sessionForAdmin(opts.as ?? 'nico')
    cookieSlot.value = { value: sid }
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
 *
 * The payload is a genuine, if minimal, LEGACY-shaped spec (lib/spec/legacy.ts's
 * six fields) rather than an arbitrary placeholder object. Task 11 made the
 * route call readStoredSpec(spec.payload) on every confirmed spec, not just
 * ones with a diff to compute — an ad hoc `{ fake: ... }` object satisfies
 * neither the version reader (no `screens`) nor the legacy reader (missing
 * `title` etc.), so it would throw there and, prior to this fixture change,
 * silently depended on the counts try/catch to survive. Most tests in this
 * file don't care about spec shape at all; they should not be coupled to
 * diff internals just because the route now touches the payload.
 */
async function seedSpec(slug: string): Promise<number> {
  const db = await ensureDb()
  const accountId = await ensureAccountId(slug)
  const { insertSpec } = await import('@/lib/db/specs')
  return insertSpec(db, {
    accountId,
    conversationId: 'conv-test',
    promptSha: 'sha-test-fake',
    payload: {
      title: 'COFFEE PALACE TEST SPEC',
      summary: 'COFFEE PALACE TEST SUMMARY',
      background: 'COFFEE PALACE TEST BACKGROUND',
      panels: [
        { name: 'COFFEE PALACE TEST PANEL', shows: 'COFFEE PALACE TEST SHOWS', why: 'COFFEE PALACE TEST WHY', source: 'manual' },
      ],
      manual_logging: [],
      open_questions: [],
    },
    mockupHtml: '<html>COFFEE PALACE TEST MOCKUP</html>',
    at: Date.now(),
  })
}

/**
 * Insert a spec whose payload is genuinely unparseable by EITHER reader —
 * has no `screens` (so readStoredSpec tries the legacy reader), and is
 * missing the legacy reader's own required fields too. Used only as a BASE
 * row (based_on_version target), never as the spec being confirmed: it
 * stands in for "a corrupt base row that can never be repaired" — the other
 * half of the bound the counts try/catch exists for, distinct from
 * seedSpec's now-valid legacy payload.
 */
async function seedCorruptSpec(slug: string): Promise<number> {
  const db = await ensureDb()
  const accountId = await ensureAccountId(slug)
  const { insertSpec } = await import('@/lib/db/specs')
  return insertSpec(db, {
    accountId,
    conversationId: 'conv-test',
    promptSha: 'sha-test-fake',
    payload: { fake: 'COFFEE PALACE TEST CORRUPT SPEC' },
    mockupHtml: '<html>COFFEE PALACE TEST MOCKUP</html>',
    at: Date.now(),
  })
}

// Fixtures below mirror tests/spec/diff.test.ts's panel()/draft() helpers
// (that file's own comment says they were copied from tests/spec/validate.test.ts
// for the same reason): going through the real validator/sealer, rather than
// casting an invented object, means v1/v2 are genuine SpecVersions and any
// diff computed over them is the real diffVersions, not a stand-in.
function panel(over: Partial<Panel> = {}): Panel {
  return {
    id: 'walked_today',
    title: 'Walked today?',
    intent: 'Did I walk the dog today?',
    display: 'A big yes/no with a tap-to-mark control.',
    context_of_use: 'Phone, in bed, before getting up.',
    values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
    entry: {
      description: 'One tap.',
      fields: [{ name: 'walked', type: 'boolean', choices: [] }],
      annotates: null,
    },
    ...over,
  }
}

function draft(over: Record<string, unknown> = {}): unknown {
  return {
    title: 'Did I walk the dog today?',
    summary: 'A one-tap daily tracker.',
    background: 'Pivoted from a weather idea.',
    change_summary: 'The whole dashboard: one tap, a streak, a 30-day rate.',
    screens: [{ id: 'today', title: 'Today', order: 1, panels: [panel()] }],
    data_requirements: [{ table: 'walks', purpose: 'One row per day walked.', status: 'new' }],
    open_questions: [],
    ...over,
  }
}

// v1: a first proposal, no prior version. v2: one new panel ("streak") added
// on top, based_on_version 1 — the shape a real second proposal has once a
// friend confirms a first dashboard and asks for a change. v1's panel
// carries a distinctive id/title ("walked_today" / "Walked today?") on
// purpose: the no-content test below needs a fixture that COULD leak a
// title, or its assertion proves nothing.
const v1: SpecVersion = sealVersion(parseSpecDraft(draft()), null)
const v1Screen = v1.screens[0]
if (!v1Screen) throw new Error('fixture: v1 has no screens')
const v2: SpecVersion = {
  ...v1,
  based_on_version: 1,
  screens: [
    {
      ...v1Screen,
      panels: [
        ...v1Screen.panels,
        // A distinct values[].id, not the default 'walk_flag': re-inserting
        // panel()'s default would duplicate a value id across panels, which
        // parseSpecVersion's checkInvariants rejects on the read back inside
        // the route — a fixture bug, not the behavior under test.
        panel({
          id: 'streak',
          title: 'Current streak',
          values: [{ kind: 'entered', id: 'streak_flag', description: 'Consecutive days walked.' }],
        }),
      ],
    },
  ],
}

/**
 * Insert a spec whose payload is a genuine SpecVersion — unlike seedSpec's
 * `{ fake: ... }` placeholder, which exists only for tests that never touch
 * the diff and would fail both the version and legacy readers if parsed.
 */
async function seedVersionSpec(slug: string, version: SpecVersion): Promise<number> {
  const db = await ensureDb()
  const accountId = await ensureAccountId(slug)
  const { insertSpec } = await import('@/lib/db/specs')
  return insertSpec(db, {
    accountId,
    conversationId: 'conv-test',
    promptSha: 'sha-test-fake',
    payload: version,
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

  it('403s an admin, confirming nothing — not 404, because there is nothing to hide here', async () => {
    // Unlike canSeeUserSpace's 404, the admin check on this route answers
    // 403: the caller is asking about their own account and already knows
    // their own role. Uses devtwo's spec (not the admin's own — admins have
    // none) to prove the rejection fires on IDENTITY alone, before the
    // route ever looks at whether the spec belongs to the caller.
    const id = await seedSpec('devtwo')
    const res = await post({ specId: id }, { admin: true })
    expect(res.status).toBe(403)
    expect(confirmationCount(id)).toBe(0)
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

describe('spec_confirmed records the structural diff, never its content', () => {
  it('records the structural diff counts on spec_confirmed', async () => {
    // The diff between confirmed versions is the canonical record of what a
    // request WAS — it replaces classifying chat text after the fact.
    await seedVersionSpec('devtwo', v1)
    const v2Id = await seedVersionSpec('devtwo', v2)
    expect((await post({ specId: v2Id })).status).toBe(200)
    expect(lastMetric('spec_confirmed').data).toMatchObject({
      spec_id: v2Id,
      version: 2,
      panels_added: 1,
      panels_changed: 0,
    })
  })

  it('records counts only — never a panel id or a title', async () => {
    // Metrics is the unencrypted platform database. Counts are structural;
    // a panel title is the friend's own words.
    await seedVersionSpec('devtwo', v1)
    const v2Id = await seedVersionSpec('devtwo', v2)
    expect((await post({ specId: v2Id })).status).toBe(200)
    const serialized = JSON.stringify(lastMetric('spec_confirmed').data)
    expect(serialized).not.toContain('walked_today')
    expect(serialized).not.toContain('Walked today?')
  })

  it('counts every panel as added for a first confirmed version', async () => {
    const v1Id = await seedVersionSpec('devtwo', v1)
    expect((await post({ specId: v1Id })).status).toBe(200)
    expect(lastMetric('spec_confirmed').data.panels_added).toBe(1)
  })

  it('still confirms, and still fires the alert, when the diff cannot be computed', async () => {
    // v1 here is seedCorruptSpec's payload: no `screens` key, so
    // readStoredSpec tries the frozen legacy reader, which then throws
    // because it also lacks the legacy reader's own required fields.
    // Standing in for a corrupt base row that can never be repaired — one of
    // the two reasons (alongside a legacy base with no ids to diff against)
    // this bound must survive without stopping a friend pressing "Build
    // this".
    const v1Id = await seedCorruptSpec('devtwo')
    const v2Id = await seedVersionSpec('devtwo', v2)
    expect(v2Id).toBeGreaterThan(v1Id) // sanity: v1 really is version 1, the based-on target
    const res = await post({ specId: v2Id })
    expect(res.status).toBe(200)
    expect(alertBodies()).toHaveLength(1)
  })

  it('still confirms, with counts against a null base, when the based-on spec is legacy-shaped', async () => {
    // The brief's OTHER named condition, distinct from the corrupt-base test
    // above: "a legacy base (which has no ids to diff against)". This is not
    // a throw at all — readStoredSpec parses a legacy payload fine (kind
    // 'legacy'), and the route's own ternary
    // (`base?.kind === 'version' ? base.version : null`) already collapses
    // it to a null base before diffVersions ever runs. seedSpec's payload is
    // now a genuine, if minimal, legacy-shaped spec (see its own comment),
    // so it can stand in for this case directly instead of only the
    // corrupt-and-unparseable one above, which the try/catch actually
    // catches.
    const v1Id = await seedSpec('devtwo')
    const v2Id = await seedVersionSpec('devtwo', v2)
    expect(v2Id).toBeGreaterThan(v1Id) // sanity: v1 really is version 1, the based-on target
    const res = await post({ specId: v2Id })
    expect(res.status).toBe(200)
    expect(alertBodies()).toHaveLength(1)
    // Same shape as "counts every panel as added for a first confirmed
    // version": a legacy base has no ids to diff against, so both of v2's
    // panels read as added, not as changes against panels a legacy payload
    // cannot express.
    expect(lastMetric('spec_confirmed').data).toMatchObject({
      spec_id: v2Id,
      version: 2,
      panels_added: 2,
      panels_changed: 0,
      panels_removed: 0,
    })
  })
})
