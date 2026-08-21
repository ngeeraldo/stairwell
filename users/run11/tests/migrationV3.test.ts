// users/run11/tests/migrationV3.test.ts
//
// THE DATA-SURVIVAL TEST 003 and 004 owe, in the same commit as the migrations
// (2026-08-15 migrations design, D3 — it is what earns full DDL under D1).
// Seed the OLD shape, apply the new files, assert the rows survived.
//
// ONE FILE FOR BOTH, because they land together and there is no state of run11's
// database that has 003 without 004: a friend unlocking after this deploy runs
// the pending migrations in one go. Splitting them would assert a shape that
// never exists in the wild. Both are asserted individually below all the same —
// the forecast and walk-log rows are checked after 003 AND again after 004 — so
// a failure still says which file lost them.
//
// It matters more than the phrase makes it sound. run11's real database is
// SQLCipher-encrypted under a key that exists only while he is unlocked, so
// these run on HIS machine, on HIS file, at unlock (lib/db/migrate.ts) — there
// is no server-side copy to fall back to and no way for anyone to inspect the
// result. `<slug>.backup.db` is one deep and under the same key. If they lose
// rows, they are gone.
//
// 003 is the vendored Plaid envelope and 004 only CREATEs, so this ought to be
// uninteresting — which is exactly why it is written down. "It only adds
// tables" is what everyone believes about their own migration, and D3 does not
// make an exception for the easy ones.
//
// It deliberately does NOT import lib/db/migrate.ts: that runner opens
// encrypted files, takes locks and writes backups, none of which this is about.
// It applies the same files, in the same order, the way tests/support does.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { migrationFilesFor } from '@/tests/support/userMigrations'

const files = migrationFilesFor('run11')
const sqlFor = (number: number) => {
  const path = files.find((f) => basename(f).startsWith(String(number).padStart(3, '0')))
  if (path === undefined) throw new Error(`no migration ${number} for run11`)
  return readFileSync(path, 'utf8')
}

const DAY = '2026-08-19'
const NEXT = '2026-08-20'

