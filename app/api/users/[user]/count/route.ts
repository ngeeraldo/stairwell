import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { readDeviceClass, readTimeZone } from '@/lib/metrics/deviceClass'
import { openUserDataForWrite } from '@/lib/db/userData'
import { logDbFailure } from '@/lib/db/failureLog'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { relativeRedirect } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'
// A route module may export only Next's own route fields — anything else
// fails `next build` with "is not a valid Route export field", which is what
// an exported-for-testability helper did on an earlier branch. Helpers live in
// lib/. See lib/time/dayKey.ts.
import { dayKey } from '@/lib/time/dayKey'

/**
 * Record one bathroom trip, or take one back.
 *
 * A SECOND route beside walk/, not a generalisation of it. Per-friend write
 * routes are the worked pattern (build-rules §4) — each dashboard's rules live
 * in its own route, where they can be read next to the table they defend,
 * rather than in a shared handler that grows a branch per friend.
 *
 * The order of the checks below is the security property, and is walk/'s
 * order unchanged:
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

  // Which button, and nothing else. The form carries no date: run8 confirmed
  // that minus adjusts TODAY only, and the way to honour that is to give the
  // request no way to name another day rather than to validate one it sent.
  // A client-supplied date would also be a second opinion about the friend's
  // calendar, which is the disagreement lib/time/dayKey.ts exists to prevent.
  const form = await request.formData().catch(() => undefined)
  const delta = form?.get('delta') === '-1' ? -1 : 1

  // Resolved ONCE per request, not per emit: the rows below fire on mutually
  // exclusive paths, and re-reading the headers per row would be several reads
  // of a value that cannot have changed.
  const device_class = await readDeviceClass()
  // The day this tap belongs to is the friend's day, not the droplet's — the
  // droplet is UTC, and a tap at 21:03 in New York is 01:03Z.
  const timeZone = await readTimeZone()
  const at = Date.now()
  const day = dayKey(at, timeZone)

  let userDb
  try {
    userDb = openUserDataForWrite(user, key)
  } catch (error) {
    // A wrong key or a corrupt file must not become a bare 500 with a stack: a
    // metric is recorded first so the failure is visible at all, then a
    // bodyless 500. Slug and panel only — never the error message, which could
    // carry what was being logged.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: 'today_counter', device_class },
      at,
    })
    return new Response(null, { status: 500 })
  }

  try {
    if (delta === 1) {
      userDb
        .prepare('INSERT INTO pee_events (day, at, delta) VALUES (?, ?, 1)')
        .run(day, at)
    } else {
      // ── Minus stops at zero, in ONE statement ─────────────────────────────
      //
      // run8's confirmed answer is that a day may not go below zero. The
      // obvious shape — SELECT the total, compare, then INSERT — is a
      // read-then-write with a gap in the middle: two taps arriving together
      // both read 1, both decide they may subtract, and the day lands at -1.
      // A tap is one HTTP request and a friend has two thumbs, so that race is
      // reachable on a phone, not merely theoretical.
      //
      // The guard rides INSIDE the insert instead. SQLite evaluates the
      // subquery and writes the row in a single statement, so there is no
      // moment between them for a second request to occupy.
      userDb
        .prepare(
          `INSERT INTO pee_events (day, at, delta)
           SELECT ?, ?, -1
           WHERE (SELECT COALESCE(SUM(delta), 0) FROM pee_events WHERE day = ?) > 0`,
        )
        .run(day, at, day)
      // A refused minus is deliberately NOT an error. Pressing minus on a zero
      // is the friend saying "undo" when there is nothing to undo; the honest
      // answer is the unchanged screen they are about to be redirected to, not
      // a 4xx that drops them on an error page mid-tap.
    }
  } catch (error) {
    // The write needs its own catch, not just the open: a full disk, a
    // SQLITE_BUSY outliving the driver's timeout, or a CHECK the shape refuses
    // would otherwise throw straight out of POST and hand the friend Next's
    // default error page in response to a form submit — no dashboard, no chat,
    // no way back but the browser's back button — and no metric row, so it
    // would be invisible to the operator too.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: 'today_counter', device_class },
      at,
    })
    return new Response(null, { status: 500 })
  } finally {
    userDb.close()
  }

  // Permanent policy: a slug and a panel, never a value (CLAUDE.md > Dashboard
  // folder conventions). Not the delta, not the day, not the resulting count —
  // "how many times run8 went to the bathroom today" is exactly what the login
  // page promises is not recorded here, and `metrics` is the unencrypted
  // platform database. Which BUTTON was pressed is that same fact at one
  // remove, so it is not recorded either: a row per press with delta=-1 would
  // let anyone reading the table count a friend's corrections.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel: 'today_counter', device_class },
    at,
  })

  return relativeRedirect(`/${user}`)
}
