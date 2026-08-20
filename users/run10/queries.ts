// users/run10/queries.ts
//
// Every READ for run10's dashboard; the component holds none. The WRITE — one
// INSERT per tap — lives in the platform route app/api/users/[user]/pee-log/route.ts
// instead, deliberately: a platform route must not import one user's queries
// file, which is also why the day-shift helper below is private here rather
// than shared with it.
//
// ─── the one rule that shapes every function here ───
//
// A DAY BEFORE run10 STARTED IS NOT A DAY THEY LOGGED NOTHING.
//
// Both panels this file feeds are anchored to in-dashboard behaviour — there
// is no synced source for a pee, and the spec says so ("Every tap writes a
// timestamped entry by hand — there is no synced source for this"). So a day
// with no rows before their first tap is a day the product has nothing to say
// about (docs/dashboard-ui-ux-guidelines.md, "Pre-existence days"), and the
// trend CLIPS to `firstLoggedDay` rather than padding the window with
// confident zeros. devtwo shipped the unclipped version and told a friend on
// their first morning that they had missed each of the previous fourteen days,
// with every test green (docs/superpowers/ledgers/onboarding.md D16).
//
// A zero INSIDE the logged range is different in kind and does render as zero:
// that is a day they had the dashboard and did not log, which is real data.
//
// ─── no zone is consulted here, and that is by construction ───
//
// Every function below takes a day key as a parameter, or an array that
// already holds them. `pee_logs.day` is resolved once, at write time, by the
// route — the only moment the friend's zone is known to be the one they were
// standing in (docs/superpowers/ledgers/friend-timezone.md). Nothing on the
// read side re-derives it, so this file never imports `dayKey` at all.
import type { UserDb } from '@/lib/db/userDb'

/** One day of the trend: the key, the count, and the label the chart shows. */
export type DayCount = { day: string; count: number; label: string }

/** How many days the bar chart and its average look back over, today included. */
export const TREND_DAYS = 7

/**
 * A day key from local calendar components — PRIVATE, and only for `shift`.
 *
 * Deliberately not exported: exported, it becomes the thing a dashboard calls
 * as `dayKeyOf(Date.now())` to derive its own "today", which is precisely the
 * bug lib/time/dayKey.ts's header describes.
 *
 * WHY IT IS NOT A ZONE BUG: `shift` CONSTRUCTS and FORMATS in one zone, so the
 * zone cancels out entirely. It is pure calendar arithmetic over a day string
 * — "what is 6 days before 2026-03-01" — and never reads a clock, which is the
 * only thing that made the original wrong.
 */
function dayKeyOf(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** `day` shifted by `delta` days, as a day key. Calendar-correct across months. */
function shift(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return dayKeyOf(new Date(y!, m! - 1, d! + delta).getTime())
}

/**
 * The chart's x-axis label for a day key.
 *
 * Relative inside the week, per the formatting guidelines — the whole window is
 * seven days, so a weekday name is never ambiguous and an absolute date would
 * be noise. Today is named rather than abbreviated because it is the bar the
 * whole panel is read against.
 *
 * Formatted HERE and not in dashboard.tsx, the same way devone attaches its
 * row days in queries.ts: a component that can turn a day into a label is a
 * component that will eventually turn a clock into one.
 */
function labelFor(day: string, today: string): string {
  if (day === today) return 'Today'
  const [y, m, d] = day.split('-').map(Number)
  // `new Date(y, m, d)` — three arguments, constructed and read in one zone,
  // exactly like `shift` above. The zero-argument form is what the sweep
  // forbids (tests/users/noLocalDay.test.ts), and for good reason: that one
  // asks the host what time it is.
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(y!, m! - 1, d!).getDay()
  ]!
}

/**
 * How many times `day` was logged.
 *
 * The spec's "today's running count", and the whole of the midnight reset:
 * `day` is filed at write time in run10's own zone, so the count for a new day
 * starts at zero because no row carries that key yet. Nothing has to be reset.
 */
export function countOn(db: UserDb, day: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM pee_logs WHERE day = ?').get(day) as {
      n: number
    }
  ).n
}

