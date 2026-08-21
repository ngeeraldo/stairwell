// tests/plaid/refreshRoute.test.ts
//
// The refresh route on the ENCRYPTED path, with the Plaid client stubbed and
// lib/plaid/sync.ts doing REAL writes into a real SQLCipher database. Nothing
// here reaches the network.
//
// Mocking the client rather than the sync layer is deliberate: the interesting
// behaviour is what ends up in the tables and in plaid_refreshes, and a test
// that stubbed the writers would assert that the route called functions rather
// than that a friend's data arrived.
//
// The harness is duplicated from tests/plaid/connectRoutes.test.ts rather than
// shared, following tests/routing/*Route.test.ts — CLAUDE.md is explicit that
// the four ordered checks are not to be abstracted, and a shared harness is
// the first step toward abstracting them.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformDb } from '@/lib/db/platform'
import { setNodeEnv } from '@/tests/support/nodeEnv'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => ({ get: () => null }),
}))

const loaderSlot: { value: unknown } = { value: undefined }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => loaderSlot.value,
  registeredSlugs: () => ['devtwo'],
}))

const canSeeUserSpaceSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>('@/lib/auth/authorize')
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  return { ...actual, canSeeUserSpace: canSeeUserSpaceSpy }
})

const syncTransactionsSpy = vi.fn()
const getAccountsSpy = vi.fn()
const getHoldingsSpy = vi.fn()
const getRecurringSpy = vi.fn()
const getInvestmentTransactionsSpy = vi.fn()
vi.mock('@/lib/plaid/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plaid/client')>('@/lib/plaid/client')
  return {
    ...actual,
    plaidApiFromEnv: () => ({ __stub: true }),
    syncTransactions: syncTransactionsSpy,
    getAccounts: getAccountsSpy,
    getHoldings: getHoldingsSpy,
    getRecurring: getRecurringSpy,
    getInvestmentTransactions: getInvestmentTransactionsSpy,
  }
})

const SCHEMA = readFileSync(
  resolve(__dirname, '..', '..', 'modules', 'plaid', 'initial.sql'),
  'utf8',
)

let dir: string
let handle: PlatformDb | undefined
let originalEnv: string | undefined
const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-refresh-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')

  mkdirSync(join(dir, 'users', 'devtwo', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'users', 'devtwo', 'migrations', '001_module_plaid_initial.sql'), SCHEMA)
  writeFileSync(
    join(dir, 'users', 'devtwo', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: [{ number: 1, sha256: createHash('sha256').update(SCHEMA).digest('hex') }],
    }),
  )

  vi.resetModules()
  // mockCLEAR, not mockReset, for the delegating spies: mockReset strips the
  // implementation the vi.mock factory installed, so canSeeUserSpace would
  // return undefined and every request would 404 for the wrong reason.
  cookieGet.mockClear()
  canSeeUserSpaceSpy.mockClear()
  // mockRESET for the Plaid spies, which get fresh implementations below —
  // a leftover mockRejectedValue from one test is exactly the kind of thing
  // that makes the next one fail somewhere unrelated.
  for (const spy of [
    syncTransactionsSpy,
    getAccountsSpy,
    getHoldingsSpy,
    getRecurringSpy,
    getInvestmentTransactionsSpy,
  ]) {
    spy.mockReset()
  }
  // Defaults: everything answers, emptily.
  syncTransactionsSpy.mockResolvedValue({
    added: [],
    modified: [],
    removed: [],
    nextCursor: 'c1',
    hasMore: false,
  })
  getAccountsSpy.mockResolvedValue([])
  getHoldingsSpy.mockResolvedValue({ accounts: [], holdings: [], securities: [] })
  getRecurringSpy.mockResolvedValue({ inflow: [], outflow: [] })
  getInvestmentTransactionsSpy.mockResolvedValue({
    transactions: [],
    securities: [],
    truncated: false,
  })

  cookieSlot.value = undefined
  loaderSlot.value = async () => ({ default: () => null })
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  delete process.env.USERS_DIR
  setNodeEnv(originalEnv)
  rmSync(dir, { recursive: true, force: true })
})

