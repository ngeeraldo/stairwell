import type { PlatformDb } from '@/lib/db/platform'
import { dayKey } from '@/lib/time/dayKey'

/**
 * Which days a friend was actually in the app, and the weekly/monthly rollups
 * the admin Activity pane draws from them.
 *
 * ── What question this answers ──────────────────────────────────────────────
 *
 * Retention: did they come back. Not "how much did they use it" — every
 * function here reduces a day to a BOOLEAN. That is deliberate rather than
 * lazy: `dashboard_open` is written once per render with no write-path dedup
 * (CLAUDE.md, and app/[user]/page.tsx says so at the write), so a tab switch
 * and a write-redirect each add a row. Counting rows would measure how many
 * times the page re-rendered, which is not a thing anybody wants to know. Day
 * presence is immune to that inflation, which is why the raw log can stay raw.
 *
 * ── Read-time definition, per CLAUDE.md ─────────────────────────────────────
 *
 * "An open" is a definition applied when the log is READ, never at write time.
 * This module IS that definition, and it is the only place it lives — so a
 * change to what counts as presence is one edit, not an archaeology exercise
 * across every event that ever fired.
 *
 * ── It reads no user values, because there are none to read ─────────────────
 *
 * Only `at` and `event` from `metrics`, and only `at` and `role` from
 * `transcripts`. No `data` column, no transcript body. The bound CLAUDE.md
 * puts on what may be WRITTEN to metrics is matched here by what is read.
 */

/**
 * The zone every day boundary in this report is drawn in. Nico's zone, chosen
 * once and applied to every account.
 *
 * NOT the friend's own zone, and the difference is a decision rather than an
 * approximation. Bucketing each friend in their own zone would need that zone
 * stored on every row, which puts a weak location signal about a person into
 * the one unencrypted table CLAUDE.md says carries no user values. A single
 * reporting zone keeps the table clean; the cost is that a friend several
 * zones away has their late evening filed under our day, which moves a day
 * and essentially never moves a week.
 *
 * UTC would have been the zero-decision option and is wrong for the same
 * reason it was wrong for a dashboard (see lib/time/dayKey.ts): an evening
 * session lands on tomorrow, so a friend who opens the app every evening looks
 * like a friend who opens it every night at 00:30.
 */
export const REPORTING_TIME_ZONE = 'America/Chicago'

/**
 * The metric events that mean A PERSON WAS HERE.
 *
 * An allowlist rather than "every row for this account", because the account
 * is not the only thing that writes rows carrying its id. `deploy_announced`
 * is written by scripts/announce-deploy.ts — by Nico, from a laptop, on a day
 * the friend may never have opened the app — and `alert_sent` likewise. Those
 * would manufacture retention out of our own activity, which is the one
 * direction this report must not be able to lie in.
 *
 * `page_view` is the broad one and covers the rest on its own for anything
 * after the deploy that introduced it: it fires on every shell render,
 * unlocked or not, dashboard built or not. The others are kept because
 * `metrics` is append-only and the pilot's existing history predates
 * `page_view` — dropping them would blank out every week already lived.
 *
 * `first_session_start` also covers the registration day, when the friend
 * accepted the invite and set a password but may not have come back before
 * the session ended.
 */
export const PRESENCE_EVENTS = [
  'page_view',
  'dashboard_open',
  'dashboard_write',
  'chat_turn',
  'login',
  'first_session_start',
] as const

/** Every day this account was present, oldest first, one entry per day. */
export function activeDays(db: PlatformDb, accountId: number): string[] {
  const holes = PRESENCE_EVENTS.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT at FROM metrics
         WHERE account_id = ? AND event IN (${holes})
       UNION ALL
       -- role = 'user' and not merely account_id: announce-deploy.ts writes an
       -- ASSISTANT turn into a friend's transcript on the day we deploy, and
       -- counting it would mark them present for a visit they never made. The
       -- opening message the shell writes on a first render is an assistant
       -- turn too, and is excluded by the same clause.
       SELECT at FROM transcripts WHERE account_id = ? AND role = 'user'`,
    )
    .all(accountId, ...PRESENCE_EVENTS, accountId) as { at: number }[]

  const days = new Set(rows.map((row) => dayKey(row.at, REPORTING_TIME_ZONE)))
  // String sort is chronological on 'YYYY-MM-DD', which is the whole reason
  // dayKey zero-pads.
  return [...days].sort()
}

export type ActivityWeek = {
  /** Monday of this week, 'YYYY-MM-DD'. */
  start: string
  days: { day: string; active: boolean }[]
  activeCount: number
}

/**
 * The last `weeks` Monday-start weeks ending at `endDay`, oldest week first.
 *
 * The newest week is CLIPPED at `endDay` rather than padded out to Sunday: a
 * cell for a day that has not happened yet renders identically to a day the
 * friend missed, and this grid is read to decide whether to worry about
 * someone.
 */
export function weeklyGrid(
  active: Iterable<string>,
  endDay: string,
  weeks: number,
): ActivityWeek[] {
  const present = new Set(active)
  const newestStart = mondayOf(endDay)
  const out: ActivityWeek[] = []
  for (let week = weeks - 1; week >= 0; week--) {
    const start = shiftDay(newestStart, -7 * week)
    const days: ActivityWeek['days'] = []
    for (let offset = 0; offset < 7; offset++) {
      const day = shiftDay(start, offset)
      if (day > endDay) break
      days.push({ day, active: present.has(day) })
    }
    out.push({ start, days, activeCount: days.filter((d) => d.active).length })
  }
  return out
}

export type ActivityMonth = { month: string; activeCount: number }

/** Active days per calendar month, newest month first. */
export function monthlyActivity(active: Iterable<string>): ActivityMonth[] {
  const counts = new Map<string, number>()
  for (const day of active) {
    const month = day.slice(0, 7)
    counts.set(month, (counts.get(month) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([month, activeCount]) => ({ month, activeCount }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

/**
 * Calendar arithmetic on a day key, in ONE zone from end to end.
 *
 * UTC is used purely as that one zone — it never asks what day it is, so this
 * is pure arithmetic and not a clock read (the same distinction
 * users/devtwo/queries.ts draws for its own `shift`). Days are 86400000ms
 * apart in UTC with no DST to trip over, which is exactly why the arithmetic
 * is not done in REPORTING_TIME_ZONE.
 */
function shiftDay(day: string, days: number): string {
  const at = Date.parse(`${day}T00:00:00Z`) + days * 86_400_000
  const shifted = new Date(at)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const date = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${date}`
}

/** The Monday of the week containing `day`. Weeks start Monday. */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return shiftDay(day, weekday === 0 ? -6 : 1 - weekday)
}
