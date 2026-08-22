import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { getDb } from '@/lib/db/instance'
import { logDbFailure } from '@/lib/db/failureLog'
import { openUserDataForRead } from '@/lib/db/userData'
import { PlaidCallError, createLinkToken, plaidApiFromEnv } from '@/lib/plaid/client'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * MINT THE TOKEN PLAID LINK OPENS WITH.
 *
 * Written from platform/templates/route/route.ts.tmpl and keeping its four
 * ordered checks verbatim — they ARE the security property and are cheaper to
 * read twice than to trace through an abstraction. Two things here are
 * genuinely different from every other route in this app, and both are called
 * out because they look like drift otherwise.
 *
 * ── IT RETURNS A BODY, UNLIKE EVERY OTHER ROUTE UNDER users/ ────────────────
 *
 * The template is explicit that a write route answers with an empty body and
 * `writeAnswer`, because lib/ui/WriteAction.tsx never reads one. THIS IS NOT A
 * WRITE. It touches no table, changes nothing, and its entire output is a
 * short-lived token the browser must hand to Plaid's script. So it answers
 * with JSON and a 200, and it must not redirect.
 *
 * The link token is safe to put in a response body: it is single-use, expires
 * in minutes, authorises nothing but opening Link, and cannot read an account.
 * The ACCESS token — which can — never appears in a response from anywhere in
 * this app.
 *
 * ── THREE MODES, AND THE CALLER NAMES WHICH ────────────────────────────────
 *
 *   no item_id            NEW — Plaid shows the institution picker
 *   item_id               UPDATE — Plaid reopens THAT bank's login form
 *   item_id + accounts    ACCOUNTS — Plaid reopens that bank's ACCOUNT picker
 *
 * This route used to decide for itself, by asking whether the friend had any
 * plaid_items row at all: none meant new, any meant repair. That was wrong the
 * moment a friend could have two banks, and it is the bug that produced this
 * whole plan — once a friend connected one bank, "connect another" reopened
 * the bank they already had and the institution picker was unreachable
 * forever.
 *
 * Which connection to act on is a choice the FRIEND makes, by pressing a
 * control next to one of their banks, so it is the caller's to send. What the
 * caller does NOT get to do is name a connection that is not theirs: the id
 * arrives as an opaque string and is resolved against the friend's own
 * database below. An id that is not in there mints nothing and Plaid is never
 * called.
 *
 * A DISCONNECTED item is refused the same way. Disconnecting revokes the token
 * at Plaid, so an update-mode token minted against it could only produce an
 * error — and offering the friend a repair for a connection that cannot be
 * repaired is worse than offering nothing.
 *
 * ── WHY A READ HANDLE ───────────────────────────────────────────────────────
 *
 * openUserDataForRead, not ForWrite. This route stores nothing; the access
 * token it may read never leaves this function and is never returned, logged,
 * or put in a metric.
 */

/**
 * What a NEW connection asks Plaid for.
 *
 * ── WHY INVESTMENTS IS NOT IN THIS LIST ─────────────────────────────────────
 *
 * Plaid Link only shows institutions supporting EVERY product in `products`.
 * Measured against Sandbox: 213 of 500 institutions are OAuth, and 112 of
 * those — 53% — support transactions but not investments. Asking for
 * investments here hid every one of them from the picker WITH NO ERROR. A
 * friend banking with Chime, Discover or KeyBank would not find their own bank
 * and would have nothing to report except that it "isn't there", which is
 * about the worst bug report a person can be forced to give.
 *
 * `additional_consented_products` gets consent without filtering the list, and
 * investments still reads afterwards — verified against a real Sandbox item
 * created with transactions only, which returned 13 holdings.
 *
 * `recurring_transactions` appears in NEITHER list: Plaid rejects it in
 * `products` outright ("some products cannot be included in initial_products")
 * and it becomes available on its own roughly ten seconds after the item
 * exists. Verified against Sandbox — plan finding F1.
 */
const PRODUCTS = ['transactions']
const CONSENTED = ['investments']

