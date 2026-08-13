// users/devtwo/queries.ts
//
// Every READ for devtwo's dashboard; the component holds none. The write
// (the walk INSERT) lives in the platform walk route instead, deliberately —
// a platform route must not import one user's queries file, which is also
// why dayKey is duplicated between the route and this file rather than
// shared from here.
import type { UserDb } from '@/lib/db/userDb'

export type Walk = { day: string; at: number }

/** The LOCAL calendar day as 'YYYY-MM-DD'. Mirrors the write path's dayKey. */
export function dayKeyOf(at: number): string {
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
