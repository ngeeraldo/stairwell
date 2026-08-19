// users/run9/tests/write.test.ts
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
// run9.db is actually created under.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import { applyUserMigrations } from '@/tests/support/userMigrations'
import { countOn, dailyTrend, weeklyAverage } from '@/users/run9/queries'

let db: UserDb

/**
 * The two statements app/api/users/[user]/pee/route.ts runs, reproduced here
 * rather than imported: a platform route must not be imported by a user's test
 * any more than by a user's queries.ts.
 *
 * The limit of that, stated plainly rather than left to be inferred — because
 * these are COPIES, nothing below goes red if the route's own SQL changes.
 * These tests pin the table shape and the round trip from a write of that
 * shape to what queries.ts reads back, NOT that the route still writes it.
 * tests/routing/peeRoute.test.ts is the only thing pinning the route, and it
 * is platform scope by that same boundary. A change to the route's SQL has to
 * be checked in both places.
 */
function add(day: string, at: number): void {
  db.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, at)
}

function remove(day: string): void {
  db.prepare(
    `DELETE FROM pee_logs
       WHERE id = (
         SELECT id FROM pee_logs
          WHERE day = ?
       ORDER BY at DESC, id DESC
          LIMIT 1
       )`,
  ).run(day)
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
  applyUserMigrations(db, 'run9')
})

afterEach(() => {
  db.close()
})

describe('logging', () => {
  it('a tap becomes a count the panel can see', () => {
    add('2026-08-19', 1_000)
    expect(countOn(db, '2026-08-19')).toBe(1)
  })

  it('a SECOND tap on the same day counts twice', () => {
    // The whole contrast with devtwo's `walks`, whose day is a primary key so
    // a second tap is an idempotent no-op. Here a second tap is a second
    // occurrence, and the dashboard is a count of them — a unique constraint
    // would silently discard the thing being counted.
    add('2026-08-19', 1_000)
    add('2026-08-19', 2_000)
    expect(countOn(db, '2026-08-19')).toBe(2)
    expect(rows()).toHaveLength(2)
  })

  it('taps inside the same millisecond are still two rows', () => {
    // Why the table has an id at all. Nothing else separates these.
    add('2026-08-19', 1_000)
    add('2026-08-19', 1_000)
    expect(countOn(db, '2026-08-19')).toBe(2)
  })

  it('a fresh tap moves the trend the chart is handed', () => {
    // The composed product, not the halves.
    add('2026-08-18', 1_000)
    add('2026-08-19', 2_000)
    const before = dailyTrend(db, '2026-08-19')
    expect(before[before.length - 1]!.count).toBe(1)
    add('2026-08-19', 3_000)
    const after = dailyTrend(db, '2026-08-19')
    expect(after[after.length - 1]!.count).toBe(2)
  })
})

describe('correcting a misclick', () => {
  it('removes exactly one row, the most recent of that day', () => {
    add('2026-08-19', 1_000)
    add('2026-08-19', 5_000)
    add('2026-08-19', 3_000)
    remove('2026-08-19')
    expect(countOn(db, '2026-08-19')).toBe(2)
    // The 5_000 one — latest by `at`, not the last inserted.
    expect(rows().map((r) => r.at)).toEqual([1_000, 3_000])
  })

  it('CANNOT take the count below zero', () => {
    // The spec's bound, and it is the statement itself rather than a
    // read-then-write that could race: the subquery selects nothing, so the
    // DELETE is a no-op.
    expect(() => remove('2026-08-19')).not.toThrow()
    expect(countOn(db, '2026-08-19')).toBe(0)
    remove('2026-08-19')
    expect(countOn(db, '2026-08-19')).toBe(0)
  })

  it('ONLY EVER AFFECTS TODAY, never yesterday’s rows', () => {
    // The other half of the spec's bound. A correction that fell through to
    // the previous day when today was empty would silently rewrite history
    // the friend cannot see from this screen.
    add('2026-08-18', 1_000)
    add('2026-08-18', 2_000)
    remove('2026-08-19')
    expect(countOn(db, '2026-08-18')).toBe(2)
    expect(countOn(db, '2026-08-19')).toBe(0)
  })

  it('an add then a remove leaves the panels exactly where they started', () => {
    add('2026-08-18', 1_000)
    add('2026-08-19', 2_000)
    const trendBefore = dailyTrend(db, '2026-08-19')
    const avgBefore = weeklyAverage(db, '2026-08-19')

    add('2026-08-19', 3_000)
    remove('2026-08-19')

    expect(dailyTrend(db, '2026-08-19')).toEqual(trendBefore)
    expect(weeklyAverage(db, '2026-08-19')).toEqual(avgBefore)
  })

  it('does not disturb the baseline, which excludes today anyway', () => {
    add('2026-08-18', 1_000)
    add('2026-08-18', 2_000)
    add('2026-08-19', 3_000)
    const before = weeklyAverage(db, '2026-08-19')
    remove('2026-08-19')
    expect(weeklyAverage(db, '2026-08-19')).toEqual(before)
    expect(before!.average).toBe(2)
  })
})

describe('the first day, end to end', () => {
  it('goes from empty state to a real count on the first tap', () => {
    // What run9 sees on the morning this ships: their own database, empty,
    // then one tap.
    expect(countOn(db, '2026-08-19')).toBe(0)
    expect(dailyTrend(db, '2026-08-19')).toEqual([])
    expect(weeklyAverage(db, '2026-08-19')).toBeNull()

    add('2026-08-19', 1_000)

    expect(countOn(db, '2026-08-19')).toBe(1)
    // Still one day, so still no chart — and still no baseline, because no
    // complete day has elapsed. Both panels stay in their empty states on day
    // one, by design.
    expect(dailyTrend(db, '2026-08-19')).toHaveLength(1)
    expect(weeklyAverage(db, '2026-08-19')).toBeNull()
  })
})
