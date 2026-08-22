// users/run12/tests/migrations.test.ts
//
// THE DATA-SURVIVAL TEST run12's 002, 003 and 004 owe, in the same commit as
// the migrations (2026-08-15 migrations design, D3). D3 is what earns full DDL: a
// migration above 001 may ALTER and rebuild precisely because something proves
// the rows came through.
//
// It is deliberately NOT a copy of modules/tests/plaidMultiSource.test.ts. That
// file proves the MODULE's SQL is correct; this one proves THIS FOLDER'S OWN
// CHAIN is — that its three files are numbered so they apply in the right
// order, that each lands on a database the previous one built, and that a row
// written under the old shape is still there afterwards. A folder can vendor a
// perfectly correct migration and still break by numbering it wrong, which is a
// failure no module test can see, and which would surface on the friend's own
// encrypted file at unlock, where nobody can open it to find out why.
//
// 003's order is load-bearing for a second reason: its views select the
// `item_id` column 002 adds. Vendored before 002 it would throw on a column
// that does not exist yet.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { describe, expect, it } from 'vitest'
import { migrationFilesFor } from '@/tests/support/userMigrations'

const files = migrationFilesFor('run12')

/** The folder at its FIRST migration only, with real rows already in it. */
function databaseAtV1(): Database.Database {
  const db = new Database(':memory:')
  db.exec(readFileSync(files[0]!, 'utf8'))
  db.pragma('user_version = 1')

  db.prepare(
    `INSERT INTO plaid_items
       (item_id, access_token, institution_id, cursor, available_products, payload, connected_at)
     VALUES ('item_before', 'access-NOT-A-REAL-TOKEN-TEST', 'ins_before', 'cursor_before',
             '[]', '{}', 1)`,
  ).run()
  db.prepare(
    `INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES ('acc_before', 'item_before', ?)`,
  ).run(
    JSON.stringify({
      name: 'PLAID CHECKING TEST',
      mask: '0000',
      type: 'depository',
      subtype: 'checking',
    }),
  )
  db.prepare(
    `INSERT INTO plaid_transactions (transaction_id, account_id, date, payload)
     VALUES ('txn_before', 'acc_before', '2026-08-01', ?)`,
  ).run(
    JSON.stringify({
      merchant_name: 'COFFEE PALACE TEST',
      amount: 4.5,
      personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    }),
  )
  return db
}

