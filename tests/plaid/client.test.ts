// tests/plaid/client.test.ts
//
// Pins the four properties lib/plaid/client.ts's header claims. Every test
// here uses a STUB api object — nothing in this file reaches the network,
// which is CLAUDE.md > Testing's rule and the reason the api is a parameter
// in the first place.
//
// The live counterpart is tests/plaid/client.live.test.ts (Phase 2), which
// asks Plaid whether the shape assumed here is still real.
import { afterEach, describe, expect, it } from 'vitest'
import type { PlaidApi } from 'plaid'
import {
  LINK_CLIENT_NAME,
  PlaidCallError,
  classifyError,
  createLinkToken,
  exchangePublicToken,
  getHoldings,
  getItem,
  plaidApiFromEnv,
  removeItem,
  syncTransactions,
} from '@/lib/plaid/client'

/** Plaid's own prose. It must never appear in anything this module produces. */
const UPSTREAM_PROSE =
  'the credentials for Chase ending in 4021 could not be verified for Nicholas'

function stub(impl: Record<string, unknown>): PlaidApi {
  return impl as unknown as PlaidApi
}

/** An axios-shaped rejection, which is what the SDK actually throws. */
function httpError(status: number, errorCode?: string) {
  return {
    response: {
      status,
      data: {
        error_code: errorCode,
        error_message: UPSTREAM_PROSE,
        display_message: UPSTREAM_PROSE,
      },
    },
  }
}

describe('property 3 — a code, never Plaid’s prose', () => {
  it('maps ITEM_LOGIN_REQUIRED to the one friend-facing code', () => {
    expect(classifyError(httpError(400, 'ITEM_LOGIN_REQUIRED'))).toBe('item_login_required')
  })

  it('maps bad api keys to an operator problem, not a friend problem', () => {
    expect(classifyError(httpError(400, 'INVALID_API_KEYS'))).toBe('auth')
    expect(classifyError(httpError(401))).toBe('auth')
  })

  it('separates no-egress from a slow provider', () => {
    expect(classifyError({ code: 'ENOTFOUND' })).toBe('network')
    expect(classifyError({ code: 'ECONNABORTED' })).toBe('timeout')
  })

  it('falls back to http for any other non-2xx', () => {
    expect(classifyError(httpError(500, 'INTERNAL_SERVER_ERROR'))).toBe('http')
  })

  it('never carries the upstream message into the thrown error', async () => {
    const api = stub({
      transactionsSync: () => Promise.reject(httpError(400, 'ITEM_LOGIN_REQUIRED')),
    })

    const error = await syncTransactions(api, 'access-sandbox-x').catch((e) => e)

    expect(error).toBeInstanceOf(PlaidCallError)
    expect(error.code).toBe('item_login_required')
    // The whole point. A Plaid error message can quote an institution name or
    // an account mask, and this error reaches an ntfy alert and a log line.
    expect(error.message).not.toContain(UPSTREAM_PROSE)
    expect(error.message).not.toContain('Chase')
    expect(JSON.stringify(error)).not.toContain('Chase')
  })
})

describe('property 2 — payloads come back verbatim', () => {
  it('passes a transaction through unmapped, including fields we do not know', async () => {
    const transaction = {
      transaction_id: 'txn_1',
      account_id: 'acc_1',
      date: '2026-08-18',
      merchant_name: 'COFFEE PALACE TEST',
      personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
      amount: 4.33,
      // A field this module has never heard of. It must survive, because the
      // envelope stores the payload and a friend's dashboard may need it.
      some_field_plaid_added_last_tuesday: { nested: true },
    }
    const api = stub({
      transactionsSync: () =>
        Promise.resolve({
          data: {
            added: [transaction],
            modified: [],
            removed: [],
            next_cursor: 'cursor-2',
            has_more: false,
          },
        }),
    })

    const page = await syncTransactions(api, 'access-sandbox-x', 'cursor-1')

    expect(page.added[0]).toEqual(transaction)
    expect(page.nextCursor).toBe('cursor-2')
    expect(page.hasMore).toBe(false)
  })

  it('lifts ids out of removed, the one documented exception', async () => {
    const api = stub({
      transactionsSync: () =>
        Promise.resolve({
          data: {
            added: [],
            modified: [],
            removed: [{ transaction_id: 'txn_gone' }],
            next_cursor: 'c',
            has_more: false,
          },
        }),
    })

    expect((await syncTransactions(api, 'token')).removed).toEqual(['txn_gone'])
  })

  it('passes the stored cursor to Plaid, which is what makes the sync incremental', async () => {
    let seen: unknown
    const api = stub({
      transactionsSync: (req: unknown) => {
        seen = req
        return Promise.resolve({
          data: { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false },
        })
      },
    })

    await syncTransactions(api, 'access-sandbox-x', 'cursor-from-plaid_items')

    expect(seen).toEqual({
      access_token: 'access-sandbox-x',
      cursor: 'cursor-from-plaid_items',
    })
  })
})

describe('a 2xx that is not the shape we promised', () => {
  it('refuses a missing cursor rather than returning undefined', async () => {
    const api = stub({
      transactionsSync: () =>
        Promise.resolve({ data: { added: [], modified: [], removed: [] } }),
    })
    await expect(syncTransactions(api, 't')).rejects.toMatchObject({ code: 'unparseable' })
  })

  it('refuses an exchange with no access token', async () => {
    const api = stub({
      itemPublicTokenExchange: () => Promise.resolve({ data: { item_id: 'item_1' } }),
    })
    await expect(exchangePublicToken(api, 'public-x')).rejects.toMatchObject({
      code: 'unparseable',
    })
  })

  it('refuses holdings that are not arrays', async () => {
    const api = stub({
      investmentsHoldingsGet: () =>
        Promise.resolve({ data: { accounts: [], holdings: null, securities: [] } }),
    })
    await expect(getHoldings(api, 't')).rejects.toMatchObject({ code: 'unparseable' })
  })
})

