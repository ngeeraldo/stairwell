import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { readDeviceClass, readTimeZone } from '@/lib/metrics/deviceClass'
import { openUserDataForWrite } from '@/lib/db/userData'
import { logDbFailure } from '@/lib/db/failureLog'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { writeAnswer } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'
// dayKey lives in lib/time, not here. A route module may export only Next's
// own route fields — anything else fails `next build` with "is not a valid
// Route export field". See lib/time/dayKey.ts.
import { dayKey } from '@/lib/time/dayKey'

/**
 * run11's walk log: mark a day as walked, or take the mark back.
 *
 * A ROUTE OF ITS OWN, copied from platform/templates/route/route.ts.tmpl.
 * docs/dashboard-build-rules.md §4 is explicit that the template is a worked
 * example rather than a base class: the four checks below ARE the security
 * property, and they are cheaper to read twice than to trace through an
 * abstraction. It deliberately does not share app/api/users/[user]/walk/route.ts,
 * which is another friend's and carries their rules — that one marks TODAY from
 * a clock and can only add. A shared handler would make a change to one
 * friend's dashboard a silent change to another's.
 *
 * It is also separate from run11's OWN app/api/users/[user]/no-go-temp/route.ts,
 * which is on the other screen. That is not only tidiness: lib/ui/WriteAction.tsx
 * groups its pending state by ACTION URL, so two controls sharing a route lock
 * together while a write is in flight. The forty-odd calendar squares SHOULD
 * lock together — they all write this one table and the streak and percentage
 * above them all move at once — and the temperature stepper should not be
 * dragged into that, nor the calendar into its.
 *
 * The order of the checks IS the property:
 *
 * 1. unlocked — not merely authenticated. A locked session has no key, so it
 *    must be refused before anything reaches for one or opens a file.
 * 2. ownership — 404, never 403, so the response cannot confirm that another
 *    account exists.
 * 3. a registered dashboard — otherwise any authenticated slug could cause an
 *    encrypted file to be created for a user who has no dashboard at all.
 * 4. only then: key, open, write, close.
 *
 * ─── THIS ROUTE TAKES A DAY FROM THE CALLER, WHICH NO OTHER WRITE ROUTE DOES ─
 *
 * Every other logging route in this app files its row under `dayKey(now, tz)`
 * and nothing the caller sends can move it. This one cannot: spec v2's whole
 * marking model is "tapping today's square marks today, and back-filling a
 * missed day is the same tap on that earlier square", so the day IS the
 * payload. That makes `day` the only friend-supplied value any write route in
 * this repo writes into a database, and it is validated in three ways before
 * it gets near one — shape, reality, and not in the future. A day key is also
 * a PRIMARY KEY here, so a malformed one would not be a bad row that could be
 * fixed later; it would be a row nothing can ever address again.
 *
 * The clock is still read HERE, once, for exactly one purpose: to work out
 * what "the future" means in the friend's own calendar. That is the same
 * dayKey, from the same `stairwell_tz` cookie, that app/[user]/page.tsx hands
 * the dashboard as `today` — which is what makes the calendar's today square
 * and this route's idea of today the same day (spec v2's third open question).
 */

/** The panel a metric row names. A constant, never anything derived. */
const PANEL_MARK = 'walk_log_mark'
const PANEL_UNMARK = 'walk_log_unmark'

/**
 * Whether a caller-supplied string is a real calendar day.
 *
 * Two checks, not one. The pattern rejects anything that is not the shape of a
 * day key; the round trip rejects a well-shaped day that does not exist —
 * `2026-02-30` matches the pattern perfectly and `Date` silently rolls it
 * forward to March 2nd, which would file a mark on a day the friend did not
 * tap.
 */
function isRealDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const parsed = new Date(`${day}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    return new Response(null, { status: 403 })
  }
  if (!canSeeUserSpace(db, sessionId, user)) {
    return new Response(null, { status: 404 })
  }
  if (!dashboardLoaderFor(user)) {
    return new Response(null, { status: 404 })
  }

  const accountId = accountIdFor(db, sessionId)
  const key = getKey(sessionId!)
  // resolveState already proved a live key existed; this closes the window
  // where it expired between the two reads rather than throwing on undefined.
  if (accountId === undefined || !key) {
    return new Response(null, { status: 403 })
  }

  // READ AFTER the auth checks, deliberately: parsing a body is work done on
  // behalf of the caller, and an unauthenticated caller gets none of it.
  //
  // Wrapped because formData() throws on a malformed or absent body, and an
  // uncaught throw here would be a 500 in response to a form submit — the
  // friend's browser leaves the dashboard and lands on Next's error page.
  let action: FormDataEntryValue | null = null
  let dayField: FormDataEntryValue | null = null
  try {
    const form = await request.formData()
    action = form.get('action')
    dayField = form.get('day')
  } catch {
    return new Response(null, { status: 400 })
  }

  // A closed set of exactly two, checked before anything opens a database.
  // Unmark exists because spec v2 asks for it by name — "Tapping an
  // already-marked day unmarks it, so a mis-tap is recoverable" — which is the
  // opposite call from run10's, whose spec asks for a tap and nothing that
  // takes one back.
  if (action !== 'mark' && action !== 'unmark') {
    return new Response(null, { status: 400 })
  }
  // A File, or a missing field, is not a day. Checked before isRealDay so the
  // regex is never handed a non-string.
  if (typeof dayField !== 'string' || !isRealDay(dayField)) {
    return new Response(null, { status: 400 })
  }

  // Resolved ONCE per request, not per emit: the rows below fire on mutually
  // exclusive paths, and re-reading the request headers per row would be
  // several reads of a value that cannot have changed.
  const device_class = await readDeviceClass()
  // The friend's own calendar — see this file's header. The ONLY thing it is
  // used for is deciding what counts as the future.
  const timeZone = await readTimeZone()

  // ONE clock read for the whole request. Two reads can straddle midnight and
  // decide "is this the future" against a different day than the one the row
  // is stamped with, which is the exact class of bug the timezone ledger is
  // about.
  const now = Date.now()
  const today = dayKey(now, timeZone)

  // NO FUTURE DAYS. spec v2 says so directly, and it is the right rule: a mark
  // is a record that a walk happened, and a walk cannot have happened
  // tomorrow. The calendar renders future squares as plain text with no
  // control at all, so this is not reachable through the dashboard — it is
  // here because a disabled control is an affordance, not a rule, and the
  // no-JS path posts whatever the form holds.
  //
  // String comparison, not date arithmetic: 'YYYY-MM-DD' sorts as its own
  // calendar, which is the whole reason the day key has that shape.
  if (dayField > today) {
    return new Response(null, { status: 400 })
  }
  const day = dayField

  const panel = action === 'mark' ? PANEL_MARK : PANEL_UNMARK

  let userDb
  try {
    userDb = openUserDataForWrite(user, key)
  } catch (error) {
    // WrongKeyError (or a corrupt file) must not become a bare 500 with a
    // stack. The stderr line carries the error's name and code, which the
    // metric deliberately cannot.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  }
  try {
    if (action === 'mark') {
      // `OR IGNORE`, and the difference from run10's pee log is the whole
      // shape of this dashboard. walk_log records a FACT ABOUT A DAY — spec
      // v2: "One walk per day is all that's recorded; there's no count of
      // walks within a day" — so a second mark is the same fact twice and a
      // double tap must be a no-op, not a second row. Idempotent by primary
      // key rather than by a read-then-write, so there is no race between the
      // check and the insert.
      userDb.prepare('INSERT OR IGNORE INTO walk_log (day, at) VALUES (?, ?)').run(day, now)
    } else {
      // Unmarking a day that is not marked is also a no-op, for the same
      // reason: the friend's intent is "this day should not be marked", and
      // whether it already was is not something he should have to be right
      // about.
      userDb.prepare('DELETE FROM walk_log WHERE day = ?').run(day)
    }
  } catch (error) {
    // The WRITE needs the same catch as the open above: a full disk, a
    // SQLITE_BUSY outliving the driver's timeout, or a missing table would
    // otherwise throw straight out of POST — the friend gets Next's default
    // error page in response to a form submit, with no dashboard, no chat
    // surface and no way back but the browser's back button, and no metric
    // row, so it is invisible to the operator too.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  } finally {
    userDb.close()
  }

  // Permanent policy: a slug and a panel, never a value. NOT the day — which
  // matters more here than anywhere else in this repo, because the day is the
  // one thing the caller sent and it is a fact about the friend's life.
  // `metrics` is the unencrypted platform database, and this row is what makes
  // the login page's "I can see when you use it ... but not what you log"
  // true. Two panel names rather than one reused: marking and unmarking are
  // genuinely distinct events, and a query grouping by panel needs to tell
  // them apart.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel, device_class },
    at: now,
  })

  // A native form post gets the host-relative 303 (the app runs behind a
  // reverse proxy, so request.url names the internal origin — see
  // lib/http/redirect.ts); a fetch-initiated write gets 204, so the browser
  // never follows a redirect it would otherwise render into a second
  // dashboard_open row.
  //
  // The redirect names the walk log screen, not the bare dashboard: without
  // JavaScript this is the whole navigation, and landing a friend who just
  // tapped a calendar square back on the decider would look like the tap
  // undid itself.
  return writeAnswer(request, `/${user}?screen=walk_log`)
}
