// users/run11/tests/walkLog.test.ts
//
// Spec v2's second screen, proved where its behaviour actually lives.
//
// The Walk log has three panels and one table, and every rule that makes it
// right is arithmetic in users/run11/queries.ts: what breaks a streak, what the
// percentage divides by, which square is in the future. The component renders
// whatever these return, so a wrong rule here is a wrong dashboard that still
// renders perfectly (2026-08-12 hosting design §11.5).
//
// EVERY DAY IN THIS FILE IS A LITERAL. Nothing here reads a clock: `today` is
// a parameter everywhere precisely so a test can sit on a Thursday in August
// on any machine, on any day of the year.
//
// THE WRITE PATH IS REPRODUCED HERE, NOT IMPORTED. A user's own test must not
// import a platform route (users/run10/tests/write.test.ts sets the precedent),
// so the INSERT and DELETE below are written out to match
// app/api/users/[user]/walk-log/route.ts. tests/routing/walkLogRoute.test.ts is
// the other half and pins the real route; this half pins that the queries above
// read what that shape of write leaves behind.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3-multiple-ciphers'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  CALENDAR_HISTORY_MONTHS,
  WALK_RATE_DAYS,
  WEEKDAY_LABELS,
  calendarGrid,
  currentStreak,
  daysBetween,
  earliestMonth,
  markedDays,
  monthDays,
  monthLabel,
  monthOf,
  shiftMonth,
  walkRate,
} from '@/users/run11/queries'

// A Thursday, so a week's worth of arithmetic below is checkable by hand.
const TODAY = '2026-08-20'

let db: Database.Database

beforeEach(() => {
  db = emptyDbFromMigrations('run11')
})
afterEach(() => {
  db.close()
})

/** Exactly what the walk-log route's `mark` arm does. */
function mark(day: string, at = 0) {
  db.prepare('INSERT OR IGNORE INTO walk_log (day, at) VALUES (?, ?)').run(day, at)
}

/** Exactly what its `unmark` arm does. */
function unmark(day: string) {
  db.prepare('DELETE FROM walk_log WHERE day = ?').run(day)
}

/** `n` days before TODAY, as a day key. */
function ago(n: number): string {
  const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000)
  return d.toISOString().slice(0, 10)
}

describe('users/run11 — the walk log table', () => {
  it('reads back nothing at all on an empty log', () => {
    // The first session. Not an error, and every panel has to survive it.
    expect(markedDays(db)).toEqual([])
  })

  it('returns marked days ASCENDING, which every panel depends on', () => {
    // The streak walks backwards from the end, walkRate takes days[0] as the
    // first mark, and earliestMonth takes days[0] too. All three would be
    // wrong in different ways under a different order, so the order is
    // asserted directly rather than implied by the panels that need it.
    mark('2026-08-18')
    mark('2026-08-10')
    mark('2026-08-19')
    expect(markedDays(db)).toEqual(['2026-08-10', '2026-08-18', '2026-08-19'])
  })

  it('treats a second mark of the same day as the SAME FACT, not a second row', () => {
    // spec v2: "One walk per day is all that's recorded; there's no count of
    // walks within a day." Idempotent by primary key, so a double tap cannot
    // double-count — the opposite call from run10, whose taps are occurrences.
    mark('2026-08-19', 100)
    mark('2026-08-19', 200)
    expect(markedDays(db)).toEqual(['2026-08-19'])
    // The FIRST mark's instant survives. A second tap is a no-op, not an
    // overwrite, so nothing about the original entry moves.
    expect(db.prepare('SELECT at FROM walk_log WHERE day = ?').get('2026-08-19')).toEqual({
      at: 100,
    })
  })

  it('unmarks a day, and unmarking an unmarked day is a no-op', () => {
    // spec v2: "Tapping an already-marked day unmarks it, so a mis-tap is
    // recoverable." The no-op half matters because the friend's intent is
    // "this day should not be marked" — whether it already was is not
    // something he should have to be right about.
    mark('2026-08-19')
    unmark('2026-08-19')
    expect(markedDays(db)).toEqual([])
    expect(() => unmark('2026-08-19')).not.toThrow()
    expect(markedDays(db)).toEqual([])
  })
})

