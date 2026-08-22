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
  getAccounts,
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
 * ── IT APPENDS, AND IT USED TO REPLACE ──────────────────────────────────────
 *
 * This route ran `DELETE FROM plaid_items` before inserting, so a friend's
 * second connection silently replaced their first. That was not merely a
 * missing feature: disconnecting deliberately KEEPS synced rows, so the
 * replaced bank's transactions survived with no item that could ever refresh
 * them — permanently frozen, and indistinguishable on screen from live data.
 * The absence of a "connect another bank" button was the only thing stopping
 * anyone from reaching it.
 *
 * So it upserts on `item_id` instead. Plaid issues a new item id for a new
 * connection and returns the EXISTING one from update mode, which makes the id
 * itself the right thing to key on: a repair updates the row it belongs to, a
 * new bank adds one, and neither can produce a duplicate the friend cannot
 * tell apart.
 *
 * Reconnecting also clears `disconnected_at`. Without that, a friend who
 * disconnected a bank and later reconnected it would keep every panel saying
 * "no longer updating" about a live connection — and the refresh loop skips
 * disconnected items, so it would never update again either.
 *
 * ── THE ACCOUNT PICKER ONLY EVER ADDS. IT DELETES NOTHING ───────────────────
 *
 * `manage_accounts=1` means the friend just came back from Plaid's ACCOUNT
 * PICKER, where they chose which accounts this bank shares.
 *
 * This route used to delete the rows of anything they left unticked, on the
 * reasoning that "remove this account" should mean what a friend thinks it
 * means. That reasoning rested on a belief about Plaid's UI which turned out
 * to be false, and finding out cost nothing only because it was found in
 * testing:
 *
 *   THE PICKER OPENS WITH NOTHING TICKED. It does not show the friend their
 *   current selection — it looks like a fresh start.
 *
 * So a friend opening it to ADD one account, ticking that one and submitting
 * had, from here, deselected everything else. The old code then deleted all of
 * it: years of history, permanently, unrecoverable by anyone including Nico
 * because nobody can read the database — from a button labelled "Choose
 * accounts". Whether the picker pre-ticks anything is a Plaid DASHBOARD
 * setting (`link_customization_name`, Account Select view behaviour), which is
 * to say it lives outside this repository, no test can see it, and it can be
 * changed back by anyone with access. A data-safety property may not rest on
 * that.
 *
 * So nothing here deletes, ever (Nico's ruling, 2026-08-22). An account the
 * bank stops sharing simply stops being shared: the next refresh drops its row
 * from plaid_accounts — a deselected account and a CLOSED one are
 * indistinguishable from /accounts/get, and a closed one has to leave the
 * screen — while every transaction under it stays.
 *
 * ── WHAT RE-ADDING AN ACCOUNT ACTUALLY DOES ─────────────────────────────────
 *
 * MEASURED, because the obvious guess is wrong. Re-ticking an account does NOT
 * restore the rows that were there: Plaid issues the re-added account a NEW
 * account_id and its transactions come back with NEW transaction_ids, so
 * nothing upserts and the friend's history is stored twice — once under the
 * stale account_id, once under the live one. Observed in Sandbox: 24
 * transactions became 42.
 *
 * The stranded copy is harmless and is left alone, deliberately. A panel reads
 * transactions THROUGH plaid_accounts (tests/users/plaidTransactionJoin.test.ts
 * sweeps for it), so rows under an unlisted account are invisible, and they are
 * still stamped with the bank, so "Delete data" removes them.
 *
 * They are NOT pruned automatically, and the reason is the whole point of this
 * header: "transactions whose account the bank no longer lists" cannot tell an
 * account that was re-added — where the old rows are a dead duplicate — from
 * an account that was removed and left off, where the old rows are the friend's
 * ONLY copy of that history and keeping them is the entire ruling. Same
 * predicate, opposite meaning. Deleting on it would undo this.
 *
 * What makes that coherent rather than half-done is on the READ side: a panel
 * reads transactions THROUGH plaid_accounts (docs/dashboard-build-rules.md
 * §9.6), so an unticked account stops appearing without anything being
 * destroyed. Deleting a friend's financial history happens in exactly one
 * place, behind a button that says so: disconnect's `action=remove`.
 *
 * The accounts call is still made, for one reason only — the cursor, below.
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
  let manageAccounts = false
  try {
    const form = await request.formData()
    publicToken = String(form.get('public_token') ?? '')
    // The friend just came back from Plaid's account picker. See the header:
    // this is the ONLY flag that lets anything below delete a row.
    manageAccounts = form.get('manage_accounts') === '1'
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
  let detail: { institutionId?: string; institutionName?: string; availableProducts: string[] }
  /**
   * The accounts this bank shares NOW, read only on the account-picker path.
   *
   * `undefined` means "not asked", which is what stops the reconciliation
   * below from running at all. It is deliberately distinct from `[]`, which
   * means the bank was asked and named none — see guard 2 in the header.
   */
  let sharedAccounts: string[] | undefined
  try {
    const api = plaidApiFromEnv()
    item = await exchangePublicToken(api, publicToken)
    const described = await getItem(api, item.accessToken)
    detail = {
      institutionId: described.institutionId,
      institutionName: described.institutionName,
      availableProducts: described.availableProducts,
    }
    if (manageAccounts) {
      try {
        const accounts = await getAccounts(api, item.accessToken)
        sharedAccounts = accounts
          .map((a) => (a as { account_id?: unknown }).account_id)
          .filter((id): id is string => typeof id === 'string')
      } catch (error) {
        // SWALLOWED ON PURPOSE, unlike every other Plaid failure here. The
        // connection is what the friend pressed for and it has already
        // succeeded; refusing the whole press because a follow-up call timed
        // out would leave them with a bank Plaid has and this app does not.
        // Leaving `sharedAccounts` undefined means nothing is deleted, which
        // is the safe direction — the friend can reopen the picker.
        logDbFailure('plaid_connect_accounts_failed', user, error)
      }
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
      // ONE TRANSACTION for the upsert and the reconciliation together. Half
      // of this — an account deselected at Plaid whose rows are still here, or
      // rows deleted for a connection that did not land — is a state no later
      // press can repair.
      userDb.transaction(() => {
        userDb
          .prepare(
            `INSERT INTO plaid_items
               (item_id, access_token, institution_id, institution_name, cursor,
                available_products, payload, connected_at)
             VALUES (?, ?, ?, ?, NULL, ?, '{}', ?)
             ON CONFLICT(item_id) DO UPDATE SET
               access_token       = excluded.access_token,
               institution_id     = excluded.institution_id,
               institution_name   = excluded.institution_name,
               available_products = excluded.available_products,
               -- Back to life. A row that kept its disconnected_at would make
               -- every panel say "no longer updating" about a live connection,
               -- and the refresh loop skips disconnected items, so it never
               -- would update again.
               disconnected_at    = NULL`,
          )
          .run(
            item.itemId,
            item.accessToken,
            detail.institutionId ?? null,
            // What the friend calls this bank, from the /item/get above. NULL
            // rather than '' when Plaid has no name for it: a panel can fall
            // back from NULL, where a blank renders as a bank with no name.
            detail.institutionName ?? null,
            JSON.stringify(detail.availableProducts),
            now,
          )

        if (sharedAccounts !== undefined && sharedAccounts.length > 0) {
          // ── THE CURSOR, AND WHY ADDING AN ACCOUNT RESETS IT ──────────────
          //
          // MEASURED AGAINST SANDBOX. This code originally left the cursor
          // alone on every update, on the reasoning that it only moves forward
          // and re-sending would be a slow no-op. That was wrong, and the way
          // it was wrong is invisible:
          //
          //   A friend added two accounts at a bank they already had.
          //   /transactions/sync then reported SUCCESS on every refresh
          //   afterwards and returned nothing, because the stored cursor had
          //   already passed everything Plaid was willing to re-send. The two
          //   accounts sat empty forever, with a green connection above them
          //   and no amount of pressing Refresh able to fix it.
          //
          // So an account the friend has just ADDED clears the cursor, and the
          // next sync re-pulls the window. Everything upserts by
          // transaction_id, so nothing is duplicated, and this names one item.
          //
          // Only on an ADD. Removing an account can bring nothing new, and a
          // repair changes no account at all — re-pulling a whole history in
          // either case is a slow surprise on a press the friend is waiting on.
          const known = new Set(
            (
              userDb
                .prepare('SELECT account_id FROM plaid_accounts WHERE item_id = ?')
                .all(item.itemId) as { account_id: string }[]
            ).map((row) => row.account_id),
          )
          if (sharedAccounts.some((accountId) => !known.has(accountId))) {
            userDb.prepare('UPDATE plaid_items SET cursor = NULL WHERE item_id = ?').run(item.itemId)
          }
        }
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
