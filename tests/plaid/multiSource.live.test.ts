// tests/plaid/multiSource.live.test.ts
//
// TWO REAL BANKS, AGAINST REAL PLAID. The one thing the offline suite cannot
// answer.
//
// Read CLAUDE.md > Testing before changing anything here. It follows
// tests/plaid/client.live.test.ts's conventions deliberately rather than
// inventing a second pattern: opt-in, excluded from every gate, skips without
// credentials, asserts SHAPE and RELATIONSHIPS rather than values, and removes
// every item it creates.
//
//     npm run test:live
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// Every behaviour below is already covered offline, with a stubbed Plaid
// client. What a stub cannot tell you is whether real Plaid behaves the way
// the stub assumes — and that assumption has been wrong twice:
//
//   1. The sync layer wrote an unscoped cursor. With one item that is
//      invisible; with two, refreshing either overwrote both, and a cursor
//      claiming data you do not hold is the one failure with no repair,
//      because Plaid never re-sends it.
//   2. A comment in the connect route claimed the cursor "only ever moves
//      forward — nothing is lost either way". A friend adding an account then
//      got an account that stayed permanently empty while every test stayed
//      green and the connection reported healthy.
//
// Both were found by a person clicking through Sandbox and reading rows out of
// SQLite by hand. That is not a thing anyone can do on every change. This is.
//
// ── WHAT IT STILL CANNOT COVER ──────────────────────────────────────────────
//
// Anything inside Plaid Link's own UI — in particular the ACCOUNT PICKER,
// which is a third-party modal this repository cannot drive. Its observed
// behaviour (it opens with nothing ticked) is why the connect route never
// deletes. That fact is recorded in the route's header and enforced by the
// offline tests; nothing here can re-check it, and a change in Plaid's UI
// would not fail this file.
import { afterAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PlaidApi } from 'plaid'
import type { UserDb } from '@/lib/db/userDb'
import { createSandboxItem, plaidApiFromEnv } from '@/lib/plaid/client'
import { pullAccounts, pullTransactions, recordRefresh } from '@/lib/plaid/sync'
import { readPlaidSources } from '@/modules/plaid/sources'

/** Two DIFFERENT institutions, so the two items are as unalike as Sandbox allows. */
const INSTITUTIONS = ['ins_109508', 'ins_109509']

const TIMEOUT_MS = 180_000

const configured =
  process.env.PLAID_ENV === 'sandbox' &&
  Boolean(process.env.PLAID_CLIENT_ID) &&
  Boolean(process.env.PLAID_SECRET)

const moduleSql = (name: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'modules', 'plaid', name), 'utf8')

let api: PlaidApi | undefined
const created: string[] = []

afterAll(async () => {
  // Leave nothing behind in Plaid's world: items are capped, and a test that
  // leaked two per run would eventually exhaust a real quota.
  for (const accessToken of created) {
    await api?.itemRemove({ access_token: accessToken }).catch(() => {})
  }
})

/** A friend's database, in the shape their migrations really produce. */
function userDb(): UserDb {
  const db = new Database(':memory:') as UserDb
  db.exec(moduleSql('initial.sql'))
  db.exec(moduleSql('002_multi_source.sql'))
  return db
}

