// users/devone/dashboard.tsx
//
// devone's dashboard. A server component handed its own slug and an open
// read-only handle on its own database — it never resolves either itself.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { eatingOutThisMonthCents, recentTransactions } from './queries'

// devone predates the spec loop entirely — hand-written, with no spec.md to
// pull an id/title from (CLAUDE.md: "users/devone/ is the worked reference
// implementation... hand-written, not agent output"). One screen, covering
// both panels below: this month's eating-out total and the recent
// transaction list, i.e. what got spent and on what.
export const screens: DashboardScreen[] = [{ id: 'morning', title: 'Spending', order: 1 }]

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export default function DevOneDashboard({ db, today, timeZone }: DashboardProps) {
  // The friend's calendar, not the host's and not UTC.
  //
  // This file used to format dates from local calendar components with a
  // comment explaining that toISOString() would be UTC and would disagree with
  // the month total. That was right about the disagreement and wrong about the
  // fix: "local" meant the droplet, the droplet is UTC, and the two agreed with
  // each other while both disagreed with the person reading the screen. The
  // total and the row labels now come from the same zone, which is the friend's
  // — see lib/time/dayKey.ts.
  const eatingOut = eatingOutThisMonthCents(db, today, timeZone)
  const recent = recentTransactions(db, timeZone)

  return (
    <section>
      <section>
        <h2>Eating out this month</h2>
        {/*
          "Nothing logged yet" is NOT the same statement as "$0.00", and on a
          friend's first morning only one of them is true. There is no
          synthetic fallback any more, so the first thing anyone sees of their
          own dashboard is this panel over an empty database — and a confident
          zero there reads as "you spent nothing this month", which is a claim
          about their life rather than about their data.

          Caught by looking at the picture, not by a test: the empty-render
          test passed the whole time, because rendering $0.00 is not a throw.
          Distinguishing the two is the pattern a dashboard copied from this
          reference should carry.
        */}
        {recent.length === 0 ? (
          <p>Nothing logged yet.</p>
        ) : (
          <p>{money(eatingOut)}</p>
        )}
      </section>
      <section>
        <h2>Recent transactions</h2>
        {recent.length === 0 ? (
          <p>No transactions yet.</p>
        ) : (
          <ul>
            {recent.map((t) => (
              <li key={`${t.at}-${t.merchant}`}>
                {t.day} — {t.merchant} — {money(t.amount_cents)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
