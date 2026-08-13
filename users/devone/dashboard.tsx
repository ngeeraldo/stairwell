// users/devone/dashboard.tsx
//
// devone's dashboard. A server component handed its own slug and an open
// read-only handle on its own database — it never resolves either itself.
import type { DashboardProps } from '@/lib/dashboard/contract'
import { eatingOutThisMonthCents, recentTransactions } from './queries'

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// Local calendar components, not toISOString() (which is UTC). monthRange
// (queries.ts) buckets transactions by the LOCAL calendar, so a UTC render
// here would disagree with it: west of Greenwich, a transaction late enough
// in the local day rolls over to the NEXT UTC date, so it could render next
// to a total for a month it wasn't counted in.
function day(at: number): string {
  const d = new Date(at)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const date = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
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