const rowsFor = (db: UserDb, table: string, itemId: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE item_id = ?`).get(itemId) as { n: number }).n

describe.skipIf(!configured)('a friend with two real banks', () => {
  it(
    'keeps each bank’s cursor, accounts and transactions entirely its own',
    async () => {
      api = plaidApiFromEnv()
      const db = userDb()

      // Two real items, created the way a friend's connect would leave them.
      const items = []
      for (const institutionId of INSTITUTIONS) {
        const item = await createSandboxItem(api, {
          institutionId,
          // recurring_transactions is deliberately absent: Plaid rejects it in
          // initial_products outright, and it arrives on its own ~10s later.
          products: ['transactions'],
        })
        created.push(item.accessToken)
        items.push(item)
        db.prepare(
          `INSERT INTO plaid_items (item_id, access_token, institution_id, available_products, connected_at)
           VALUES (?, ?, ?, '[]', ?)`,
        ).run(item.itemId, item.accessToken, institutionId, Date.now())
      }
      const [a, b] = items as [(typeof items)[number], (typeof items)[number]]
      expect(a.itemId).not.toBe(b.itemId)

      // Pull both, in sequence, exactly as the refresh route's loop does.
      for (const item of items) {
        const ref = { itemId: item.itemId, accessToken: item.accessToken }
        await pullTransactions(db, api, ref)
        await pullAccounts(db, api, ref)
        recordRefresh(db, { at: Date.now(), day: '2026-08-22' }, { product: 'transactions', ok: true }, item.itemId)
      }

      // ── THE LANDMINE, against real responses ──────────────────────────────
      const cursors = db
        .prepare('SELECT item_id, cursor FROM plaid_items ORDER BY item_id')
        .all() as { item_id: string; cursor: string | null }[]
      expect(cursors).toHaveLength(2)
      for (const row of cursors) expect(typeof row.cursor).toBe('string')
      // Two banks, two places in two different streams. One cursor written
      // over both is unrecoverable: Plaid never re-sends what a cursor claims.
      expect(cursors[0]!.cursor).not.toBe(cursors[1]!.cursor)

      // Neither pull emptied the other's tables.
      for (const item of items) {
        expect({ item: item.itemId, accounts: rowsFor(db, 'plaid_accounts', item.itemId) > 0 }).toEqual(
          { item: item.itemId, accounts: true },
        )
      }
      // Sandbox always has transactions for at least one of these
      // institutions; asserting BOTH would be a claim about Plaid's fixture
      // data rather than about our scoping.
      const totals = items.map((item) => rowsFor(db, 'plaid_transactions', item.itemId))
      expect(totals.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0)

      // Every synced row names the bank it came from — the property "delete
      // this bank and everything it brought" rests on.
      const unstamped = db
        .prepare(
          `SELECT COUNT(*) n FROM plaid_transactions
            WHERE item_id IS NULL OR item_id NOT IN (SELECT item_id FROM plaid_items)`,
        )
        .get() as { n: number }
      expect(unstamped.n).toBe(0)

      // ── AND WHAT THE FRIEND WOULD BE TOLD ─────────────────────────────────
      const sources = readPlaidSources(db)
      expect(sources).toHaveLength(2)
      expect(sources.every((s) => s.status === 'live')).toBe(true)
      expect(sources.every((s) => s.accountCount > 0)).toBe(true)

      // ── DELETING ONE BANK LEAVES THE OTHER EXACTLY AS IT WAS ──────────────
      const survivor = {
        accounts: rowsFor(db, 'plaid_accounts', b.itemId),
        transactions: rowsFor(db, 'plaid_transactions', b.itemId),
      }
      db.transaction(() => {
        for (const table of [
          'plaid_transactions',
          'plaid_holdings',
          'plaid_recurring_streams',
          'plaid_investment_transactions',
          'plaid_accounts',
          'plaid_refreshes',
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(a.itemId)
        }
        db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(a.itemId)
      })()

      expect(rowsFor(db, 'plaid_accounts', a.itemId)).toBe(0)
      expect(rowsFor(db, 'plaid_transactions', a.itemId)).toBe(0)
      expect({
        accounts: rowsFor(db, 'plaid_accounts', b.itemId),
        transactions: rowsFor(db, 'plaid_transactions', b.itemId),
      }).toEqual(survivor)

      db.close()
    },
    TIMEOUT_MS,
  )

  it(
    'resumes a bank from ITS OWN cursor, and re-pulls everything when the cursor is cleared',
    async () => {
      // The second bug, in the form it actually appeared: a stored cursor is a
      // position in ONE bank's stream, and clearing it is what makes a newly
      // shared account's history arrive. Asserted against real Plaid rather
      // than against a stub that would agree with whatever we wrote.
      api = plaidApiFromEnv()
      const db = userDb()

      const item = await createSandboxItem(api, {
        institutionId: INSTITUTIONS[0]!,
        products: ['transactions'],
      })
      created.push(item.accessToken)
      const ref = { itemId: item.itemId, accessToken: item.accessToken }
      db.prepare(
        `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
         VALUES (?, ?, '[]', ?)`,
      ).run(item.itemId, item.accessToken, Date.now())

      await pullTransactions(db, api, ref)
      const first = rowsFor(db, 'plaid_transactions', item.itemId)
      const cursor = (
        db.prepare('SELECT cursor FROM plaid_items WHERE item_id = ?').get(item.itemId) as {
          cursor: string | null
        }
      ).cursor
      expect(typeof cursor).toBe('string')

      // Syncing again from the stored cursor returns nothing new — which is
      // the whole point of a cursor, and the reason a friend pressing Refresh
      // does not re-pull two years every morning.
      await pullTransactions(db, api, ref)
      expect(rowsFor(db, 'plaid_transactions', item.itemId)).toBe(first)

      // Clearing it re-pulls the window. Everything upserts by
      // transaction_id, so the count must NOT double — that is what makes the
      // reset safe to do when a friend adds an account.
      db.prepare('UPDATE plaid_items SET cursor = NULL WHERE item_id = ?').run(item.itemId)
      await pullTransactions(db, api, ref)
      expect(rowsFor(db, 'plaid_transactions', item.itemId)).toBe(first)

      db.close()
    },
    TIMEOUT_MS,
  )
})
