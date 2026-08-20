// users/run10/tests/write.test.ts
//
// Per-user tests/ must cover write paths, not just rendering. queries.test.ts
// covers the reads and dashboard.test.ts covers the screen; this covers the
// shape a write lands in and what the panels read back out of it.
//
// EVERY TEST HERE DOES BOTH HALVES — writes through the shape, then reads back
// through queries.ts — because the defect this convention exists for lives
// only where a write path and a read path meet. The step-6a ledger's headline
// bug was exactly that: devtwo's seed always marked today walked and its
// dashboard hid the tap control once today was walked, each half correct
// alone, the composition leaving a friend unable to log anything on handover
// morning. Reviewing either in isolation could not have found it.
//
// Built from the migrations, not from synthetic.db: the point is the shape
// run10.db is actually created under.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import { applyUserMigrations } from '@/tests/support/userMigrations'
import { countOn, dailyAverage, dailyTrend } from '@/users/run10/queries'

let db: UserDb

/**
 * The single statement app/api/users/[user]/pee-log/route.ts runs, reproduced
 * here rather than imported: a platform route must not be imported by a user's
 * test any more than by a user's queries.ts.
 *
 * The limit of that, stated plainly rather than left to be inferred — because
 * this is a COPY, nothing below goes red if the route's own SQL changes. These
 * tests pin the table shape and the round trip from a write of that shape to
 * what queries.ts reads back, NOT that the route still writes it.
 * tests/routing/peeLogRoute.test.ts is the only thing pinning the route, and
 * it is platform scope by that same boundary. A change to the route's SQL has
 * to be checked in both places.
 */
function tap(day: string, at: number): void {
  db.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, at)
}

function rows(): { id: number; day: string; at: number }[] {
  return db.prepare('SELECT id, day, at FROM pee_logs ORDER BY id').all() as {
    id: number
    day: string
    at: number
  }[]
}

beforeEach(() => {
  db = new Database(':memory:')
  applyUserMigrations(db, 'run10')
})

afterEach(() => {
  db.close()
})

describe('logging a pee', () => {
  it('a tap becomes a count the panel can see', () => {
    tap('2026-08-20', 1_000)
    expect(countOn(db, '2026-08-20')).toBe(1)
  })

  it('a SECOND tap on the same day counts twice', () => {
    // The whole reason this table has no unique key on `day`. A shape keyed by
    // day makes the second tap an idempotent no-op, which is right for "walked
    // today" and wrong for a counter: it would silently discard the thing
    // being counted, and this dashboard is nothing but the count.
    tap('2026-08-20', 1_000)
    tap('2026-08-20', 2_000)
    expect(countOn(db, '2026-08-20')).toBe(2)
    expect(rows()).toHaveLength(2)
  })

  it('taps inside the same millisecond are still two rows', () => {
    // Why the table declares an id at all. Nothing else separates these.
    tap('2026-08-20', 1_000)
    tap('2026-08-20', 1_000)
    expect(countOn(db, '2026-08-20')).toBe(2)
    expect(rows()).toHaveLength(2)
    expect(rows()[0]!.id).not.toBe(rows()[1]!.id)
  })

  it('a tap files under the day it names, and nothing else moves', () => {
    // The midnight reset, from the write side: yesterday's number is settled
    // the moment the day key changes, with no job to run and nothing to reset.
    tap('2026-08-19', 1_000)
    tap('2026-08-20', 2_000)
    expect(countOn(db, '2026-08-19')).toBe(1)
    expect(countOn(db, '2026-08-20')).toBe(1)
  })
})

describe('a fresh tap moves both panels, together', () => {
  it('adds to today’s bar in the trend the chart is handed', () => {
    // The composed product, not the halves.
    tap('2026-08-19', 1_000)
    tap('2026-08-20', 2_000)
    const before = dailyTrend(db, '2026-08-20')
    expect(before[before.length - 1]!.count).toBe(1)

    tap('2026-08-20', 3_000)
    const after = dailyTrend(db, '2026-08-20')
    expect(after[after.length - 1]!.count).toBe(2)
  })

  it('moves the average with it, because the average IS those bars', () => {
    // What the friend sees when they tap: the count, the bar and the line all
    // land together. (3 + 1) / 2 = 2, then (3 + 2) / 2 = 2.5.
    tap('2026-08-19', 1_000)
    tap('2026-08-19', 1_100)
    tap('2026-08-19', 1_200)
    tap('2026-08-20', 2_000)
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))).toEqual({ average: 2, days: 2 })

    tap('2026-08-20', 3_000)
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))).toEqual({ average: 2.5, days: 2 })
  })

  it('starts the whole dashboard from the very first tap', () => {
    // The transition out of the empty state, end to end: before it there is
    // nothing to chart and no average at all; after it there is exactly one
    // day, which is still not a chart but is no longer nothing.
    expect(countOn(db, '2026-08-20')).toBe(0)
    expect(dailyTrend(db, '2026-08-20')).toEqual([])
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))).toBeNull()

    tap('2026-08-20', 1_000)
    expect(countOn(db, '2026-08-20')).toBe(1)
    expect(dailyTrend(db, '2026-08-20')).toHaveLength(1)
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))).toEqual({ average: 1, days: 1 })
  })

  it('never back-fills the days before the first tap', () => {
    // The pre-existence rule, asserted from the write side: a first tap on a
    // Thursday does not retroactively create six zero days the friend could
    // not have filled.
    tap('2026-08-20', 1_000)
    expect(dailyTrend(db, '2026-08-20').map((d) => d.day)).toEqual(['2026-08-20'])
  })
})