describe('users/run11 — current streak', () => {
  it('is zero on an empty log, and says nothing else', () => {
    expect(currentStreak([], TODAY)).toEqual({ days: 0, throughYesterday: false })
  })

  it('counts a run ending TODAY, including today', () => {
    const days = [ago(2), ago(1), ago(0)]
    expect(currentStreak(days, TODAY)).toEqual({ days: 3, throughYesterday: false })
  })

  it('does NOT drop to zero when today is not marked yet', () => {
    // THE EDGE spec v2 asks to have decided: "a day with no mark yet should not
    // break a streak built up through yesterday — show the streak as it stands
    // through yesterday rather than dropping it to zero the moment the day
    // rolls over." He marks from his desk later in the day; a streak that
    // reset at midnight would be punishing him for a day that is not over.
    const days = [ago(3), ago(2), ago(1)]
    expect(currentStreak(days, TODAY)).toEqual({ days: 3, throughYesterday: true })
  })

  it('ends the run when BOTH today and yesterday are unmarked', () => {
    // A real zero, and a genuinely different thing from the empty log above:
    // the run is over. Two clear days is the earliest that can be true.
    const days = [ago(4), ago(3), ago(2)]
    expect(currentStreak(days, TODAY)).toEqual({ days: 0, throughYesterday: false })
  })

  it('counts one day when only today is marked', () => {
    expect(currentStreak([TODAY], TODAY)).toEqual({ days: 1, throughYesterday: false })
  })

  it('stops at a GAP rather than counting every mark it can see', () => {
    // The whole difference between a streak and a count. Six marks, a hole
    // three days back, and the answer is three.
    const days = [ago(9), ago(8), ago(7), ago(2), ago(1), ago(0)]
    expect(currentStreak(days, TODAY).days).toBe(3)
  })

  it('crosses a MONTH boundary, which is where naive day arithmetic breaks', () => {
    // 2026-08-01 back through 2026-07-30. A streak computed by subtracting
    // date-of-month numbers would report 1 here.
    const days = ['2026-07-30', '2026-07-31', '2026-08-01']
    expect(currentStreak(days, '2026-08-01')).toEqual({ days: 3, throughYesterday: false })
  })

  it('ignores marks AFTER today rather than starting the run in the future', () => {
    // Unreachable through the route, which refuses a future day — but a friend
    // who flies west far enough moves his own calendar backwards, and a streak
    // that counted tomorrow would be a number he cannot explain.
    const days = [ago(1), TODAY, '2026-08-21', '2026-08-22']
    expect(currentStreak(days, TODAY)).toEqual({ days: 2, throughYesterday: false })
  })
})

describe('users/run11 — percentage of days walked', () => {
  it('is NULL on an empty log, never zero percent', () => {
    // spec v2 asks for this by name: "Should say there is nothing logged yet
    // rather than show 0% on an empty log." There is also nothing to divide
    // by, so a percentage would have to be invented.
    expect(walkRate([], TODAY)).toBeNull()
  })

  it('reports the full window once the log is older than it', () => {
    // The framing that prompted the panel: 18 of the last 30 days.
    const days: string[] = []
    for (const n of [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 14, 16, 17, 19, 20, 21, 25, 26]) {
      days.push(ago(n))
    }
    days.push(ago(45))
    days.sort()
    const rate = walkRate(days, TODAY)!
    expect(rate.walked).toBe(18)
    expect(rate.total).toBe(WALK_RATE_DAYS)
    expect(rate.full).toBe(true)
    expect(Math.round((rate.walked / rate.total) * 100)).toBe(60)
  })

  it('EXCLUDES marks older than the window from the count', () => {
    // Day 30 is one outside a thirty-day window that ends today inclusive.
    const rate = walkRate([ago(30), ago(29), ago(0)].sort(), TODAY)!
    expect(rate.total).toBe(WALK_RATE_DAYS)
    expect(rate.walked).toBe(2)
  })

  it('does NOT count days before the friend started as days he failed', () => {
    // THE PRE-EXISTENCE RULE (docs/dashboard-ui-ux-guidelines.md > States, and
    // docs/dashboard-build-rules.md §6). A friend whose first mark was
    // yesterday has not walked on 1 of 30 days; he has walked on 1 of the 2
    // days he has had the screen. This project has shipped the other answer
    // once already — fourteen rows saying "missed" on a friend's first
    // morning, with every test green.
    const rate = walkRate([ago(1)], TODAY)!
    expect(rate.from).toBe(ago(1))
    expect(rate.total).toBe(2)
    expect(rate.walked).toBe(1)
    expect(rate.full).toBe(false)
  })

  it('is 100% on the day of the first mark, and that is the honest answer', () => {
    // One day, one walk. It reads as "1 of the 1 day since you started", which
    // is a true sentence — where "1 of the last 30 days, 3%" would be a claim
    // about twenty-nine days he never had.
    const rate = walkRate([TODAY], TODAY)!
    expect(rate).toEqual({ walked: 1, total: 1, from: TODAY, full: false })
  })

  it('extends the window backwards when an EARLIER day is back-filled', () => {
    // Back-filling is a statement that he was walking then, so the window
    // should reach back to it. The first mark is the only "when did this
    // start" signal there is, and this is what makes using it correct rather
    // than merely convenient.
    const before = walkRate([ago(1)], TODAY)!
    expect(before.total).toBe(2)
    const after = walkRate([ago(5), ago(1)], TODAY)!
    expect(after.total).toBe(6)
    expect(after.walked).toBe(2)
  })
})