describe('plaidApiFromEnv refuses to guess an environment', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('throws when PLAID_ENV is unset rather than defaulting to sandbox', () => {
    delete process.env.PLAID_ENV
    process.env.PLAID_CLIENT_ID = 'id'
    process.env.PLAID_SECRET = 'secret'

    // A default here is the PLATFORM_DB failure shape: production quietly
    // talking to Sandbox and serving fabricated balances to a real person
    // with every health check green.
    expect(() => plaidApiFromEnv()).toThrow(PlaidCallError)
  })

  it('throws on an environment Plaid does not have', () => {
    process.env.PLAID_ENV = 'development' // retired by Plaid; only two remain
    process.env.PLAID_CLIENT_ID = 'id'
    process.env.PLAID_SECRET = 'secret'

    expect(() => plaidApiFromEnv()).toThrow(PlaidCallError)
  })

  it('throws when credentials are missing', () => {
    process.env.PLAID_ENV = 'sandbox'
    delete process.env.PLAID_CLIENT_ID
    delete process.env.PLAID_SECRET

    expect(() => plaidApiFromEnv()).toThrow(PlaidCallError)
  })
})

describe('createLinkToken — the two modes Phase 3 depends on', () => {
  it('asks for products when connecting a NEW bank', async () => {
    let seen: any
    const api = stub({
      linkTokenCreate: (req: unknown) => {
        seen = req
        return Promise.resolve({ data: { link_token: 'link-sandbox-1' } })
      },
    })

    const token = await createLinkToken(api, {
      clientUserId: '7',
      products: ['transactions', 'investments'],
    })

    expect(token).toBe('link-sandbox-1')
    expect(seen.products).toEqual(['transactions', 'investments'])
    expect(seen.access_token).toBeUndefined()
    // The friend sees this name above their bank's login form.
    expect(seen.client_name).toBe(LINK_CLIENT_NAME)
  })

  it('asks for NO products in update mode, which is how a broken item is repaired', async () => {
    let seen: any
    const api = stub({
      linkTokenCreate: (req: unknown) => {
        seen = req
        return Promise.resolve({ data: { link_token: 'link-sandbox-2' } })
      },
    })

    await createLinkToken(api, { clientUserId: '7', accessToken: 'access-sandbox-x' })

    // Plaid rejects the pair. Sending products here would make re-auth
    // impossible for a friend whose bank has expired — the one failure the
    // design currently has no other way out of.
    expect(seen.access_token).toBe('access-sandbox-x')
    expect('products' in seen).toBe(false)
  })

  it('refuses to send both, rather than letting Plaid answer with an opaque 400', async () => {
    const api = stub({ linkTokenCreate: () => Promise.resolve({ data: {} }) })
    await expect(
      createLinkToken(api, { clientUserId: '7', products: ['transactions'], accessToken: 'a' }),
    ).rejects.toBeInstanceOf(PlaidCallError)
  })

  it('never sends a friend’s slug to Plaid as the user id', async () => {
    // Plaid STORES client_user_id. A slug is a name a person chose; the
    // account's opaque integer id is not.
    let seen: any
    const api = stub({
      linkTokenCreate: (req: unknown) => {
        seen = req
        return Promise.resolve({ data: { link_token: 't' } })
      },
    })

    await createLinkToken(api, { clientUserId: '42', products: ['transactions'] })

    expect(seen.user).toEqual({ client_user_id: '42' })
    expect(JSON.stringify(seen)).not.toContain('run11')
  })
})

describe('getItem — what this connection can serve, and whether it is broken', () => {
  it('reports the products stored on plaid_items at connect time', async () => {
    const api = stub({
      itemGet: () =>
        Promise.resolve({
          data: {
            item: {
              item_id: 'item_1',
              institution_id: 'ins_109508',
              available_products: ['balance', 'recurring_transactions'],
              error: null,
            },
          },
        }),
    })

    const item = await getItem(api, 'token')

    expect(item.itemId).toBe('item_1')
    expect(item.institutionId).toBe('ins_109508')
    expect(item.availableProducts).toEqual(['balance', 'recurring_transactions'])
    expect(item.errorCode).toBeUndefined()
  })

  it('surfaces an expired bank connection as a taxonomy code, never as prose', async () => {
    const api = stub({
      itemGet: () =>
        Promise.resolve({
          data: {
            item: {
              item_id: 'item_1',
              available_products: [],
              error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: UPSTREAM_PROSE },
            },
          },
        }),
    })

    const item = await getItem(api, 'token')

    expect(item.errorCode).toBe('ITEM_LOGIN_REQUIRED')
    expect(JSON.stringify(item)).not.toContain('Chase')
  })

  it('refuses an item with no id rather than inventing one', async () => {
    const api = stub({ itemGet: () => Promise.resolve({ data: { item: {} } }) })
    await expect(getItem(api, 'token')).rejects.toMatchObject({ code: 'unparseable' })
  })
})

describe('removeItem', () => {
  it('revokes the connection at Plaid', async () => {
    let seen: any
    const api = stub({
      itemRemove: (req: unknown) => {
        seen = req
        return Promise.resolve({ data: { request_id: 'r' } })
      },
    })

    await removeItem(api, 'access-sandbox-x')

    expect(seen).toEqual({ access_token: 'access-sandbox-x' })
  })

  it('raises a code, not prose, when Plaid refuses', async () => {
    const api = stub({ itemRemove: () => Promise.reject(httpError(400, 'INVALID_API_KEYS')) })
    await expect(removeItem(api, 't')).rejects.toMatchObject({ code: 'auth' })
  })
})
