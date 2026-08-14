// users/devtwo/dashboard.tsx
//
// Built toward users/devtwo/mockup.html: today's yes/no with a tap control,
// the streak, the 30-day percentage, and a 14-day row.
//
// ONE component with plain helpers, deliberately. The page calls this function
// directly inside a try/catch; a nested React function component's body would
// run later, during Next's render pass, outside that catch — turning a broken
// panel into a 500 for the whole page instead of a degraded region.
import type { DashboardProps } from '@/lib/dashboard/contract'
import { currentStreak, last14, last30, walkedOn } from './queries'

export default function DevTwoDashboard({ slug, db, today }: DashboardProps) {
  // Handed down, never derived: the walk route files a tap under a day, and
  // a dashboard computing its own would let the two disagree about the
  // calendar. See lib/dashboard/contract.ts.
  const done = walkedOn(db, today)
  const streak = currentStreak(db, today)
  const month = last30(db, today)
  const fortnight = last14(db, today)

  return (
    <section>
      <section>
        <h2>Walked today?</h2>
        <p>{done ? 'WALKED' : 'NOT YET'}</p>
        <p>{today}</p>
        {done ? (
          <p>Marked for today.</p>
        ) : (
          // A form POST rather than client-side fetch: this keeps the
          // dashboard a server component, and matches the logout control.
          <form method="post" action={`/api/users/${slug}/walk`}>
            <button type="submit">Tap to mark walked</button>
          </form>
        )}
      </section>

      <section>
        <h2>Current streak</h2>
        <p>{streak}</p>
        <p>{streak === 1 ? 'day in a row' : 'days in a row'}</p>
      </section>

      <section>
        <h2>Last 30 days</h2>
        <p>{month.percent}%</p>
        <p>
          {month.walked} of {month.total} days
        </p>
      </section>

      <section>
        <h2>Last 14 days at a glance</h2>
        <ul>
          {fortnight.map((d) => (
            <li key={d.day} data-day={d.day} data-walked={d.walked ? 'yes' : 'no'}>
              {d.day} {d.walked ? 'walked' : 'missed'}
            </li>
          ))}
        </ul>
      </section>
    </section>
  )
}
