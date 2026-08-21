// tests/plaid/sync.test.ts
//
// The three write patterns, against a real SQLite database built from the real
// modules/plaid/initial.sql. No network: every Plaid call is a stub.
//
// THE ASSERTION THAT MATTERS MOST is cursor atomicity. A cursor saved without
// its rows claims we already hold data we threw away, and Plaid will never
// send it again — there is no repair short of disconnecting and reconnecting,
// which loses every annotation keyed to a transaction id. The reverse order is
// harmless. That asymmetry is why it is asserted directly rather than inferred
// from the code reading correctly.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { PlaidApi } from 'plaid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserDb } from '@/lib/db/userDb'
import {
  applyTransactionPage,
  pullAccounts,
  pullHoldings,
  pullInvestmentTransactions,
  pullRecurring,
  pullTransactions,
  recordRefresh,
} from '@/lib/plaid/sync'

const SCHEMA = readFileSync(
  resolve(__dirname, '..', '..', 'modules', 'plaid', 'initial.sql'),
  'utf8',
)

let db: UserDb

const stub = (impl: Record<string, unknown>) => impl as unknown as PlaidApi

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SCHEMA)
  db.prepare(
    `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
     VALUES ('item_1', 'token', '[]', 1)`,
  ).run()
})

afterEach(() => db.close())

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n
const cursor = () =>
  (db.prepare('SELECT cursor FROM plaid_items').get() as { cursor: string | null }).cursor

const txn = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acc_1',
  date: '2026-08-01',
  merchant_name: 'COFFEE PALACE TEST',
  amount: 4.5,
  ...over,
})

describe('the cursor stream', () => {
  it('writes rows and advances the cursor together', () => {
    applyTransactionPage(db, {
      added: [txn('t1'), txn('t2')],
      modified: [],
      removed: [],
      nextCursor: 'cursor-2',
    })

    expect(count('plaid_transactions')).toBe(2)
    expect(cursor()).toBe('cursor-2')
  })

  it('NEVER advances the cursor when the rows fail to write', () => {
    // The unrecoverable direction. If the cursor moved here, Plaid would never
    // resend these transactions and they would be gone permanently.
    const broken = {
      added: [txn('t1')],
      modified: [],
      removed: [],
      nextCursor: 'cursor-2',
    }
    // Force the insert to throw mid-transaction by removing the table the
    // statement targets after it was prepared.
    const original = db.prepare
    let calls = 0
    vi.spyOn(db, 'prepare').mockImplementation(function (this: UserDb, sql: string) {
      calls += 1
      const stmt = original.call(this, sql)
      if (sql.includes('INSERT INTO plaid_transactions')) {
        return { run: () => { throw new Error('disk full') } } as never
      }
      return stmt
    })

    expect(() => applyTransactionPage(db, broken)).toThrow()
    vi.restoreAllMocks()

    expect(calls).toBeGreaterThan(0)
    expect(cursor()).toBeNull()
    expect(count('plaid_transactions')).toBe(0)
  })

  it('upserts a modified transaction rather than duplicating it', () => {
    // A pending charge settles at a different amount and keeps its id.
    applyTransactionPage(db, { added: [txn('t1', { amount: 4.5 })], modified: [], removed: [], nextCursor: 'c1' })
    applyTransactionPage(db, { added: [], modified: [txn('t1', { amount: 5.25 })], removed: [], nextCursor: 'c2' })

    expect(count('plaid_transactions')).toBe(1)
    const row = db
      .prepare(`SELECT json_extract(payload,'$.amount') amount FROM plaid_transactions`)
      .get() as { amount: number }
    expect(row.amount).toBe(5.25)
  })

  it('deletes a removed transaction', () => {
    applyTransactionPage(db, { added: [txn('t1'), txn('t2')], modified: [], removed: [], nextCursor: 'c1' })
    applyTransactionPage(db, { added: [], modified: [], removed: ['t1'], nextCursor: 'c2' })

    expect(count('plaid_transactions')).toBe(1)
  })

  it('skips a row missing a key it is indexed on, rather than defaulting it', () => {
    // A transaction filed under an empty account id is worse than one absent,
    // because it renders as real.
    applyTransactionPage(db, {
      added: [txn('t1'), { transaction_id: 't2', date: '2026-08-01' }],
      modified: [],
      removed: [],
      nextCursor: 'c1',
    })

    expect(count('plaid_transactions')).toBe(1)
  })

  it('resumes from the stored cursor instead of re-pulling history', async () => {
    db.prepare("UPDATE plaid_items SET cursor = 'stored-cursor'").run()
    const seen: unknown[] = []
    const api = stub({
      transactionsSync: (req: unknown) => {
        seen.push(req)
        return Promise.resolve({
          data: { added: [], modified: [], removed: [], next_cursor: 'c2', has_more: false },
        })
      },
    })

    await pullTransactions(db, api, 'token')

    expect(seen[0]).toMatchObject({ cursor: 'stored-cursor' })
  })

  it('walks every page Plaid offers', async () => {
    let page = 0
    const api = stub({
      transactionsSync: () => {
        page += 1
        return Promise.resolve({
          data: {
            added: [txn(`t${page}`)],
            modified: [],
            removed: [],
            next_cursor: `c${page}`,
            has_more: page < 3,
          },
        })
      },
    })

    await pullTransactions(db, api, 'token')

    expect(count('plaid_transactions')).toBe(3)
    expect(cursor()).toBe('c3')
  })
})

