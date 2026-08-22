// modules/tests/plaidMultiSource.test.ts
//
// THE DATA-SURVIVAL TEST modules/plaid/002_multi_source.sql owes, in the same
// commit as the migration (2026-08-15 migrations design, D3). Seed the OLD
// shape with real rows, apply the new file, assert the rows survived.
//
// This one is not a formality. 002 is the first module migration that TOUCHES
// EXISTING ROWS rather than only adding tables: it stamps every synced row with
// the bank it came from, by joining back through plaid_accounts. A backfill
// that got the join wrong would file one bank's transactions under another
// bank's name, and the friend's own database is SQLCipher-encrypted under a key
// that exists only while they are unlocked — nobody, including Nico, can open
// it afterwards to see what happened.
//
// So it asserts on ROWS AND THEIR CONTENT, never on counts. A count survives a
// backfill that shuffled every payload.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { describe, expect, it } from 'vitest'

const sql = (name: string) =>
  readFileSync(resolve(__dirname, '..', 'plaid', name), 'utf8')

const INITIAL = sql('initial.sql')
const MULTI_SOURCE = sql('002_multi_source.sql')

const A = 'item_alpha'
const B = 'item_beta'

/**
 * A database in the shape 002 has to migrate: two banks, each with its own
 * accounts and its own rows in every table Plaid fills.
 *
 * Two banks rather than one, because a backfill cannot be wrong with only one
 * — every row would get the right answer by having no alternative.
 */