async function arrange(opts: { lock?: boolean } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  const accountId = await createAccount(handle, { slug: 'devtwo', role: 'user', password: 'pw' })
  const sid = createSession(handle, accountId)
  if (!opts.lock) {
    putKey(sid, KEY)
    const { migrateUserDb } = await import('@/lib/db/migrate')
    migrateUserDb('devtwo', KEY)
  }
  cookieSlot.value = { value: sid }
  return { accountId }
}

const refresh = async () => (await import('@/app/api/users/[user]/plaid/refresh/route')).POST
const params = (user = 'devtwo') => ({ params: Promise.resolve({ user }) })
const post = (fields: Record<string, string> = {}) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return new Request('http://internal/x', { method: 'POST', body: form })
}

async function openUserDb(write = false) {
  const { openEncryptedUserDb } = await import('@/lib/db/encryptedUserDb')
  return openEncryptedUserDb('devtwo', KEY, write ? {} : { readonly: true })
}

/** A connected item advertising the given capabilities. */
async function connect(available: string[]) {
  const db = await openUserDb(true)
  db.prepare(
    `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
     VALUES ('item_1', 'token', ?, 1)`,
  ).run(JSON.stringify(available))
  db.close()
}

const refreshRows = async () => {
  const db = await openUserDb()
  const rows = db
    .prepare('SELECT product, ok, code FROM plaid_refreshes ORDER BY product')
    .all() as { product: string; ok: number; code: string | null }[]
  db.close()
  return rows
}

describe('the four ordered checks', () => {
  it('refuses a locked session before check 2 is reached', async () => {
    await arrange({ lock: true })
    expect((await (await refresh())(post(), params())).status).toBe(403)
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
  })

  it('answers 404, never 403, for another account’s space', async () => {
    await arrange()
    expect((await (await refresh())(post(), params('someoneelse'))).status).toBe(404)
  })

  it('answers 404 for a slug with no registered dashboard', async () => {
    await arrange()
    loaderSlot.value = undefined
    expect((await (await refresh())(post(), params())).status).toBe(404)
  })
})

describe('with no bank connected', () => {
  it('is a no-op, not an error — it is the state every friend starts in', async () => {
    await arrange()
    const response = await (await refresh())(post(), params())

    expect(response.status).toBeLessThan(400)
    expect(syncTransactionsSpy).not.toHaveBeenCalled()
    expect(await refreshRows()).toEqual([])
  })
})

describe('which products get called', () => {
  it('skips investments entirely for a card-only connection', async () => {
    // A friend with one credit card should never pay the latency of a call
    // their connection cannot answer.
    await arrange()
    await connect(['transactions_refresh'])

    await (await refresh())(post(), params())

    expect(syncTransactionsSpy).toHaveBeenCalled()
    expect(getAccountsSpy).toHaveBeenCalled()
    expect(getHoldingsSpy).not.toHaveBeenCalled()
    expect(getInvestmentTransactionsSpy).not.toHaveBeenCalled()
    expect(getRecurringSpy).not.toHaveBeenCalled()
  })

  it('calls everything a full connection supports', async () => {
    await arrange()
    await connect(['investments', 'recurring_transactions'])

    await (await refresh())(post(), params())

    expect(getHoldingsSpy).toHaveBeenCalled()
    expect(getRecurringSpy).toHaveBeenCalled()
    expect(getInvestmentTransactionsSpy).toHaveBeenCalled()
  })

  it('lets a caller NARROW the set', async () => {
    await arrange()
    await connect(['investments', 'recurring_transactions'])

    await (await refresh())(post({ products: 'transactions,accounts' }), params())

    expect(syncTransactionsSpy).toHaveBeenCalled()
    expect(getHoldingsSpy).not.toHaveBeenCalled()
  })

  it('does NOT let a caller widen past what the connection can serve', async () => {
    // The intersection happens server-side. A caller naming a product the item
    // cannot answer would otherwise turn this route into a way to spend money
    // on calls that are guaranteed to fail.
    await arrange()
    await connect([])

    await (await refresh())(post({ products: 'holdings,investment_transactions' }), params())

    expect(getHoldingsSpy).not.toHaveBeenCalled()
    expect(getInvestmentTransactionsSpy).not.toHaveBeenCalled()
  })

  it('never calls the two per-call billed refresh endpoints', async () => {
    // /transactions/refresh and /investments/refresh are fire-and-forget: they
    // return before the bank has finished, so calling them then syncing costs
    // ~4 seconds for zero additional data.
    const actual = await import('@/lib/plaid/client')
    await arrange()
    await connect(['investments'])

    await (await refresh())(post(), params())

    expect(Object.keys(actual)).toContain('requestTransactionsRefresh')
    // Nothing in the route imports it; asserted through the module, since a
    // spy on an uncalled function proves nothing on its own.
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'app', 'api', 'users', '[user]', 'plaid', 'refresh', 'route.ts'),
      'utf8',
    )
    expect(source).not.toContain('requestTransactionsRefresh')
    expect(source).not.toContain('investmentsRefresh')
  })
})

