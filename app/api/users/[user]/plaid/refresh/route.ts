import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { getDb } from '@/lib/db/instance'
import { logDbFailure } from '@/lib/db/failureLog'
import { openUserDataForWrite } from '@/lib/db/userData'
import { readDeviceClass, readTimeZone } from '@/lib/metrics/deviceClass'
import { writeAnswer } from '@/lib/http/redirect'
import { PlaidCallError, plaidApiFromEnv } from '@/lib/plaid/client'
import {
  pullAccounts,
  pullHoldings,
  pullInvestmentTransactions,
  pullRecurring,
  pullTransactions,
  recordRefresh,
  type ProductOutcome,
} from '@/lib/plaid/sync'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'
// dayKey lives in lib/time, not here. A route module may export only Next's
// own route fields — anything else fails `next build` with "is not a valid
// Route export field". See lib/time/dayKey.ts.
import { dayKey } from '@/lib/time/dayKey'
import type { UserDb } from '@/lib/db/userDb'

/**
 * PULL A FRIEND'S BANK DATA. The only thing in this app that writes a plaid_*
 * data table.
 *
 * Written from platform/templates/route/route.ts.tmpl, four ordered checks
 * verbatim. What is different, and why:
 *
 * ── IT IS ONE OF EXACTLY TWO SANCTIONED TRIGGERS, AND THE ONLY ONE V1 USES ──
 *
 * CLAUDE.md: nothing writes to a friend's database except from their own
 * session, and V1 has two triggers — a control the friend presses, and a
 * one-time action at login. This is the FIRST of those, and the login trigger
 * was dropped for Plaid: their data key exists only in the in-process keymap
 * while they are unlocked, so a button and a login are the only two moments a
 * write is POSSIBLE at all, and the button alone covers every "I want it now".
 *
 * ── PARTIAL SUCCESS IS THE NORMAL CASE, NOT AN EDGE ─────────────────────────
 *
 * Five products are pulled and any of them can fail on its own. One bank being
 * slow with investments must not throw away the transactions that already
 * arrived, so each product is attempted independently, each writes its own
 * plaid_refreshes row, and the response is 200 as long as ANY product
 * succeeded. A blanket failure would make the friend press Refresh again and
 * lose data that was already theirs.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CALL ──────────────────────────────────────
 *
 * /transactions/refresh and /investments/refresh. Both are fire-and-forget —
 * they return a request_id while the extraction is still running at the bank,
 * so calling one and then immediately syncing returns exactly what Plaid
 * already had. Measured: they add ~4 seconds to a button press for zero
 * additional data, and they are the two endpoints billed PER CALL. The whole
 * default path is 5 calls that cost nothing extra.
 *
 * ── WHICH PRODUCTS, AND WHO DECIDES ─────────────────────────────────────────
 *
 * The item's own `available_products`, stored at connect time from /item/get,
 * intersected with what the caller asks for. A friend with one credit card
 * never pays the latency of an investments call, and a dashboard with no
 * subscriptions panel can skip recurring. The intersection happens SERVER-SIDE
 * so a caller can only ever narrow the set, never widen it past what this
 * connection can serve.
 */

/** The panel a metric row names. A constant, never anything derived. */
const PANEL = 'plaid_refresh'

/** How far back investment transactions are pulled. Plaid offers 24 months. */
const INVESTMENT_WINDOW_DAYS = 730

/**
 * Products this route knows how to pull, and the item capability each needs.
 *
 * `transactions` and `accounts` have no capability requirement: every item can
 * serve them, and `accounts` is where balances come from.
 */
const PULLABLE = ['transactions', 'accounts', 'holdings', 'recurring', 'investment_transactions'] as const
type Pullable = (typeof PULLABLE)[number]

const REQUIRES: Partial<Record<Pullable, string>> = {
  holdings: 'investments',
  investment_transactions: 'investments',
  recurring: 'recurring_transactions',
}

