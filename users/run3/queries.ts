// users/run3/queries.ts
//
// Every SQL statement for run3's dashboard. The component holds none —
// data logic in a .tsx file can only be tested by rendering it.
import type { UserDb } from '@/lib/db/userDb'
import { dayKey } from '@/lib/time/dayKey'

export type Transaction = {
  merchant: string
  category: string
  amount_cents: number
  at: number
}

/** A stored transaction with the friend's calendar day already attached. */
export type RecentTransaction = Transaction & { day: string }

/**
 * The most recent transactions, newest first, each labelled with the day it
 * happened on in the FRIEND'S zone.
 *
 * Replace this with run3's real panels, and keep two habits:
 *
 * 1. Anything that needs "today" or "this month" takes it as a PARAMETER.
 *    A query that reads the clock itself is a query whose test passes for
 *    twenty-nine days a month — and it reads the SERVER'S clock, which is
 *    UTC and is not where the friend lives. That bug has already been shipped
 *    once here; see lib/time/dayKey.ts.
 * 2. Dates are turned into days HERE, not in dashboard.tsx. This file may
 *    import `dayKey` and run it over a stored instant; a dashboard may not
 *    import it at all. `tests/users/noLocalDay.test.ts` sweeps both rules over
 *    every user folder, including this template.
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
