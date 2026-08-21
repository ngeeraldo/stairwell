// users/plaidtest/dashboard.tsx
//
// The scratch dashboard the shared Plaid connection is proved against.
//
// A server component handed its own slug and an open READ-ONLY handle on its
// own database. It never resolves either itself, holds no writable handle, and
// contains no SQL — every value comes from ./queries.
//
// IT IS NOT A FRIEND'S DASHBOARD and is not trying to be. It exists so a
// person can sit in front of a browser and watch a real bank connect, refresh
// and disconnect. Its panels are deliberately plain: what is being reviewed
// here is the CONNECTION, not a design.
//
// ── THE ONE THING WORTH COPYING FROM IT ─────────────────────────────────────
//
// The not-connected / connected split, and where the boundary sits. A finance
// dashboard has two entirely different screens, and which one renders is
// decided by whether a token exists (isConnected) — never by whether any
// transactions exist. A freshly connected bank has a token and NO rows for the
// first few seconds while Plaid backfills, and a dashboard that inferred
// "not connected" from an empty table would tell a friend their connection
// failed while it was still working.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { PlaidConnect } from '@/lib/ui/PlaidConnect'
import { WriteAction } from '@/lib/ui/WriteAction'
import {
  accountBalances,
  availableProducts,
  isConnected,
  lastRefreshes,
  recentTransactions,
  type Refresh,
} from './queries'

export const screens: DashboardScreen[] = [{ id: 'money', title: 'Money', order: 1 }]

/**
 * What one product's last refresh attempt should say.
 *
 * THREE OUTCOMES, NOT TWO. `not_ready` means Plaid holds the connection and
 * has not finished preparing that product — routine for recurring streams,
 * which cannot be requested when an item is created and become available about
 * ten seconds later. Reporting it as a failure would put "couldn't reach your
 * bank" on screen at the exact moment everything is working; reporting it as
 * success would claim data that is not there.
 *
 * A failure names the CODE rather than a provider's prose, and says so plainly
 * — that sentence is what stops the numbers above it from reading as current.
 */
function describeRefresh(refresh: Refresh): string {
  if (refresh.ok) return 'ok'
  if (refresh.code === 'not_ready') return 'still being prepared by your bank — try again shortly'
  if (refresh.code === 'item_login_required') return 'your bank needs you to log in again'
  return `couldn’t reach your bank (${refresh.code ?? 'error'})`
}