function plannedProducts(available: string[], requested: string[] | undefined): Pullable[] {
  const asked = requested?.length ? requested : [...PULLABLE]
  return PULLABLE.filter((product) => {
    if (!asked.includes(product)) return false
    const capability = REQUIRES[product]
    // No capability required, or this connection reports it.
    return !capability || available.includes(capability)
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    console.error('[plaid_refresh] refused: session not unlocked')
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
    console.error('[plaid_refresh] refused: key vanished between reads')
    return new Response(null, { status: 403 })
  }

  // READ AFTER the auth checks, deliberately: parsing a body is work done on
  // behalf of the caller, and an unauthenticated caller gets none of it.
  let requested: string[] | undefined
  try {
    const form = await request.formData()
    const raw = form.get('products')
    requested = typeof raw === 'string' && raw ? raw.split(',').map((p) => p.trim()) : undefined
  } catch {
    requested = undefined
  }

  const device_class = await readDeviceClass()
  const timeZone = await readTimeZone()
  // ONE clock read for the whole request. Two can straddle midnight and file a
  // row whose `day` and `at` disagree about the calendar, which is the exact
  // class of bug the friend-timezone ledger is about.
  const now = Date.now()
  const attempt = { at: now, day: dayKey(now, timeZone) }

  let userDb: UserDb
  try {
    userDb = openUserDataForWrite(user, key)
  } catch (error) {
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: PANEL, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  }

  try {
    // EVERY LIVE BANK, not the oldest one. This read was
    // `ORDER BY connected_at LIMIT 1`, so a friend's second bank was never
    // refreshed at all — it sat there going stale while the button reported
    // success.
    //
    // Disconnected banks are excluded rather than attempted: disconnecting
    // destroys the stored token, so there is nothing to call with, and
    // recording a failure for a connection the friend deliberately stopped
    // would read as a fault rather than as their own choice.
    const items = userDb
      .prepare(
        `SELECT item_id, access_token, available_products
           FROM plaid_items
          WHERE disconnected_at IS NULL
          ORDER BY connected_at`,
      )
      .all() as { item_id: string; access_token: string; available_products: string }[]

    // Nothing connected. Not an error — it is the state every friend is in
    // before they connect, and a 4xx here would make an ordinary situation
    // look like a fault.
    if (items.length === 0) return writeAnswer(request, `/${user}`)

    const api = plaidApiFromEnv()
    // `itemId` is optional on ProductOutcome — some callers describe a single
    // item they already have in hand — but this route loops over banks, so
    // narrowing it here makes "every outcome names its bank" a compiler rule
    // rather than a convention.
    const outcomes: (ProductOutcome & { itemId: string })[] = []

    for (const item of items) {
      let available: string[] = []
      try {
        const parsed: unknown = JSON.parse(item.available_products)
        if (Array.isArray(parsed)) {
          available = parsed.filter((p): p is string => typeof p === 'string')
        }
      } catch {
        // A malformed column is a bug in the connect route, not a reason to
        // refuse the friend a refresh of the products that need no capability.
      }

      const ref = { itemId: item.item_id, accessToken: item.access_token }

      for (const product of plannedProducts(available, requested)) {
        try {
          if (product === 'transactions') {
            await pullTransactions(userDb, api, ref)
          } else if (product === 'accounts') {
            await pullAccounts(userDb, api, ref)
          } else if (product === 'holdings') {
            await pullHoldings(userDb, api, ref)
          } else if (product === 'recurring') {
            const state = await pullRecurring(userDb, api, ref)
            // 'not_ready' is recorded as its own outcome rather than as a
            // success or a failure: Plaid has the connection and has not
            // finished preparing the product, which is routine on the first
            // refresh after connecting and is neither.
            outcomes.push({
              product,
              ok: state === 'ok',
              code: state === 'ok' ? undefined : 'not_ready',
              itemId: item.item_id,
            })
            continue
          } else {
            await pullInvestmentTransactions(userDb, api, ref, {
              startDate: dayKey(now - INVESTMENT_WINDOW_DAYS * 86_400_000, timeZone),
              endDate: attempt.day,
            })
          }
          outcomes.push({ product, ok: true, itemId: item.item_id })
        } catch (error) {
          // ONE FAILURE IS NOT THE REFRESH'S FAILURE, and that now holds in
          // two directions. A bank being slow with investments must not
          // discard the transactions that already landed; and ONE BANK being
          // down must not leave the friend's other bank stale, because they
          // pressed Refresh once and both are theirs.
          const code = error instanceof PlaidCallError ? error.code : 'error'
          outcomes.push({ product, ok: false, code, itemId: item.item_id })
          logDbFailure('plaid_refresh_failed', user, error)
        }
      }
    }

    // Every attempt is recorded, including the failures. Without these rows a
    // failed refresh is indistinguishable from no refresh and the dashboard
    // renders stale numbers as though they were current. Each row names its
    // bank: "transactions failed" is unactionable when the friend's other bank
    // is perfectly healthy.
    for (const outcome of outcomes) recordRefresh(userDb, attempt, outcome, outcome.itemId)

    // Permanent policy: a slug and a panel, never a value. Not how many
    // transactions arrived, not a balance, not the institution.
    appendMetric(db, {
      accountId,
      event: 'dashboard_write',
      data: { slug: user, panel: PANEL, device_class },
      at: now,
    })

    // 502 only when EVERY product failed. Anything less is a partial success,
    // and the per-product rows above are what let the panel say which half.
    const anySucceeded = outcomes.some((o) => o.ok)
    if (outcomes.length > 0 && !anySucceeded) {
      return new Response(null, { status: 502 })
    }

    return writeAnswer(request, `/${user}`)
  } catch (error) {
    // A full disk, a SQLITE_BUSY outliving the driver's timeout, or a missing
    // table would otherwise throw straight out of POST: the friend gets Next's
    // default error page with no dashboard and no way back, and no metric row,
    // so it is invisible to the operator too.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: PANEL, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  } finally {
    userDb.close()
  }
}
