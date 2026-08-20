import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { openUserDataForWrite } from '@/lib/db/userData'
import { logDbFailure } from '@/lib/db/failureLog'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { writeAnswer } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * run11's no-go feels-like temperature: nudge it one degree either way.
 *
 * A ROUTE OF ITS OWN, copied from platform/templates/route/route.ts.tmpl and
 * separate from run11's own walk-log route on purpose — see that file's header
 * for the pending-grouping reason as well as the standing one
 * (docs/dashboard-build-rules.md §4: the template is a worked example, not a
 * base class, and the four checks below ARE the security property).
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
 * ─── IT TAKES A DIRECTION, NEVER A NUMBER ──────────────────────────────────
 *
 * The body says `raise` or `lower`; the new value is computed HERE, from the
 * row that is already there, inside the same transaction that writes it. A
 * body carrying the target number would be simpler and wrong in two ways: two
 * presses landing together would both compute 91 from a 90 they each read
 * before the other wrote, and every clamp would then be a bound the CALLER
 * chose to respect. WriteAction disables its control while a write is in
 * flight, so the race is not reachable through the dashboard — but the no-JS
 * path has no such guard, and "the browser prevents it" is not where a bound
 * belongs.
 *
 * ─── AND IT READS NO CLOCK FOR A DAY ───────────────────────────────────────
 *
 * Unlike every other write route here, nothing this one writes is filed under
 * a calendar day: a setting is not an event. `Date.now()` appears once, as the
 * timestamp on the row and on the metric, and no timezone is consulted at all.
 */

/**
 * The bounds and the step, DUPLICATED from users/run11/queries.ts rather than
 * imported, and that is deliberate.
 *
 * A platform route importing a user folder would make one friend's dashboard a
 * build dependency of the platform — the direction of that arrow is the whole
 * reason `queries.ts` takes a `UserDb` and knows nothing about routes. The
 * dashboard's disabled buttons are an AFFORDANCE and these are the RULE; they
 * are meant to agree, and users/run11/tests/noGoTemp.test.ts asserts they do,
 * by reading both. Two constants that a test pins together are safer than an
 * import that inverts a dependency.
 */
const MIN_F = 80
const MAX_F = 105
const STEP_F = 1

/** The panel a metric row names. A constant, never anything derived. */
const PANEL_RAISE = 'no_go_temp_raise'
const PANEL_LOWER = 'no_go_temp_lower'

/**
 * What the friend's number is before he has ever set one.
 *
 * 90°F, matching DEFAULT_HEAT_NO_GO_F in users/run11/queries.ts for the same
 * reason as the bounds above. It is needed here because the first press has no
 * row to read: pressing + on a screen showing 90 must store 91, not 1.
 */
const DEFAULT_F = 90

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
  // Wrapped because formData() throws on a malformed or absent body.
  let action: FormDataEntryValue | null = null
  try {
    action = (await request.formData()).get('action')
  } catch {
    return new Response(null, { status: 400 })
  }
  // A closed set of exactly two, checked before anything opens a database.
  if (action !== 'raise' && action !== 'lower') {
    return new Response(null, { status: 400 })
  }

  const device_class = await readDeviceClass()
  const now = Date.now()
  const panel = action === 'raise' ? PANEL_RAISE : PANEL_LOWER

  let userDb
  try {
    userDb = openUserDataForWrite(user, key)
  } catch (error) {
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
    // READ AND WRITE IN ONE TRANSACTION. The read is what the step is applied
    // to, so a second request slipping between them would compute its step
    // from a value this one has already replaced.
    userDb.transaction(() => {
      const row = userDb.prepare('SELECT heat_no_go_f FROM walk_settings WHERE id = 1').get() as
        | { heat_no_go_f: number }
        | undefined
      const current = row === undefined ? DEFAULT_F : row.heat_no_go_f
      const stepped = current + (action === 'raise' ? STEP_F : -STEP_F)
      // CLAMPED HERE, so the bound holds however the request arrived — and
      // Math.round so a row that somehow holds a fraction cannot make every
      // future value a fraction too.
      const next = Math.min(MAX_F, Math.max(MIN_F, Math.round(stepped)))
      // Upsert on the single row the shape allows (002's CHECK (id = 1)), so
      // the first press and every one after it are the same statement.
      userDb
        .prepare(
          `INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET heat_no_go_f = excluded.heat_no_go_f,
                                           set_at       = excluded.set_at`,
        )
        .run(next, now)
    })()
  } catch (error) {
    // Same catch as the open above: a full disk, a SQLITE_BUSY outliving the
    // driver's timeout, or a missing table would otherwise throw straight out
    // of POST and give the friend Next's default error page in response to a
    // form submit, with no metric row to make it visible to the operator.
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

  // Permanent policy: a slug and a panel, never a value. NOT the temperature —
  // a threshold someone picked for their own dog is a preference about their
  // life, and `metrics` is the unencrypted platform database. The direction is
  // carried by the panel name, which is a constant chosen here, not derived
  // from anything he entered.
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
  // dashboard_open row. The decider screen is the default screen, so the bare
  // path is where this control lives.
  return writeAnswer(request, `/${user}`)
}
