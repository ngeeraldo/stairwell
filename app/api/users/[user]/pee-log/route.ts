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
 * run10's write path: log one pee.
 *
 * A ROUTE OF ITS OWN, copied from platform/templates/route/route.ts.tmpl and
 * not a generalisation of any existing one. docs/dashboard-build-rules.md §4
 * is explicit that the template is a worked example rather than a base class:
 * the four checks below ARE the security property, and they are cheaper to
 * read twice than to trace through an abstraction. It deliberately does not
 * share app/api/users/[user]/pee/route.ts, which is run9's and carries run9's
 * rules — a shared handler would make a change to one friend's dashboard a
 * silent change to another's, and users/run8's orphaned count/ route is what
 * the alternative looks like when a friend goes away.
 *
 * ONE ACTION, `add`, and the omission is the spec rather than an oversight.
 * run10's v1 asks for a tap button and nothing that takes a tap back: "A large,
 * easy-to-hit button that logs one pee per tap". The template's `remove` arm is
 * therefore not copied — an undocumented correction path would be a write this
 * dashboard's own record does not describe. If a correction is asked for later
 * it arrives as a spec version, with the not-below-zero bound written down.
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
 */
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
  try {
    action = (await request.formData()).get('action')
  } catch {
    return new Response(null, { status: 400 })
  }
  // A closed set of exactly one, checked before anything opens a database.
  // Written as an equality against the same string the dashboard's WriteAction
  // sends, so a body naming anything else — including the `remove` the
  // template ships and this dashboard does not implement — is refused here
  // rather than reaching the table.
  if (action !== 'add') {
    return new Response(null, { status: 400 })
  }

  // Resolved ONCE per request, not per emit: the rows below fire on mutually
  // exclusive paths, and re-reading the request headers per row would be
  // several reads of a value that cannot have changed.
  const device_class = await readDeviceClass()
  // The day this tap belongs to is the FRIEND'S day, not the droplet's — the
  // droplet is UTC, and a tap at 21:03 in New York is 01:03Z. See
  // lib/time/dayKey.ts and docs/superpowers/ledgers/friend-timezone.md. This
  // is also the whole of the spec's "resets to zero at midnight local time":
  // the reset is a consequence of filing under the right day, not a job.
  const timeZone = await readTimeZone()

  // ONE clock read for both columns. Two reads can straddle midnight and file
  // a row whose `day` and `at` disagree about the calendar, which is the exact
  // class of bug the timezone ledger is about.
  const now = Date.now()
  const day = dayKey(now, timeZone)

  // The panel a metric row names. A CONSTANT chosen by the builder, never
  // anything derived from what run10 logged: `metrics` is the unencrypted
  // platform database and carries a slug and a panel and nothing else — no
  // day, no count, no payload. That bound is what makes the login page's "I
  // can see when you use it ... but not what you log" true.
  const panel = 'pee_log'

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
    // NO `OR IGNORE`, and the difference is the whole shape of this dashboard.
    // A table keyed by day wants it, because a fact like "walked today" cannot
    // happen twice; here every tap is a distinct occurrence and both panels
    // are COUNTS of them, so deduplicating would silently discard the thing
    // being counted — and this is a tracker whose whole point is that a day
    // holds several.
    userDb.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, now)
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

  // Permanent policy: a slug and a panel, never a value. "They logged" and
  // "they went at 14:32" are the same fact for this dashboard, and this table
  // is unencrypted.
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
  return writeAnswer(request, `/${user}`)
}
