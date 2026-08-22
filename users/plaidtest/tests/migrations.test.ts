// users/plaidtest/tests/migrations.test.ts
//
// THE DATA-SURVIVAL TEST plaidtest's 002 owes, in the same commit as the
// migration (2026-08-15 migrations design, D3).
//
// It is deliberately NOT a copy of modules/tests/plaidMultiSource.test.ts.
// That file proves the module's SQL is correct; this one proves THIS FOLDER'S
// OWN CHAIN is — that its two files are numbered so they apply in the right
// order, that the second one lands on a database the first one built, and that
// a row written under the old shape is still there afterwards. A folder can
// vendor a perfectly correct migration and still break by numbering it wrong,
// which is a failure no module test can see.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { describe, expect, it } from 'vitest'
import { migrationFilesFor } from '@/tests/support/userMigrations'

const files = migrationFilesFor('plaidtest')

/** The folder at its FIRST migration only, with a transaction already in it. */
function databaseAtV1(): Database.Database {
  const db = new Database(':memory:')
  db.exec(readFileSync(files[0]!, 'utf8'))
  db.pragma('user_version = 1')

  db.prepare(
    `INSERT INTO plaid_items (item_id, access_token, institution_id, cursor, available_products, payload, connected_at)
     VALUES ('item_before', 'access-NOT-A-REAL-TOKEN-TEST', 'ins_before', 'cursor_before', '[]', '{}', 1)`,
  ).run()
  db.prepare(
    "INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES ('acc_before', 'item_before', '{}')",
  ).run()
  db.prepare(
    `INSERT INTO plaid_transactions (transaction_id, account_id, date, payload)
     VALUES ('txn_before', 'acc_before', '2026-08-01', ?)`,
  ).run(JSON.stringify({ merchant_name: 'COFFEE PALACE TEST', amount: 4.5 }))
  return db
}

describe('users/plaidtest — the vendored chain applies in order', () => {
  it('declares exactly the migrations the manifest covers', () => {
    // Membership, not content — the manifest's SHA-256 per file covers content
    // (tests/users/conventions.test.ts). A new migration cannot join the chain
    // without this list moving with it.
    expect(files.map((f) => basename(f))).toEqual([
      '001_module_plaid_initial.sql',
      '002_module_plaid_multi_source.sql',
    ])
  })

  it('keeps the row that was already there', () => {
    const db = databaseAtV1()
    db.exec(readFileSync(files[1]!, 'utf8'))

    expect(
      db.prepare('SELECT transaction_id, account_id, date, payload FROM plaid_transactions').get(),
    ).toEqual({
      transaction_id: 'txn_before',
      account_id: 'acc_before',
      date: '2026-08-01',
      payload: JSON.stringify({ merchant_name: 'COFFEE PALACE TEST', amount: 4.5 }),
    })
    expect(db.prepare('SELECT item_id, cursor, access_token FROM plaid_items').get()).toEqual({
      item_id: 'item_before',
      cursor: 'cursor_before',
      access_token: 'access-NOT-A-REAL-TOKEN-TEST',
    })
  })

  it('stamps the row that was already there with the bank it came from', () => {
    const db = databaseAtV1()
    db.exec(readFileSync(files[1]!, 'utf8'))

    expect(db.prepare('SELECT item_id FROM plaid_transactions').get()).toEqual({
      item_id: 'item_before',
    })
  })

  it('fails if the two are applied in the wrong order', () => {
    // Not a hypothetical: 002 ALTERs tables 001 creates, so a folder that
    // numbered them the other way round would throw at unlock, on a friend's
    // encrypted file, where nobody can open it to see why. This pins the
    // failure here instead.
    const db = new Database(':memory:')
    expect(() => db.exec(readFileSync(files[1]!, 'utf8'))).toThrow()
  })
})