describe('snapshots replace, and that is the point', () => {
  it('drops an account that is no longer returned', async () => {
    // A closed account absent from the new answer must leave the screen. An
    // upsert would leave it there forever, indistinguishable from a live one.
    const first = stub({
      accountsGet: () =>
        Promise.resolve({ data: { accounts: [{ account_id: 'a1' }, { account_id: 'a2' }] } }),
    })
    await pullAccounts(db, first, 'token', 'item_1')
    expect(count('plaid_accounts')).toBe(2)

    const second = stub({
      accountsGet: () => Promise.resolve({ data: { accounts: [{ account_id: 'a1' }] } }),
    })
    await pullAccounts(db, second, 'token', 'item_1')

    expect(count('plaid_accounts')).toBe(1)
  })

  it('drops a holding the friend sold', async () => {
    const holdings = (ids: string[]) =>
      stub({
        investmentsHoldingsGet: () =>
          Promise.resolve({
            data: {
              accounts: [],
              holdings: ids.map((id) => ({ account_id: 'a1', security_id: id })),
              securities: ids.map((id) => ({ security_id: id })),
            },
          }),
      })

    await pullHoldings(db, holdings(['s1', 's2']), 'token')
    expect(count('plaid_holdings')).toBe(2)

    await pullHoldings(db, holdings(['s1']), 'token')
    expect(count('plaid_holdings')).toBe(1)
  })

  it('tags recurring streams with a direction, so a paycheck cannot collide with a subscription', async () => {
    // The response splits inflow from outflow into two arrays and the id space
    // is shared; `direction` is ours, not Plaid's.
    const api = stub({
      transactionsRecurringGet: () =>
        Promise.resolve({
          data: {
            inflow_streams: [{ stream_id: 's1', account_id: 'a1' }],
            outflow_streams: [{ stream_id: 's2', account_id: 'a1' }],
          },
        }),
    })

    await expect(pullRecurring(db, api, 'token')).resolves.toBe('ok')

    const rows = db
      .prepare('SELECT stream_id, direction FROM plaid_recurring_streams ORDER BY stream_id')
      .all() as { stream_id: string; direction: string }[]
    expect(rows).toEqual([
      { stream_id: 's1', direction: 'inflow' },
      { stream_id: 's2', direction: 'outflow' },
    ])
  })

  it('reports notReady without writing anything', async () => {
    const api = stub({
      transactionsRecurringGet: () =>
        Promise.reject({ response: { status: 400, data: { error_code: 'PRODUCT_NOT_READY' } } }),
    })

    await expect(pullRecurring(db, api, 'token')).resolves.toBe('notReady')
    expect(count('plaid_recurring_streams')).toBe(0)
  })
})

describe('investment transactions', () => {
  const api = (total: number) =>
    stub({
      investmentsTransactionsGet: (req: any) => {
        const offset = req.options.offset as number
        const size = Math.min(req.options.count as number, Math.max(0, total - offset))
        return Promise.resolve({
          data: {
            investment_transactions: Array.from({ length: size }, (_, i) => ({
              investment_transaction_id: `it_${offset + i}`,
              account_id: 'a1',
              security_id: 's1',
              date: '2026-08-01',
            })),
            securities: [{ security_id: 's_from_investments' }],
            total_investment_transactions: total,
          },
        })
      },
    })

  const RANGE = { startDate: '2024-08-21', endDate: '2026-08-21' }

  it('writes every page, not just the first', async () => {
    await pullInvestmentTransactions(db, api(1171), 'token', RANGE)
    expect(count('plaid_investment_transactions')).toBe(1171)
  })

  it('UPSERTS securities rather than replacing them', async () => {
    // Securities arrive from BOTH holdings and investment transactions. If
    // this replaced, whichever product refreshed last would delete the other's
    // securities and leave its rows unjoinable.
    const holdings = stub({
      investmentsHoldingsGet: () =>
        Promise.resolve({
          data: {
            accounts: [],
            holdings: [{ account_id: 'a1', security_id: 's_from_holdings' }],
            securities: [{ security_id: 's_from_holdings' }],
          },
        }),
    })
    await pullHoldings(db, holdings, 'token')
    await pullInvestmentTransactions(db, api(1), 'token', RANGE)

    const ids = (db.prepare('SELECT security_id FROM plaid_securities ORDER BY security_id').all() as {
      security_id: string
    }[]).map((r) => r.security_id)
    expect(ids).toEqual(['s_from_holdings', 's_from_investments'])
  })
})

describe('plaid_refreshes records failures, which is the whole reason it exists', () => {
  it('records a success', () => {
    recordRefresh(db, { at: 1, day: '2026-08-21' }, { product: 'transactions', ok: true })
    const row = db.prepare('SELECT * FROM plaid_refreshes').get() as any
    expect(row).toMatchObject({ product: 'transactions', ok: 1, code: null })
  })

  it('records a failure with a CODE, never prose', () => {
    // Without this row a failed refresh is indistinguishable from no refresh,
    // and the dashboard renders the numbers it already had as current.
    recordRefresh(
      db,
      { at: 1, day: '2026-08-21' },
      { product: 'holdings', ok: false, code: 'item_login_required' },
    )
    const row = db.prepare('SELECT * FROM plaid_refreshes').get() as any
    expect(row).toMatchObject({ product: 'holdings', ok: 0, code: 'item_login_required' })
  })
})
