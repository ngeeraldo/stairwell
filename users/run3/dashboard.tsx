// users/run3/dashboard.tsx
//
// run3's dashboard. Handed its own slug and an open read-only handle on
// its own database; it never resolves either itself.
//
// Register it in lib/dashboard/registry.ts or it will not render:
//   run3: () => import('@/users/run3/dashboard'),
//
// Compose only host elements (<div>, <section>, <ul>, ...) here — never a
// nested function component (returning <Foo />, where Foo is itself a
// function component). app/[user]/page.tsx wraps the direct call to this
// component's body in a try/catch, but a nested component's body is deferred
// to Next's own render pass, which runs after that function returns and
// therefore OUTSIDE the catch. A throw there 500s the page after the
// `dashboard_open` metric row has already been written, leaving an
// append-only row saying "opened" for a request that failed.
//
// `today` and `timeZone` are HANDED to this component and it never derives
// either. Do not reach for Date.now() or new Date() to find out what day it
// is: the answer would be the droplet's day, the droplet is UTC, and the
// friend is not. tests/users/noLocalDay.test.ts enforces this over every user
// folder — including this template, so a scaffolded dashboard starts correct.
import type { DashboardProps } from '@/lib/dashboard/contract'
import { recentTransactions } from './queries'

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export default function Dashboard({ db, today, timeZone }: DashboardProps) {
  const recent = recentTransactions(db, timeZone)

  return (
    <section>
      <h2>Recent transactions</h2>
      <p>Today is {today}.</p>
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
  )
}
