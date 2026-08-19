// users/run9/dashboard.tsx
//
// run9's dashboard — spec v1, users/run9/spec.md. One screen, four things,
// in the order the spec asks for them top to bottom: today's count with the
// log button, the correction control, the 7-day trend, the weekly average.
//
// NO SQL HERE. Every statement lives in ./queries.ts.
//
// `today` and `timeZone` are HANDED to this component and it never derives
// either — the write route files a tap under the friend's day, and a
// dashboard computing its own would let the two disagree about the calendar.
//
// COMPOSITION, and why it is not the host-elements-only shape devone and
// devtwo use. Nico's ruling of 2026-08-19 splits imported components in two:
// purely presentational ones (shadcn's Card, Button) are trusted, while
// data-computing ones (Recharts) are a sanctioned exception guarded by the
// states rule — degenerate data renders the panel's empty state as host
// elements and NEVER mounts the component. `chartable` below is that guard,
// and it is why the empty-database first render shows an empty state rather
// than a chart. The accepted residual is a throw on well-formed props landing
// outside app/[user]/page.tsx's try/catch. See ./TrendChart.tsx's header.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendChart } from './TrendChart'
import { TREND_DAYS, countOn, dailyTrend, firstLoggedDay, weeklyAverage } from './queries'

// ONE screen, so the platform draws no tab strip — a single tab is chrome that
// explains nothing. The title is what the spec calls it; the id and order are
// the builder's (a change-only spec carries no ids) and are written down in
// users/run9/current.md's `## Screens`.
export const screens: DashboardScreen[] = [
  { id: 'pee_tracker', title: 'Pee Tracker', order: 1 },
]

