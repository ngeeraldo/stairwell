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
const removeItemSpy = vi.fn()
vi.mock('@/lib/plaid/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plaid/client')>('@/lib/plaid/client')
  return {
    ...actual,
    plaidApiFromEnv: () => ({ __stub: true }),
    createLinkToken: createLinkTokenSpy,
    exchangePublicToken: exchangePublicTokenSpy,
    getItem: getItemSpy,
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

describe('link-token chooses its mode from the database, not from the caller', () => {
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

  it('switches to update mode once a connection exists — the only repair for a dead bank', async () => {
    await arrange()
    const db = await openUserDb('devtwo', true)
    db.prepare(
      `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
       VALUES ('item_1', ?, '[]', 1)`,
    ).run(ACCESS_TOKEN)
    db.close()
    createLinkTokenSpy.mockResolvedValue('link-sandbox-update')

    const response = await (await linkToken())(post(), params())

    expect(await response.json()).toMatchObject({ mode: 'update' })
    const opts = createLinkTokenSpy.mock.calls[0]![1]
    expect(opts.accessToken).toBe(ACCESS_TOKEN)
    // Plaid rejects the pair, so sending products here would make re-auth
    // impossible for a friend whose bank expired.
    expect(opts.products).toBeUndefined()
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

  it('replaces rather than appends, so a friend cannot end up with two items', async () => {
    await arrange()
    await (await connect())(post({ public_token: 'p1' }), params())
    exchangePublicTokenSpy.mockResolvedValue({ accessToken: 'second', itemId: 'item_10' })
    getItemSpy.mockResolvedValue({ itemId: 'item_10', availableProducts: [] })
    await (await connect())(post({ public_token: 'p2' }), params())

    const db = await openUserDb()
    const rows = db.prepare('SELECT item_id FROM plaid_items').all() as any[]
    db.close()
    expect(rows).toEqual([{ item_id: 'item_10' }])
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

describe('disconnect destroys the credential first and tells Plaid second', () => {
  async function connected() {
    await arrange()
    const db = await openUserDb('devtwo', true)
    db.prepare(
      `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
       VALUES ('item_9', ?, '[]', 1)`,
    ).run(ACCESS_TOKEN)
    db.close()
  }

  it('deletes the row and revokes the item at Plaid', async () => {
    await connected()
    removeItemSpy.mockResolvedValue(undefined)

    const response = await (await disconnect())(post(), params())
    expect(response.status).toBeLessThan(400)

    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_items').get() as any).n).toBe(0)
    db.close()
    expect(removeItemSpy).toHaveBeenCalledWith({ __stub: true }, ACCESS_TOKEN)
  })

  it('still destroys the local token when Plaid refuses', async () => {
    // The friend asked for the credential to be gone. Leaving a working bank
    // token in their database because a third party had a bad minute would be
    // the wrong way to fail.
    await connected()
    const { PlaidCallError } = await import('@/lib/plaid/client')
    removeItemSpy.mockRejectedValue(new PlaidCallError('network'))

    const response = await (await disconnect())(post(), params())

    expect(response.status).toBeLessThan(400)
    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_items').get() as any).n).toBe(0)
    db.close()
  })

  it('leaves the synced data alone — disconnecting is not deleting', async () => {
    // Dropping the synced rows would orphan every annotation a friend has
    // written against a transaction_id, as a side effect of a button that
    // says "disconnect".
    await connected()
    const seeded = await openUserDb('devtwo', true)
    seeded
      .prepare(
        `INSERT INTO plaid_transactions (transaction_id, account_id, date, payload)
         VALUES ('t1', 'a1', '2026-08-01', '{}')`,
      )
      .run()
    seeded.close()
    removeItemSpy.mockResolvedValue(undefined)

    await (await disconnect())(post(), params())

    const db = await openUserDb()
    expect((db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as any).n).toBe(1)
    db.close()
  })

  it('is a no-op rather than an error when nothing is connected', async () => {
    await arrange()
    const response = await (await disconnect())(post(), params())
    expect(response.status).toBeLessThan(400)
    expect(removeItemSpy).not.toHaveBeenCalled()
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
