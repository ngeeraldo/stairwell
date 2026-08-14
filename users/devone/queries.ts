// users/devone/queries.ts
//
// Every SQL statement for devone's dashboard. The component holds none: data
// logic that lives in a .tsx file can only be tested by rendering, and the
// month-boundary cases below are the reason that matters.
import type { UserDb } from '@/lib/db/userDb'
import { dayKey } from '@/lib/time/dayKey'

export type Transaction = {
  merchant: string
  category: string
  amount_cents: number
  at: number
}

/**
 * A stored transaction with the friend's calendar day already attached.
 *
 * The day is computed HERE rather than in the component, and that is a rule
 * rather than a preference: `dashboard.tsx` may not import `dayKey` at all
 * (tests/users/noLocalDay.test.ts), because a dashboard that can format a day
 * is a dashboard that will eventually format one from a clock. Everything a
 * component renders as a date arrives already resolved.
 */
export type RecentTransaction = Transaction & { day: string }

/**
 * A GENEROUS instant window around the month `today` falls in — a prefilter,
 * not the answer.
 *
 * It deliberately over-selects by two days at each end. The precise question —
 * "is this transaction in the friend's calendar month" — cannot be asked in
 * SQL, because SQLite has no zone-aware formatting, and answering it in
 * instants would mean converting "midnight on the 1st in Asia/Kathmandu" to
 * epoch milliseconds. That is the hard direction: it needs the zone's offset
 * at a local midnight that, on a spring-forward date, may not exist at all.
 *
 * So this narrows, and `eatingOutThisMonthCents` decides. Two days covers every
 * real UTC offset (−12 to +14) with room to spare, and at pilot volumes the
 * over-selection is a handful of rows.
 *
 * `today` is a PARAMETER, and so is the zone. A query that reads the clock
 * itself is a query whose test passes for twenty-nine days a month and cannot
 * be made to fail on the thirtieth — and, as this project found out the hard
 * way, it reads the SERVER's clock rather than the friend's.
 */
export function monthWindow(today: string): { start: number; end: number } {
  const [year, month] = today.split('-').map(Number)
  const DAY = 86_400_000
  return {
    start: Date.UTC(year!, month! - 1, 1) - 2 * DAY,
    end: Date.UTC(year!, month!, 1) + 2 * DAY,
  }
}

/**
 * Total spent on eating out in the friend's calendar month containing `today`.
 *
 * The window above narrows; this filters exactly, by turning each stored
 * instant into the friend's day and comparing the YYYY-MM prefix. That is the
 * legitimate use of `dayKey` inside a user's queries file — a stored instant,
 * never a clock — and `tests/users/noLocalDay.test.ts` allows it explicitly
 * for this reason.
 */
export function eatingOutThisMonthCents(
  db: UserDb,
  today: string,
  timeZone: string | undefined,
): number {
  const { start, end } = monthWindow(today)
  const rows = db
    .prepare(
      `SELECT amount_cents, at
         FROM transactions
        WHERE category = 'eating out'
          AND at >= ? AND at < ?`,
    )
    .all(start, end) as { amount_cents: number; at: number }[]

  const month = today.slice(0, 7)
  return rows
    .filter((r) => dayKey(r.at, timeZone).slice(0, 7) === month)
    .reduce((total, r) => total + r.amount_cents, 0)
}

/**
 * The most recent transactions, newest first, each labelled with the day it
 * happened on in the friend's zone.
 *
 * The label and the month total above now come from the same zone, which is
 * the point: the previous version formatted rows from the host's local
 * calendar and bucketed the month from the host's local calendar, so the two
 * agreed with each other and both disagreed with the friend reading them.
 */
export function recentTransactions(
  db: UserDb,
  timeZone: string | undefined,
  limit = 10,
): RecentTransaction[] {
  const rows = db
    .prepare(
      `SELECT merchant, category, amount_cents, at
         FROM transactions
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as Transaction[]
  return rows.map((t) => ({ ...t, day: dayKey(t.at, timeZone) }))
}