export default function Run9Dashboard({ slug, db, today }: DashboardProps) {
  // THE ONE READ THIS DASHBOARD CANNOT DEGRADE WITHOUT. If today's count
  // cannot be read, the glance is gone and there is nothing honest to render
  // in its place — so this is deliberately OUTSIDE the catch below and goes to
  // app/[user]/page.tsx's own, which is what "This dashboard failed to load"
  // is for.
  const count = countOn(db, today)

  // EVERYTHING DERIVED IS READ BEHIND ITS OWN CATCH, and the boundary is
  // chosen rather than sprinkled. Every panel here reads one table through one
  // handle, so per-panel isolation is mostly theatre — except across this
  // line. The log button IS the product; a failure computing a chart must not
  // take away run9's ability to log, which is exactly what letting these
  // throw would do (the whole dashboard becomes "This dashboard failed to
  // load", the log button with it).
  //
  // `firstLoggedDay` sits INSIDE, and it did not at first: outside, a broken
  // trend read took the whole dashboard down through this line while the
  // catch below sat there looking like it was handling it. Found by writing
  // the test named for the behaviour and watching it assert the opposite.
  let trend: ReturnType<typeof dailyTrend> | null = null
  let average: ReturnType<typeof weeklyAverage> = null
  // Seeded from the read that already succeeded rather than defaulting to
  // false: a count above zero PROVES they have logged, so the caption stays
  // honest even if the history read fails underneath it.
  let everLogged = count > 0
  let trendFailed = false
  try {
    everLogged = everLogged || firstLoggedDay(db) !== null
    trend = dailyTrend(db, today)
    average = weeklyAverage(db, today)
  } catch {
    trendFailed = true
  }

  // THE GUARD Nico's ruling requires, stated as one boolean so it is impossible
  // to render the chart without having asked. Degenerate for a zero-based bar
  // chart means:
  //   - fewer than two points (nothing to compare, and a one-bar "trend" is
  //     not one)
  //   - any non-finite count (a scale cannot be derived from NaN)
  //   - every count zero, which is the ONLY case where "all-identical" is
  //     actually degenerate here: the y-domain is [0, max], so a week of
  //     identical non-zero days yields [0, 6] and charts perfectly well.
  //     Blanking that panel would hide a real and quite likely week —
  //     a deliberate reading of the ruling's "all-identical", flagged rather
  //     than silently narrowed.
  const chartable =
    trend !== null &&
    trend.length >= 2 &&
    trend.every((d) => Number.isFinite(d.count)) &&
    trend.some((d) => d.count > 0)

  return (
    // Fluid to 1200px and centred, one column at every width: the spec asks
    // for a screen that "works identically on phone and computer", which
    // outranks the default of giving desktop more columns.
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Today
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            THE GLANCE. One large number, readable without scrolling at 375px.
            A zero here is DATA, not absence — "you have not been yet today" is
            a true and useful thing to say — so it renders as a confident 0
            rather than an empty state, and only the caption changes. The
            empty-state rule is about a zero that stands in for "we do not
            know", which this never is: the row either exists or it does not.
          */}
          <p className="text-7xl leading-none font-semibold tabular-nums">{count}</p>
          <p className="text-sm text-muted-foreground">
            {!everLogged && !trendFailed
              ? 'Tap below to log your first one.'
              : count === 0
                ? 'Nothing logged yet today.'
                : count === 1
                  ? 'time today'
                  : 'times today'}
          </p>

          {/*
            A form POST, not a client-side fetch: it keeps this a server
            component, works with JavaScript off, and matches every other
            control in the app (the logout button, devtwo's tap). The press
            feedback is shadcn's own `active:translate-y-px` — interaction
            motion, which responds to the user rather than impersonating live
            data.
          */}
          <form method="post" action={`/api/users/${slug}/pee`}>
            <input type="hidden" name="action" value="add" />
            <Button
              type="submit"
              size="lg"
              // Deliberately taller than any stock size: the spec asks for a
              // button "comfortable to hit on a phone one-handed", and shadcn's
              // tallest default is 36px, under the 44px touch-target floor.
              className="h-16 w-full text-base"
            >
              Log one
            </Button>
          </form>

          {/*
            THE CORRECTION CONTROL, rendered inside this card rather than as a
            card of its own: the spec places it "just below the log button" and
            it is about the number directly above it. Keeping it here is what
            lets the whole glance — count, log, fix — sit above the fold at
            375px.

            Two separate forms rather than one with two submit buttons, so each
            carries its own intent and neither depends on which button the
            browser decided to serialise.
          */}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">Miscounted?</span>
            <form method="post" action={`/api/users/${slug}/pee`}>
              <input type="hidden" name="action" value="remove" />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                // DISABLED AT ZERO, which is the spec's "should not be able to
                // take the count below zero" said in the UI. The route enforces
                // it too — this is the affordance, not the rule.
                disabled={count === 0}
                aria-label="Remove one from today"
              >
                −1
              </Button>
            </form>
            <form method="post" action={`/api/users/${slug}/pee`}>
              <input type="hidden" name="action" value="add" />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                aria-label="Add one to today"
              >
                +1
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Last {TREND_DAYS} days
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trendFailed ? (
            // Honest degradation, never stale or partial data dressed as
            // current. The log button above still works.
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load the trend just now. Logging still works.
            </p>
          ) : chartable ? (
            <TrendChart data={trend!} average={average?.average} />
          ) : (
            /*
              A DAY BEFORE run9 STARTED IS NOT A DAY THEY LOGGED NOTHING.
              queries.ts clips the window at the first logged day, so this
              branch is what a first day looks like — never seven zero bars
              reporting a week of failure that predates the dashboard.
            */
            <p className="text-sm text-muted-foreground">
              {!everLogged
                ? 'Nothing to chart yet. Your first tap starts this.'
                : trend!.length < 2
                  ? 'One day so far — the trend fills in from tomorrow.'
                  : /*
                      The third case, and it is NOT "one day so far": the
                      window is full but every day in it is zero, which happens
                      when the last log predates the window entirely. Saying
                      "one day so far" there would be plainly false to someone
                      who has used this for a month and then stopped.
                    */
                    `Nothing logged in the last ${TREND_DAYS} days.`}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Weekly average
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trendFailed ? (
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load the average just now.
            </p>
          ) : average === null ? (
            <p className="text-sm text-muted-foreground">
              Not enough days yet — this needs one full day to average.
            </p>
          ) : (
            <>
              <p className="text-3xl font-semibold tabular-nums">{average.average}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {/*
                  The denominator is said out loud. During the first week this
                  averages fewer than seven days, and a panel labelled "weekly"
                  that quietly averaged two would be lying about its own basis.
                */}
                a day, over the last {average.days === 1 ? 'day' : `${average.days} days`}
                {average.days < TREND_DAYS ? ' so far' : ''} — today not counted
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
