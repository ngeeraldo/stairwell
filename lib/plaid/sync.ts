// lib/plaid/sync.ts
//
// Pulling Plaid data into a friend's database, one product at a time.
//
// Split out of the route because the route's job is authorisation and
// orchestration, and this file's job is the three genuinely different write
// patterns Plaid's products come in. Neither is small enough to hide inside
// the other.
//
// ── THE THREE PATTERNS, AND WHY THEY CANNOT SHARE CODE ──────────────────────
//
// 1. CURSOR STREAM (/transactions/sync). Incremental and stateful. `added` and
//    `modified` upsert, `removed` deletes, and the cursor advances. Pass the
//    stored cursor and Plaid returns only what changed since it — which is the
//    whole reason a friend pressing Refresh does not re-pull two years of
//    history every morning.
//
// 2. SNAPSHOT (accounts, holdings, recurring). Stateless and total. Plaid
//    returns what is true right now, so the table is REPLACED rather than
//    merged: a holding the friend sold is absent from the new answer, and
//    merging would leave it on their screen forever.
//
// 3. DATE-RANGED AND PAGED (investment transactions). Neither of the above —
//    no cursor to resume from, and one call is not the whole answer. Handled
//    by lib/plaid/client.ts's own paging, then written as a snapshot of the
//    window that was asked for.
//
// ── THE ONE RULE THAT IS NOT NEGOTIABLE ─────────────────────────────────────
//
// A PAGE'S ROWS AND THE CURSOR THAT DESCRIBES THEM ADVANCE IN ONE TRANSACTION.
// If the cursor were saved without its rows, it would claim we already hold
// data we threw away — and Plaid will never send it again. There is no repair
// for that short of disconnecting and reconnecting, which loses every
// annotation keyed to a transaction id. The reverse order is harmless: rows
// written without the cursor are simply re-sent and upserted next time.
//
// ── EVERY READ AND EVERY WRITE IS SCOPED TO ONE ITEM ────────────────────────
//
// A friend may connect more than one bank, so every function here takes the
// item it is acting for and touches nothing outside it. That is not a tidiness
// rule, it is the difference between a refresh and a data loss:
//
//   - The cursor UPDATE without a WHERE stamped EVERY item with the cursor of
//     whichever one was syncing. An item whose cursor points into someone
//     else's stream is unrecoverable — Plaid never re-sends what a cursor
//     claims you already have, and the only repair is disconnect-and-reconnect,
//     which loses every annotation keyed to a transaction id.
//   - A snapshot DELETE without a WHERE meant syncing bank A emptied bank B's
//     accounts, holdings, recurring streams and investment transactions.
//
// Every table here carries its own item_id (modules/plaid/002_multi_source.sql)
// and is scoped directly on it. Plaid keys transactions, holdings, recurring
// streams and investment transactions by ACCOUNT and never mentions the item,
// so the alternative was to scope them by joining back through plaid_accounts
// — and that fails in the case that matters. A dashboard may refresh holdings
// alone, so plaid_accounts is never consulted and may be empty; a closed
// account is gone from it entirely, stranding its transactions where no delete
// can reach them. The bank is stamped on the row at write time instead.
//
// plaid_securities is the exception and is never scoped, because a security is
// not owned by anyone: two brokerages holding the same fund describe the same
// security_id. So it UPSERTS and never deletes. The rows it accumulates are
// only ever reached by joining from a holding or an investment transaction, so
// an orphan is invisible rather than wrong — and deleting one out from under
// another item's holding would leave that holding unjoinable, which is.
//
// ── WHAT THIS FILE MAY NOT DO ───────────────────────────────────────────────
//
// It never reads a clock. Date ranges arrive from the caller, which resolved
// them in the friend's own zone — this app has exactly one answer to what day
// it is for a person (lib/time/dayKey.ts) and a sync job is not allowed to
// become a second one.
//
// It writes only plaid_* tables. A friend's annotation lives in their own
// table keyed to a transaction id, and nothing here touches it — which is what
// makes an annotation survive the refresh that rewrites the row beneath it.
import type { PlaidApi } from 'plaid'
import type { UserDb } from '@/lib/db/userDb'
import {
  getAccounts,
  getHoldings,
  getInvestmentTransactions,
  getRecurring,
  syncTransactions,
} from '@/lib/plaid/client'

/**
 * A hard stop on the cursor loop.
 *
 * Each page is up to 500 transactions, so this is 50,000 — far beyond two
 * years for any real person. It exists because `has_more` is Plaid's claim,
 * not ours, and an unbounded loop driven by someone else's flag is an
 * unbounded loop.
 */
const MAX_PAGES = 100

/**
 * The one connection a pull is acting for.
 *
 * The two fields travel together in an object rather than as adjacent string
 * parameters deliberately: they are both strings, so a swapped pair would
 * compile, run, and quietly write one bank's rows under another bank's id.
 * That is exactly the failure this file was rewritten to remove.
 */
