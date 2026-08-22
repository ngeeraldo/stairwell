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

const moduleSql = (name: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'modules', 'plaid', name), 'utf8')

/** Every module migration, in order — the shape a friend's database is in. */
const SCHEMA = [moduleSql('initial.sql'), moduleSql('002_multi_source.sql')].join('\n')

let db: UserDb

const stub = (impl: Record<string, unknown>) => impl as unknown as PlaidApi

/** The single item the outer beforeEach seeds. */
const ITEM = { itemId: 'item_1', accessToken: 'token' }

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
    applyTransactionPage(db, 'item_1', {
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

    expect(() => applyTransactionPage(db, 'item_1', broken)).toThrow()
    vi.restoreAllMocks()

    expect(calls).toBeGreaterThan(0)
    expect(cursor()).toBeNull()
    expect(count('plaid_transactions')).toBe(0)
  })

  it('upserts a modified transaction rather than duplicating it', () => {
    // A pending charge settles at a different amount and keeps its id.
    applyTransactionPage(db, 'item_1', { added: [txn('t1', { amount: 4.5 })], modified: [], removed: [], nextCursor: 'c1' })
    applyTransactionPage(db, 'item_1', { added: [], modified: [txn('t1', { amount: 5.25 })], removed: [], nextCursor: 'c2' })

    expect(count('plaid_transactions')).toBe(1)
    const row = db
      .prepare(`SELECT json_extract(payload,'$.amount') amount FROM plaid_transactions`)
      .get() as { amount: number }
    expect(row.amount).toBe(5.25)
  })

  it('deletes a removed transaction', () => {
    applyTransactionPage(db, 'item_1', { added: [txn('t1'), txn('t2')], modified: [], removed: [], nextCursor: 'c1' })
    applyTransactionPage(db, 'item_1', { added: [], modified: [], removed: ['t1'], nextCursor: 'c2' })

    expect(count('plaid_transactions')).toBe(1)
  })

  it('skips a row missing a key it is indexed on, rather than defaulting it', () => {
    // A transaction filed under an empty account id is worse than one absent,
    // because it renders as real.
    applyTransactionPage(db, 'item_1', {
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

    await pullTransactions(db, api, ITEM)

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

    await pullTransactions(db, api, ITEM)

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
    await pullAccounts(db, first, ITEM)
    expect(count('plaid_accounts')).toBe(2)

    const second = stub({
      accountsGet: () => Promise.resolve({ data: { accounts: [{ account_id: 'a1' }] } }),
    })
    await pullAccounts(db, second, ITEM)

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

    await pullHoldings(db, holdings(['s1', 's2']), ITEM)
    expect(count('plaid_holdings')).toBe(2)

    await pullHoldings(db, holdings(['s1']), ITEM)
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

    await expect(pullRecurring(db, api, ITEM)).resolves.toBe('ok')

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

    await expect(pullRecurring(db, api, ITEM)).resolves.toBe('notReady')
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
    await pullInvestmentTransactions(db, api(1171), ITEM, RANGE)
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
    await pullHoldings(db, holdings, ITEM)
    await pullInvestmentTransactions(db, api(1), ITEM, RANGE)

    const ids = (db.prepare('SELECT security_id FROM plaid_securities ORDER BY security_id').all() as {
      security_id: string
    }[]).map((r) => r.security_id)
    expect(ids).toEqual(['s_from_holdings', 's_from_investments'])
  })
})

