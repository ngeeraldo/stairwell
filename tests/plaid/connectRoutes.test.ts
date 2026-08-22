// tests/plaid/connectRoutes.test.ts
//
// The three connection-lifecycle routes, on the ENCRYPTED path.
//
// Modelled on tests/routing/walkRoute.test.ts, including its reason for
// forcing NODE_ENV=production: lib/db/userData.ts sends dev writes to
// synthetic.db, so without this these tests would quietly exercise a different
// database than the one they describe.
//
// Every Plaid call is mocked. Nothing here reaches the network — that is what
// tests/plaid/client.live.test.ts is for, and CLAUDE.md > Testing forbids the
// default suite from doing it.
//
// TWO THINGS THIS SUITE EXISTS TO PROVE, beyond the usual:
//
//   1. The four ordered checks, in order. The lock test asserts that
//      canSeeUserSpace (check 2) is never reached, because a route that opened
//      the database and refused afterwards would look identical from the
//      outside on status alone.
//   2. THE ACCESS TOKEN NEVER LEAVES. It is a bearer credential for a real
//      bank account, so its absence from every response body is asserted
//      directly rather than assumed from reading the route.
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

// The Plaid boundary. plaidApiFromEnv returns a marker rather than a real
// client, so a route that somehow reached the network would fail loudly.
const createLinkTokenSpy = vi.fn()
const exchangePublicTokenSpy = vi.fn()
const getItemSpy = vi.fn()
const getAccountsSpy = vi.fn()
const removeItemSpy = vi.fn()
vi.mock('@/lib/plaid/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plaid/client')>('@/lib/plaid/client')
  return {
    ...actual,
    plaidApiFromEnv: () => ({ __stub: true }),
    createLinkToken: createLinkTokenSpy,
    exchangePublicToken: exchangePublicTokenSpy,
    getItem: getItemSpy,
    getAccounts: getAccountsSpy,
    removeItem: removeItemSpy,
  }
})

/** The real shared envelope, so these tests break if it stops holding a token. */
const moduleSql = (name: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'modules', 'plaid', name), 'utf8')

/** The module's migrations, as a friend's folder vendors them. */
const MODULE_MIGRATIONS = [
  { number: 1, file: '001_module_plaid_initial.sql', sql: moduleSql('initial.sql') },
  { number: 2, file: '002_module_plaid_multi_source.sql', sql: moduleSql('002_multi_source.sql') },
]

/** A value that must never appear in a response body. */
const ACCESS_TOKEN = 'access-sandbox-SECRET-DO-NOT-LEAK'

let dir: string
let handle: PlatformDb | undefined
let originalEnv: string | undefined
const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-plaid-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')

  mkdirSync(join(dir, 'users', 'devtwo', 'migrations'), { recursive: true })
  for (const m of MODULE_MIGRATIONS) {
    writeFileSync(join(dir, 'users', 'devtwo', 'migrations', m.file), m.sql)
  }
  writeFileSync(
    join(dir, 'users', 'devtwo', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: MODULE_MIGRATIONS.map((m) => ({
        number: m.number,
        sha256: createHash('sha256').update(m.sql).digest('hex'),
      })),
    }),
  )

  vi.resetModules()
  for (const spy of [
    cookieGet,
    canSeeUserSpaceSpy,
    createLinkTokenSpy,
    exchangePublicTokenSpy,
    getItemSpy,
    getAccountsSpy,
    removeItemSpy,
  ]) {
    spy.mockClear()
  }
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

async function arrange(opts: { lock?: boolean; slug?: string } = {}) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  const accountId = await createAccount(handle, {
    slug: opts.slug ?? 'devtwo',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) {
    putKey(sid, KEY)
    const { migrateUserDb } = await import('@/lib/db/migrate')
    migrateUserDb(opts.slug ?? 'devtwo', KEY)
  }
  cookieSlot.value = { value: sid }
  return { accountId }
}

const linkToken = async () =>
  (await import('@/app/api/users/[user]/plaid/link-token/route')).POST
const connect = async () => (await import('@/app/api/users/[user]/plaid/connect/route')).POST
const disconnect = async () =>
  (await import('@/app/api/users/[user]/plaid/disconnect/route')).POST

const params = (user = 'devtwo') => ({ params: Promise.resolve({ user }) })
const post = (body?: Record<string, string>) => {
  if (!body) return new Request('http://internal/x', { method: 'POST' })
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) form.set(k, v)
  return new Request('http://internal/x', { method: 'POST', body: form })
}

/**
 * Open the friend's encrypted database the way a later session would.
 *
 * Read-only by default, which is how an assertion should look at it. The
 * `write` flag is only for arranging a starting state — no route under test
 * ever gets a handle from here.
 */
