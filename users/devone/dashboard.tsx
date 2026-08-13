// users/devone/dashboard.tsx
//
// devone's dashboard. A server component handed its own slug and an open
// read-only handle on its own database — it never resolves either itself.
import type { DashboardProps } from '@/lib/dashboard/contract'
import { eatingOutThisMonthCents, recentTransactions } from './queries'

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export default function DevOneDashboard({ db }: DashboardProps) {
  const now = Date.now()
  const eatingOut = eatingOutThisMonthCents(db, now)
  const recent = recentTransactions(db)

  return (
    <section>
      <section>
        <h2>Eating out this month</h2>
        <p>{money(eatingOut)}</p>
      </section>
      <section>
        <h2>Recent transactions</h2>
        {recent.length === 0 ? (
          <p>No transactions yet.</p>
        ) : (
          <ul>
            {recent.map((t) => (
              <li key={`${t.at}-${t.merchant}`}>
                {day(t.at)} — {t.merchant} — {money(t.amount_cents)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
