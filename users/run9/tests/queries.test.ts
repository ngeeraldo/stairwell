// users/run9/tests/queries.test.ts
//
// The reads behind run9's four panels. Built from the migrations, never from
// synthetic.db: the point is the shape a real write lands in (the one run9.db
// is created under), not whatever seed.py happened to generate this run.
//
// THE HEADLINE ASSERTIONS ARE THE PRE-EXISTENCE ONES. Everything else here is
// arithmetic; those are the ones guarding a defect this project has already
// shipped to a friend's first morning (docs/superpowers/ledgers/onboarding.md
// D16, and docs/dashboard-ui-ux-guidelines.md "Pre-existence days"). A dashboard
// that pads its window with confident zeros passes every test that only checks
// totals.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import { applyUserMigrations } from '@/tests/support/userMigrations'
import {
  TREND_DAYS,
  countOn,
  dailyTrend,
  firstLoggedDay,
  weeklyAverage,
} from '@/users/run9/queries'

let db: UserDb

/**
 * `n` logs on `day`, an hour apart.
 *
 * The exact statement the pee route runs on a tap, reproduced rather than
 * imported: a platform route must not be imported by a user's test any more
 * than by a user's queries.ts. The limit of that, stated plainly — because
 * this is a COPY, nothing here goes red if the route's own SQL changes.
 * tests/routing/peeRoute.test.ts is what pins the route.
 */
function log(day: string, n: number): void {
  const at = Date.parse(`${day}T08:00:00Z`)
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, at + i * 3_600_000)
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  applyUserMigrations(db, 'run9')
})

afterEach(() => {
  db.close()
})

describe('countOn', () => {
  it('counts only the day asked for', () => {
    log('2026-08-18', 3)
    log('2026-08-19', 5)
    expect(countOn(db, '2026-08-19')).toBe(5)
  })

  it('is zero on a day with no rows, and on an empty database', () => {
    expect(countOn(db, '2026-08-19')).toBe(0)
    log('2026-08-18', 2)
    expect(countOn(db, '2026-08-19')).toBe(0)
  })
})

describe('firstLoggedDay', () => {
  it('is null before anything is ever logged', () => {
    expect(firstLoggedDay(db)).toBeNull()
  })

  it('is the earliest day holding a row, whatever order they arrived in', () => {
    log('2026-08-19', 1)
    log('2026-08-14', 1)
    log('2026-08-17', 1)
    expect(firstLoggedDay(db)).toBe('2026-08-14')
  })
})

describe('dailyTrend — the pre-existence rule', () => {
  it('is empty on an empty database, so no chart is ever mounted over nothing', () => {
    expect(dailyTrend(db, '2026-08-19')).toEqual([])
  })

  it('NEVER reports days before the first log as zeros', () => {
    // THE ONE THAT MATTERS. devtwo shipped the unclipped version of this and
    // told a friend on their first morning that they had missed each of the
    // previous fourteen days — a day before they started is not a day they
    // failed. An implementation that pads the window to TREND_DAYS passes
    // every other test in this file.
    log('2026-08-19', 4)
    const trend = dailyTrend(db, '2026-08-19')
    expect(trend).toHaveLength(1)
    expect(trend[0]!.day).toBe('2026-08-19')
  })

  it('grows a day at a time until the window is full, then stops', () => {
    log('2026-08-17', 1)
    expect(dailyTrend(db, '2026-08-17')).toHaveLength(1)
    expect(dailyTrend(db, '2026-08-18')).toHaveLength(2)
    expect(dailyTrend(db, '2026-08-23')).toHaveLength(TREND_DAYS)
    // Older rows do not widen it past the window.
    log('2026-08-01', 3)
    expect(dailyTrend(db, '2026-08-23')).toHaveLength(TREND_DAYS)
  })

  it('renders a zero INSIDE the logged range, which is real data', () => {
    // Different in kind from the case above: he had the dashboard on the 18th
    // and did not log. That day belongs in the chart as a zero.
    log('2026-08-17', 2)
    log('2026-08-19', 3)
    const trend = dailyTrend(db, '2026-08-19')
    expect(trend.map((d) => [d.day, d.count])).toEqual([
      ['2026-08-17', 2],
      ['2026-08-18', 0],
      ['2026-08-19', 3],
    ])
  })

  it('is oldest first, with today last', () => {
    log('2026-08-15', 1)
    log('2026-08-19', 1)
    const trend = dailyTrend(db, '2026-08-19')
    expect(trend[0]!.day).toBe('2026-08-15')
    expect(trend[trend.length - 1]!.day).toBe('2026-08-19')
  })

  it('crosses a month boundary correctly', () => {
    log('2026-07-30', 2)
    const trend = dailyTrend(db, '2026-08-02')
    expect(trend.map((d) => d.day)).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ])
  })

  it('labels today as Today and the rest by weekday', () => {
    log('2026-08-17', 1) // a Monday
    log('2026-08-19', 1)
    const trend = dailyTrend(db, '2026-08-19')
    expect(trend[0]!.label).toBe('Mon')
    expect(trend[trend.length - 1]!.label).toBe('Today')
  })
})