describe('users/run12 — the migration chain applies in order', () => {
  it('declares exactly the migrations the manifest covers', () => {
    // Membership, not content — the manifest's SHA-256 per file covers content
    // (tests/users/conventions.test.ts). A new migration cannot join the chain
    // without this list moving with it.
    expect(files.map((f) => basename(f))).toEqual([
      '001_module_plaid_initial.sql',
      '002_module_plaid_multi_source.sql',
      '003_run12_spending.sql',
      '004_run12_categories.sql',
    ])
  })

  it('keeps every row that was already there', () => {
    const db = databaseAtV1()
    db.exec(readFileSync(files[1]!, 'utf8'))
    db.exec(readFileSync(files[2]!, 'utf8'))

    expect(
      db.prepare('SELECT transaction_id, account_id, date FROM plaid_transactions').get(),
    ).toEqual({
      transaction_id: 'txn_before',
      account_id: 'acc_before',
      date: '2026-08-01',
    })
    expect(db.prepare('SELECT item_id, cursor, access_token FROM plaid_items').get()).toEqual({
      item_id: 'item_before',
      cursor: 'cursor_before',
      access_token: 'access-NOT-A-REAL-TOKEN-TEST',
    })
    db.close()
  })

  it('backfills item_id THROUGH the account, and leaves an orphan null', () => {
    // 002 adds `item_id` to plaid_transactions and fills it by looking the
    // transaction's account up in plaid_accounts. That is the whole reason a
    // pre-002 row can name its bank at all — nothing in the old shape recorded
    // the connection directly.
    //
    // An ORPHAN is the case with no answer: a transaction whose account has
    // already gone from plaid_accounts (Plaid's picker only ever adds, so an
    // unticked account loses its row while its transactions stay). The subquery
    // finds nothing and the column stays NULL rather than inventing a bank, and
    // `frozenBanksInWindow` in ../queries.ts filters that null out rather than
    // attributing it to someone.
    const db = databaseAtV1()
    db.prepare(
      `INSERT INTO plaid_transactions (transaction_id, account_id, date, payload)
       VALUES ('txn_orphan', 'acc_gone', '2026-08-02', '{}')`,
    ).run()

    db.exec(readFileSync(files[1]!, 'utf8'))
    db.exec(readFileSync(files[2]!, 'utf8'))

    expect(
      db
        .prepare('SELECT transaction_id, item_id FROM plaid_transactions ORDER BY transaction_id')
        .all(),
    ).toEqual([
      { transaction_id: 'txn_before', item_id: 'item_before' },
      { transaction_id: 'txn_orphan', item_id: null },
    ])
    db.close()
  })

  it("003's views read a row 001 stored and 002 widened", () => {
    // The end-to-end proof that the ORDER is right: `spending_accounts` reads
    // 002's `item_id` column off a table 001 created, and
    // `spending_transactions` joins through it to a payload 001 stored.
    const db = databaseAtV1()
    db.exec(readFileSync(files[1]!, 'utf8'))
    db.exec(readFileSync(files[2]!, 'utf8'))

    expect(db.prepare('SELECT account_id, item_id, name, subtype FROM spending_accounts').get()).toEqual(
      {
        account_id: 'acc_before',
        item_id: 'item_before',
        name: 'PLAID CHECKING TEST',
        subtype: 'checking',
      },
    )
    expect(
      db.prepare('SELECT transaction_id, category, amount, is_internal FROM spending_transactions').get(),
    ).toEqual({
      transaction_id: 'txn_before',
      category: 'FOOD_AND_DRINK',
      amount: 4.5,
      is_internal: 0,
    })
    db.close()
  })

  it('ends with exactly the three tables 004 adds, and the two views', () => {
    const db = new Database(':memory:')
    for (const file of files) db.exec(readFileSync(file, 'utf8'))

    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'plaid_%' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all()
        .map((r) => (r as { name: string }).name),
    ).toEqual(['category_visibility', 'custom_categories', 'transaction_category_overrides'])

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name),
    ).toEqual(['spending_accounts', 'spending_transactions'])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 004 — THE ONE THAT LANDS ON A DATABASE WITH REAL HISTORY IN IT
// ─────────────────────────────────────────────────────────────────────────────
//
// 002 and 003 above are proved against the shape 001 built. 004 is different in
// kind: it is the first migration run12 will ever apply to a database that has
// been LIVED IN — a friend's own encrypted file, full of synced transactions,
// at unlock. It also DROPS AND RECREATES a view, which is the operation most
// likely to be got wrong in a way that only shows up on real data.

describe('users/run12 — 004 lands on a database with data in it', () => {
  /** The folder at 003, with a bank, an account and two transactions. */
  function databaseAtV3(): Database.Database {
    const db = databaseAtV1()
    db.exec(readFileSync(files[1]!, 'utf8'))
    db.exec(readFileSync(files[2]!, 'utf8'))
    db.prepare(
      `INSERT INTO plaid_transactions (transaction_id, account_id, item_id, date, payload)
       VALUES ('txn_transfer', 'acc_before', 'item_before', '2026-08-03', ?)`,
    ).run(
      JSON.stringify({
        amount: 900,
        name: 'TRANSFER TEST',
        personal_finance_category: {
          primary: 'TRANSFER_OUT',
          detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        },
      }),
    )
    db.pragma('user_version = 3')
    return db
  }

  it('keeps every synced row through the view rebuild', () => {
    const db = databaseAtV3()
    const before = db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as { n: number }

    db.exec(readFileSync(files[3]!, 'utf8'))

    expect(db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get()).toEqual(before)
    expect(
      db.prepare('SELECT transaction_id, date FROM plaid_transactions ORDER BY transaction_id').all(),
    ).toEqual([
      { transaction_id: 'txn_before', date: '2026-08-01' },
      { transaction_id: 'txn_transfer', date: '2026-08-03' },
    ])
    expect(db.prepare('SELECT item_id, access_token FROM plaid_items').get()).toEqual({
      item_id: 'item_before',
      access_token: 'access-NOT-A-REAL-TOKEN-TEST',
    })
    db.close()
  })

  it('rebuilds the view so it still answers what 003 answered', () => {
    // A DROP that recreated the view WRONG would leave every synced row intact
    // and the screen empty — a data-survival test that only counted rows would
    // pass while the dashboard showed nothing. So this asserts the view, not the
    // table.
    const db = databaseAtV3()
    db.exec(readFileSync(files[3]!, 'utf8'))

    expect(
      db
        .prepare(
          'SELECT transaction_id, category, is_internal FROM spending_transactions ORDER BY transaction_id',
        )
        .all(),
    ).toEqual([
      { transaction_id: 'txn_before', category: 'FOOD_AND_DRINK', is_internal: 0 },
      { transaction_id: 'txn_transfer', category: 'TRANSFER_OUT', is_internal: 1 },
    ])
    db.close()
  })

  it('adds the three tables EMPTY — a migration never seeds rows', () => {
    // 2026-08-15 migrations design, D9. Changing a shape must not invent data:
    // a pre-seeded bucket would be this dashboard inventing a category the
    // friend did not ask for and cannot tell from one he made.
    const db = databaseAtV3()
    db.exec(readFileSync(files[3]!, 'utf8'))

    for (const table of [
      'custom_categories',
      'transaction_category_overrides',
      'category_visibility',
    ]) {
      expect({ table, ...(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as object) }).toEqual({
        table,
        n: 0,
      })
    }
    db.close()
  })

  it('leaves spending_accounts alone — the allow-list did not change', () => {
    const db = databaseAtV3()
    const before = db.prepare('SELECT * FROM spending_accounts').all()
    db.exec(readFileSync(files[3]!, 'utf8'))
    expect(db.prepare('SELECT * FROM spending_accounts').all()).toEqual(before)
    db.close()
  })
})