/**
 * The earliest day holding a row, or null on an empty database.
 *
 * The proxy for "when this dashboard was born". It is the only such signal the
 * database carries — nothing records a start date — and it is the honest one:
 * before the first row there is provably nothing to say about any day.
 *
 * Consequence worth stating, because it is a real limit and not a bug: if
 * run10 logs nothing for a fortnight and then taps again, the days in between
 * ARE inside the logged range and render as zeros, because by then they are
 * days they had the dashboard and did not use.
 */
export function firstLoggedDay(db: UserDb): string | null {
  const row = db.prepare('SELECT MIN(day) AS d FROM pee_logs').get() as {
    d: string | null
  }
  return row.d
}

/**
 * Counts per day for the window ending on `today`, oldest first — one entry
 * per bar the chart draws.
 *
 * CLIPPED at the first logged day, so this returns FEWER than TREND_DAYS
 * entries during run10's first week rather than padding with zeros they never
 * had the chance to fill. Empty on an empty database — the caller renders the
 * panel's empty state, and no chart is mounted at all.
 */
export function dailyTrend(db: UserDb, today: string): DayCount[] {
  const first = firstLoggedDay(db)
  if (first === null) return []

  const windowStart = shift(today, -(TREND_DAYS - 1))
  // The later of the two: never earlier than their first row, never earlier
  // than the window. A `first` in the future relative to `today` (a clock
  // moved backwards, a row filed from another zone) yields an empty range
  // below rather than a reversed one.
  const start = first > windowStart ? first : windowStart

  const counts = new Map(
    (
      db
        .prepare(
          `SELECT day, COUNT(*) AS n
             FROM pee_logs
            WHERE day >= ? AND day <= ?
         GROUP BY day`,
        )
        .all(start, today) as { day: string; n: number }[]
    ).map((r) => [r.day, r.n] as const),
  )

  const days: DayCount[] = []
  for (let cursor = start; cursor <= today; cursor = shift(cursor, 1)) {
    days.push({
      day: cursor,
      // A day inside the range with no rows is a real zero: they had the
      // dashboard and did not log. See this file's header.
      count: counts.get(cursor) ?? 0,
      label: labelFor(cursor, today),
    })
  }
  return days
}

/**
 * The daily average across the days the chart is drawing, and how many days
 * that is.
 *
 * TAKES THE TREND, NEVER THE DATABASE, and that is the point rather than a
 * convenience. The spec asks for "the daily average across those seven days" —
 * the ones charted — and the dashboard draws it as a reference line ON that
 * chart. Computed from a second query it could disagree with the bars beside
 * it while both were individually correct; computed from the array itself it
 * cannot. It is still data logic and still lives here, not in dashboard.tsx.
 *
 * TODAY IS INCLUDED, because today is one of the bars. That means the average
 * reads low in the morning, while today is still partial — a real property of
 * "the average of what you are looking at", and the caption in dashboard.tsx
 * says the window out loud rather than leaving it implied. (run9's dashboard
 * excludes today from its average; its spec asked for a BASELINE to read the
 * trend against, which is a different question from this one.)
 *
 * `null` on an empty trend, which is an empty database: an average of no days
 * is not zero, it is nothing, and the caller renders the empty state.
 */
export function dailyAverage(trend: DayCount[]): { average: number; days: number } | null {
  if (trend.length === 0) return null
  const total = trend.reduce((sum, d) => sum + d.count, 0)
  return {
    // One decimal. A whole number would round 6.4 and 7.4 to the same figure
    // on a scale whose whole range is single digits; two would be false
    // precision on a count of bathroom trips.
    average: Math.round((total / trend.length) * 10) / 10,
    // The DENOMINATOR IS ELAPSED DAYS, not days that have rows — a day they
    // had the dashboard and logged nothing is a zero that belongs in the
    // average. It is `trend.length` rather than TREND_DAYS because the trend
    // is clipped: during run10's first week this averages fewer than seven
    // days, and the caption says which.
    days: trend.length,
  }
}
