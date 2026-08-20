// users/run10/tests/queries.test.ts
//
// The arithmetic behind run10's two panels: today's count, the seven bars, and
// the average drawn across them. dashboard.test.ts proves those reach a
// screen; this proves they are right.
//
// Fixtures are built from users/run10/migrations/, never from synthetic.db —
// the point is the shape run10.db is actually created under, and a fixture at
// exact day keys is the only way to assert a window's edges.
//
// THE HEADLINE PROPERTY IS THE CLIP. A day before run10 started is not a day
// they logged nothing (docs/dashboard-ui-ux-guidelines.md, "Pre-existence
// days"), and the difference between clipping and padding is invisible to a
// test that only ever seeds a full fortnight — so several tests below seed one
// or two days deliberately.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import { applyUserMigrations, emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  TREND_DAYS,
  countOn,
  dailyAverage,
  dailyTrend,
  firstLoggedDay,
} from '@/users/run10/queries'

let db: UserDb

beforeEach(() => {
  db = new Database(':memory:')
  applyUserMigrations(db, 'run10')
})

afterEach(() => {
  db.close()
})

/** `n` taps on `day`, an hour apart, the way a real day of tapping arrives. */
function seed(day: string, n: number): void {
  const at = Date.parse(`${day}T07:00:00Z`)
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, at + i * 3_600_000)
  }
}

describe('countOn — the number at the top of the screen', () => {
  it('is zero on a database with nothing in it', () => {
    const empty = emptyDbFromMigrations('run10')
    try {
      expect(countOn(empty, '2026-08-20')).toBe(0)
    } finally {
      empty.close()
    }
  })

  it('counts every tap of that day, not distinct days', () => {
    // The whole reason `pee_logs` has no unique constraint: this dashboard is
    // a count of occurrences, and a day holds several.
    seed('2026-08-20', 4)
    expect(countOn(db, '2026-08-20')).toBe(4)
  })

  it('counts THAT day only — this is the midnight reset', () => {
    // The spec's "resets to zero at midnight local time". There is no job and
    // no rollover offset: the count for a new day is zero because no row
    // carries that key yet.
    seed('2026-08-19', 6)
    expect(countOn(db, '2026-08-20')).toBe(0)
    expect(countOn(db, '2026-08-19')).toBe(6)
  })
})

describe('firstLoggedDay — the proxy for when this dashboard was born', () => {
  it('is null before anything has ever been logged', () => {
    expect(firstLoggedDay(db)).toBeNull()
  })

  it('is the earliest day holding a row, whatever order they arrived in', () => {
    seed('2026-08-20', 1)
    seed('2026-08-14', 1)
    seed('2026-08-17', 1)
    expect(firstLoggedDay(db)).toBe('2026-08-14')
  })
})

describe('dailyTrend — the bars', () => {
  it('is empty on an empty database, so no chart is ever mounted over nothing', () => {
    expect(dailyTrend(db, '2026-08-20')).toEqual([])
  })

  it('CLIPS at the first logged day rather than padding the window with zeros', () => {
    // devtwo shipped the unclipped version and told a friend on their first
    // morning that they had missed each of the previous fourteen days, with
    // every test green (onboarding ledger D16). Two logged days must produce
    // two bars, not seven.
    seed('2026-08-19', 5)
    seed('2026-08-20', 3)
    const trend = dailyTrend(db, '2026-08-20')
    expect(trend.map((d) => d.day)).toEqual(['2026-08-19', '2026-08-20'])
  })

  it('gives exactly one bar on the very first day', () => {
    seed('2026-08-20', 2)
    expect(dailyTrend(db, '2026-08-20')).toHaveLength(1)
  })

  it('returns TREND_DAYS bars, oldest first, once the history is old enough', () => {
    for (let back = 0; back < 10; back++) {
      seed(`2026-08-${String(20 - back).padStart(2, '0')}`, 1)
    }
    const trend = dailyTrend(db, '2026-08-20')
    expect(trend).toHaveLength(TREND_DAYS)
    expect(trend[0]!.day).toBe('2026-08-14')
    expect(trend[trend.length - 1]!.day).toBe('2026-08-20')
  })

  it('excludes the day just outside the window, and includes its first day', () => {
    // The edge, asserted from both sides. Seeding only the boundary days is
    // what makes an off-by-one visible: a window one day too wide picks up the
    // 13th, one day too narrow drops the 14th.
    seed('2026-08-13', 9)
    seed('2026-08-14', 4)
    seed('2026-08-20', 2)
    const trend = dailyTrend(db, '2026-08-20')
    expect(trend.map((d) => d.day)).not.toContain('2026-08-13')
    expect(trend.find((d) => d.day === '2026-08-14')!.count).toBe(4)
  })

  it('renders a day inside the range with no rows as a real zero, not a gap', () => {
    // A day they had the dashboard and did not log IS data. The chart has to
    // draw it as a zero bar rather than omit it and shift the others along.
    seed('2026-08-18', 5)
    seed('2026-08-20', 3)
    const trend = dailyTrend(db, '2026-08-20')
    expect(trend.map((d) => [d.day, d.count])).toEqual([
      ['2026-08-18', 5],
      ['2026-08-19', 0],
      ['2026-08-20', 3],
    ])
  })

  it('never counts a day past today, even when rows exist for one', () => {
    // A row filed from a device a day ahead, or a clock that moved. The window
    // ends at the day the page was rendered for.
    seed('2026-08-20', 2)
    seed('2026-08-21', 4)
    const trend = dailyTrend(db, '2026-08-20')
    expect(trend.map((d) => d.day)).not.toContain('2026-08-21')
  })

  it('crosses a month boundary correctly', () => {
    // `shift` is calendar arithmetic over a day string, and the only place it
    // can go wrong is where the month does.
    seed('2026-02-26', 1)
    seed('2026-03-01', 2)
    const trend = dailyTrend(db, '2026-03-01')
    expect(trend.map((d) => d.day)).toEqual([
      '2026-02-26',
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ])
  })

  it('labels today as "Today" and the rest by weekday', () => {
    // Relative inside the week, per the formatting guidelines. 2026-08-20 is a
    // Thursday, so the 19th is Wednesday.
    seed('2026-08-19', 1)
    seed('2026-08-20', 1)
    const trend = dailyTrend(db, '2026-08-20')
    expect(trend.map((d) => d.label)).toEqual(['Wed', 'Today'])
  })
})