/** A database at the v2 shape — 001 and 002 — with a friend's history in it. */
function databaseAtV2(): Database.Database {
  const db = new Database(':memory:')
  db.exec(sqlFor(1))
  db.exec(sqlFor(2))
  db.pragma('user_version = 2')

  for (const [index, day] of [DAY, NEXT].entries()) {
    for (let h = 0; h < 24; h += 1) {
      db.prepare(
        `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(index * 86_400_000 + h * 3_600_000, day, h * 60, 0.2, 40, 95.5, 1)
    }
    db.prepare(
      'INSERT INTO forecast_days (day, sunrise_minute, sunset_minute, fetched_at) VALUES (?, ?, ?, ?)',
    ).run(day, 413, 1196, 1)
  }
  db.prepare('INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, ?)').run(
    1,
    DAY,
    600,
    1,
  )

  // The hand-entered half, which is the half that cannot be re-fetched. A lost
  // forecast row is replaced by pressing Refresh; a lost walk is gone.
  for (const day of [DAY, NEXT]) {
    db.prepare('INSERT INTO walk_log (day, at) VALUES (?, ?)').run(day, 1_700_000_000_000)
  }
  db.prepare('INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, ?, ?)').run(93, 1)
  return db
}

/** What lib/db/migrate.ts does per file: the DDL and the version, together. */
function apply(db: Database.Database, number: number) {
  db.exec('BEGIN')
  db.exec(sqlFor(number))
  db.pragma(`user_version = ${number}`)
  db.exec('COMMIT')
}

function snapshot(db: Database.Database) {
  return {
    hours: db.prepare('SELECT * FROM forecast_hours ORDER BY at').all(),
    days: db.prepare('SELECT * FROM forecast_days ORDER BY day').all(),
    fetches: db.prepare('SELECT * FROM forecast_fetches ORDER BY id').all(),
    walks: db.prepare('SELECT * FROM walk_log ORDER BY day').all(),
    settings: db.prepare('SELECT * FROM walk_settings').all(),
  }
}

describe('users/run11 — 003 and 004 do not lose what 001 and 002 stored', () => {
  it('leaves every forecast, walk and setting row exactly as it was', () => {
    const db = databaseAtV2()
    try {
      const before = snapshot(db)
      expect(before.hours).toHaveLength(48)
      expect(before.walks).toHaveLength(2)

      // Asserted after EACH file, so a failure names the one that lost them.
      apply(db, 3)
      // Whole rows, not counts. A migration that dropped and recreated a table
      // would keep the count and lose the contents, and a count-only assertion
      // would sail past exactly the failure D3 exists to catch.
      expect(snapshot(db)).toEqual(before)

      apply(db, 4)
      expect(snapshot(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('adds the Plaid envelope and the three spending tables, EMPTY', () => {
    // A MIGRATION NEVER SEEDS ROWS (D9). Changing a shape must not invent data
    // — and here that has two further edges: a pre-seeded custom category would
    // be a bucket the friend did not create and cannot tell from one he did,
    // and a pre-seeded visibility row would be a choice attributed to him that
    // he never made. category_visibility holds his explicit presses ONLY; the
    // default is resolved at read time.
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      for (const table of [
        'plaid_items',
        'plaid_accounts',
        'plaid_transactions',
        'plaid_refreshes',
        'custom_categories',
        'transaction_category_overrides',
        'category_visibility',
      ]) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
        expect({ table, n: row.n }).toEqual({ table, n: 0 })
      }
    } finally {
      db.close()
    }
  })

  it('leaves the vendored envelope byte-identical to the shared module', () => {
    // THE NEVER-FORKED RULE, as a test rather than as a promise
    // (CLAUDE.md > Schema & module rules). 003 is a COPY of
    // modules/plaid/initial.sql, and a friend's own needs are met by 004's
    // views on top of it. An edit here is the fork the rule forbids, and it
    // would be invisible: the file would still apply cleanly and the manifest
    // would still match, because the manifest hashes what is on disk.
    const shared = readFileSync('modules/plaid/initial.sql', 'utf8')
    expect(sqlFor(3)).toBe(shared)
  })

  it('moves user_version to 4, so they are never applied twice', () => {
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      expect(db.pragma('user_version', { simple: true })).toBe(4)
    } finally {
      db.close()
    }
  })

  it('is idempotent if either is ever re-run, rather than throwing on the tables', () => {
    // Every statement in both files is CREATE ... IF NOT EXISTS, views
    // included. The runner will not re-apply them — user_version is what stops
    // it — but a migration that throws on a second run turns a bookkeeping bug
    // into a friend who cannot log in.
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      expect(() => {
        db.exec(sqlFor(3))
        db.exec(sqlFor(4))
      }).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('holds custom_categories to one row per name, case-insensitively', () => {
    // COLLATE NOCASE at the DATABASE, not a rule the route is trusted to keep:
    // "Coffee" and "coffee" are one bucket to him, and two rows would be two
    // slices he cannot tell apart.
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      db.prepare('INSERT INTO custom_categories (name, created_at) VALUES (?, ?)').run('Coffee', 1)
      expect(() =>
        db.prepare('INSERT INTO custom_categories (name, created_at) VALUES (?, ?)').run(
          'coffee',
          2,
        ),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  it('holds one override per transaction, so re-filing twice is one fact', () => {
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      const insert = db.prepare(
        `INSERT INTO transaction_category_overrides (transaction_id, category, set_at)
         VALUES (?, ?, ?)
         ON CONFLICT(transaction_id) DO UPDATE SET category = excluded.category`,
      )
      insert.run('txn-TEST', 'Eating out', 1)
      insert.run('txn-TEST', 'Groceries', 2)
      const rows = db.prepare('SELECT * FROM transaction_category_overrides').all() as {
        category: string
      }[]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.category).toBe('Groceries')
    } finally {
      db.close()
    }
  })

  it('holds category_visibility to one row per category, case-SENSITIVELY', () => {
    // The opposite call from custom_categories above, and deliberate. This
    // column holds a category KEY out of the view's COALESCE, and those keys
    // are compared exactly everywhere else — so folding 'TRAVEL' and a bucket
    // called 'Travel' into one row here would give one tick box to two slices
    // the pie draws separately.
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      const insert = db.prepare(
        'INSERT INTO category_visibility (category, included, set_at) VALUES (?, ?, ?)',
      )
      insert.run('TRAVEL', 0, 1)
      expect(() => insert.run('Travel', 1, 2)).not.toThrow()
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM category_visibility').get(),
      ).toEqual({ n: 2 })
      // …and the same key twice is still one row.
      expect(() => insert.run('TRAVEL', 1, 3)).toThrow()
    } finally {
      db.close()
    }
  })

  it('keeps an override alive when the synced transaction is removed and re-sent', () => {
    // THE NO-FOREIGN-KEY DECISION, as a test. /transactions/sync's `removed`
    // verb DELETEs a row, and Plaid can re-send a transaction it removed. A
    // cascade would silently destroy the friend's re-filing at the moment his
    // bank restated something, which is precisely when he would not be looking.
    const db = databaseAtV2()
    try {
      apply(db, 3)
      apply(db, 4)
      db.prepare(
        'INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)',
      ).run('acct', 'item', JSON.stringify({ name: 'CARD TEST', type: 'credit' }))
      const addTxn = db.prepare(
        'INSERT INTO plaid_transactions (transaction_id, account_id, date, payload) VALUES (?, ?, ?, ?)',
      )
      addTxn.run('txn-TEST', 'acct', '2026-08-20', JSON.stringify({ amount: 5 }))
      db.prepare(
        'INSERT INTO transaction_category_overrides (transaction_id, category, set_at) VALUES (?, ?, ?)',
      ).run('txn-TEST', 'Eating out', 1)

      db.prepare('DELETE FROM plaid_transactions WHERE transaction_id = ?').run('txn-TEST')
      // The override outlived it, and is inert while nothing joins to it.
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM transaction_category_overrides').get(),
      ).toEqual({ n: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM spending_transactions').get()).toEqual({ n: 0 })

      addTxn.run('txn-TEST', 'acct', '2026-08-20', JSON.stringify({ amount: 5 }))
      const back = db
        .prepare('SELECT category FROM spending_transactions WHERE transaction_id = ?')
        .get('txn-TEST') as { category: string }
      expect(back.category).toBe('Eating out')
    } finally {
      db.close()
    }
  })
})
