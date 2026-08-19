// users/run9/queries.ts
//
// Every READ for run9's dashboard; the component holds none. The WRITES — one
// INSERT per tap, one DELETE per correction — live in the platform route
// app/api/users/[user]/pee/route.ts instead, deliberately: a platform route
// must not import one user's queries file, which is also why the day-shift
// helper below is private here rather than shared with it.
//
// ─── the one rule that shapes every function here ───
//
// A DAY BEFORE run9 STARTED IS NOT A DAY THEY LOGGED NOTHING.
//
// Every panel this file feeds is anchored to in-dashboard behaviour — there is
// no synced source, so a day with no rows before their first tap is a day the
// product has nothing to say about (docs/dashboard-ui-ux-guidelines.md,
// "Pre-existence days"). So the trend and the average both CLIP to
// `firstLoggedDay` rather than padding the window with confident zeros. devtwo
// shipped the unclipped version and told a friend on their first morning that
// they had missed each of the previous fourteen days, with every test green
// (docs/superpowers/ledgers/onboarding.md D16).
//
// A zero INSIDE the logged range is different in kind and does render as zero:
// that is a day they had the dashboard and did not log, which is real data.
import type { UserDb } from '@/lib/db/userDb'

/** One day of the trend: the key, the count, and the label the chart shows. */
export type DayCount = { day: string; count: number; label: string }

/** How many days the trend and the average each look back over. */
export const TREND_DAYS = 7

/**
 * A day key from local calendar components — PRIVATE, and only for `shift`.
 *
 * The same helper `users/devtwo/queries.ts` keeps, for the same reason, and
 * deliberately not exported for the same reason either: exported, it becomes
 * the thing a dashboard calls as `dayKeyOf(Date.now())` to derive its own
 * "today", which is precisely the bug lib/time/dayKey.ts's header describes.
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
 * Relative inside the week, per the formatting guidelines — and the whole
 * window is seven days, so a weekday name is never ambiguous and an absolute
 * date would be noise. Today is named rather than abbreviated because it is
 * the point of comparison the whole panel exists to serve.
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

/** How many times `day` was logged. */
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
 * run9 logs nothing for a fortnight and then taps again, the days in between
 * ARE inside the logged range and render as zeros, because by then they are
 * days he had the dashboard and did not use.
 */
export function firstLoggedDay(db: UserDb): string | null {
  const row = db.prepare('SELECT MIN(day) AS d FROM pee_logs').get() as {
    d: string | null
  }
  return row.d
}

/**
 * Counts per day for the window ending on `today`, oldest first.
 *
 * CLIPPED at the first logged day, so this returns FEWER than TREND_DAYS
 * entries during run9's first week rather than padding with zeros he never
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
      // A day inside the range with no rows is a real zero: he had the
      // dashboard and did not log. See this file's header.
      count: counts.get(cursor) ?? 0,
      label: labelFor(cursor, today),
    })
  }
  return days
}

/**
 * The average logs per day over the week, and how many days it averages.
 *
 * TODAY IS EXCLUDED — Nico's ruling, 2026-08-19. The spec calls this "a
 * baseline to read the daily trend against", and a baseline that includes the
 * partial day being measured moves all morning and compares today partly
 * against itself. So it averages the complete days BEFORE today.
 *
 * Clipped at the first logged day like the trend, and `null` when that leaves
 * nothing — on day one there is no complete day yet, and an average of one
 * partial day is not a baseline. The caller renders an empty state.
 */
export function weeklyAverage(
  db: UserDb,
  today: string,
): { average: number; days: number } | null {
  const first = firstLoggedDay(db)
  if (first === null) return null

  const yesterday = shift(today, -1)
  const windowStart = shift(today, -TREND_DAYS)
  const start = first > windowStart ? first : windowStart
  // Their first row is today, so no complete day has elapsed under this
  // dashboard yet.
  if (start > yesterday) return null

  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM pee_logs WHERE day >= ? AND day <= ?',
    )
    .get(start, yesterday) as { n: number }

  // The DENOMINATOR IS ELAPSED DAYS, not days that have rows. A day he had
  // the dashboard and logged nothing is a zero that belongs in the average;
  // dividing by rows-bearing days instead would report his average as if the
  // blank days had not happened.
  let days = 0
  for (let cursor = start; cursor <= yesterday; cursor = shift(cursor, 1)) days += 1

  return {
    // One decimal. A whole number would round 6.4 and 7.4 to the same
    // baseline on a scale whose whole range is single digits; two would be
    // false precision on a count of bathroom trips.
    average: Math.round((row.n / days) * 10) / 10,
    days,
  }
}