describe('dailyAverage — the number alongside the chart', () => {
  it('is null on an empty trend, because the average of no days is not zero', () => {
    expect(dailyAverage([])).toBeNull()
  })

  it('averages exactly the bars it is handed, TODAY INCLUDED', () => {
    // The spec asks for "the daily average across those seven days" — the ones
    // charted — so today is one of them. (run9 excludes today; its spec asked
    // for a baseline to read the trend against, a different question.)
    seed('2026-08-19', 8)
    seed('2026-08-20', 2)
    const trend = dailyTrend(db, '2026-08-20')
    expect(dailyAverage(trend)).toEqual({ average: 5, days: 2 })
  })

  it('counts a zero day in the denominator', () => {
    // A day they had the dashboard and logged nothing belongs in the average.
    // Dividing by rows-bearing days instead would report their average as if
    // the blank day had not happened: 8 over two days is 4, not 8.
    seed('2026-08-19', 8)
    seed('2026-08-20', 0)
    seed('2026-08-21', 0)
    seed('2026-08-22', 0)
    const trend = dailyTrend(db, '2026-08-22')
    expect(trend).toHaveLength(4)
    expect(dailyAverage(trend)).toEqual({ average: 2, days: 4 })
  })

  it('keeps ONE decimal — enough to separate two neighbouring weeks, no more', () => {
    seed('2026-08-18', 6)
    seed('2026-08-19', 7)
    seed('2026-08-20', 7)
    // 20 / 3 = 6.666…
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))!.average).toBe(6.7)
  })

  it('reports the CLIPPED denominator during the first week, not seven', () => {
    // What the caption says out loud. A panel labelled "last 7 days" that
    // quietly averaged two days would be lying about its own basis.
    seed('2026-08-19', 4)
    seed('2026-08-20', 6)
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))!.days).toBe(2)
    expect(dailyAverage(dailyTrend(db, '2026-08-20'))!.days).toBeLessThan(TREND_DAYS)
  })

  it('can never disagree with the bars the chart draws', () => {
    // THE REASON dailyAverage TAKES THE TREND RATHER THAN THE DATABASE. The
    // average is drawn as a reference line ON the chart, so a second query
    // could put the line somewhere the bars contradict while both were
    // individually correct. Asserted as a property over the same array the
    // component hands to TrendChart.
    seed('2026-08-14', 3)
    seed('2026-08-16', 9)
    seed('2026-08-17', 1)
    seed('2026-08-20', 5)
    const trend = dailyTrend(db, '2026-08-20')
    const result = dailyAverage(trend)!
    const mean = trend.reduce((sum, d) => sum + d.count, 0) / trend.length
    expect(result.days).toBe(trend.length)
    expect(result.average).toBe(Math.round(mean * 10) / 10)
  })
})