/**
 * Where an OAuth bank returns the friend after they log in.
 *
 * FROM THE ENVIRONMENT, not derived from the request, for two independent
 * reasons. It must EXACTLY match an entry in the Plaid dashboard's allowed
 * redirect URIs — Plaid rejects the token otherwise — and `request.url` behind
 * a reverse proxy names the INTERNAL origin, which is the same trap
 * lib/http/redirect.ts exists for.
 *
 * Set on every token, not only ones destined for an OAuth bank: which
 * institution the friend picks is decided inside Plaid's UI, long after this
 * runs.
 *
 * Absent, non-OAuth banks still connect and OAuth banks fail at the picker.
 * That is the DEGRADED tier in deploy/required-env, and it is why this returns
 * undefined rather than throwing — one kind of bank not working is not a
 * reason to refuse the whole flow.
 */
function redirectUri(): string | undefined {
  return process.env.PLAID_REDIRECT_URI || undefined
}

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
    console.error('[plaid_link_token] refused: session not unlocked')
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
    // The narrow race: resolveState proved a key existed a moment ago and it
    // is gone now. Distinct from the check above, and far rarer.
    console.error('[plaid_link_token] refused: key vanished between reads')
    return new Response(null, { status: 403 })
  }

  // READ AFTER the auth checks, deliberately: parsing a body is work done on
  // behalf of the caller, and an unauthenticated caller gets none of it.
  let requestedItem: string | undefined
  let manageAccounts = false
  try {
    const form = await request.formData()
    const raw = form.get('item_id')
    if (typeof raw === 'string' && raw !== '') requestedItem = raw
    manageAccounts = form.get('manage_accounts') === '1'
  } catch {
    // No body at all is the ordinary "connect a bank" press. PlaidConnect
    // posts nothing when it is opening the institution picker.
  }

  // The connection the caller named, resolved against the friend's OWN
  // database. Opening it is work done on their behalf, so it happens after the
  // auth checks.
  let existingToken: string | undefined
  if (requestedItem !== undefined) {
    let row: { access_token?: string; disconnected_at?: number | null } | undefined
    try {
      const userDb = openUserDataForRead(user, key)
      try {
        row = userDb
          .prepare(
            'SELECT access_token, disconnected_at FROM plaid_items WHERE item_id = ?',
          )
          .get(requestedItem) as { access_token?: string; disconnected_at?: number | null } | undefined
      } finally {
        userDb.close()
      }
    } catch (error) {
      // A missing plaid_items table means this dashboard has no Plaid module
      // vendored into its migrations — a build mistake, not a friend's problem.
      logDbFailure('plaid_link_token_error', user, error)
      return new Response(null, { status: 500 })
    }

    // 404 for both "no such item" and "not yours", exactly as check 2 answers
    // 404 rather than 403 for another account's space: a caller learns that
    // the id names nothing they can act on, and nothing about whether it
    // exists for someone else.
    if (!row?.access_token || row.disconnected_at !== null) {
      return new Response(null, { status: 404 })
    }
    existingToken = row.access_token
  }

  try {
    const token = await createLinkToken(plaidApiFromEnv(), {
      // OURS, not Plaid's, and never the slug: Plaid stores this value, and a
      // slug is a name a person chose. The account's opaque id is not.
      clientUserId: String(accountId),
      ...(existingToken
        ? { accessToken: existingToken, ...(manageAccounts ? { accountSelection: true } : {}) }
        : { products: PRODUCTS, additionalConsentedProducts: CONSENTED }),
      ...(redirectUri() ? { redirectUri: redirectUri() } : {}),
    })

    return Response.json({
      link_token: token,
      mode: existingToken ? (manageAccounts ? 'accounts' : 'update') : 'new',
    })
  } catch (error) {
    // PASSED THROUGH UNWRAPPED, and that is the whole point: PlaidCallError
    // carries a `code`, and lib/db/failureLog.ts prints an error's `name` and
    // `code` while deliberately dropping its `message`. Wrapping this in
    // `new Error(code)` put the code in the one field that gets discarded and
    // produced `error=Error code=none` — a log line with no information in it,
    // which is worse than none because it looks like diagnostics.
    logDbFailure('plaid_link_token_error', user, error)
    return new Response(null, { status: 502 })
  }
}
