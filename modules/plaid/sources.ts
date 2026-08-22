// modules/plaid/sources.ts
//
// WHAT THE FRIEND'S CONNECTIONS ARE DOING, read from the shared envelope.
//
// Part of the module rather than of any one dashboard, and shared for the same
// reason the SQL is: every finance dashboard renders the same source list with
// the same capabilities (2026-08-21 plan, D4). Two implementations of "is this
// bank live" would be two answers to a question a friend asks once, and which
// answer they got would depend on which dashboard they happened to open.
//
// ── IT IS A READ, WHICH IS WHY A DASHBOARD MAY CALL IT ──────────────────────
//
// A dashboard never imports lib/plaid/ — that is the module that knows a
// network exists, and it is confined to the platform routes. This file knows
// only SQL. It takes a UserDb, touches no clock and no environment, and writes
// nothing, so it is safe against the read-only handle a dashboard holds.
//
// ── THE STATES, AND WHY EACH ONE EXISTS ─────────────────────────────────────
//
// docs/dashboard-ui-ux-guidelines.md forbids rendering stale data as current,
// and every one of these is a way that would otherwise happen:
//
//   never_refreshed  A bank connected seconds ago has a token and no rows.
//                    Calling that a failure tells a friend their connection
//                    broke at the exact moment it is working.
//   live             A refresh has succeeded. The only state that may show a
//                    "last updated" time as meaning anything.
//   needs_login      The one failure only the friend can fix. Folding it into
//                    a generic error hides the single action that resolves it.
//   unreachable      Something else failed. Honest, and not the friend's to
//                    repair.
//   disconnected     They revoked it. The rows are still on screen and must
//                    say so — this state is the entire reason plaid_items
//                    survives a disconnect rather than being deleted.
//
// `not_ready` is deliberately NOT a failure: Plaid holds the connection and
// has not finished preparing that product, which is routine on the first
// refresh after connecting.
import type { UserDb } from '@/lib/db/userDb'

export type PlaidSourceStatus =
  | 'live'
  | 'never_refreshed'
  | 'needs_login'
  | 'unreachable'
  | 'disconnected'

export type PlaidSource = {
  itemId: string
  /** What the friend calls this bank, never an institution id. */
  name: string
  status: PlaidSourceStatus
  connectedAt: number
  disconnectedAt: number | null
  /** When this bank last returned data. Null until it has. */
  lastRefreshAt: number | null
  /** When it was last TRIED, successfully or not. */
  lastAttemptAt: number | null
  accountCount: number
  /**
   * Products that failed in the MOST RECENT round, while others succeeded.
   *
   * A refresh can succeed and fail at the same time: one bank's transactions
   * land while its balances do not. Without this the source reported itself
   * `live` and said "Updated just now" — true about the connection, false
   * about the numbers on the page, and precisely what
   * docs/dashboard-ui-ux-guidelines.md > States forbids.
   *
   * The rows were always written; they were thrown away as soon as anything
   * in the round succeeded.
   *
   * Empty when the newest round was clean, and `not_ready` never appears here
   * — a product Plaid has not finished preparing is not a failure.
   */
  failedProducts: string[]
}

/**
 * The fallback when Plaid names no institution.
 *
 * Deliberately not the institution id: `ins_109508` in place of a bank's name
 * reads as a broken row, and a friend cannot act on it.
 */
const UNNAMED = 'Your bank'

type ItemRow = {
  item_id: string
  institution_name: string | null
  connected_at: number
  disconnected_at: number | null
}

type AttemptRow = {
  item_id: string
  at: number
  product: string
  ok: number
  code: string | null
}

