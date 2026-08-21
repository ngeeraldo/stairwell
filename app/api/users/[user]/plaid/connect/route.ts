import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { getDb } from '@/lib/db/instance'
import { logDbFailure } from '@/lib/db/failureLog'
import { openUserDataForWrite } from '@/lib/db/userData'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { writeAnswer } from '@/lib/http/redirect'
import {
  PlaidCallError,
  exchangePublicToken,
  getItem,
  plaidApiFromEnv,
} from '@/lib/plaid/client'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * FINISH A BANK CONNECTION: trade Plaid Link's public token for the long-lived
 * access token, and store it in the friend's own encrypted database.
 *
 * Written from platform/templates/route/route.ts.tmpl, four ordered checks
 * verbatim.
 *
 * ── THIS IS THE MOST SENSITIVE WRITE IN THE APPLICATION ─────────────────────
 *
 * The access token is a bearer credential that reads a real person's real bank
 * account. It exists in exactly two places for its whole life: the return
 * value of the exchange below, and one row in the friend's SQLCipher database.
 * It is never logged, never returned in a response body, never written to a
 * metric, and never copied to the platform database. Nobody can read it
 * without that friend's password — including Nico, by design.
 *
 * That is also why the failure paths below carry a CODE and not Plaid's
 * message: an upstream error body is text we did not write, on a path that
 * ends in a log line.
 *
 * ── WHAT THE FRIEND'S BANK CREDENTIALS NEVER TOUCH ──────────────────────────
 *
 * Their username and password go into Plaid's own UI, running on their own
 * device. They never reach this server, this route, or this repository. All
 * that arrives here is a short-lived public token that is worthless on its own
 * and useless once exchanged.
 *
 * ── available_products IS STORED, AND IT IS NOT DECORATION ──────────────────
 *
 * /item/get reports what THIS connection can serve. A friend who connected one
 * credit card cannot answer an investments call, and storing that here is what
 * lets the refresh route skip it rather than spend 3.5 seconds discovering it
 * every time (plan F8).
 *
 * ── ONE ITEM PER FRIEND, FOR NOW ────────────────────────────────────────────
 *
 * The table can hold several, but connecting replaces rather than appends.
 * Multiple banks per friend is a real want and a real design question — which
 * accounts belong to which item, what a partial failure means, what the UI
 * says — and inventing an answer here would be guessing at it. Named as a
 * limit rather than left to be discovered.
 */

/** The panel a metric row names. A constant, never anything derived. */
const PANEL = 'plaid_connect'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    // WHICH check refused, and nothing else. No slug-derived value, no session
    // id, no user data — just the name of the gate, so a 403 can be told apart
    // from the other 403 below. Without this they are indistinguishable from
    // the browser, and they have completely different causes: this one means
    // the session has no key at all (logged out, swept, or the in-process
    // keymap was reset — which `npm run dev` can do by re-evaluating a module
    // when it compiles a route for the first time).
    console.error('[plaid_connect] refused: session not unlocked')
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
  if (accountId === undefined || !key) {
    // The narrow race: resolveState proved a key existed a moment ago and it
    // is gone now. Distinct from the check above, and far rarer.
    console.error('[plaid_connect] refused: key vanished between reads')
    return new Response(null, { status: 403 })
  }

  // READ AFTER the auth checks, deliberately: parsing a body is work done on
  // behalf of the caller, and an unauthenticated caller gets none of it.
  let publicToken: string
  try {
    const form = await request.formData()
    publicToken = String(form.get('public_token') ?? '')
  } catch {
    return new Response(null, { status: 400 })
  }
  if (!publicToken) return new Response(null, { status: 400 })

  const device_class = await readDeviceClass()
  const now = Date.now()

  // EXCHANGED BEFORE THE DATABASE IS OPENED. Holding an open handle on a
  // friend's encrypted database across two network round trips buys nothing,
  // and the same reasoning app/api/users/[user]/forecast/route.ts already
  // applies to its provider call.
  let item: { accessToken: string; itemId: string }
  let detail: { institutionId?: string; availableProducts: string[] }
  try {
    const api = plaidApiFromEnv()
    item = await exchangePublicToken(api, publicToken)
    const described = await getItem(api, item.accessToken)
    detail = {
      institutionId: described.institutionId,
      availableProducts: described.availableProducts,
    }
  } catch (error) {
    // PASSED THROUGH UNWRAPPED. PlaidCallError carries a `code`, and
    // lib/db/failureLog.ts prints `name` and `code` while deliberately
    // dropping `message` — so wrapping this in `new Error(code)` logged
    // `error=Error code=none`, which is the exact opposite of the reason this
    // line exists. The token and Plaid's prose still never reach it: a
    // PlaidCallError holds neither.
    logDbFailure('plaid_connect_failed', user, error)
    return new Response(null, { status: 502 })
  }

  try {
    const userDb = openUserDataForWrite(user, key)
    try {
      // REPLACE, not append — see the one-item-per-friend note above. Inside a
      // transaction so a crash cannot leave a friend with two items and no way
      // to tell which one their data came from.
      userDb.transaction(() => {
        userDb.prepare('DELETE FROM plaid_items').run()
        userDb
          .prepare(
            `INSERT INTO plaid_items
               (item_id, access_token, institution_id, cursor, available_products, payload, connected_at)
             VALUES (?, ?, ?, NULL, ?, '{}', ?)`,
          )
          .run(
            item.itemId,
            item.accessToken,
            detail.institutionId ?? null,
            JSON.stringify(detail.availableProducts),
            now,
          )
      })()
    } finally {
      userDb.close()
    }
  } catch (error) {
    // A full disk, a SQLITE_BUSY, or a missing plaid_items table would
    // otherwise throw straight out of POST: the friend gets Next's default
    // error page with no dashboard and no way back, and no metric row, so it
    // is invisible to the operator too.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: PANEL, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  }

  // Permanent policy: a slug and a panel, never a value. Not the institution,
  // not the item id, not how many accounts came back — `metrics` is the
  // unencrypted platform database, and this row is what makes the login page's
  // "I can see when you use it … but not what you log" true.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel: PANEL, device_class },
    at: now,
  })

  return writeAnswer(request, `/${user}`)
}
