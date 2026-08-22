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
 * STOP A BANK, OR DELETE IT. Two actions, one route, and the difference is the
 * whole point.
 *
 * Written from platform/templates/route/route.ts.tmpl, four ordered checks
 * verbatim.
 *
 * ── TWO ACTIONS ─────────────────────────────────────────────────────────────
 *
 *   (default)        DISCONNECT. Revoke at Plaid, keep every synced row, and
 *                    mark the connection `disconnected_at`.
 *   action=remove    DELETE. Revoke at Plaid, then delete the connection and
 *                    every row that came from it.
 *
 * They are separate because they answer different questions, and a friend who
 * is offered only one of them ends up doing the wrong one. "I don't want this
 * updating any more" and "I want this out of my dashboard" have very different
 * consequences, and only the second is irreversible.
 *
 * ── DISCONNECT IS A SOFT DELETE, AND IT USED TO BE A HARD ONE ───────────────
 *
 * This route deleted the plaid_items row while deliberately keeping the synced
 * data. Both halves were defensible and together they produced an orphan: a
 * friend's transactions stayed on screen with nothing left to say they had
 * stopped updating, and no item that could ever refresh them. Frozen numbers,
 * rendering exactly like live ones.
 *
 * The row surviving with `disconnected_at` set is what turns that orphan into
 * a stated fact. Every panel can now say "no longer updating", and
 * lib/ui/PlaidSources.tsx does.
 *
 * The stored token IS destroyed — set to ''. /item/remove makes it useless, so
 * keeping it would store a credential-shaped string that authorises nothing.
 * `disconnected_at` is what records the state; the token has no second job.
 *
 * Keeping the synced rows is still the reversible choice, and still for the
 * same reasons:
 *
 *   - Deleting a friend's financial history cannot be undone by anyone —
 *     including Nico — because nobody can read the database.
 *   - Any annotation a friend has written lives in THEIR OWN table keyed to a
 *     transaction_id (CLAUDE.md > Schema & module rules). Dropping the synced
 *     rows would orphan every one of those notes as a side effect of a button
 *     that says "disconnect".
 *
 * ── remove DELETES EVERY ROW, AND CAN, BECAUSE EVERY ROW NAMES ITS BANK ─────
 *
 * modules/plaid/002_multi_source.sql stamps `item_id` on every synced table.
 * That is what lets this be exact: before it, the only way to find a bank's
 * transactions was to join through plaid_accounts, and an account that had
 * since closed was gone from there — so "delete this bank's data" would have
 * silently left rows behind, unreachable, in a database nobody can open to go
 * and find them.
 *
 * Annotations are the friend's own tables and are NOT deleted here. A note
 * keyed to a transaction that no longer exists is inert; deleting rows this
 * route does not own would be a worse surprise than leaving them.
 *
 * ── THE CALLER NAMES THE BANK, AND IT MUST ──────────────────────────────────
 *
 * `item_id` is required, and this route used to take the oldest row instead.
 * With two banks that is a coin flip on a destructive action, when the friend
 * pressed a control next to ONE of them. An id that is not in the friend's own
 * database answers 404 and calls Plaid not at all.
 *
 * ── PLAID IS TOLD FIRST, AND A FAILURE THERE STILL DESTROYS THE TOKEN ───────
 *
 * If /item/remove fails, the local write happens anyway. The friend pressed
 * the button; leaving a working bank credential in their database because a
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

  // READ AFTER the auth checks, deliberately: parsing a body is work done on
  // behalf of the caller, and an unauthenticated caller gets none of it.
  let itemId: string
  let remove = false
  try {
    const form = await request.formData()
    itemId = String(form.get('item_id') ?? '')
    remove = form.get('action') === 'remove'
  } catch {
    return new Response(null, { status: 400 })
  }
  // Named rather than guessed. See the header: taking the oldest row is a coin
  // flip on a destructive action once a friend has two banks.
  if (!itemId) return new Response(null, { status: 400 })

  const device_class = await readDeviceClass()
  const now = Date.now()

  let token: string | undefined
  try {
    const userDb = openUserDataForWrite(user, key)
    try {
      const row = userDb
        .prepare('SELECT access_token FROM plaid_items WHERE item_id = ?')
        .get(itemId) as { access_token?: string } | undefined

      // 404 for both "no such item" and "not yours", exactly as check 2
      // answers 404 rather than 403 for another account's space.
      if (row === undefined) {
        userDb.close()
        return new Response(null, { status: 404 })
      }
      token = row.access_token || undefined

      // WRITTEN BEFORE Plaid is told, and outside the network call. The
      // friend's instruction was "stop this" or "delete this"; the local write
      // is the part we can guarantee, so it is the part that happens first.
      if (remove) {
        // One transaction: a bank half-deleted is a state no later press can
        // repair, because the row naming what to delete is itself deleted.
        userDb.transaction(() => {
          for (const table of [
            'plaid_transactions',
            'plaid_holdings',
            'plaid_recurring_streams',
            'plaid_investment_transactions',
            'plaid_accounts',
            'plaid_refreshes',
          ]) {
            userDb.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(itemId)
          }
          userDb.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(itemId)
        })()
        // plaid_securities is deliberately NOT touched. A security belongs to
        // no bank — two brokerages holding the same fund report the same
        // security_id — so deleting one could leave the friend's OTHER bank's
        // holdings unjoinable. An unreferenced security is invisible.
      } else {
        userDb
          .prepare(
            "UPDATE plaid_items SET disconnected_at = ?, access_token = '' WHERE item_id = ?",
          )
          .run(now, itemId)
      }
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