async function openUserDb(slug = 'devtwo', write = false) {
  const { openEncryptedUserDb } = await import('@/lib/db/encryptedUserDb')
  return openEncryptedUserDb(slug, KEY, write ? {} : { readonly: true })
}

/** Put a connected bank in the friend's own database, as a connect would have. */
async function seedItem(opts: {
  itemId: string
  accessToken?: string
  institutionId?: string
  institutionName?: string
  availableProducts?: string[]
  connectedAt?: number
  disconnectedAt?: number | null
  slug?: string
}) {
  const db = await openUserDb(opts.slug ?? 'devtwo', true)
  db.prepare(
    `INSERT INTO plaid_items
       (item_id, access_token, institution_id, institution_name, available_products,
        connected_at, disconnected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.itemId,
    opts.accessToken ?? ACCESS_TOKEN,
    opts.institutionId ?? null,
    opts.institutionName ?? null,
    JSON.stringify(opts.availableProducts ?? []),
    opts.connectedAt ?? 1,
    opts.disconnectedAt ?? null,
  )
  db.close()
}

/** An account with a row in every table a removal has to reach. */
async function seedAccountWithData(itemId: string, accountId: string, slug = 'devtwo') {
  const db = await openUserDb(slug, true)
  db.prepare('INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)').run(
    accountId,
    itemId,
    '{}',
  )
  db.prepare(
    `INSERT INTO plaid_transactions (transaction_id, account_id, item_id, date, payload)
     VALUES (?, ?, ?, '2026-08-01', ?)`,
  ).run(`txn_${accountId}`, accountId, itemId, JSON.stringify({ merchant_name: 'COFFEE PALACE TEST' }))
  db.prepare(
    'INSERT INTO plaid_holdings (account_id, security_id, item_id, payload) VALUES (?, ?, ?, ?)',
  ).run(accountId, `sec_${accountId}`, itemId, '{}')
  db.prepare(
    `INSERT INTO plaid_recurring_streams (stream_id, account_id, item_id, direction, payload)
     VALUES (?, ?, ?, 'outflow', '{}')`,
  ).run(`stream_${accountId}`, accountId, itemId)
  db.prepare(
    `INSERT INTO plaid_investment_transactions
       (investment_transaction_id, account_id, item_id, security_id, date, payload)
     VALUES (?, ?, ?, NULL, '2026-08-01', '{}')`,
  ).run(`inv_${accountId}`, accountId, itemId)
  db.close()
}

describe('the four ordered checks, on all three routes', () => {
  it('refuses a LOCKED session before check 2 is ever reached', async () => {
    await arrange({ lock: true })
    for (const route of [await linkToken(), await connect(), await disconnect()]) {
      const response = await route(post({ public_token: 'p' }), params())
      expect(response.status).toBe(403)
    }
    // A route that opened the database and refused afterwards would look
    // identical on status alone. This is what separates them.
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
  })

  it('answers 404, never 403, for another account’s space', async () => {
    await arrange({ slug: 'devtwo' })
    for (const route of [await linkToken(), await connect(), await disconnect()]) {
      // 404 so the response cannot confirm that another account exists.
      expect((await route(post({ public_token: 'p' }), params('someoneelse'))).status).toBe(404)
    }
  })

  it('answers 404 for a slug with no registered dashboard', async () => {
    await arrange()
    loaderSlot.value = undefined
    for (const route of [await linkToken(), await connect(), await disconnect()]) {
      expect((await route(post({ public_token: 'p' }), params())).status).toBe(404)
    }
  })
})

describe('link-token mints for the connection the caller names', () => {
  it('asks for products when the friend has no connection yet', async () => {
    await arrange()
    createLinkTokenSpy.mockResolvedValue('link-sandbox-new')

    const response = await (await linkToken())(post(), params())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ link_token: 'link-sandbox-new', mode: 'new' })
    const opts = createLinkTokenSpy.mock.calls[0]![1]
    // INVESTMENTS IS NOT HERE ON PURPOSE. Plaid Link only lists institutions
    // supporting every product in `products`, and 53% of Sandbox's OAuth banks
    // support transactions but not investments — asking for it hid all of them
    // from the picker with no error.
    expect(opts.products).toEqual(['transactions'])
    expect(opts.additionalConsentedProducts).toEqual(['investments'])
    expect(opts.accessToken).toBeUndefined()
  })

  it('NEVER asks for recurring_transactions, which Plaid rejects outright', async () => {
    // Plaid: "some products cannot be included in initial_products". Adding it
    // here does not degrade a feature — it breaks connecting entirely.
    await arrange()
    createLinkTokenSpy.mockResolvedValue('t')
    await (await linkToken())(post(), params())
    const opts = createLinkTokenSpy.mock.calls[0]![1]
    expect(opts.products).not.toContain('recurring_transactions')
    expect(opts.additionalConsentedProducts).not.toContain('recurring_transactions')
  })

  it('switches to update mode for the item the caller names — the only repair for a dead bank', async () => {
    await arrange()
    await seedItem({ itemId: 'item_1', accessToken: ACCESS_TOKEN })
    createLinkTokenSpy.mockResolvedValue('link-sandbox-update')

    const response = await (await linkToken())(post({ item_id: 'item_1' }), params())

    expect(await response.json()).toMatchObject({ mode: 'update' })
    const opts = createLinkTokenSpy.mock.calls[0]![1]
    expect(opts.accessToken).toBe(ACCESS_TOKEN)
    // Plaid rejects the pair, so sending products here would make re-auth
    // impossible for a friend whose bank expired.
    expect(opts.products).toBeUndefined()
  })

  it('opens the institution picker for a friend who ALREADY has a bank', async () => {
    // THE BUG THAT STARTED THIS PLAN. This route used to switch to update mode
    // whenever any plaid_items row existed, so the moment a friend connected
    // one bank, "connect another" became impossible — the picker never opened
    // again and Plaid reopened the bank they already had.
    await arrange()
    await seedItem({ itemId: 'item_1', accessToken: ACCESS_TOKEN })
    createLinkTokenSpy.mockResolvedValue('link-sandbox-new')

    const response = await (await linkToken())(post(), params())

    expect(await response.json()).toMatchObject({ mode: 'new' })
    const opts = createLinkTokenSpy.mock.calls[0]![1]
    expect(opts.accessToken).toBeUndefined()
    expect(opts.products).toEqual(['transactions'])
  })

  it('asks Plaid for the account picker when the friend is managing accounts', async () => {
    // How a friend adds their SECOND account at a bank they already connected.
    // Which accounts a bank shares is chosen inside Plaid's own UI, so this is
    // the only place that choice can be reopened.
    await arrange()
    await seedItem({ itemId: 'item_1', accessToken: ACCESS_TOKEN })
    createLinkTokenSpy.mockResolvedValue('link-sandbox-accounts')

    const response = await (await linkToken())(
      post({ item_id: 'item_1', manage_accounts: '1' }),
      params(),
    )

    expect(await response.json()).toMatchObject({ mode: 'accounts' })
    const opts = createLinkTokenSpy.mock.calls[0]![1]
    expect(opts.accessToken).toBe(ACCESS_TOKEN)
    expect(opts.accountSelection).toBe(true)
  })

  it('refuses an item_id that is not this friend’s, without calling Plaid', async () => {
    // The caller names an item now, so the caller can name someone else's. The
    // check is a lookup inside the friend's OWN database — an item id that is
    // not in there cannot be minted against, and Plaid is never asked.
    await arrange()
    await seedItem({ itemId: 'item_1', accessToken: ACCESS_TOKEN })

    const response = await (await linkToken())(post({ item_id: 'item_someone_else' }), params())

    expect(response.status).toBe(404)
    expect(createLinkTokenSpy).not.toHaveBeenCalled()
  })

  it('refuses to repair a connection the friend already disconnected', async () => {
    // Disconnecting revokes the token at Plaid. Minting an update-mode token
    // against a revoked credential can only produce a Plaid error, and offering
    // it would tell the friend a dead connection is repairable.
    await arrange()
    await seedItem({ itemId: 'item_1', accessToken: ACCESS_TOKEN, disconnectedAt: 99 })

    const response = await (await linkToken())(post({ item_id: 'item_1' }), params())

    expect(response.status).toBe(404)
    expect(createLinkTokenSpy).not.toHaveBeenCalled()
  })

  it('sends Plaid an opaque account id, never the friend’s slug', async () => {
    const { accountId } = await arrange()
    createLinkTokenSpy.mockResolvedValue('t')
    await (await linkToken())(post(), params())
    expect(createLinkTokenSpy.mock.calls[0]![1].clientUserId).toBe(String(accountId))
    expect(createLinkTokenSpy.mock.calls[0]![1].clientUserId).not.toBe('devtwo')
  })

  it('answers 502 with no body when Plaid fails', async () => {
    await arrange()
    const { PlaidCallError } = await import('@/lib/plaid/client')
    createLinkTokenSpy.mockRejectedValue(new PlaidCallError('http'))

    const response = await (await linkToken())(post(), params())

    expect(response.status).toBe(502)
    expect(await response.text()).toBe('')
  })
})

describe('connect stores the token and never shows it to anyone', () => {
  beforeEach(() => {
    exchangePublicTokenSpy.mockResolvedValue({ accessToken: ACCESS_TOKEN, itemId: 'item_9' })
    getItemSpy.mockResolvedValue({
      itemId: 'item_9',
      institutionId: 'ins_109508',
      institutionName: 'First Platypus Bank',
      availableProducts: ['balance', 'recurring_transactions'],
    })
  })

  it('writes exactly one plaid_items row, with what the item can serve', async () => {
    await arrange()

    const response = await (await connect())(post({ public_token: 'public-sandbox-1' }), params())
    expect(response.status).toBeLessThan(400)

    const db = await openUserDb()
    const rows = db.prepare('SELECT * FROM plaid_items').all() as any[]
    db.close()

    expect(rows).toHaveLength(1)
    expect(rows[0].item_id).toBe('item_9')
    expect(rows[0].access_token).toBe(ACCESS_TOKEN)
    expect(rows[0].institution_id).toBe('ins_109508')
    expect(JSON.parse(rows[0].available_products)).toEqual(['balance', 'recurring_transactions'])
    // No cursor yet: nothing has been synced.
    expect(rows[0].cursor).toBeNull()
  })

  it('stores the institution NAME, because ins_109508 is not a name', async () => {
    // The friend has to be able to tell two banks apart before any control
    // over one of them means anything. It rides in on the /item/get the route
    // already makes, so this costs no additional Plaid call.
    await arrange()
    await (await connect())(post({ public_token: 'public-sandbox-1' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT institution_name FROM plaid_items').get() as any
    db.close()

    expect(row.institution_name).toBe('First Platypus Bank')
  })

  it('stores no institution name rather than an empty one when Plaid omits it', async () => {
    // NULL is a fallback a panel can act on. '' renders as a bank with no
    // name, which looks like a bug in the connection rather than a missing
    // field.
    await arrange()
    getItemSpy.mockResolvedValue({ itemId: 'item_9', availableProducts: [] })
    await (await connect())(post({ public_token: 'public-sandbox-1' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT institution_name FROM plaid_items').get() as any
    db.close()

    expect(row.institution_name).toBeNull()
  })

  it('APPENDS, so a friend can connect a second bank', async () => {
    // THE DATA-CORRUPTION PATH THIS PLAN EXISTS TO CLOSE. This route used to
    // DELETE FROM plaid_items before inserting, so a second connection
    // silently replaced the first — and because disconnecting deliberately
    // keeps synced rows, the replaced bank's transactions survived with no
    // item that could ever refresh them. Permanently frozen, and
    // indistinguishable on screen from live data.
    await arrange()
    await (await connect())(post({ public_token: 'p1' }), params())
    exchangePublicTokenSpy.mockResolvedValue({ accessToken: 'second', itemId: 'item_10' })
    getItemSpy.mockResolvedValue({ itemId: 'item_10', availableProducts: [] })
    await (await connect())(post({ public_token: 'p2' }), params())

    const db = await openUserDb()
    const rows = db.prepare('SELECT item_id FROM plaid_items ORDER BY item_id').all() as any[]
    db.close()
    expect(rows).toEqual([{ item_id: 'item_10' }, { item_id: 'item_9' }])
  })

  it('updates the row in place when the SAME bank comes back', async () => {
    // Update mode returns the item the friend already has. Inserting a second
    // row for it would give them two entries they cannot tell apart, for one
    // bank.
    await arrange()
    await (await connect())(post({ public_token: 'p1' }), params())
    exchangePublicTokenSpy.mockResolvedValue({ accessToken: 'rotated', itemId: 'item_9' })
    getItemSpy.mockResolvedValue({
      itemId: 'item_9',
      institutionName: 'First Platypus Bank',
      availableProducts: ['investments'],
    })

    await (await connect())(post({ public_token: 'p2' }), params())

    const db = await openUserDb()
    const rows = db.prepare('SELECT item_id, access_token, available_products FROM plaid_items').all() as any[]
    db.close()
    expect(rows).toHaveLength(1)
    expect(rows[0].access_token).toBe('rotated')
    expect(JSON.parse(rows[0].available_products)).toEqual(['investments'])
  })

  it('brings a disconnected bank back to life when it is reconnected', async () => {
    // A row that still said disconnected_at would keep every panel saying "no
    // longer updating" about a connection that is now live — and the refresh
    // loop skips disconnected items, so it would never update again.
    await arrange()
    await seedItem({ itemId: 'item_9', disconnectedAt: 5 })

    await (await connect())(post({ public_token: 'p1' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT disconnected_at FROM plaid_items WHERE item_id = ?').get('item_9') as any
    db.close()
    expect(row.disconnected_at).toBeNull()
  })

  it('DELETES NOTHING when the friend unticks an account in the picker', async () => {
    // THE PICKER ONLY EVER ADDS (Nico's ruling, 2026-08-22), and the reason is
    // a measured fact about Plaid's UI rather than a preference: the account
    // picker opens with NOTHING TICKED. It looks like a fresh start, not like
    // the friend's current selection.
    //
    // So a friend who opens it to ADD one account, ticks that one and
    // submits has — from this route's point of view — just deselected
    // everything else. The earlier version of this code deleted all of it:
    // years of history, permanently, unrecoverable by anyone including Nico,
    // from a button labelled "Choose accounts".
    //
    // Nothing here deletes. An account the bank stops sharing simply stops
    // being shared: the next refresh drops its row from plaid_accounts (a
    // deselected account and a CLOSED one are indistinguishable from
    // /accounts/get, and a closed one must leave the screen), its data stays,
    // and re-ticking it in the picker brings the whole thing straight back.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_keep')
    await seedAccountWithData('item_9', 'acc_drop')
    getAccountsSpy.mockResolvedValue([{ account_id: 'acc_keep' }])

    await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    const db = await openUserDb()
    const accounts = db.prepare('SELECT account_id FROM plaid_accounts ORDER BY account_id').all()
    const transactions = db.prepare('SELECT account_id FROM plaid_transactions ORDER BY account_id').all()
    const holdings = db.prepare('SELECT account_id FROM plaid_holdings ORDER BY account_id').all()
    db.close()

    expect(accounts).toEqual([{ account_id: 'acc_drop' }, { account_id: 'acc_keep' }])
    expect(transactions).toEqual([{ account_id: 'acc_drop' }, { account_id: 'acc_keep' }])
    expect(holdings).toEqual([{ account_id: 'acc_drop' }, { account_id: 'acc_keep' }])
  })

  it('re-adding an account the friend already had changes nothing', async () => {
    // Every table is keyed and upserts, so a re-select is a no-op rather than
    // a duplicate. Measured end to end against Sandbox too: a cursor reset
    // re-pulled a full window over 18 existing transactions and the total went
    // to 24, not 36.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_keep')
    getAccountsSpy.mockResolvedValue([{ account_id: 'acc_keep' }])

    await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    const db = await openUserDb()
    const counts = {
      accounts: (db.prepare('SELECT COUNT(*) n FROM plaid_accounts').get() as any).n,
      transactions: (db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as any).n,
      holdings: (db.prepare('SELECT COUNT(*) n FROM plaid_holdings').get() as any).n,
    }
    db.close()
    expect(counts).toEqual({ accounts: 1, transactions: 1, holdings: 1 })
  })

  it('leaves the friend’s OTHER bank untouched by the picker', async () => {
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedItem({ itemId: 'item_other', connectedAt: 2 })
    await seedAccountWithData('item_9', 'acc_drop')
    await seedAccountWithData('item_other', 'acc_other')
    getAccountsSpy.mockResolvedValue([{ account_id: 'acc_new' }])

    await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    const db = await openUserDb()
    const accounts = db.prepare('SELECT account_id FROM plaid_accounts ORDER BY account_id').all()
    db.close()
    expect(accounts).toEqual([{ account_id: 'acc_drop' }, { account_id: 'acc_other' }])
  })

  it('clears the cursor when an account is ADDED, so its history can arrive', async () => {
    // MEASURED AGAINST SANDBOX, not reasoned about. A friend added two
    // accounts at a bank they already had; /transactions/sync reported ok on
    // every refresh afterwards and returned nothing, because the stored cursor
    // had already passed everything Plaid was willing to re-send. Those
    // accounts sat empty and no amount of pressing Refresh would have fixed
    // it. Clearing the cursor is what makes the next sync re-pull the window.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_old')
    const seeded = await openUserDb('devtwo', true)
    seeded.prepare("UPDATE plaid_items SET cursor = 'far-ahead' WHERE item_id = 'item_9'").run()
    seeded.close()
    getAccountsSpy.mockResolvedValue([{ account_id: 'acc_old' }, { account_id: 'acc_new' }])

    await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT cursor FROM plaid_items WHERE item_id = ?').get('item_9') as any
    db.close()
    expect(row.cursor).toBeNull()
  })

  it('leaves the cursor alone when accounts were only REMOVED', async () => {
    // Nothing new can arrive, so re-pulling the whole window would be a slow
    // no-op on the next refresh — and the friend is waiting on that press.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_keep')
    await seedAccountWithData('item_9', 'acc_drop')
    const seeded = await openUserDb('devtwo', true)
    seeded.prepare("UPDATE plaid_items SET cursor = 'keep-me' WHERE item_id = 'item_9'").run()
    seeded.close()
    getAccountsSpy.mockResolvedValue([{ account_id: 'acc_keep' }])

    await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT cursor FROM plaid_items WHERE item_id = ?').get('item_9') as any
    db.close()
    expect(row.cursor).toBe('keep-me')
  })

  it('leaves the cursor alone on an ordinary reconnect', async () => {
    // A repair changes nothing about which accounts are shared, so there is
    // nothing new to fetch — and re-pulling a friend's whole history every
    // time their bank asks them to log in again would be a slow surprise.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    const seeded = await openUserDb('devtwo', true)
    seeded.prepare("UPDATE plaid_items SET cursor = 'keep-me' WHERE item_id = 'item_9'").run()
    seeded.close()

    await (await connect())(post({ public_token: 'p1' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT cursor FROM plaid_items WHERE item_id = ?').get('item_9') as any
    db.close()
    expect(row.cursor).toBe('keep-me')
  })

  it('does not clear the cursor of the friend’s OTHER bank', async () => {
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedItem({ itemId: 'item_other', connectedAt: 2 })
    await seedAccountWithData('item_other', 'acc_other')
    const seeded = await openUserDb('devtwo', true)
    seeded.prepare("UPDATE plaid_items SET cursor = 'others-place'  WHERE item_id = 'item_other'").run()
    seeded.close()
    getAccountsSpy.mockResolvedValue([{ account_id: 'acc_new' }])

    await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    const db = await openUserDb()
    const row = db
      .prepare('SELECT cursor FROM plaid_items WHERE item_id = ?')
      .get('item_other') as any
    db.close()
    expect(row.cursor).toBe('others-place')
  })

  it('still connects when the account check itself fails', async () => {
    // The connection is the thing the friend asked for. Failing the whole
    // press because a follow-up call did not answer would leave them with a
    // bank Plaid has and this app does not.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_keep')
    const { PlaidCallError } = await import('@/lib/plaid/client')
    getAccountsSpy.mockRejectedValue(new PlaidCallError('timeout'))

    const response = await (await connect())(post({ public_token: 'p1', manage_accounts: '1' }), params())

    expect(response.status).toBeLessThan(400)
    const db = await openUserDb()
    expect(db.prepare('SELECT account_id FROM plaid_accounts').all()).toEqual([
      { account_id: 'acc_keep' },
    ])
    db.close()
  })

  it('puts the access token in NO response body', async () => {
    await arrange()
    const response = await (await connect())(post({ public_token: 'p' }), params())
    expect(await response.text()).not.toContain(ACCESS_TOKEN)
  })

  it('writes a metric carrying a slug and a panel, and nothing else', async () => {
    const { accountId } = await arrange()
    await (await connect())(post({ public_token: 'p' }), params())

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write'")
      .all() as { data: string }[]
    expect(rows).toHaveLength(1)
    const data = JSON.parse(rows[0]!.data)
    expect(data.slug).toBe('devtwo')
    expect(data.panel).toBe('plaid_connect')
    // Permanent policy: never an institution, an item id, or a count.
    expect(rows[0]!.data).not.toContain('ins_109508')
    expect(rows[0]!.data).not.toContain('item_9')
    expect(rows[0]!.data).not.toContain(ACCESS_TOKEN)
    expect(accountId).toBeGreaterThan(0)
  })

  it('refuses an empty public token before calling Plaid', async () => {
    await arrange()
    expect((await (await connect())(post({ public_token: '' }), params())).status).toBe(400)
    expect(exchangePublicTokenSpy).not.toHaveBeenCalled()
  })

  it('writes nothing when the exchange fails', async () => {
    await arrange()
    const { PlaidCallError } = await import('@/lib/plaid/client')
    exchangePublicTokenSpy.mockRejectedValue(new PlaidCallError('auth'))

    expect((await (await connect())(post({ public_token: 'p' }), params())).status).toBe(502)

    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_items').get() as any).n).toBe(0)
    db.close()
  })
})

describe('disconnect keeps the history and says it is no longer updating', () => {
  async function connected(itemId = 'item_9', token = ACCESS_TOKEN) {
    await seedItem({ itemId, accessToken: token })
    await seedAccountWithData(itemId, `acc_${itemId}`)
  }

  it('keeps the row, marks it disconnected, and revokes the item at Plaid', async () => {
    // A SOFT delete, and the reason is what the friend sees afterwards. This
    // route used to DELETE the plaid_items row while deliberately keeping the
    // synced data — which left history on screen with nothing to say it had
    // stopped updating, and no item that could ever refresh it. The row
    // surviving with disconnected_at set is what turns an orphan into a
    // stated fact.
    await arrange()
    await connected()
    removeItemSpy.mockResolvedValue(undefined)

    const response = await (await disconnect())(post({ item_id: 'item_9' }), params())
    expect(response.status).toBeLessThan(400)

    const db = await openUserDb()
    const row = db.prepare('SELECT item_id, disconnected_at FROM plaid_items').get() as any
    db.close()
    expect(row.item_id).toBe('item_9')
    expect(row.disconnected_at).toBeGreaterThan(0)
    expect(removeItemSpy).toHaveBeenCalledWith({ __stub: true }, ACCESS_TOKEN)
  })

  it('destroys the stored token, which is now dead anyway', async () => {
    // /item/remove makes the token useless, so keeping it stores a
    // credential-shaped string that authorises nothing. disconnected_at is
    // what records the state; the token has no second job.
    await arrange()
    await connected()
    removeItemSpy.mockResolvedValue(undefined)

    await (await disconnect())(post({ item_id: 'item_9' }), params())

    const db = await openUserDb()
    const row = db.prepare('SELECT access_token FROM plaid_items').get() as any
    db.close()
    expect(row.access_token).toBe('')
  })

  it('still destroys the local token when Plaid refuses', async () => {
    // The friend asked for the credential to be gone. Leaving a working bank
    // token in their database because a third party had a bad minute would be
    // the wrong way to fail.
    await arrange()
    await connected()
    const { PlaidCallError } = await import('@/lib/plaid/client')
    removeItemSpy.mockRejectedValue(new PlaidCallError('network'))

    const response = await (await disconnect())(post({ item_id: 'item_9' }), params())

    expect(response.status).toBeLessThan(400)
    const db = await openUserDb()
    const row = db.prepare('SELECT access_token, disconnected_at FROM plaid_items').get() as any
    db.close()
    expect(row.access_token).toBe('')
    expect(row.disconnected_at).toBeGreaterThan(0)
  })

  it('leaves the synced data alone — disconnecting is not deleting', async () => {
    // Dropping the synced rows would orphan every annotation a friend has
    // written against a transaction_id, as a side effect of a button that
    // says "disconnect".
    await arrange()
    await connected()
    removeItemSpy.mockResolvedValue(undefined)

    await (await disconnect())(post({ item_id: 'item_9' }), params())

    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as any).n).toBe(1)
    db.close()
  })

  it('touches only the bank it was asked about', async () => {
    await arrange()
    await connected('item_9')
    await connected('item_other', 'other-token')
    removeItemSpy.mockResolvedValue(undefined)

    await (await disconnect())(post({ item_id: 'item_9' }), params())

    const db = await openUserDb()
    const rows = db
      .prepare('SELECT item_id, disconnected_at FROM plaid_items ORDER BY item_id')
      .all() as any[]
    db.close()
    expect(rows.find((r) => r.item_id === 'item_other').disconnected_at).toBeNull()
    expect(removeItemSpy).toHaveBeenCalledTimes(1)
    expect(removeItemSpy).toHaveBeenCalledWith({ __stub: true }, ACCESS_TOKEN)
  })

  it('refuses without an item_id rather than guessing which bank', async () => {
    // It used to take the oldest row. With two banks that is a coin flip on a
    // destructive action, and the friend pressed a control next to ONE of
    // them.
    await arrange()
    await connected()

    const response = await (await disconnect())(post(), params())

    expect(response.status).toBe(400)
    expect(removeItemSpy).not.toHaveBeenCalled()
  })

  it('refuses an item_id that is not this friend’s, without calling Plaid', async () => {
    await arrange()
    await connected()

    const response = await (await disconnect())(post({ item_id: 'item_elsewhere' }), params())

    expect(response.status).toBe(404)
    expect(removeItemSpy).not.toHaveBeenCalled()
  })
})

describe('disconnect with action=remove deletes for real', () => {
  it('deletes the connection and every row it brought', async () => {
    // The louder action. "Delete this bank's data" has to mean all of it —
    // which is why every synced row carries the bank it came from, rather than
    // being reachable only by joining through an account that may since have
    // closed.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_9')
    removeItemSpy.mockResolvedValue(undefined)

    const response = await (await disconnect())(
      post({ item_id: 'item_9', action: 'remove' }),
      params(),
    )
    expect(response.status).toBeLessThan(400)

    const db = await openUserDb()
    const counts = Object.fromEntries(
      [
        'plaid_items',
        'plaid_accounts',
        'plaid_transactions',
        'plaid_holdings',
        'plaid_recurring_streams',
        'plaid_investment_transactions',
      ].map((t) => [t, (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n]),
    )
    db.close()
    expect(counts).toEqual({
      plaid_items: 0,
      plaid_accounts: 0,
      plaid_transactions: 0,
      plaid_holdings: 0,
      plaid_recurring_streams: 0,
      plaid_investment_transactions: 0,
    })
  })

  it('leaves the friend’s OTHER bank completely intact', async () => {
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedItem({ itemId: 'item_other', connectedAt: 2 })
    await seedAccountWithData('item_9', 'acc_9')
    await seedAccountWithData('item_other', 'acc_other')
    removeItemSpy.mockResolvedValue(undefined)

    await (await disconnect())(post({ item_id: 'item_9', action: 'remove' }), params())

    const db = await openUserDb()
    const items = db.prepare('SELECT item_id FROM plaid_items').all()
    const accounts = db.prepare('SELECT account_id FROM plaid_accounts').all()
    const transactions = db.prepare('SELECT account_id FROM plaid_transactions').all()
    const holdings = db.prepare('SELECT account_id FROM plaid_holdings').all()
    db.close()
    expect(items).toEqual([{ item_id: 'item_other' }])
    expect(accounts).toEqual([{ account_id: 'acc_other' }])
    expect(transactions).toEqual([{ account_id: 'acc_other' }])
    expect(holdings).toEqual([{ account_id: 'acc_other' }])
  })

  it('deletes the data even when Plaid cannot be told', async () => {
    // The friend asked for their history gone. A third party being down is not
    // a reason to keep it, and there is no later moment at which this can be
    // retried — the row naming what to delete would be the thing deleted.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    await seedAccountWithData('item_9', 'acc_9')
    const { PlaidCallError } = await import('@/lib/plaid/client')
    removeItemSpy.mockRejectedValue(new PlaidCallError('network'))

    const response = await (await disconnect())(
      post({ item_id: 'item_9', action: 'remove' }),
      params(),
    )

    expect(response.status).toBeLessThan(400)
    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_items').get() as any).n).toBe(0)
    db.close()
  })

  it('does not ask Plaid to revoke an already-disconnected bank', async () => {
    // Its token was destroyed when it was disconnected, and the item is
    // already gone at Plaid — /item/get returns ITEM_NOT_FOUND. Calling again
    // could only log a failure for something that already succeeded.
    await arrange()
    await seedItem({ itemId: 'item_9', accessToken: '', disconnectedAt: 5 })

    const response = await (await disconnect())(
      post({ item_id: 'item_9', action: 'remove' }),
      params(),
    )

    expect(response.status).toBeLessThan(400)
    expect(removeItemSpy).not.toHaveBeenCalled()
    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_items').get() as any).n).toBe(0)
    db.close()
  })

  it('writes a metric carrying a slug and a panel, and nothing else', async () => {
    // Permanent policy: no institution name, no item id, no count, no balance.
    await arrange()
    await seedItem({ itemId: 'item_9' })
    removeItemSpy.mockResolvedValue(undefined)

    await (await disconnect())(post({ item_id: 'item_9', action: 'remove' }), params())

    const { getDb } = await import('@/lib/db/instance')
    const rows = getDb()
      .prepare("SELECT data FROM metrics WHERE event = 'dashboard_write' ORDER BY at DESC")
      .all() as { data: string }[]
    const data = JSON.parse(rows[0]!.data)
    expect(data.slug).toBe('devtwo')
    expect(Object.keys(data).sort()).toEqual(['device_class', 'panel', 'slug'])
  })
})

describe('the OAuth redirect URI', () => {
  const saved = process.env.PLAID_REDIRECT_URI

  afterEach(() => {
    if (saved === undefined) delete process.env.PLAID_REDIRECT_URI
    else process.env.PLAID_REDIRECT_URI = saved
  })

  it('is sent on every token, not only ones bound for an OAuth bank', async () => {
    // Which institution the friend picks is decided inside Plaid's UI, long
    // after this runs, so there is nothing to branch on.
    process.env.PLAID_REDIRECT_URI = 'https://app.example.test/plaid/oauth'
    await arrange()
    createLinkTokenSpy.mockResolvedValue('t')

    await (await linkToken())(post(), params())

    expect(createLinkTokenSpy.mock.calls[0]![1].redirectUri).toBe(
      'https://app.example.test/plaid/oauth',
    )
  })

  it('is simply omitted when unset, rather than refusing the whole flow', async () => {
    // DEGRADED, not REQUIRED: one kind of bank not working is not a reason to
    // stop a friend connecting a non-OAuth one.
    delete process.env.PLAID_REDIRECT_URI
    await arrange()
    createLinkTokenSpy.mockResolvedValue('t')

    const response = await (await linkToken())(post(), params())

    expect(response.status).toBe(200)
    expect(createLinkTokenSpy.mock.calls[0]![1].redirectUri).toBeUndefined()
  })
})
