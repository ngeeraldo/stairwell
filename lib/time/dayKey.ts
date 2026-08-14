/**
 * The calendar day as 'YYYY-MM-DD', in the FRIEND'S timezone.
 *
 * ── Why it takes a timezone, and what it used to get wrong ──────────────────
 *
 * This function was built to fix a real bug and then had a bigger one hiding
 * inside it. The original: devone shipped a dashboard whose query bucketed
 * months locally while its renderer formatted dates in UTC, so west of
 * Greenwich a late-evening row displayed under the previous day. A tracker
 * whose unit IS the day cannot afford that, so the day key was built from
 * *local* calendar components at the one place it is derived.
 *
 * Local — but local to WHOM. It was local to the process, and the process runs
 * on a droplet that `timedatectl` reports as UTC. So the ambiguity was closed
 * INSIDE the server and left wide open BETWEEN the friend and the server: a tap
 * at 21:03 in New York is 01:03Z, and was stored as the next day.
 *
 * That is not hypothetical. devtwo's only real tap, made on the evening of
 * 2026-08-13, is stored under `2026-08-14`, and its dashboard duly shows the
 * 13th as missed. One row on a dev account is what it cost to find; three
 * friends and a month of streaks is what it would have cost later.
 *
 * ── How the zone gets here ──────────────────────────────────────────────────
 *
 * From a `stairwell_tz` cookie the root layout's inline script writes, beside
 * the `stairwell_dc` one it already wrote — the client is the only party that
 * knows its own zone, and this is the mechanism already proven for telling the
 * server something the client alone knows. `readTimeZone()` in
 * lib/metrics/deviceClass.ts reads it.
 *
 * ── Why it cannot throw ─────────────────────────────────────────────────────
 *
 * A cookie is untrusted input and this runs on the path that records a tap. An
 * unusable zone degrades to UTC — never an exception — for the same reason an
 * unrecognised `device_class` degrades to 'desktop': a friend's tap must not be
 * able to fail because something rewrote a cookie.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 *
 * It lived in `app/api/users/[user]/walk/route.ts` and was exported so its
 * timezone behaviour could be tested directly. Next 15 validates a route
 * module's export list against a closed set of route fields, so that export
 * failed `next build` outright — while `npx vitest run` and `npx tsc --noEmit`
 * both stayed green, the latter because tsconfig pulls in `.next/types` and no
 * build had ever generated them. A pure helper does not belong in a route
 * module; this is where it belongs.
 *
 * ── Who may call it ─────────────────────────────────────────────────────────
 *
 * Platform code, and a user's `queries.ts` turning a STORED instant into the
 * friend's day — which every finance dashboard will need to do. NOT a
 * `dashboard.tsx`: a dashboard is handed its `today` as a prop and never
 * derives one, so that the read and the write can never disagree about what
 * day it is. `tests/users/noLocalDay.test.ts` enforces both halves, including
 * for user folders that do not exist yet.
 *
 * `users/devtwo/queries.ts` keeps a private day-key helper for `shift()`, and
 * that is not a duplicate of this: `shift` constructs and formats in ONE zone,
 * making it pure calendar arithmetic that is correct whatever that zone is. It
 * never reads a clock.
 */

/**
 * Whether `Intl` recognises this as a timezone.
 *
 * A try/catch rather than a lookup against `Intl.supportedValuesOf`: the
 * question is precisely "will the formatter below accept it", and asking the
 * formatter is the only way to be sure the answer matches.
 */
export function isValidTimeZone(timeZone: string | undefined): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
    return true
  } catch {
    return false
  }
}

export function dayKey(at: number, timeZone: string | undefined): string {
  // 'en-CA' formats as YYYY-MM-DD, zero-padded, which is exactly the shape
  // `walks.day` uses as a TEXT primary key — and every range query in a
  // dashboard compares those keys as strings, so the padding is load-bearing
  // rather than cosmetic.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}
