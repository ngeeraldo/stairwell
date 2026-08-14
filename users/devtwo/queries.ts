// users/devtwo/queries.ts
//
// Every READ for devtwo's dashboard; the component holds none. The write
// (the walk INSERT) lives in the platform walk route instead, deliberately —
// a platform route must not import one user's queries file, which is also
// why dayKey is duplicated between the route and this file rather than
// shared from here.
import type { UserDb } from '@/lib/db/userDb'

export type Walk = { day: string; at: number }

/**
 * A day key from local calendar components — PRIVATE, and only for `shift`.
 *
 * It is deliberately NOT exported any more. It used to be, and
 * `dashboard.tsx` used it as `dayKeyOf(Date.now())` to derive its own "today"
 * — which is precisely the bug: the write path filed taps under the server's
 * day and the read path computed the server's day, so the two agreed with each
 * other and disagreed with the friend. `today` arrives as a prop now
 * (lib/dashboard/contract.ts), and un-exporting this is what makes the old
 * shape unavailable rather than merely discouraged.
 *
 * WHY IT IS NOT A ZONE BUG in the one place it survives: `shift` below
 * CONSTRUCTS and FORMATS in the same zone, so the zone cancels out entirely.
 * It is pure calendar arithmetic over a day string — "what is 13 days before
 * 2026-03-01" — and never reads a clock, which is the only thing that made
 * the original wrong.
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

export function walkedOn(db: UserDb, day: string): boolean {
  return (
    db.prepare('SELECT 1 FROM walks WHERE day = ?').get(day) !== undefined
  )
}

/**
 * Consecutive days walked, ending today OR yesterday.
 *
 * The grace day is from the confirmed spec, not invented: a streak that broke
 * at 00:01 would punish the user for the day not having happened yet.
 */
export function currentStreak(db: UserDb, today: string): number {
  let cursor = today
  if (!walkedOn(db, cursor)) {
    cursor = shift(today, -1)
    if (!walkedOn(db, cursor)) return 0
  }
  let streak = 0
  while (walkedOn(db, cursor)) {
    streak += 1
    cursor = shift(cursor, -1)
  }
  return streak
}

/** Walked days in the 30-day window ending on (and including) `today`. */
export function last30(
  db: UserDb,
  today: string,
): { walked: number; total: number; percent: number } {
  const total = 30
  const from = shift(today, -(total - 1))
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM walks WHERE day >= ? AND day <= ?')
    .get(from, today) as { n: number }
  return {
    walked: row.n,
    total,
    // Rounded, because a percentage with decimals on a one-tap tracker is
    // false precision.
    percent: Math.round((row.n / total) * 100),
  }
}

/** The 14 days ending today, oldest first, each marked walked or not. */
export function last14(
  db: UserDb,
  today: string,
): { day: string; walked: boolean }[] {
  const days: string[] = []
  for (let i = 13; i >= 0; i--) days.push(shift(today, -i))
  const logged = new Set(
    (
      db
        .prepare('SELECT day FROM walks WHERE day >= ? AND day <= ?')
        .all(days[0], today) as { day: string }[]
    ).map((r) => r.day),
  )
  return days.map((day) => ({ day, walked: logged.has(day) }))
}
