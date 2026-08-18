// users/run8/tests/queries.test.ts
//
// The conventions sweep proves this folder's SHAPE, never that a query is
// right — a wrong query is a wrong dashboard, and only this file catches it
// (build-rules §10).
//
// Every function takes `today` as a parameter, so every case here is pinned to
// a fixed date. That is the point: a query that read a clock would have tests
// passing for twenty-nine days a month, and would read the DROPLET's clock,
// which is UTC and is not where the friend lives.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserDb } from '@/lib/db/userDb'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  dayTotal,
  firstTrackedDay,
  mondayOf,
  sameDayLastWeek,
  weekDays,
  weeklyAverages,
} from '@/users/run8/queries'

let db: UserDb

// 2026-08-16 is a Sunday; 2026-08-10 is the Monday that starts its week.
const SUNDAY = '2026-08-16'
const MONDAY = '2026-08-10'

function tap(day: string, delta: number, times = 1): void {
  const insert = db.prepare('INSERT INTO pee_events (day, at, delta) VALUES (?, ?, ?)')
  for (let i = 0; i < times; i++) insert.run(day, 1, delta)
}

beforeEach(() => {
  db = emptyDbFromMigrations('run8')
})
afterEach(() => {
  db.close()
})

describe('mondayOf', () => {
  it('starts the week on Monday, which is what run8 confirmed', () => {
    expect(mondayOf('2026-08-16')).toBe(MONDAY) // Sunday → the Monday BEFORE
    expect(mondayOf('2026-08-10')).toBe(MONDAY) // Monday → itself
    expect(mondayOf('2026-08-11')).toBe(MONDAY) // Tuesday
  })

  it('crosses a month boundary correctly', () => {
    // Calendar arithmetic, not string arithmetic: 2026-09-01 is a Tuesday, so
    // its week starts in August.
    expect(mondayOf('2026-09-01')).toBe('2026-08-31')
  })
})

describe('dayTotal', () => {
  it('is zero for a day with no rows', () => {
    // COALESCE, not NULL: SUM over no rows is NULL, and the panel renders this
    // straight into a numeral.
    expect(dayTotal(db, SUNDAY)).toBe(0)
  })

  it('nets minuses against pluses', () => {
    tap(SUNDAY, 1, 5)
    tap(SUNDAY, -1)
    expect(dayTotal(db, SUNDAY)).toBe(4)
  })

  it('counts only the day asked for', () => {
    tap(SUNDAY, 1, 3)
    tap('2026-08-15', 1, 9)
    expect(dayTotal(db, SUNDAY)).toBe(3)
  })
})

describe('weekDays', () => {
  it('returns all seven days, Monday first', () => {
    tap(SUNDAY, 1)
    const days = weekDays(db, SUNDAY)
    expect(days).toHaveLength(7)
    expect(days[0]!.day).toBe(MONDAY)
    expect(days[6]!.day).toBe(SUNDAY)
  })

  it('marks days before the friend started as untracked', () => {
    // The whole point. A day before their first tap is not a day they scored
    // zero, and the panel draws no bar for it.
    tap('2026-08-13', 1, 4) // Thursday is their first ever tap
    const days = weekDays(db, SUNDAY)
    expect(days.map((d) => d.tracked)).toEqual([
      false, false, false, true, true, true, true,
    ])
  })

  it('marks days later this week as untracked', () => {
    // Wednesday is "today"; Thursday onward has not happened.
    tap(MONDAY, 1, 5)
    const days = weekDays(db, '2026-08-12')
    expect(days.map((d) => d.tracked)).toEqual([
      true, true, true, false, false, false, false,
    ])
  })

  it('keeps a real zero on a tracked day', () => {
    // They were using it that day and logged nothing. That is a zero, not an
    // absence — distinct from the untracked cases above.
    tap(MONDAY, 1, 4)
    tap('2026-08-12', 1, 6)
    const days = weekDays(db, '2026-08-12')
    expect(days[1]).toEqual({ day: '2026-08-11', total: 0, tracked: true })
  })

  it('is all untracked on an empty database', () => {
    expect(weekDays(db, SUNDAY).every((d) => !d.tracked)).toBe(true)
  })
})

describe('weeklyAverages', () => {
  it('is empty when nothing has been logged', () => {
    expect(weeklyAverages(db, SUNDAY)).toEqual([])
  })

  it('averages over the days actually logged, not over seven', () => {
    // Two logged days totalling 14 is an average of 7 a day — not 2, which is
    // what dividing by seven would say. A day they forgot to open the app is
    // not a day they went zero times, and this panel answers "how many times a
    // day do I usually go".
    tap(MONDAY, 1, 8)
    tap('2026-08-11', 1, 6)
    expect(weeklyAverages(db, SUNDAY)).toEqual([
      { weekStart: MONDAY, average: 7, days: 2 },
    ])
  })

  it('reports one point per week, oldest first', () => {
    tap('2026-08-03', 1, 6) // the Monday before
    tap(MONDAY, 1, 8)
    const weeks = weeklyAverages(db, SUNDAY)
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-08-03', MONDAY])
  })

  it('is unbounded — as many weeks as we have', () => {
    // run8's confirmed answer, so this is deliberately not a trailing window.
    // Ten Mondays, ten weeks: a trailing-N window would cap this at N.
    const mondays = [
      '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06',
      '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', MONDAY,
    ]
    for (const day of mondays) tap(day, 1, 5)

    const weeks = weeklyAverages(db, SUNDAY)
    expect(weeks).toHaveLength(10)
    expect(weeks[0]!.weekStart).toBe('2026-06-08')
    expect(weeks[9]!.weekStart).toBe(MONDAY)
  })

  it('rounds to one decimal, matching the mockup’s own note', () => {
    // "Averaging 7.7 a day this week" — a whole number would round two
    // visibly different weeks to the same point.
    tap(MONDAY, 1, 8)
    tap('2026-08-11', 1, 7)
    tap('2026-08-12', 1, 8)
    expect(weeklyAverages(db, SUNDAY)[0]!.average).toBe(7.7)
  })

  it('ignores days after today', () => {
    tap(MONDAY, 1, 4)
    tap(SUNDAY, 1, 99) // in the future relative to the `today` below
    expect(weeklyAverages(db, '2026-08-11')).toEqual([
      { weekStart: MONDAY, average: 4, days: 1 },
    ])
  })
})

describe('sameDayLastWeek and firstTrackedDay', () => {
  it('is undefined before the friend started, rather than zero', () => {
    // "last week this day: 0" would report a day they had no dashboard on.
    tap(SUNDAY, 1, 3)
    expect(sameDayLastWeek(db, SUNDAY)).toBeUndefined()
  })

  it('reads the same weekday one week back', () => {
    tap('2026-08-09', 1, 6)
    tap(SUNDAY, 1, 3)
    expect(sameDayLastWeek(db, SUNDAY)).toBe(6)
  })

  it('reports no first day on an empty database', () => {
    expect(firstTrackedDay(db)).toBeUndefined()
  })
})
