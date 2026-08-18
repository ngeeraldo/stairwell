// users/run8/tests/write.test.ts
//
// Per-user tests/ cover write paths, not just rendering (build-rules §4), and
// every case here does BOTH halves — writes through the shape the route writes,
// then reads back through queries.ts. devtwo's headline defect existed only
// where the write path and the read path met: each half was reasonable alone,
// and the composition met a friend with "already done, no control left" on
// handover morning.
//
// ── What these DO NOT cover, stated plainly ────────────────────────────────
//
// The statements below are COPIES of the ones in
// app/api/users/[user]/count/route.ts, reproduced rather than imported: a
// platform route must not be imported by a user's test any more than by a
// user's queries.ts. So nothing here goes red if the route's own SQL changes.
// These pin the table's shape and the round trip out of it; the route itself
// is pinned by tests/routing/countRoute.test.ts, which is platform scope.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserDb } from '@/lib/db/userDb'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'
import { dayTotal, weekDays, weeklyAverages } from '@/users/run8/queries'

let db: UserDb

const TODAY = '2026-08-16'
const MONDAY = '2026-08-10'

/** The route's plus: an unconditional +1 for the friend's own day. */
function plus(day: string): void {
  db.prepare('INSERT INTO pee_events (day, at, delta) VALUES (?, ?, 1)').run(day, 1)
}

/**
 * The route's minus: a -1 guarded INSIDE the insert.
 *
 * The guard is a subquery rather than a SELECT-then-INSERT because a tap is one
 * HTTP request and a friend has two thumbs: two minuses arriving together would
 * both read 1, both decide they may subtract, and land the day at -1.
 */
function minus(day: string): void {
  db.prepare(
    `INSERT INTO pee_events (day, at, delta)
     SELECT ?, ?, -1
     WHERE (SELECT COALESCE(SUM(delta), 0) FROM pee_events WHERE day = ?) > 0`,
  ).run(day, 1, day)
}

function rowCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM pee_events').get() as { n: number }).n
}

beforeEach(() => {
  db = emptyDbFromMigrations('run8')
})
afterEach(() => {
  db.close()
})

describe('the pee_events shape, and what queries.ts reads back out of it', () => {
  it('a tap becomes a count the panel can see', () => {
    plus(TODAY)
    expect(dayTotal(db, TODAY)).toBe(1)
  })

  it('taps accumulate rather than replacing each other', () => {
    // A ledger, not a counter: five taps are five rows.
    for (let i = 0; i < 5; i++) plus(TODAY)
    expect(dayTotal(db, TODAY)).toBe(5)
    expect(rowCount()).toBe(5)
  })

  it('a minus takes one back and stays in the ledger as a row', () => {
    plus(TODAY)
    plus(TODAY)
    minus(TODAY)
    expect(dayTotal(db, TODAY)).toBe(1)
    // Three rows for a net of one — the correction is data, not arithmetic
    // applied and forgotten.
    expect(rowCount()).toBe(3)
  })

  it('a minus at zero writes nothing at all', () => {
    // run8's confirmed answer: a day may not go below zero. The guard lives in
    // the statement, so this is proven by the row NOT existing, not by a
    // clamp applied on read.
    minus(TODAY)
    expect(dayTotal(db, TODAY)).toBe(0)
    expect(rowCount()).toBe(0)
  })

  it('a minus that would cross zero writes nothing', () => {
    plus(TODAY)
    minus(TODAY)
    minus(TODAY)
    expect(dayTotal(db, TODAY)).toBe(0)
    expect(rowCount()).toBe(2)
  })

  it('the day a tap lands on is the only day it affects', () => {
    plus(MONDAY)
    plus(TODAY)
    expect(dayTotal(db, MONDAY)).toBe(1)
    expect(dayTotal(db, TODAY)).toBe(1)
  })

  it('the shape refuses a delta the ledger has no meaning for', () => {
    // CHECK (delta IN (-1, 1)). A widget posting 5 would otherwise write a
    // value every panel would silently display as a five-fold day.
    expect(() =>
      db.prepare('INSERT INTO pee_events (day, at, delta) VALUES (?, ?, ?)').run(TODAY, 1, 5),
    ).toThrow()
  })

  it('the shape refuses a day key that is not a day', () => {
    // The GLOB. devtwo's `day` carries the same contract in a comment only,
    // and holds '1970-01-01 SAMPLE TEST' as a result.
    expect(() =>
      db.prepare('INSERT INTO pee_events (day, at, delta) VALUES (?, ?, 1)').run('today', 1),
    ).toThrow()
  })

  it('a first tap turns an untracked week into a tracked one', () => {
    // The composed product: before the write every day is untracked and the
    // panel says "nothing logged yet"; after it, the day the tap landed on is
    // drawn and the days before it are still not.
    expect(weekDays(db, TODAY).every((d) => !d.tracked)).toBe(true)

    plus('2026-08-13')

    const days = weekDays(db, TODAY)
    expect(days.filter((d) => d.tracked).map((d) => d.day)).toEqual([
      '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16',
    ])
  })

  it('a tap moves the weekly average the toggle renders', () => {
    plus(MONDAY)
    expect(weeklyAverages(db, TODAY)).toEqual([
      { weekStart: MONDAY, average: 1, days: 1 },
    ])

    for (let i = 0; i < 5; i++) plus(MONDAY)
    expect(weeklyAverages(db, TODAY)[0]!.average).toBe(6)
  })
})