describe('weeklyAverage — the baseline today is read against', () => {
  it('is null before anything is logged', () => {
    expect(weeklyAverage(db, '2026-08-19')).toBeNull()
  })

  it('is null on the first day, when no complete day has elapsed', () => {
    log('2026-08-19', 6)
    expect(weeklyAverage(db, '2026-08-19')).toBeNull()
  })

  it('EXCLUDES today, so the baseline does not move while he logs', () => {
    // Nico's ruling, 2026-08-19. The spec calls this a baseline to read the
    // daily trend against; one that included the partial day being measured
    // would drop every morning and compare today partly against itself.
    log('2026-08-18', 6)
    log('2026-08-19', 1)
    const before = weeklyAverage(db, '2026-08-19')
    log('2026-08-19', 9) // ten logged today now
    expect(weeklyAverage(db, '2026-08-19')).toEqual(before)
    expect(before!.average).toBe(6)
  })

  it('divides by ELAPSED days, not by days that happen to have rows', () => {
    // A day he had the dashboard and logged nothing is a zero that belongs in
    // the average. Dividing by rows-bearing days instead would report his
    // average as if the blank days had not happened — 6 rather than 3.
    log('2026-08-17', 6)
    log('2026-08-18', 0) // no-op, stated for the reader
    log('2026-08-19', 99)
    const avg = weeklyAverage(db, '2026-08-19')
    expect(avg).toEqual({ average: 3, days: 2 })
  })

  it('averages only the days since the first log, and says how many', () => {
    log('2026-08-18', 4)
    log('2026-08-19', 1)
    // One complete day exists (the 18th), not seven.
    expect(weeklyAverage(db, '2026-08-19')).toEqual({ average: 4, days: 1 })
  })

  it('looks back no further than the window, once it is full', () => {
    for (let d = 10; d <= 19; d++) log(`2026-08-${d}`, 2)
    // The seven complete days before today: the 12th through the 18th.
    expect(weeklyAverage(db, '2026-08-19')).toEqual({ average: 2, days: TREND_DAYS })
  })

  it('reports one decimal rather than a rounded whole number', () => {
    log('2026-08-17', 5)
    log('2026-08-18', 6)
    log('2026-08-19', 1)
    // 11 over two complete days.
    expect(weeklyAverage(db, '2026-08-19')!.average).toBe(5.5)
  })
})

// ─── on the timezone assertion this file does NOT make ───
//
// The scaffold's parting comment asks for "one instant, two zones, two
// different rendered days", and it does not apply here — not because the rule
// is relaxed but because run9's reads never touch a zone. `pee_logs.day` is
// resolved in the FRIEND'S zone at WRITE time and stored (see
// migrations/001_initial.sql), so every function above takes a day key as a
// parameter and does pure string/calendar arithmetic over it. There is no
// stored instant for a zone to reinterpret, which is the whole reason the day
// is a column.
//
// The zone-sensitive step is therefore the route, and that assertion lives in
// tests/routing/peeRoute.test.ts, where it can be made against the thing that
// actually calls dayKey.
