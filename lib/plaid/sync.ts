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
  page: { added: unknown[]; modified: unknown[]; removed: string[]; nextCursor: string },
): void {
  const upsert = db.prepare(
    `INSERT INTO plaid_transactions (transaction_id, account_id, date, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       account_id = excluded.account_id,
       date       = excluded.date,
       payload    = excluded.payload`,
  )
  const remove = db.prepare('DELETE FROM plaid_transactions WHERE transaction_id = ?')
  const setCursor = db.prepare('UPDATE plaid_items SET cursor = ?')

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
      upsert.run(t.transaction_id, t.account_id, t.date, JSON.stringify(raw))
    }
    for (const id of page.removed) remove.run(id)
    setCursor.run(page.nextCursor)
  })()
}

export async function pullTransactions(
  db: UserDb,
  api: PlaidApi,
  accessToken: string,
): Promise<void> {
  const row = db.prepare('SELECT cursor FROM plaid_items LIMIT 1').get() as
    | { cursor?: string | null }
    | undefined
  let cursor = row?.cursor ?? undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await syncTransactions(api, accessToken, cursor)
    applyTransactionPage(db, result)
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
 */
function replaceAll(
  db: UserDb,
  table: string,
  rows: unknown[],
  toValues: (row: Record<string, unknown>) => unknown[] | null,
  columns: string[],
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  )
  db.transaction(() => {
    db.prepare(`DELETE FROM ${table}`).run()
    for (const row of rows) {
      const values = toValues(row as Record<string, unknown>)
      if (values) insert.run(...values)
    }
  })()
}

export async function pullAccounts(
  db: UserDb,
  api: PlaidApi,
  accessToken: string,
  itemId: string,
): Promise<void> {
  const accounts = await getAccounts(api, accessToken)
  replaceAll(
    db,
    'plaid_accounts',
    accounts,
    (a) =>
      typeof a.account_id === 'string' ? [a.account_id, itemId, JSON.stringify(a)] : null,
    ['account_id', 'item_id', 'payload'],
  )
}

export async function pullHoldings(
  db: UserDb,
  api: PlaidApi,
  accessToken: string,
): Promise<void> {
  const snapshot = await getHoldings(api, accessToken)
  replaceAll(
    db,
    'plaid_securities',
    snapshot.securities,
    (s) => (typeof s.security_id === 'string' ? [s.security_id, JSON.stringify(s)] : null),
    ['security_id', 'payload'],
  )
  replaceAll(
    db,
    'plaid_holdings',
    snapshot.holdings,
    (h) =>
      typeof h.account_id === 'string' && typeof h.security_id === 'string'
        ? [h.account_id, h.security_id, JSON.stringify(h)]
        : null,
    ['account_id', 'security_id', 'payload'],
  )
}

/**
 * @returns 'notReady' when Plaid has not finished preparing the product, which
 * is routine on the first refresh after a friend connects and is NOT a failure.
 */
export async function pullRecurring(
  db: UserDb,
  api: PlaidApi,
  accessToken: string,
): Promise<'ok' | 'notReady'> {
  const streams = await getRecurring(api, accessToken)
  if (streams === 'notReady') return 'notReady'

  const tagged = [
    ...streams.inflow.map((s) => ({ direction: 'inflow', stream: s })),
    ...streams.outflow.map((s) => ({ direction: 'outflow', stream: s })),
  ]
  replaceAll(
    db,
    'plaid_recurring_streams',
    tagged,
    (entry) => {
      const { direction, stream } = entry as { direction: string; stream: Record<string, unknown> }
      // `direction` is ours, not Plaid's: the response splits inflow from
      // outflow into two arrays and the id space is shared, so without it a
      // paycheck and a subscription could collide on stream_id.
      return typeof stream.stream_id === 'string' && typeof stream.account_id === 'string'
        ? [stream.stream_id, stream.account_id, direction, JSON.stringify(stream)]
        : null
    },
    ['stream_id', 'account_id', 'direction', 'payload'],
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
  accessToken: string,
  range: { startDate: string; endDate: string },
): Promise<{ truncated: boolean }> {
  const result = await getInvestmentTransactions(api, accessToken, range)

  replaceAll(
    db,
    'plaid_investment_transactions',
    result.transactions,
    (t) =>
      typeof t.investment_transaction_id === 'string' &&
      typeof t.account_id === 'string' &&
      typeof t.date === 'string'
        ? [
            t.investment_transaction_id,
            t.account_id,
            typeof t.security_id === 'string' ? t.security_id : null,
            t.date,
            JSON.stringify(t),
          ]
        : null,
    ['investment_transaction_id', 'account_id', 'security_id', 'date', 'payload'],
  )

  // Securities arrive from BOTH holdings and investment transactions and are
  // the same objects, so this upserts rather than replacing — otherwise
  // whichever product refreshed last would delete the other's securities and
  // leave its rows unjoinable.
  const insert = db.prepare('INSERT OR REPLACE INTO plaid_securities (security_id, payload) VALUES (?, ?)')
  db.transaction(() => {
    for (const raw of result.securities) {
      const s = raw as { security_id?: unknown }
      if (typeof s.security_id === 'string') insert.run(s.security_id, JSON.stringify(raw))
    }
  })()

  return { truncated: result.truncated }
}

/**
 * Record the attempt — successful or not.
 *
 * NOT OPTIONAL. Without a row here a failed refresh is indistinguishable from
 * no refresh, and the dashboard renders the numbers it already had as though
 * they were current. The forecast build learned this first; the panel's honest
 * "couldn't reach your bank" is built on this row existing.
 */
export function recordRefresh(
  db: UserDb,
  attempt: { at: number; day: string },
  outcome: ProductOutcome,
): void {
  db.prepare(
    'INSERT INTO plaid_refreshes (at, day, product, ok, code) VALUES (?, ?, ?, ?, ?)',
  ).run(attempt.at, attempt.day, outcome.product, outcome.ok ? 1 : 0, outcome.code ?? null)
}
