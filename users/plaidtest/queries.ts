// users/plaidtest/queries.ts
//
// Every SQL statement plaidtest runs, as pure functions taking a UserDb.
//
// plaidtest is a SCRATCH DASHBOARD, not a friend's. It exists to prove the
// shared Plaid connection end to end — connect, refresh, disconnect — with a
// real browser and a real Sandbox bank. It is the worked example of how a
// finance dashboard reads the shared envelope, so the shape of this file
// matters more than the panels do.
//
// ── EVERY VALUE COMES OUT OF JSON, AND THAT IS THE DESIGN ───────────────────
//
// modules/plaid/initial.sql stores Plaid's payload verbatim and gives columns
// only to the keys a row is upserted or filtered on. So a panel reads
// json_extract(payload, '$.whatever') rather than a modelled column, and a
// friend who later wants a field nobody anticipated gets a view — not a
// migration against an encrypted database nobody can open.
//
// ── WHAT MAY NOT APPEAR HERE ────────────────────────────────────────────────
//
// No INSERT, UPDATE or DELETE against a plaid_* table. Exactly one thing
// writes them: app/api/users/[user]/plaid/refresh/route.ts. The handle these
// functions receive is read-only in both dev and production
// (lib/db/userData.ts), so this is enforced rather than merely intended.
//
// No clock. `today` and `timeZone` arrive from the page, which resolved them
// from the friend's own zone once per request — tests/users/noLocalDay.test.ts
// sweeps this file for Date.now() and zero-argument new Date().
import type { UserDb } from '@/lib/db/userDb'

/**
 * Whether a bank is connected at all.
 *
 * This is the single most important read in the file, because it decides which
 * of two entirely different screens the friend sees. It counts plaid_items
 * rather than counting transactions on purpose: a freshly connected bank has a
 * token and no rows yet (Plaid backfills asynchronously — measured at 2-6
 * seconds), and a dashboard that inferred "not connected" from an empty
 * transaction table would tell a friend their connection failed while it was
 * still working.
 */
export function isConnected(db: UserDb): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM plaid_items').get() as { n: number }
  return row.n > 0
}

export type AccountBalance = {
  accountId: string
  name: string
  mask: string | null
  type: string
  current: number | null
}

/**
 * Accounts and their balances, largest first.
 *
 * `balances` is nested inside the payload, which is why this reads
 * '$.balances.current' rather than a column. Plaid returns `current` as null
 * on some account types, so the type says so instead of coercing it to zero —
 * a zero balance and an unknown balance are different statements to make to
 * someone about their money.
 */
export function accountBalances(db: UserDb): AccountBalance[] {
  return db
    .prepare(
      `SELECT account_id AS accountId,
              json_extract(payload, '$.name')            AS name,
              json_extract(payload, '$.mask')            AS mask,
              json_extract(payload, '$.type')            AS type,
              json_extract(payload, '$.balances.current') AS current
         FROM plaid_accounts
        ORDER BY current DESC NULLS LAST`,
    )
    .all() as AccountBalance[]
}

export type Transaction = {
  transactionId: string
  date: string
  merchant: string | null
  amount: number
  category: string | null
  pending: number
}

/**
 * The most recent transactions.
 *
 * `pending` comes back because a pending charge is a different thing from a
 * settled one — it can still change amount or vanish entirely. A friend who
 * only cares about processed transactions filters on it; this scratch
 * dashboard shows both and labels them, which is the honest default.
 *
 * JOINED TO plaid_accounts, and that join is doing real work
 * (docs/dashboard-build-rules.md §9.6). Nothing ever deletes the transactions
 * of an account a bank stops sharing — the account picker only adds — so a
 * panel reading plaid_transactions on its own would keep counting an account
 * the friend removed, forever, with nothing on screen to explain it. The join
 * is what makes an unticked account simply stop appearing, and what makes
 * re-ticking it bring everything back.
 */
export function recentTransactions(db: UserDb, limit = 12): Transaction[] {
  return db
    .prepare(
      `SELECT t.transaction_id AS transactionId,
              t.date,
              json_extract(t.payload, '$.merchant_name') AS merchant,
              json_extract(t.payload, '$.amount')        AS amount,
              json_extract(t.payload, '$.personal_finance_category.primary') AS category,
              json_extract(t.payload, '$.pending')       AS pending
         FROM plaid_transactions t
         JOIN plaid_accounts a ON a.account_id = t.account_id
        ORDER BY t.date DESC, t.transaction_id DESC
        LIMIT ?`,
    )
    .all(limit) as Transaction[]
}

export type Refresh = {
  at: number
  product: string
  ok: number
  code: string | null
  /** What the friend calls the bank this attempt was for. Null on pre-002 rows. */
  bank: string | null
}

/**
 * The last refresh attempt per BANK per product, successful or not.
 *
 * A FAILED attempt is as load-bearing as a successful one. Without this the
 * panel cannot tell "we could not reach your bank" from "your bank has nothing
 * new", and would render stale numbers as though they were current — which
 * docs/dashboard-ui-ux-guidelines.md > States forbids by name.
 *
 * PER BANK, and the bank is NAMED. Grouping by product alone produced
 * "transactions: ok / transactions: ok / transactions: ok" on a friend with
 * three connections — three true statements that together said nothing anyone
 * could act on, since one of those banks was failing and the list could not
 * say which. That is exactly what plaid_refreshes.item_id was added for
 * (modules/plaid/002_multi_source.sql).
 */
export function lastRefreshes(db: UserDb): Refresh[] {
  return db
    .prepare(
      `SELECT r.at, r.product, r.ok, r.code, i.institution_name AS bank
         FROM plaid_refreshes r
         LEFT JOIN plaid_items i ON i.item_id = r.item_id
        WHERE r.at = (
                SELECT MAX(at) FROM plaid_refreshes
                 WHERE product = r.product
                   AND (item_id IS r.item_id)
              )
        ORDER BY bank, r.product`,
    )
    .all() as Refresh[]
}

/**
 * Which products this connection can actually serve.
 *
 * Stored at connect time from /item/get. It is what the refresh route filters
 * on so a friend with one credit card never pays for an investments call —
 * and it is worth showing here because "why is my holdings panel empty" is
 * answered by this list, not by a bug.
 */
export function availableProducts(db: UserDb): string[] {
  const row = db
    .prepare('SELECT available_products FROM plaid_items ORDER BY connected_at LIMIT 1')
    .get() as { available_products?: string } | undefined
  if (!row?.available_products) return []
  try {
    const parsed: unknown = JSON.parse(row.available_products)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    // A malformed column is a bug in the connect route, not a reason to take
    // the whole dashboard down.
    return []
  }
}
