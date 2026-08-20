// lib/time/minuteOfDay.ts
//
// The companion to lib/time/dayKey.ts, and it exists for the same reason:
// there must be exactly ONE place that turns an instant into something on the
// friend's wall clock.
//
// dayKey answers "which calendar day"; this answers "how far into that day",
// as minutes since local midnight. Together they are the whole of what
// users/run11 stores about a forecast hour, and a caller that has both has the
// friend's local time without ever having asked a clock.
//
// ── Why this is a separate question from the day ────────────────────────────
//
// A tap tracker only ever needs the day: a row belongs to 2026-08-20 and
// nothing about it depends on whether it happened at 09:00 or at 21:00. A
// dashboard answering "does a 40-minute walk starting now finish before
// sunset" needs the POSITION IN THE DAY, and there was previously nowhere in
// this repo to get one. Written inline at a call site it would be a second
// implementation of the zone handling dayKey already owns — including its
// fallback — which is precisely the drift the timezone ledger is about.
//
// ── Why it cannot throw ─────────────────────────────────────────────────────
//
// Same contract as dayKey, for the same reason: the zone arrives from an
// untrusted `stairwell_tz` cookie, and an unusable one degrades to UTC rather
// than failing a write path. See lib/time/dayKey.ts.
//
// ── Who may call it ─────────────────────────────────────────────────────────
//
// Platform code, and a user's queries.ts over a STORED instant — the same
// bound dayKey carries. NOT a dashboard.tsx. A dashboard is handed everything
// it renders already resolved; users/run11 stores `minute_of_day` at write
// time and its dashboard formats integers, so it never converts anything.
import { isValidTimeZone } from '@/lib/time/dayKey'

/** Minutes in a day. Exported because callers bound windows against it. */
export const MINUTES_PER_DAY = 1440

/**
 * Minutes since local midnight, 0..1439, in the FRIEND'S timezone.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`: the latter is specified to
 * produce '24' for midnight in some locales, which would silently make
 * midnight 1440 minutes past midnight. 'en-GB' with h23 is the pairing that
 * gives a plain zero-padded 00..23.
 */
export function localMinuteOfDay(at: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)

  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  // Defensive rather than expected: every zone Intl accepts yields both parts.
  // Degrading to midnight keeps the no-throw contract above rather than
  // handing a NaN to arithmetic that would carry it silently into a row.
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return hour * 60 + minute
}