function money(amount: number | null): string {
  if (amount === null) return '—'
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function PlaidTestDashboard({ slug, db }: DashboardProps) {
  const connected = isConnected(db)

  // Both URLs are host-relative and built from the slug the page handed us —
  // PlaidConnect asserts that before it renders, the same bound WriteAction
  // puts on its own action.
  const linkTokenAction = `/api/users/${slug}/plaid/link-token`
  const connectAction = `/api/users/${slug}/plaid/connect`
  // Where an OAuth bank's return page sends the friend once the connection
  // finishes. It has to be carried rather than re-derived: /plaid/oauth is a
  // cold page load that knows nothing about whose connection this was.
  const returnTo = `/${slug}`

  if (!connected) {
    return (
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-medium">No bank connected</h2>
          <p className="text-sm text-muted-foreground">
            Connecting runs on your own device — your bank login never reaches this
            server.
          </p>
        </div>
        <PlaidConnect
          linkTokenAction={linkTokenAction}
          connectAction={connectAction}
          returnTo={returnTo}
        />
      </section>
    )
  }

  const accounts = accountBalances(db)
  const transactions = recentTransactions(db)
  const refreshes = lastRefreshes(db)
  const products = availableProducts(db)

  return (
    <section className="flex flex-col gap-6">
      <section>
        <h2 className="text-lg font-medium">Accounts</h2>
        {accounts.length === 0 ? (
          // NOT "$0.00". A connection with no accounts yet is Plaid still
          // working, and a confident zero would be a false statement about
          // someone's money.
          <p className="text-sm text-muted-foreground">
            Nothing has arrived yet — press Refresh in a moment.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {accounts.map((account) => (
              <li key={account.accountId} className="flex justify-between gap-4 text-sm">
                <span>
                  {account.name}
                  {account.mask ? ` ••${account.mask}` : ''}
                </span>
                <span className="tabular-nums">{money(account.current)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium">Recent transactions</h2>
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {transactions.map((transaction) => (
              <li key={transaction.transactionId} className="flex justify-between gap-4 text-sm">
                <span>
                  {transaction.date} · {transaction.merchant ?? transaction.category ?? 'Unknown'}
                  {/* A pending charge can still change amount or vanish. Saying
                      so is the difference between a number and a claim. */}
                  {transaction.pending ? ' · pending' : ''}
                </span>
                <span className="tabular-nums">{money(transaction.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Connection</h2>
        <p className="text-sm text-muted-foreground">
          {products.length > 0
            ? `This bank can serve: ${products.join(', ')}.`
            : 'This bank reported no additional products.'}
        </p>
        {refreshes.length === 0 ? (
          // NOT "up to date". Nothing has ever been pulled, and saying
          // otherwise about someone's money is the kind of confident wrong
          // this panel exists to avoid.
          <p className="text-sm text-muted-foreground">Never refreshed.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {refreshes.map((refresh) => (
              <li key={refresh.product}>
                {refresh.product}: {describeRefresh(refresh)}
              </li>
            ))}
          </ul>
        )}
        {/*
          The friend's own control, and the ONLY trigger in V1. Their data key
          exists only while they are unlocked, so nothing can pull on their
          behalf while they are away — there is no scheduled job and cannot be
          one. Pressing this is what "fresh" means.
        */}
        <WriteAction
          action={`/api/users/${slug}/plaid/refresh`}
          payload={{}}
          pendingLabel="Checking with your bank…"
          // "nothing was recorded" is FALSE here: a failed refresh writes a
          // plaid_refreshes row per product, and those rows are listed
          // directly above this message. The default sentence contradicted
          // them on screen.
          failedLabel="Couldn’t reach your bank. What happened is recorded above."
        >
          Refresh
        </WriteAction>
      </section>

      <section className="flex flex-col gap-2">
        {/*
          ALWAYS AVAILABLE, NEVER A PROMPT — and the wording has to say so.
          Nothing in the app knows whether this connection still works: the
          item's health is only discovered when something CALLS Plaid and gets
          ITEM_LOGIN_REQUIRED back, which is the refresh route (Phase 4).
          Until then a permanently-visible "Reconnect your bank" reads as
          "your bank is broken", which is a claim this dashboard has no
          grounds to make. Verified against a real Sandbox item: after
          reset_login and a repair, the screen was identical in both states.
        */}
        <p className="text-sm text-muted-foreground">
          Whether this connection still works is only known after a refresh.
        </p>
        <PlaidConnect
          linkTokenAction={linkTokenAction}
          connectAction={connectAction}
          returnTo={returnTo}
          reconnect
        >
          Log in to your bank again
        </PlaidConnect>
        {/*
          WriteAction, NOT a bare <form>, and the difference is not cosmetic.

          This was a native form on the reasoning that disconnect is
          destructive and must work without JavaScript. That reasoning was
          right and the conclusion was wrong: WriteAction ALSO renders a real
          form, so the no-JS path is identical — and when JavaScript is
          available it intercepts, so a failure becomes an inline message
          instead of navigating the browser to a raw error page.

          Measured, not theorised: a 403 from this control replaced the entire
          app with Chrome's "Access to localhost was denied", losing the
          dashboard, the chat surface and any way back. A friend hitting that
          has nothing to do except close the tab.
        */}
        <WriteAction
          action={`/api/users/${slug}/plaid/disconnect`}
          payload={{}}
          variant="ghost"
          size="sm"
          pendingLabel="Disconnecting…"
        >
          Disconnect this bank
        </WriteAction>
      </section>
    </section>
  )
}
