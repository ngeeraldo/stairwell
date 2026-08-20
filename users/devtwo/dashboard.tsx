// users/devtwo/dashboard.tsx
//
// Built toward users/devtwo/mockup.html: today's yes/no with a tap control,
// the streak, the 30-day percentage, and a 14-day row.
//
// ONE component with plain helpers, plus the platform's write control. The
// page calls this function directly inside a try/catch. docs/dashboard-build-rules.md
// states the component rule in three arms; WriteAction is arm 3, an
// interaction control, sanctioned and the default for every write.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { WriteAction } from '@/lib/ui/WriteAction'
import { currentStreak, last14, last30, walkedOn } from './queries'

// devtwo predates the spec loop entirely — hand-written, with no spec.md to
// pull an id/title from. One screen: today's walk status, the streak, the
// 30-day rate, and the 14-day history — the whole daily walk check.
export const screens: DashboardScreen[] = [{ id: 'morning', title: 'Daily walk', order: 1 }]

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
          // The default write control (lib/ui/WriteAction.tsx): still a POST to
          // the platform route, but it patches this page in place rather than
          // navigating. A real form underneath, so it still works with JS off.
          <WriteAction action={`/api/users/${slug}/walk`} payload={{}} pendingLabel="Marking…">
            Tap to mark walked
          </WriteAction>
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
        {/*
          NOTHING LOGGED EVER IS NOT FOURTEEN MISSED DAYS.

          Before the fallback was removed, a friend never saw this panel over
          their own empty database — they saw devone's sample data under a
          banner. Now the first screen of their own dashboard is this one, and
          rendering the list unconditionally told a friend on their FIRST
          MORNING that they had missed each of the previous fourteen days:
          days that passed before their dashboard existed, about which the
          product has nothing to say and no standing to judge.

          Found by reading the screenshot. Every test was green — a list of
          fourteen "missed" rows is not a throw — which is the whole reason
          screens are reviewed as pictures (onboarding ledger D16).

          The general rule this is an instance of, for any dashboard measuring
          adherence: a day before the friend started is not a day they failed.
        */}
        {month.walked === 0 && !done ? (
          <p>Nothing logged yet.</p>
        ) : (
          <ul>
            {fortnight.map((d) => (
              <li key={d.day} data-day={d.day} data-walked={d.walked ? 'yes' : 'no'}>
                {d.day} {d.walked ? 'walked' : 'missed'}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
