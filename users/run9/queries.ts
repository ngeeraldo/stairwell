// users/run9/queries.ts
//
// Every SQL statement for run9's dashboard. EMPTY, because no shape has
// been designed yet — see ./migrations/README.md.
//
// The component holds none of this: data logic in a .tsx file can only be
// tested by rendering it. Each query is a pure function taking the `UserDb`
// handle the page opened, so a test can hand it a database it built itself.
//
// ─── two habits to keep, whatever you write here ───
//
// 1. ANYTHING THAT NEEDS "TODAY" OR "THIS MONTH" TAKES IT AS A PARAMETER.
//    A query that reads the clock is a query whose test passes for
//    twenty-nine days a month — and it reads the SERVER'S clock, which is UTC
//    and is not where the friend lives. That bug has already shipped here
//    once; see docs/superpowers/ledgers/friend-timezone.md.
//
// 2. DATES BECOME DAYS HERE, NOT IN dashboard.tsx. This file MAY import
//    `dayKey` from lib/time/dayKey and run it over a STORED instant —
//    converting a timestamp a row already holds into the friend's calendar
//    day is legitimate. A dashboard.tsx may not import it at all.
//    tests/users/noLocalDay.test.ts sweeps both rules over every user folder.
//
// A worked example of both: users/devone/queries.ts.
//
// import { dayKey } from '@/lib/time/dayKey'
// import type { UserDb } from '@/lib/db/userDb'
//
// export function recentEntries(db: UserDb, timeZone: string | undefined) {
//   const rows = db.prepare('SELECT ... ORDER BY at DESC LIMIT 10').all()
//   return rows.map((r) => ({ ...r, day: dayKey(r.at, timeZone) }))
// }

export {}
