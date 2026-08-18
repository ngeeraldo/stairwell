// users/run8/queries.ts
//
// Every READ for run8's dashboard; the component holds none. The write — the
// +1/-1 INSERT — lives in app/api/users/[user]/count/route.ts, because a
// dashboard is handed a read-only handle and only a platform route may write
// (CLAUDE.md > Dashboard folder conventions).
//
// Nothing here reads a clock. `today` arrives as a prop from the page, which
// resolved it once from the friend's own timezone; every function below takes
// it as a parameter. A query that asked the server what day it was would be
// asking a droplet that runs in UTC — see lib/time/dayKey.ts and
// docs/superpowers/ledgers/friend-timezone.md.
//
// `dayKey` is deliberately NOT imported. It converts a stored INSTANT into a
// day, and this table already stores the day the tap belongs to as a column —
// frozen at write time from the friend's own zone (migrations/001_initial.sql).
// Converting `at` here would compute a SECOND opinion about which day a tap
// belongs to, using whatever zone the friend is in now, and the two would
// silently disagree the first time they travelled.
import type { UserDb } from '@/lib/db/userDb'

/** `day` shifted by `delta` days, as a day key. Calendar-correct across months. */
function shift(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  // Constructed and formatted in ONE zone, so the zone cancels out entirely:
  // this is arithmetic over a day string — "what is six days before
  // 2026-03-01" — and never asks what day it is now. `new Date(...)` WITH
  // arguments is allowed here; the zero-argument form is what
  // tests/users/noLocalDay.test.ts forbids.
  const date = new Date(y!, m! - 1, d! + delta)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayOfMonth}`
}

/**
 * The Monday on or before `day`.
 *
 * Monday is run8's confirmed answer to "does the week start Monday or Sunday",
 * and it is what the mockup's axis runs on (Mon…Sun). It is stated once, here,
 * so a panel cannot disagree with the average beside it.
 */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  // getDay() is 0=Sunday; this rotates it to 0=Monday.
  const weekday = (new Date(y!, m! - 1, d!).getDay() + 6) % 7
  return shift(day, -weekday)
}

/**
 * Net taps for one day: pluses minus minuses.
 *
 * COALESCE because SUM over no rows is NULL, and a day nobody has logged is a
 * zero rather than an absence — for TODAY specifically, "0" is the honest
 * reading at 7am and the friend's cue to press plus. Whether an OLDER empty
 * day should be drawn at all is a different question, and `weekDays` answers
 * it with `tracked` rather than by folding it in here.
 */
export function dayTotal(db: UserDb, day: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM pee_events WHERE day = ?')
    .get(day) as { n: number }
  return row.n
}

/** The earliest day this friend ever logged, or undefined if they never have. */
export function firstTrackedDay(db: UserDb): string | undefined {
  const row = db.prepare('SELECT MIN(day) AS d FROM pee_events').get() as {
    d: string | null
  }
  return row.d ?? undefined
}

/**
 * The same weekday one week before `today`, for the count panel's note.
 *
 * `undefined` — not 0 — when that day falls before the friend's first tap.
 * The panel prints nothing in that case rather than "last week this day: 0",
 * which would report a day they had no dashboard on as a day they went nowhere.
 */
export function sameDayLastWeek(db: UserDb, today: string): number | undefined {
  const day = shift(today, -7)
  const first = firstTrackedDay(db)
  if (first === undefined || day < first) return undefined
  return dayTotal(db, day)
}

export type DayTotal = {
  day: string
  total: number
  /**
   * Whether this day is one the friend could have been logging on: on or after
   * their first ever tap, and not in the future.
   *
   * The panel draws a bar only for these. A day before they started is not a
   * day they scored zero, and a day that has not happened yet is not a day they
   * failed — the mistake devtwo shipped, which rendered fourteen "missed" rows
   * on a friend's first morning with every test green (build-rules §6).
   */
  tracked: boolean
}

/**
 * Monday…Sunday of the week containing `today`, every day present.
 *
 * All seven are returned even when several are untracked, because the mockup's
 * axis is a fixed seven-column grid — the panel needs the empty columns to
 * place the labels under, and decides what to draw in each from `tracked`.
 */
export function weekDays(db: UserDb, today: string): DayTotal[] {
  const monday = mondayOf(today)
  const first = firstTrackedDay(db)
  const totals = new Map(
    (
      db
        .prepare(
          'SELECT day, SUM(delta) AS n FROM pee_events WHERE day >= ? AND day <= ? GROUP BY day',
        )
        .all(monday, shift(monday, 6)) as { day: string; n: number }[]
    ).map((r) => [r.day, r.n]),
  )

  const days: DayTotal[] = []
  for (let i = 0; i < 7; i++) {
    const day = shift(monday, i)
    days.push({
      day,
      total: totals.get(day) ?? 0,
      tracked: first !== undefined && day >= first && day <= today,
    })
  }
  return days
}

export type WeekAverage = {
  /** The Monday that starts this week. */
  weekStart: string
  /** Mean taps across the days in this week that the friend actually logged. */
  average: number
  /** How many days that mean is over — 1…7. */
  days: number
}

/**
 * One point per week, oldest first, for every week from the friend's first tap
 * to the week containing `today`.
 *
 * "As many as we have" is run8's confirmed answer, so this is deliberately
 * unbounded rather than a trailing-N window.
 *
 * ── What the average is over, and why ───────────────────────────────────────
 *
 * Days the friend LOGGED, not all seven. The question this panel answers is
 * "how many times a day do I usually go", and a day they forgot to open the app
 * is not a day they went zero times — dividing by seven would quietly restate
 * every missed day as a day of perfect continence and drag the line down for a
 * reason that has nothing to do with their body. It also keeps the current,
 * partial week comparable to the finished ones beside it: a Tuesday would
 * otherwise show a third of its true average purely because Wednesday has not
 * happened.
 *
 * `days` rides along so the panel can say what a point is made of. A week
 * averaging 8 across one logged day and one averaging 8 across seven are not
 * the same claim, and only this number distinguishes them.
 */
export function weeklyAverages(db: UserDb, today: string): WeekAverage[] {
  const rows = db
    .prepare(
      'SELECT day, SUM(delta) AS n FROM pee_events WHERE day <= ? GROUP BY day ORDER BY day',
    )
    .all(today) as { day: string; n: number }[]

  const weeks = new Map<string, { total: number; days: number }>()
  for (const row of rows) {
    const week = mondayOf(row.day)
    const bucket = weeks.get(week) ?? { total: 0, days: 0 }
    bucket.total += row.n
    bucket.days += 1
    weeks.set(week, bucket)
  }

  return [...weeks.entries()]
    // Map preserves insertion order and the SQL is ordered, so this is already
    // chronological — sorted anyway, because relying on that couples a display
    // order to a detail of how the loop above happens to be written.
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, bucket]) => ({
      weekStart,
      // One decimal: the mockup's own note reads "Averaging 7.7 a day this
      // week", and a whole number would round two visibly different weeks to
      // the same point.
      average: Math.round((bucket.total / bucket.days) * 10) / 10,
      days: bucket.days,
    }))
}