export function readPlaidSources(db: UserDb): PlaidSource[] {
  const items = db
    .prepare(
      `SELECT item_id, institution_name, connected_at, disconnected_at
         FROM plaid_items
        ORDER BY connected_at, item_id`,
    )
    .all() as ItemRow[]
  if (items.length === 0) return []

  const counts = new Map<string, number>()
  for (const row of db
    .prepare('SELECT item_id, COUNT(*) n FROM plaid_accounts GROUP BY item_id')
    .all() as { item_id: string; n: number }[]) {
    counts.set(row.item_id, row.n)
  }

  // The MOST RECENT attempt per (item, product). Status describes the
  // connection now, so a failure the friend has already recovered from is
  // history rather than a state — and a product that is merely slow to become
  // ready must not outvote the one that succeeded.
  //
  // A NULL item_id is excluded: rows written before 002_multi_source do not
  // know which connection they described, and attributing one to a bank would
  // be inventing what an old row meant.
  const attempts = db
    .prepare(
      `SELECT item_id, at, product, ok, code
         FROM plaid_refreshes r
        WHERE item_id IS NOT NULL
          AND at = (
            SELECT MAX(at) FROM plaid_refreshes
             WHERE item_id = r.item_id AND product = r.product
          )`,
    )
    .all() as AttemptRow[]

  const byItem = new Map<string, AttemptRow[]>()
  for (const row of attempts) {
    const list = byItem.get(row.item_id)
    if (list) list.push(row)
    else byItem.set(row.item_id, [row])
  }

  return items.map((item) => {
    const own = byItem.get(item.item_id) ?? []
    const lastAttemptAt = own.length > 0 ? Math.max(...own.map((a) => a.at)) : null
    const succeeded = own.filter((a) => a.ok === 1)
    const lastRefreshAt = succeeded.length > 0 ? Math.max(...succeeded.map((a) => a.at)) : null

    return {
      itemId: item.item_id,
      name: item.institution_name ?? UNNAMED,
      status: statusOf(item, own, lastRefreshAt),
      connectedAt: item.connected_at,
      disconnectedAt: item.disconnected_at,
      lastRefreshAt,
      lastAttemptAt,
      accountCount: counts.get(item.item_id) ?? 0,
      failedProducts: failuresIn(own),
    }
  })
}

/**
 * What went wrong in the newest round, and nothing older.
 *
 * The newest round only, because this describes the last attempt rather than
 * the history — a caveat that lingered after a successful retry would train a
 * friend to ignore it, which is worse than not showing one.
 */
function failuresIn(attempts: AttemptRow[]): string[] {
  if (attempts.length === 0) return []
  const newest = Math.max(...attempts.map((a) => a.at))
  return attempts
    .filter((a) => a.at === newest && a.ok === 0 && a.code !== 'not_ready')
    .map((a) => a.product)
    .sort()
}

/**
 * Precedence, and it is load-bearing in both directions.
 *
 * Disconnected wins over everything: a bank that refreshed successfully an
 * hour before it was revoked is not live, and saying so would put a confident
 * label on frozen numbers.
 *
 * needs_login wins over a plain failure, because it is the only one the friend
 * can act on — a refresh that failed two ways should send them to the door
 * they can actually open.
 */
function statusOf(
  item: ItemRow,
  attempts: AttemptRow[],
  lastRefreshAt: number | null,
): PlaidSourceStatus {
  if (item.disconnected_at !== null) return 'disconnected'
  if (attempts.length === 0) return 'never_refreshed'

  const newest = Math.max(...attempts.map((a) => a.at))
  const current = attempts.filter((a) => a.at === newest)

  if (current.some((a) => a.ok === 0 && a.code === 'item_login_required')) return 'needs_login'
  if (current.some((a) => a.ok === 1)) return 'live'
  // Everything in the newest round failed. `not_ready` alone is not a failure
  // — it means the product is still being prepared — so a round that is only
  // not_ready is treated as "nothing has arrived yet" rather than as broken.
  if (current.every((a) => a.code === 'not_ready')) {
    return lastRefreshAt === null ? 'never_refreshed' : 'live'
  }
  return 'unreachable'
}
