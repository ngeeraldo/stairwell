// users/devone/queries.ts
//
// Every SQL statement for devone's dashboard. The component holds none: data
// logic that lives in a .tsx file can only be tested by rendering, and the
// month-boundary cases below are the reason that matters.
import type { UserDb } from '@/lib/db/userDb'

export type Transaction = {
  merchant: string
  category: string
  amount_cents: number
  at: number
}

/**
 * [start, end) for the calendar month containing `now`, in the host timezone.
 *
 * `now` is a PARAMETER. A query that reads the clock itself is a query whose
 * test passes for twenty-nine days a month and cannot be made to fail on the
 * thirtieth.
 */
export function monthRange(now: number): { start: number; end: number } {
  const d = new Date(now)
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
  }
}

/** Total spent on eating out inside the calendar month containing `now`. */
export function eatingOutThisMonthCents(db: UserDb, now: number): number {
  const { start, end } = monthRange(now)
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM transactions
        WHERE category = 'eating out'
          AND at >= ? AND at < ?`,
    )
    .get(start, end) as { total: number }
  return row.total
}

/** The most recent transactions, newest first. */
export function recentTransactions(db: UserDb, limit = 10): Transaction[] {
  return db
    .prepare(
      `SELECT merchant, category, amount_cents, at
         FROM transactions
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as Transaction[]
}