function databaseBefore(): Database.Database {
  const db = new Database(':memory:')
  db.exec(INITIAL)

  for (const [item, token] of [[A, 'access-alpha'], [B, 'access-beta']]) {
    db.prepare(
      `INSERT INTO plaid_items (item_id, access_token, institution_id, cursor, available_products, payload, connected_at)
       VALUES (?, ?, ?, ?, '["transactions"]', '{}', 1)`,
    ).run(item, token, `ins_${item}`, `cursor-${item}`)
  }

  // Alpha owns acc_a1 and acc_a2; beta owns acc_b1.
  for (const [account, item] of [['acc_a1', A], ['acc_a2', A], ['acc_b1', B]]) {
    db.prepare('INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)').run(
      account,
      item,
      JSON.stringify({ account_id: account, name: `CHECKING TEST ${account}` }),
    )
  }

  const txn = (id: string, account: string) =>
    db.prepare(
      'INSERT INTO plaid_transactions (transaction_id, account_id, date, payload) VALUES (?, ?, ?, ?)',
    ).run(id, account, '2026-08-01', JSON.stringify({ transaction_id: id, merchant_name: 'COFFEE PALACE TEST' }))
  txn('txn_a1', 'acc_a1')
  txn('txn_a2', 'acc_a2')
  txn('txn_b1', 'acc_b1')
  // A transaction whose account is NOT in plaid_accounts — the stranded row
  // this migration exists to stop being created. It has no bank to be filed
  // under and must not be guessed at.
  txn('txn_orphan', 'acc_vanished')

  for (const security of ['sec_1', 'sec_2']) {
    db.prepare('INSERT INTO plaid_securities (security_id, payload) VALUES (?, ?)').run(
      security,
      JSON.stringify({ security_id: security, ticker_symbol: 'TEST' }),
    )
  }
  db.prepare(
    'INSERT INTO plaid_holdings (account_id, security_id, payload) VALUES (?, ?, ?)',
  ).run('acc_a1', 'sec_1', JSON.stringify({ quantity: 10 }))
  db.prepare(
    'INSERT INTO plaid_holdings (account_id, security_id, payload) VALUES (?, ?, ?)',
  ).run('acc_b1', 'sec_2', JSON.stringify({ quantity: 20 }))

  db.prepare(
    'INSERT INTO plaid_recurring_streams (stream_id, account_id, direction, payload) VALUES (?, ?, ?, ?)',
  ).run('stream_a', 'acc_a1', 'outflow', JSON.stringify({ description: 'GYM TEST' }))
  db.prepare(
    'INSERT INTO plaid_recurring_streams (stream_id, account_id, direction, payload) VALUES (?, ?, ?, ?)',
  ).run('stream_b', 'acc_b1', 'inflow', JSON.stringify({ description: 'PAYCHECK TEST' }))

  db.prepare(
    `INSERT INTO plaid_investment_transactions
       (investment_transaction_id, account_id, security_id, date, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('inv_a', 'acc_a1', 'sec_1', '2026-07-15', JSON.stringify({ amount: 100.5 }))

  db.prepare(
    'INSERT INTO plaid_refreshes (at, day, product, ok, code) VALUES (?, ?, ?, ?, ?)',
  ).run(1_700_000_000_000, '2026-08-01', 'transactions', 1, null)

  db.pragma('user_version = 1')
  return db
}

function migrated(): Database.Database {
  const db = databaseBefore()
  db.exec(MULTI_SOURCE)
  return db
}

describe('002_multi_source keeps every row it found', () => {
  it('keeps each transaction with its payload untouched', () => {
    const rows = migrated()
      .prepare('SELECT transaction_id, account_id, date, payload FROM plaid_transactions ORDER BY transaction_id')
      .all()

    expect(rows).toEqual([
      { transaction_id: 'txn_a1', account_id: 'acc_a1', date: '2026-08-01', payload: JSON.stringify({ transaction_id: 'txn_a1', merchant_name: 'COFFEE PALACE TEST' }) },
      { transaction_id: 'txn_a2', account_id: 'acc_a2', date: '2026-08-01', payload: JSON.stringify({ transaction_id: 'txn_a2', merchant_name: 'COFFEE PALACE TEST' }) },
      { transaction_id: 'txn_b1', account_id: 'acc_b1', date: '2026-08-01', payload: JSON.stringify({ transaction_id: 'txn_b1', merchant_name: 'COFFEE PALACE TEST' }) },
      { transaction_id: 'txn_orphan', account_id: 'acc_vanished', date: '2026-08-01', payload: JSON.stringify({ transaction_id: 'txn_orphan', merchant_name: 'COFFEE PALACE TEST' }) },
    ])
  })

  it('keeps holdings, securities, recurring streams and investment transactions', () => {
    const db = migrated()
    expect(
      db.prepare('SELECT account_id, security_id, payload FROM plaid_holdings ORDER BY account_id').all(),
    ).toEqual([
      { account_id: 'acc_a1', security_id: 'sec_1', payload: JSON.stringify({ quantity: 10 }) },
      { account_id: 'acc_b1', security_id: 'sec_2', payload: JSON.stringify({ quantity: 20 }) },
    ])
    expect(db.prepare('SELECT security_id FROM plaid_securities ORDER BY security_id').all()).toEqual([
      { security_id: 'sec_1' },
      { security_id: 'sec_2' },
    ])
    expect(
      db.prepare('SELECT stream_id, direction, payload FROM plaid_recurring_streams ORDER BY stream_id').all(),
    ).toEqual([
      { stream_id: 'stream_a', direction: 'outflow', payload: JSON.stringify({ description: 'GYM TEST' }) },
      { stream_id: 'stream_b', direction: 'inflow', payload: JSON.stringify({ description: 'PAYCHECK TEST' }) },
    ])
    expect(
      db.prepare('SELECT investment_transaction_id, security_id, date, payload FROM plaid_investment_transactions').all(),
    ).toEqual([
      { investment_transaction_id: 'inv_a', security_id: 'sec_1', date: '2026-07-15', payload: JSON.stringify({ amount: 100.5 }) },
    ])
  })

  it('keeps each item with its access token and its own cursor', () => {
    const rows = migrated()
      .prepare('SELECT item_id, access_token, institution_id, cursor FROM plaid_items ORDER BY item_id')
      .all()

    expect(rows).toEqual([
      { item_id: A, access_token: 'access-alpha', institution_id: `ins_${A}`, cursor: `cursor-${A}` },
      { item_id: B, access_token: 'access-beta', institution_id: `ins_${B}`, cursor: `cursor-${B}` },
    ])
  })

  it('keeps the refresh history, which is append-only', () => {
    expect(
      migrated().prepare('SELECT at, day, product, ok, code FROM plaid_refreshes').all(),
    ).toEqual([{ at: 1_700_000_000_000, day: '2026-08-01', product: 'transactions', ok: 1, code: null }])
  })
})

describe('002_multi_source stamps every synced row with the bank it came from', () => {
  // This is what makes "remove this bank and everything it brought" exact. Get
  // the join wrong and a friend deleting one bank loses rows from the other.
  it('files each transaction under its own bank', () => {
    const rows = migrated()
      .prepare('SELECT transaction_id, item_id FROM plaid_transactions ORDER BY transaction_id')
      .all()

    expect(rows).toEqual([
      { transaction_id: 'txn_a1', item_id: A },
      { transaction_id: 'txn_a2', item_id: A },
      { transaction_id: 'txn_b1', item_id: B },
      // No account, so no bank. Left NULL rather than guessed — a row filed
      // under the wrong bank is worse than one filed under none, because it
      // would be deleted when the friend removes a bank it never came from.
      { transaction_id: 'txn_orphan', item_id: null },
    ])
  })

  it('files each holding, stream and investment transaction under its own bank', () => {
    const db = migrated()
    expect(db.prepare('SELECT security_id, item_id FROM plaid_holdings ORDER BY security_id').all()).toEqual([
      { security_id: 'sec_1', item_id: A },
      { security_id: 'sec_2', item_id: B },
    ])
    expect(db.prepare('SELECT stream_id, item_id FROM plaid_recurring_streams ORDER BY stream_id').all()).toEqual([
      { stream_id: 'stream_a', item_id: A },
      { stream_id: 'stream_b', item_id: B },
    ])
    expect(
      db.prepare('SELECT investment_transaction_id, item_id FROM plaid_investment_transactions').all(),
    ).toEqual([{ investment_transaction_id: 'inv_a', item_id: A }])
  })

  it('leaves securities unstamped, because a security belongs to no bank', () => {
    // Two brokerages holding the same fund report the same security_id. An
    // item_id here would force one of them to be wrong.
    const columns = migrated().prepare('PRAGMA table_info(plaid_securities)').all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(['security_id', 'payload'])
  })
})

describe('002_multi_source adds what a source needs to describe itself', () => {
  it('gives an item a disconnected_at that starts null, meaning live', () => {
    const rows = migrated().prepare('SELECT item_id, disconnected_at FROM plaid_items ORDER BY item_id').all()
    expect(rows).toEqual([
      { item_id: A, disconnected_at: null },
      { item_id: B, disconnected_at: null },
    ])
  })

  it('gives an item an institution_name, so two banks can be told apart', () => {
    const db = migrated()
    db.prepare('UPDATE plaid_items SET institution_name = ? WHERE item_id = ?').run('First Platypus Bank TEST', A)
    expect(
      db.prepare('SELECT institution_name FROM plaid_items WHERE item_id = ?').get(A),
    ).toEqual({ institution_name: 'First Platypus Bank TEST' })
  })

  it('records which bank a refresh attempt was for', () => {
    // Without it a panel can say "a refresh failed" but never WHICH source
    // failed, which is the only version of that sentence a friend can act on.
    const db = migrated()
    db.prepare(
      'INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(1_700_000_000_001, '2026-08-02', 'transactions', 0, 'item_login_required', B)
    expect(
      db.prepare('SELECT item_id, code FROM plaid_refreshes WHERE ok = 0').get(),
    ).toEqual({ item_id: B, code: 'item_login_required' })
  })

  it('leaves rows written before this migration with no bank named on the refresh', () => {
    // An append-only table keeps what it already held. A pre-002 attempt did
    // not know which item it was for and must not claim one.
    expect(
      migrated().prepare('SELECT item_id FROM plaid_refreshes WHERE at = 1700000000000').get(),
    ).toEqual({ item_id: null })
  })
})
