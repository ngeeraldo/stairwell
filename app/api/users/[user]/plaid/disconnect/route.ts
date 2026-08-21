import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { getDb } from '@/lib/db/instance'
import { logDbFailure } from '@/lib/db/failureLog'
import { openUserDataForWrite } from '@/lib/db/userData'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { writeAnswer } from '@/lib/http/redirect'
import { plaidApiFromEnv, removeItem } from '@/lib/plaid/client'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * DISCONNECT A BANK: revoke the item at Plaid and destroy the stored token.
 *
 * Written from platform/templates/route/route.ts.tmpl, four ordered checks
 * verbatim.
 *
 * ── WHAT IT DELETES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * It removes the CONNECTION: the item is revoked at Plaid (verified in Phase
 * 1 — /item/get afterwards returns ITEM_NOT_FOUND) and the plaid_items row,
 * which holds the access token, is deleted.
 *
 * It does NOT delete the synced transactions, balances or holdings. That is a
 * deliberate split, and it is the reversible choice:
 *
 *   - Stopping a connection is undoable. The friend reconnects and syncing
 *     resumes.
 *   - Deleting their financial history is not, and nobody — including Nico —
 *     can restore it, because nobody can read the database.
 *   - Any annotation a friend has written lives in THEIR OWN table keyed to a
 *     transaction_id (CLAUDE.md > Schema & module rules). Dropping the synced
 *     rows here would orphan every one of those notes as a side effect of a
 *     button that says "disconnect".
 *
 * A friend who wants the data gone as well is a second, louder action that
 * does not exist yet, and it should say what it does. Named as a limit rather
 * than left to be discovered.
 *
 * ── PLAID IS TOLD FIRST, AND A FAILURE THERE STILL DESTROYS THE TOKEN ───────
 *
 * If /item/remove fails, the local row is deleted anyway. The friend pressed
 * disconnect; leaving a working bank credential in their database because a
 * third party had a bad minute would be the wrong way to fail. The orphaned
 * item on Plaid's side costs a slot against the 200-item cap and is visible in
 * the Plaid dashboard — an operator problem, not a friend's.
 */

/** The panel a metric row names. A constant, never anything derived. */
const PANEL = 'plaid_disconnect'

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
    console.error('[plaid_disconnect] refused: session not unlocked')
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
    console.error('[plaid_disconnect] refused: key vanished between reads')
    return new Response(null, { status: 403 })
  }

  const device_class = await readDeviceClass()
  const now = Date.now()

  let token: string | undefined
  try {
    const userDb = openUserDataForWrite(user, key)
    try {
      const row = userDb
        .prepare('SELECT access_token FROM plaid_items ORDER BY connected_at LIMIT 1')
        .get() as { access_token?: string } | undefined
      token = row?.access_token

      // DELETED BEFORE Plaid is told, and outside the network call. The
      // friend's instruction was "destroy this credential"; the local delete
      // is the part we can guarantee, so it is the part that happens first.
      userDb.prepare('DELETE FROM plaid_items').run()
    } finally {
      userDb.close()
    }
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

  if (token) {
    try {
      await removeItem(plaidApiFromEnv(), token)
    } catch (error) {
      // Logged, not surfaced. The credential is already gone from the friend's
      // database, which is what they asked for; a stranded item on Plaid's
      // side is an operator's problem and must not make a successful
      // disconnect look like a failure.
      logDbFailure('plaid_item_remove_failed', user, error)
    }
  }

  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel: PANEL, device_class },
    at: now,
  })

  return writeAnswer(request, `/${user}`)
}