export type PlaidItemRef = {
  itemId: string
  accessToken: string
}

/** What one product's pull did, for the plaid_refreshes row that follows. */
export type ProductOutcome = {
  product: string
  ok: boolean
  /** A PlaidErrorCode, 'not_ready', or undefined on success. Never prose. */
  code?: string
}

/**
 * Walk the cursor stream to its end, writing each page atomically.
 *
 * Each page is committed with its own cursor before the next is fetched, so an
 * interruption anywhere leaves a database that is CONSISTENT but behind — the
 * next refresh resumes from the last committed page. That is the correct
 * failure: behind is recoverable, ahead is not.
 */
export function applyTransactionPage(
  db: UserDb,
  itemId: string,
  page: { added: unknown[]; modified: unknown[]; removed: string[]; nextCursor: string },
): void {
  const upsert = db.prepare(
    `INSERT INTO plaid_transactions (transaction_id, account_id, item_id, date, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       account_id = excluded.account_id,
       item_id    = excluded.item_id,
       date       = excluded.date,
       payload    = excluded.payload`,
  )
  const remove = db.prepare('DELETE FROM plaid_transactions WHERE transaction_id = ?')
  // WHERE item_id — a friend's other bank must keep its own place in its own
  // stream. Without it, refreshing either bank stamped both.
  const setCursor = db.prepare('UPDATE plaid_items SET cursor = ? WHERE item_id = ?')

  db.transaction(() => {
    for (const raw of [...page.added, ...page.modified]) {
      const t = raw as { transaction_id?: unknown; account_id?: unknown; date?: unknown }
      // A row missing a key we index on is skipped rather than defaulted: a
      // transaction filed under an empty account id is worse than one absent,
      // because it renders as real.
      if (
        typeof t.transaction_id !== 'string' ||
        typeof t.account_id !== 'string' ||
        typeof t.date !== 'string'
      ) {
        continue
      }
      upsert.run(t.transaction_id, t.account_id, itemId, t.date, JSON.stringify(raw))
    }
    for (const id of page.removed) remove.run(id)
    setCursor.run(page.nextCursor, itemId)
  })()
}

export async function pullTransactions(
  db: UserDb,
  api: PlaidApi,
  item: PlaidItemRef,
): Promise<void> {
  // WHERE item_id, not LIMIT 1. Handing bank B a cursor minted for bank A asks
  // Plaid to resume a stream that is not B's.
  const row = db.prepare('SELECT cursor FROM plaid_items WHERE item_id = ?').get(item.itemId) as
    | { cursor?: string | null }
    | undefined
  let cursor = row?.cursor ?? undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await syncTransactions(api, item.accessToken, cursor)
    applyTransactionPage(db, item.itemId, result)
    cursor = result.nextCursor
    if (!result.hasMore) return
  }
}

/**
 * Replace a whole table from a snapshot, inside one transaction.
 *
 * DELETE-THEN-INSERT rather than upsert, and the reason is the rows that are
 * NOT in the new answer: a closed account, a sold holding, a subscription the
 * friend cancelled. An upsert leaves every one of them on screen forever,
 * indistinguishable from the live ones. The transaction is what stops a crash
 * mid-swap from leaving the friend with no accounts at all.
 *
 * Modelled on replaceForecast in app/api/users/[user]/forecast/route.ts, which
 * draws exactly this distinction for exactly this reason.
 *
 * `scope` is what makes "replace whole" mean "replace this item's whole share".
 * It is REQUIRED rather than optional: an omitted scope is a DELETE with no
 * WHERE, which is the bug this parameter exists to make unwritable.
 */
function replaceAll(
  db: UserDb,
  table: string,
  scope: Scope,
  rows: unknown[],
  toValues: (row: Record<string, unknown>) => unknown[] | null,
  columns: string[],
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  )
  const clear = db.prepare(`DELETE FROM ${table} WHERE ${scope.where}`)
  db.transaction(() => {
    clear.run(...scope.params)
    for (const row of rows) {
      const values = toValues(row as Record<string, unknown>)
      if (values) insert.run(...values)
    }
  })()
}

/** A WHERE fragment naming the rows one item owns, and its bound parameters. */
type Scope = { where: string; params: unknown[] }

/**
 * Every table a snapshot replaces carries item_id, so this is the only scope
 * there is. It reads no other table, which is the property that matters: a
 * replace cannot be silently narrowed by a plaid_accounts that is empty,
 * stale, or missing a closed account.
 */
const ownedBy = (itemId: string): Scope => ({ where: 'item_id = ?', params: [itemId] })

/**
 * Securities upsert and are never deleted — they belong to no item.
 *
 * Both products that return them (holdings and investment transactions) return
 * the SAME objects for the same security_id, and two items at different
 * brokerages can hold the same fund. Whichever refreshed last would otherwise
 * delete the other's securities and leave its rows unjoinable.
 */
