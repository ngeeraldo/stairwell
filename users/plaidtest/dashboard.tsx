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
import { PlaidSources } from '@/lib/ui/PlaidSources'
import { readPlaidSources } from '@/modules/plaid/sources'
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

export default function PlaidTestDashboard({ slug, db, now, timeZone }: DashboardProps) {
  const connected = isConnected(db)
  // The shared surface, identical on every finance dashboard (2026-08-21 plan
  // D4, swept by tests/users/plaidSurface.test.ts). Every control a friend has
  // over their banks lives in it — connect another, choose accounts, sign in
  // again, stop, delete, refresh — so this dashboard writes none of them.
  const sources = readPlaidSources(db)

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
        <PlaidSources slug={slug} sources={sources} now={now} timeZone={timeZone} />
      </section>
    )
  }

  const accounts = accountBalances(db)
  const transactions = recentTransactions(db)
  const refreshes = lastRefreshes(db)
  const products = availableProducts(db)

  return (
    <section className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Your banks</h2>
        {/*
          THE SHARED SURFACE, and this dashboard writes none of it.

          Everything that used to be hand-wired here — a refresh control, a
          reconnect control, a disconnect form — now lives in lib/ui, is
          identical for every friend with a bank, and is swept for by
          tests/users/plaidSurface.test.ts. That is not tidying: the version
          this replaced offered a friend a way to connect ONE bank and no way
          to add a second, see which one had gone stale, change which accounts
          it shared, or remove it.

          It also carries a last-updated time beside the refresh control
          (docs/dashboard-ui-ux-guidelines.md > States), which the hand-wired
          version did not — a refresh button with no time next to it invites a
          friend to assume the numbers are current.
        */}
        <PlaidSources slug={slug} sources={sources} now={now} timeZone={timeZone} />
      </section>

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
              // The BANK is named. Without it a friend with three connections
              // read "transactions: ok / transactions: ok / transactions: ok"
              // — three true statements that together said nothing they could
              // act on, while one of those banks was failing.
              <li key={`${refresh.bank ?? ''}-${refresh.product}`}>
                {refresh.bank ? `${refresh.bank} — ` : ''}
                {refresh.product}: {describeRefresh(refresh)}
              </li>
            ))}
          </ul>
        )}
      </section>

    </section>
  )
}