describe('plaid_refreshes records failures, which is the whole reason it exists', () => {
  it('records a success', () => {
    recordRefresh(db, { at: 1, day: '2026-08-21' }, { product: 'transactions', ok: true }, 'item_1')
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
      'item_1',
    )
    const row = db.prepare('SELECT * FROM plaid_refreshes').get() as any
    expect(row).toMatchObject({ product: 'holdings', ok: 0, code: 'item_login_required' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TWO ITEMS
//
// Everything above seeds ONE plaid_items row, which is why every writer in this
// file could be unscoped and still look correct. A friend with two banks is the
// case that reads the landmine out loud:
//
//   - the cursor UPDATE had no WHERE, so refreshing either bank stamped BOTH
//     items with the same cursor
//   - pullTransactions read `SELECT cursor FROM plaid_items LIMIT 1`, so
//     refreshing bank B resumed from bank A's cursor — a pointer into a stream
//     that is not B's
//   - every snapshot DELETEd its whole table, so syncing bank A wiped bank B's
//     accounts, holdings, recurring streams and investment transactions
//
// The cursor ones are the unrecoverable half. A cursor claiming data we do not
// hold is never re-sent by Plaid, and the only repair loses every annotation
// keyed to a transaction id. So these are asserted directly rather than
// inferred from the code reading correctly — the same reasoning as the
// atomicity test at the top of this file.
// ─────────────────────────────────────────────────────────────────────────────

describe('two items do not touch each other', () => {
  const ITEM_A = { itemId: 'item_1', accessToken: 'token-a' }
  const ITEM_B = { itemId: 'item_2', accessToken: 'token-b' }

  const cursorOf = (itemId: string) =>
    (db.prepare('SELECT cursor FROM plaid_items WHERE item_id = ?').get(itemId) as {
      cursor: string | null
    }).cursor

  beforeEach(() => {
    // item_1 is seeded by the outer beforeEach. This is the friend's second bank.
    db.prepare(
      `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
       VALUES ('item_2', 'token-b', '[]', 2)`,
    ).run()
    // Both banks have already been refreshed once, so each owns rows in every
    // table a snapshot replaces. Without these the DELETEs have nothing to hit
    // and an unscoped writer looks harmless.
    db.prepare("INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES ('a_a', 'item_1', '{}')").run()
    db.prepare("INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES ('a_b', 'item_2', '{}')").run()
    db.prepare("INSERT INTO plaid_holdings (account_id, security_id, payload) VALUES ('a_b', 's_b', '{}')").run()
    db.prepare("INSERT INTO plaid_securities (security_id, payload) VALUES ('s_b', '{}')").run()
    db.prepare(
      "INSERT INTO plaid_recurring_streams (stream_id, account_id, direction, payload) VALUES ('st_b', 'a_b', 'outflow', '{}')",
    ).run()
    db.prepare(
      `INSERT INTO plaid_investment_transactions
         (investment_transaction_id, account_id, security_id, date, payload)
       VALUES ('it_b', 'a_b', 's_b', '2026-08-01', '{}')`,
    ).run()
  })

  it('advances only the refreshed item\'s cursor', () => {
    db.prepare("UPDATE plaid_items SET cursor = 'b-cursor' WHERE item_id = 'item_2'").run()

    applyTransactionPage(db, ITEM_A.itemId, {
      added: [txn('t_a', { account_id: 'a_a' })],
      modified: [],
      removed: [],
      nextCursor: 'a-cursor',
    })

    expect(cursorOf('item_1')).toBe('a-cursor')
    // The unrecoverable one. item_2's cursor now claiming item_1's position
    // means Plaid never re-sends item_2's transactions.
    expect(cursorOf('item_2')).toBe('b-cursor')
  })

  it('resumes each item from its OWN cursor', async () => {
    db.prepare("UPDATE plaid_items SET cursor = 'a-cursor' WHERE item_id = 'item_1'").run()
    db.prepare("UPDATE plaid_items SET cursor = 'b-cursor' WHERE item_id = 'item_2'").run()
    const seen: unknown[] = []
    const api = stub({
      transactionsSync: (req: unknown) => {
        seen.push(req)
        return Promise.resolve({
          data: { added: [], modified: [], removed: [], next_cursor: 'next', has_more: false },
        })
      },
    })

    await pullTransactions(db, api, ITEM_B)

    expect(seen[0]).toMatchObject({ cursor: 'b-cursor' })
  })

  it('keeps the other item\'s accounts when one item syncs', async () => {
    const api = stub({
      accountsGet: () => Promise.resolve({ data: { accounts: [{ account_id: 'a_a' }] } }),
    })

    await pullAccounts(db, api, ITEM_A)

    const ids = (db.prepare('SELECT account_id FROM plaid_accounts ORDER BY account_id').all() as {
      account_id: string
    }[]).map((r) => r.account_id)
    expect(ids).toEqual(['a_a', 'a_b'])
  })

  it('keeps the other item\'s holdings and securities when one item syncs', async () => {
    const api = stub({
      investmentsHoldingsGet: () =>
        Promise.resolve({
          data: {
            accounts: [],
            holdings: [{ account_id: 'a_a', security_id: 's_a' }],
            securities: [{ security_id: 's_a' }],
          },
        }),
    })

    await pullHoldings(db, api, ITEM_A)

    expect(count('plaid_holdings')).toBe(2)
    // A security deleted out from under the other item's holding leaves that
    // holding unjoinable — the row is there and nothing can say what it is.
    expect(count('plaid_securities')).toBe(2)
  })

  it('keeps the other item\'s recurring streams when one item syncs', async () => {
    const api = stub({
      transactionsRecurringGet: () =>
        Promise.resolve({
          data: {
            inflow_streams: [{ stream_id: 'st_a', account_id: 'a_a' }],
            outflow_streams: [],
          },
        }),
    })

    await pullRecurring(db, api, ITEM_A)

    expect(count('plaid_recurring_streams')).toBe(2)
  })

  it('keeps the other item\'s investment transactions when one item syncs', async () => {
    const api = stub({
      investmentsTransactionsGet: () =>
        Promise.resolve({
          data: {
            investment_transactions: [
              { investment_transaction_id: 'it_a', account_id: 'a_a', security_id: 's_a', date: '2026-08-02' },
            ],
            securities: [],
            total_investment_transactions: 1,
          },
        }),
    })

    await pullInvestmentTransactions(db, api, ITEM_A, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(count('plaid_investment_transactions')).toBe(2)
  })

  it('upserts each item\'s transactions without disturbing the other\'s', () => {
    applyTransactionPage(db, ITEM_A.itemId, {
      added: [txn('t_a', { account_id: 'a_a' })],
      modified: [],
      removed: [],
      nextCursor: 'a1',
    })
    applyTransactionPage(db, ITEM_B.itemId, {
      added: [txn('t_b', { account_id: 'a_b' })],
      modified: [],
      removed: [],
      nextCursor: 'b1',
    })

    expect(count('plaid_transactions')).toBe(2)
    expect(cursorOf('item_1')).toBe('a1')
    expect(cursorOf('item_2')).toBe('b1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EVERY ROW KNOWS ITS BANK
//
// 002_multi_source stamps item_id on each synced row. These pin the WRITE half:
// the migration backfilled what already existed, and these are what stop a new
// row being written without one — which is how the stranded rows appeared in
// the first place.
// ─────────────────────────────────────────────────────────────────────────────

describe('every synced row is stamped with the bank it came from', () => {
  const itemOf = (table: string, key: string, id: string) =>
    (db.prepare(`SELECT item_id FROM ${table} WHERE ${key} = ?`).get(id) as { item_id: string | null })
      .item_id

  it('stamps a transaction as it is written', () => {
    applyTransactionPage(db, 'item_1', {
      added: [txn('t1')],
      modified: [],
      removed: [],
      nextCursor: 'c1',
    })

    expect(itemOf('plaid_transactions', 'transaction_id', 't1')).toBe('item_1')
  })

  it('stamps a holding as it is written', async () => {
    const api = stub({
      investmentsHoldingsGet: () =>
        Promise.resolve({
          data: {
            accounts: [],
            holdings: [{ account_id: 'a1', security_id: 's1' }],
            securities: [{ security_id: 's1' }],
          },
        }),
    })

    await pullHoldings(db, api, ITEM)

    expect(itemOf('plaid_holdings', 'security_id', 's1')).toBe('item_1')
  })

  it('stamps a recurring stream as it is written', async () => {
    const api = stub({
      transactionsRecurringGet: () =>
        Promise.resolve({
          data: { inflow_streams: [{ stream_id: 's1', account_id: 'a1' }], outflow_streams: [] },
        }),
    })

    await pullRecurring(db, api, ITEM)

    expect(itemOf('plaid_recurring_streams', 'stream_id', 's1')).toBe('item_1')
  })

  it('stamps an investment transaction as it is written', async () => {
    const api = stub({
      investmentsTransactionsGet: () =>
        Promise.resolve({
          data: {
            investment_transactions: [
              { investment_transaction_id: 'it_0', account_id: 'a1', security_id: 's1', date: '2026-08-01' },
            ],
            securities: [],
            total_investment_transactions: 1,
          },
        }),
    })

    await pullInvestmentTransactions(db, api, ITEM, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(itemOf('plaid_investment_transactions', 'investment_transaction_id', 'it_0')).toBe('item_1')
  })

  it('records which bank a refresh attempt was for', () => {
    recordRefresh(db, { at: 5, day: '2026-08-01' }, { product: 'transactions', ok: false, code: 'timeout' }, 'item_1')

    expect(
      db.prepare('SELECT item_id, code FROM plaid_refreshes').get(),
    ).toEqual({ item_id: 'item_1', code: 'timeout' })
  })

  it('drops a sold holding even when accounts were never refreshed', () => {
    // THE PRODUCTION PATH THAT MADE THE ACCOUNTS JOIN UNSAFE. A dashboard may
    // ask for holdings alone, so pullAccounts never runs and plaid_accounts is
    // empty or stale. Scoped through it, the replace matched nothing and a
    // fund the friend sold stayed on their screen forever. Scoped by the
    // stamped bank, it does not care what plaid_accounts knows.
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

    expect(count('plaid_accounts')).toBe(0)
    return pullHoldings(db, holdings(['s1', 's2']), ITEM)
      .then(() => pullHoldings(db, holdings(['s1']), ITEM))
      .then(() => {
        expect(count('plaid_holdings')).toBe(1)
      })
  })
})