function upsertSecurities(db: UserDb, rows: unknown[]): void {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO plaid_securities (security_id, payload) VALUES (?, ?)',
  )
  db.transaction(() => {
    for (const raw of rows) {
      const s = raw as { security_id?: unknown }
      if (typeof s.security_id === 'string') insert.run(s.security_id, JSON.stringify(raw))
    }
  })()
}

export async function pullAccounts(db: UserDb, api: PlaidApi, item: PlaidItemRef): Promise<void> {
  const accounts = await getAccounts(api, item.accessToken)
  replaceAll(
    db,
    'plaid_accounts',
    ownedBy(item.itemId),
    accounts,
    (a) =>
      typeof a.account_id === 'string' ? [a.account_id, item.itemId, JSON.stringify(a)] : null,
    ['account_id', 'item_id', 'payload'],
  )
}

export async function pullHoldings(db: UserDb, api: PlaidApi, item: PlaidItemRef): Promise<void> {
  const snapshot = await getHoldings(api, item.accessToken)
  // Securities first, so a holding never lands with nothing to join to.
  upsertSecurities(db, snapshot.securities)
  replaceAll(
    db,
    'plaid_holdings',
    ownedBy(item.itemId),
    snapshot.holdings,
    (h) =>
      typeof h.account_id === 'string' && typeof h.security_id === 'string'
        ? [h.account_id, h.security_id, item.itemId, JSON.stringify(h)]
        : null,
    ['account_id', 'security_id', 'item_id', 'payload'],
  )
}

/**
 * @returns 'notReady' when Plaid has not finished preparing the product, which
 * is routine on the first refresh after a friend connects and is NOT a failure.
 */
export async function pullRecurring(
  db: UserDb,
  api: PlaidApi,
  item: PlaidItemRef,
): Promise<'ok' | 'notReady'> {
  const streams = await getRecurring(api, item.accessToken)
  if (streams === 'notReady') return 'notReady'

  const tagged = [
    ...streams.inflow.map((s) => ({ direction: 'inflow', stream: s })),
    ...streams.outflow.map((s) => ({ direction: 'outflow', stream: s })),
  ]
  replaceAll(
    db,
    'plaid_recurring_streams',
    ownedBy(item.itemId),
    tagged,
    (entry) => {
      const { direction, stream } = entry as { direction: string; stream: Record<string, unknown> }
      // `direction` is ours, not Plaid's: the response splits inflow from
      // outflow into two arrays and the id space is shared, so without it a
      // paycheck and a subscription could collide on stream_id.
      return typeof stream.stream_id === 'string' && typeof stream.account_id === 'string'
        ? [stream.stream_id, stream.account_id, item.itemId, direction, JSON.stringify(stream)]
        : null
    },
    ['stream_id', 'account_id', 'item_id', 'direction', 'payload'],
  )
  return 'ok'
}

/**
 * @param range YYYY-MM-DD bounds resolved by the CALLER in the friend's own
 * zone. Never computed here.
 * @returns whether Plaid had more than the page cap allowed us to fetch.
 */
export async function pullInvestmentTransactions(
  db: UserDb,
  api: PlaidApi,
  item: PlaidItemRef,
  range: { startDate: string; endDate: string },
): Promise<{ truncated: boolean }> {
  const result = await getInvestmentTransactions(api, item.accessToken, range)

  replaceAll(
    db,
    'plaid_investment_transactions',
    ownedBy(item.itemId),
    result.transactions,
    (t) =>
      typeof t.investment_transaction_id === 'string' &&
      typeof t.account_id === 'string' &&
      typeof t.date === 'string'
        ? [
            t.investment_transaction_id,
            t.account_id,
            item.itemId,
            typeof t.security_id === 'string' ? t.security_id : null,
            t.date,
            JSON.stringify(t),
          ]
        : null,
    ['investment_transaction_id', 'account_id', 'item_id', 'security_id', 'date', 'payload'],
  )

  upsertSecurities(db, result.securities)

  return { truncated: result.truncated }
}

/**
 * Record the attempt — successful or not.
 *
 * NOT OPTIONAL. Without a row here a failed refresh is indistinguishable from
 * no refresh, and the dashboard renders the numbers it already had as though
 * they were current. The forecast build learned this first; the panel's honest
 * "couldn't reach your bank" is built on this row existing.
 *
 * `itemId` is what makes that sentence actionable once a friend has two banks.
 * "Transactions failed" is not something anyone can act on when one bank is
 * perfectly healthy; "Capital One couldn't be reached" is.
 */
export function recordRefresh(
  db: UserDb,
  attempt: { at: number; day: string },
  outcome: ProductOutcome,
  itemId: string,
): void {
  db.prepare(
    'INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(attempt.at, attempt.day, outcome.product, outcome.ok ? 1 : 0, outcome.code ?? null, itemId)
}