describe('partial failure is the normal case', () => {
  it('keeps the transactions when investments fails', async () => {
    // One bank being slow with investments must not discard rows that already
    // landed. The friend pressing Refresh again would only re-fetch what they
    // already have.
    const { PlaidCallError } = await import('@/lib/plaid/client')
    await arrange()
    await connect(['investments'])
    syncTransactionsSpy.mockResolvedValue({
      added: [{ transaction_id: 't1', account_id: 'a1', date: '2026-08-01' }],
      modified: [],
      removed: [],
      nextCursor: 'c1',
      hasMore: false,
    })
    getHoldingsSpy.mockRejectedValue(new PlaidCallError('http'))

    const response = await (await refresh())(post(), params())

    expect(response.status).toBeLessThan(400)
    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as any).n).toBe(1)
    db.close()
  })

  it('records a row per product, successes and failures alike', async () => {
    const { PlaidCallError } = await import('@/lib/plaid/client')
    await arrange()
    await connect(['investments'])
    getHoldingsSpy.mockRejectedValue(new PlaidCallError('item_login_required'))

    await (await refresh())(post(), params())

    const rows = await refreshRows()
    expect(rows).toContainEqual({ product: 'transactions', ok: 1, code: null })
    expect(rows).toContainEqual({ product: 'holdings', ok: 0, code: 'item_login_required' })
  })

  it('records recurring not-ready as its own outcome, neither success nor failure', async () => {
    // Routine on the first refresh after connecting: Plaid has the connection
    // and has not finished preparing the product. Reporting "couldn't reach
    // your bank" then would be wrong in a way the friend can see.
    await arrange()
    await connect(['recurring_transactions'])
    getRecurringSpy.mockResolvedValue('notReady')

    await (await refresh())(post(), params())

    expect(await refreshRows()).toContainEqual({
      product: 'recurring',
      ok: 0,
      code: 'not_ready',
    })
  })

  it('answers 502 only when EVERY product failed', async () => {
    const { PlaidCallError } = await import('@/lib/plaid/client')
    await arrange()
    await connect([])
    syncTransactionsSpy.mockRejectedValue(new PlaidCallError('network'))
    getAccountsSpy.mockRejectedValue(new PlaidCallError('network'))

    expect((await (await refresh())(post(), params())).status).toBe(502)

    // And the rows are still written, so the panel can say what happened.
    expect(await refreshRows()).toHaveLength(2)
  })
})

describe('the metric', () => {
  it('carries a slug and a panel, and never a count or a balance', async () => {
    await arrange()
    await connect(['investments'])
    syncTransactionsSpy.mockResolvedValue({
      added: [
        { transaction_id: 't1', account_id: 'a1', date: '2026-08-01', amount: 1234.56 },
      ],
      modified: [],
      removed: [],
      nextCursor: 'c1',
      hasMore: false,
    })

    await (await refresh())(post(), params())

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .all() as { data: string }[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.data)).toMatchObject({ slug: 'devtwo', panel: 'plaid_refresh' })
    // Permanent policy.
    expect(rows[0]!.data).not.toContain('1234')
    expect(rows[0]!.data).not.toContain('t1')
  })
})
