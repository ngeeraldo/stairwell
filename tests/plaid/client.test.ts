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
  INVESTMENT_TX_PAGE,
  LINK_CLIENT_NAME,
  PlaidCallError,
  classifyError,
  createLinkToken,
  exchangePublicToken,
  getHoldings,
  getInvestmentTransactions,
  getItem,
  getRecurring,
  plaidApiFromEnv,
  removeItem,
  requestTransactionsRefresh,
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

  it('gives PRODUCT_NOT_READY its own code, because it is not a failure', () => {
    // Plaid has the connection and has not finished preparing the product.
    // Lumping it in with 'http' would make the first refresh after connecting
    // say "couldn't reach your bank" while everything was working.
    expect(classifyError(httpError(400, 'PRODUCT_NOT_READY'))).toBe('product_not_ready')
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

  it('reports the institution NAME, which the same response already carries', async () => {
    // Verified against Sandbox, not assumed: /item/get returns
    // institution_name alongside institution_id, so a friend with two banks can
    // be shown two names instead of two ids. No extra Plaid call, no new
    // failure mode — the connect route already makes this request.
    const api = stub({
      itemGet: () =>
        Promise.resolve({
          data: {
            item: {
              item_id: 'item_1',
              institution_id: 'ins_109508',
              institution_name: 'First Platypus Bank',
              available_products: [],
              error: null,
            },
          },
        }),
    })

    expect((await getItem(api, 'token')).institutionName).toBe('First Platypus Bank')
  })

  it('leaves the institution name undefined when Plaid omits it', async () => {
    // Not every institution has one, and an empty string rendered as a bank's
    // name is worse than an id: it reads as a bank with no name rather than as
    // a missing field a panel can fall back from.
    const api = stub({
      itemGet: () =>
        Promise.resolve({
          data: { item: { item_id: 'item_1', available_products: [], error: null } },
        }),
    })

    expect((await getItem(api, 'token')).institutionName).toBeUndefined()
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

describe('getRecurring — the third answer that is neither success nor failure', () => {
  it('returns notReady for PRODUCT_NOT_READY, rather than an error', async () => {
    // Recurring cannot be requested at item creation and becomes available on
    // its own about ten seconds later, so the FIRST refresh after a friend
    // connects very often finds it missing. Treating that as an error would
    // put "couldn't reach your bank" on screen at the exact moment everything
    // is working.
    const api = stub({
      transactionsRecurringGet: () => Promise.reject(httpError(400, 'PRODUCT_NOT_READY')),
    })

    await expect(getRecurring(api, 'token')).resolves.toBe('notReady')
  })

  it('still raises a genuine outage', async () => {
    const api = stub({
      transactionsRecurringGet: () => Promise.reject(httpError(500, 'INTERNAL_SERVER_ERROR')),
    })
    await expect(getRecurring(api, 'token')).rejects.toMatchObject({ code: 'http' })
  })

  it('separates inflow from outflow — a paycheck is not a subscription', async () => {
    const api = stub({
      transactionsRecurringGet: () =>
        Promise.resolve({
          data: { inflow_streams: [{ stream_id: 'in_1' }], outflow_streams: [{ stream_id: 'out_1' }] },
        }),
    })

    const streams = await getRecurring(api, 'token')

    expect(streams).toEqual({ inflow: [{ stream_id: 'in_1' }], outflow: [{ stream_id: 'out_1' }] })
  })
})

describe('getInvestmentTransactions — the only paged endpoint', () => {
  /** `total` pages of `count` each, so paging is genuinely exercised. */
  function pager(total: number) {
    const calls: any[] = []
    const api = stub({
      investmentsTransactionsGet: (req: any) => {
        calls.push(req)
        const offset = req.options.offset as number
        const size = Math.min(req.options.count as number, Math.max(0, total - offset))
        return Promise.resolve({
          data: {
            investment_transactions: Array.from({ length: size }, (_, i) => ({
              investment_transaction_id: `tx_${offset + i}`,
            })),
            // The SAME security on every page, to prove dedup.
            securities: [{ security_id: 'sec_1' }],
            total_investment_transactions: total,
          },
        })
      },
    })
    return { api, calls }
  }

  const RANGE = { startDate: '2024-01-01', endDate: '2026-01-01' }

  it('walks past the first page — a real item held 1171', async () => {
    const { api, calls } = pager(1171)

    const result = await getInvestmentTransactions(api, 'token', RANGE)

    expect(result.transactions).toHaveLength(1171)
    expect(result.truncated).toBe(false)
    // Offsets advance; a loop that always asked for offset 0 would return the
    // first page forever and look like it worked.
    expect(calls.map((c) => c.options.offset)).toEqual([0, INVESTMENT_TX_PAGE, INVESTMENT_TX_PAGE * 2])
  })

  it('deduplicates securities that repeat on every page', async () => {
    const { api } = pager(1171)
    const result = await getInvestmentTransactions(api, 'token', RANGE)
    expect(result.securities).toEqual([{ security_id: 'sec_1' }])
  })

  it('stops on an empty page even when the total disagrees', async () => {
    // A wrong total would otherwise be an infinite loop bounded only by the
    // page cap.
    const api = stub({
      investmentsTransactionsGet: () =>
        Promise.resolve({
          data: {
            investment_transactions: [],
            securities: [],
            total_investment_transactions: 9999,
          },
        }),
    })

    const result = await getInvestmentTransactions(api, 'token', RANGE)

    expect(result.transactions).toHaveLength(0)
  })

  it('reports truncation rather than presenting a partial list as complete', async () => {
    // CLAUDE.md: no silent caps. A truncated list that says nothing reads as
    // "this is everything".
    const { api } = pager(INVESTMENT_TX_PAGE * 40)

    const result = await getInvestmentTransactions(api, 'token', RANGE)

    expect(result.truncated).toBe(true)
    expect(result.transactions.length).toBeLessThan(INVESTMENT_TX_PAGE * 40)
  })

  it('sends the caller’s dates and never invents its own', async () => {
    // This app has exactly one answer to what day it is for a friend, and a
    // Plaid client is not allowed to become a second one.
    const { api, calls } = pager(1)

    await getInvestmentTransactions(api, 'token', RANGE)

    expect(calls[0].start_date).toBe('2024-01-01')
    expect(calls[0].end_date).toBe('2026-01-01')
  })
})

describe('requestTransactionsRefresh', () => {
  it('asks the bank and returns nothing, because there is nothing to return', async () => {
    // Fire and forget: the extraction is still running when this resolves,
    // which is why it is not on the default refresh path.
    let seen: any
    const api = stub({
      transactionsRefresh: (req: unknown) => {
        seen = req
        return Promise.resolve({ data: { request_id: 'r' } })
      },
    })

    await expect(requestTransactionsRefresh(api, 'access-sandbox-x')).resolves.toBeUndefined()
    expect(seen).toEqual({ access_token: 'access-sandbox-x' })
  })
})