describe('users/run11 — calendar geometry', () => {
  it('lays a month out in seven-day rows starting on the labelled weekday', () => {
    // 2026-08-01 is a Saturday, so the first row is six blanks then the 1st —
    // and WEEKDAY_LABELS[6] must be the column it lands in, or the headings
    // are pointing at the wrong squares.
    const rows = calendarGrid('2026-08', TODAY, [])
    expect(WEEKDAY_LABELS).toHaveLength(7)
    for (const row of rows) expect(row).toHaveLength(7)
    expect(rows[0]!.slice(0, 6).every((c) => c.kind === 'blank')).toBe(true)
    expect(rows[0]![6]).toMatchObject({ kind: 'day', date: 1 })
    expect(WEEKDAY_LABELS[6]).toBe('Sat')
  })

  it('holds every day of the month exactly once, February included', () => {
    for (const month of ['2026-08', '2026-02', '2028-02', '2026-04']) {
      const dates = calendarGrid(month, '2030-01-01', [])
        .flat()
        .filter((c) => c.kind !== 'blank')
        .map((c) => c.date)
      expect(dates).toEqual(monthDays(month).map((d) => Number(d.slice(8))))
    }
    // 2028 is a leap year and 2026 is not — the one case a hand-written
    // month-length table gets wrong.
    expect(monthDays('2028-02')).toHaveLength(29)
    expect(monthDays('2026-02')).toHaveLength(28)
  })

  it('marks FUTURE days as unmarkable, and today as not the future', () => {
    // spec v2: "Future days should not be markable." The component renders no
    // control at all for a future cell, so this is the rule and the disabled
    // button is not.
    const rows = calendarGrid(monthOf(TODAY), TODAY, []).flat()
    const today = rows.find((c) => c.kind !== 'blank' && c.day === TODAY)!
    const tomorrow = rows.find((c) => c.kind !== 'blank' && c.day === '2026-08-21')!
    expect(today.kind).toBe('day')
    expect(today).toMatchObject({ isToday: true })
    expect(tomorrow.kind).toBe('future')
  })

  it('fills exactly the days that are marked', () => {
    const rows = calendarGrid('2026-08', TODAY, ['2026-08-03', '2026-08-19']).flat()
    const filled = rows
      .filter((c) => c.kind === 'day' && c.marked)
      .map((c) => (c.kind === 'day' ? c.day : ''))
    expect(filled).toEqual(['2026-08-03', '2026-08-19'])
  })

  it('renders a whole month of past days as markable when the month is over', () => {
    // A back-fill month. Nothing in July 2026 is future relative to August, so
    // every non-blank cell is tappable.
    const cells = calendarGrid('2026-07', TODAY, []).flat().filter((c) => c.kind !== 'blank')
    expect(cells).toHaveLength(31)
    expect(cells.every((c) => c.kind === 'day')).toBe(true)
  })

  it('names the month in words, and steps between them across a year boundary', () => {
    expect(monthLabel('2026-08')).toBe('August 2026')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-08', -12)).toBe('2025-08')
  })

  it('counts whole days between two day keys, over a month and a year edge', () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0)
    expect(daysBetween('2026-07-31', '2026-08-01')).toBe(1)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(daysBetween('2026-08-01', '2026-07-31')).toBe(-1)
    expect(daysBetween(ago(29), TODAY)).toBe(29)
  })
})

describe('users/run11 — how far the calendar pages back', () => {
  it('offers a rolling year even with nothing logged, so back-filling is possible', () => {
    // Bounding at the first mark instead would mean a brand-new log could not
    // reach last month at all — and back-filling is half of what the calendar
    // was asked for.
    expect(earliestMonth([], TODAY)).toBe(shiftMonth('2026-08', -(CALENDAR_HISTORY_MONTHS - 1)))
    expect(earliestMonth([], TODAY)).toBe('2025-09')
  })

  it('reaches back to the first mark when the history is older than that', () => {
    expect(earliestMonth(['2024-03-11', '2026-08-01'], TODAY)).toBe('2024-03')
  })

  it('does not shrink the rolling year for a recent first mark', () => {
    expect(earliestMonth(['2026-08-19'], TODAY)).toBe('2025-09')
  })
})
