// users/run10/dashboard.tsx
//
// run10's dashboard — spec v1, users/run10/spec.md. One screen, two panels, in
// the order the spec puts them: the tap button with today's running count at
// the top, the last seven days with their daily average below it.
//
// NO SQL HERE. Every statement lives in ./queries.ts.
//
// `today` is HANDED to this component and it never derives it — the write
// route files a tap under the friend's day, and a dashboard computing its own
// would let the two disagree about the calendar. `timeZone` is not read at
// all: every row is already filed under a day key, so nothing on this screen
// has to turn an instant into a date.
//
// COMPOSITION. docs/dashboard-build-rules.md states the component rule in
// three arms: presentational components (shadcn's Card) are trusted;
// data-computing ones (Recharts, via ./TrendChart.tsx) are sanctioned and
// guarded by a states check; interaction controls (lib/ui/WriteAction.tsx) are
// sanctioned and are the default for every write. `chartable` below is the
// states guard, and it is why the empty-database first render shows an empty
// state rather than a chart. The accepted residual for all three is a throw on
// well-formed props landing outside app/[user]/page.tsx's try/catch.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { WriteAction } from '@/lib/ui/WriteAction'
import { TrendChart } from './TrendChart'
import { TREND_DAYS, countOn, dailyAverage, dailyTrend, firstLoggedDay } from './queries'

// ONE screen, so the platform draws no tab strip — a single tab is chrome that
// explains nothing. The title is what the spec calls it ("Add screen — Pee
// Tracker"); the id and order are the builder's, since a change-only spec
// carries no ids, and they are written down in users/run10/current.md's
// `## Screens`.
export const screens: DashboardScreen[] = [
  { id: 'pee_tracker', title: 'Pee Tracker', order: 1 },
]

export default function Run10Dashboard({ slug, db, today }: DashboardProps) {
  // THE ONE READ THIS DASHBOARD CANNOT DEGRADE WITHOUT. If today's count
  // cannot be read, the panel the spec calls "the panel used in the moment" is
  // gone and there is nothing honest to render in its place — so this is
  // deliberately OUTSIDE the catch below and goes to app/[user]/page.tsx's
  // own, which is what "This dashboard failed to load" is for.
  const count = countOn(db, today)

  // THE DERIVED PANEL IS READ BEHIND ITS OWN CATCH, and the boundary is chosen
  // rather than sprinkled. Both panels read one table through one handle, so
  // per-panel isolation is mostly theatre — except across this line. The tap
  // button IS the product; a failure computing the week must not take away
  // run10's ability to log, which is exactly what letting these throw would do
  // (the whole dashboard becomes "This dashboard failed to load", the button
  // with it).
  //
  // `firstLoggedDay` sits INSIDE: outside, a broken history read would take
  // the whole dashboard down through this line while the catch below sat there
  // looking like it was handling it.
  let trend: ReturnType<typeof dailyTrend> | null = null
  let average: ReturnType<typeof dailyAverage> = null
  // Seeded from the read that already succeeded rather than defaulting to
  // false: a count above zero PROVES they have logged, so the caption stays
  // honest even if the history read fails underneath it.
  let everLogged = count > 0
  let trendFailed = false
  try {
    everLogged = everLogged || firstLoggedDay(db) !== null
    trend = dailyTrend(db, today)
    average = dailyAverage(trend)
  } catch {
    trendFailed = true
  }

  // THE GUARD the component rule requires, stated as one boolean so it is
  // impossible to render the chart without having asked. Degenerate for a
  // zero-based bar chart means:
  //   - fewer than two points (nothing to compare, and a one-bar "trend" is
  //     not one)
  //   - any non-finite count (a scale cannot be derived from NaN)
  //   - every count zero, which is the ONLY case where "all-identical" is
  //     actually degenerate here: the y-domain is [0, max], so a week of
  //     identical non-zero days yields [0, 6] and charts perfectly well.
  //     Blanking that panel would hide a real and quite likely week — a
  //     deliberate reading of the rule's "all-identical", flagged rather than
  //     silently narrowed.
  const chartable =
    trend !== null &&
    trend.length >= 2 &&
    trend.every((d) => Number.isFinite(d.count)) &&
    trend.some((d) => d.count > 0)

  return (
    // Fluid and centred, one column at every width, capped WELL SHORT of the
    // guidelines' 1200px default container — a deliberate deviation, named
    // here so it is judged on a screen rather than discovered.
    // docs/dashboard-ui-ux-guidelines.md's default is 375→1200 with "wide
    // space gets more columns"; this dashboard has two panels the spec puts in
    // a FIXED vertical order (tap button on top, week below), so a second
    // column would move the trend up beside the thing being tapped, and
    // stretching a single tap target and seven bars across 1200px makes both
    // worse rather than better. The spec's own reason outranks the default
    // here: run10 asked for a screen that "works equally well on phone and on
    // a computer browser", which is one layout at both widths, not two.
    <section className="mx-auto w-full max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Today
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/*
            THE GLANCE. One large number, readable without scrolling at 375px.
            A zero here is DATA, not absence — "you have not been yet today" is
            a true and useful thing to say, and the spec's midnight reset means
            every day legitimately starts here — so it renders as a confident 0
            rather than an empty state, and only the caption changes. The
            empty-state rule is about a zero that stands in for "we do not
            know", which this never is: the row either exists or it does not.
          */}
          <div>
            <p className="text-7xl leading-none font-semibold tabular-nums">{count}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {!everLogged && !trendFailed
                ? 'Tap below to log your first one.'
                : count === 0
                  ? 'Nothing logged yet today.'
                  : count === 1
                    ? 'time today'
                    : 'times today'}
            </p>
          </div>

          {/*
            THE DEFAULT WRITE CONTROL (lib/ui/WriteAction.tsx). It POSTs to the
            platform route — the route is the only writable handle and the only
            place the four ordered auth checks live — but it patches the page in
            place rather than navigating: press, the control goes pending, and
            when the server answers, the count, the chart and the average all
            update together.

            It renders a real form underneath, so this still works with
            JavaScript off; that path is the original redirect, unchanged.

            Sized for the spec's "large, easy-to-hit button": deliberately
            taller than any stock size, because shadcn's tallest default is
            36px and the touch-target floor is 44px. The press response is
            shadcn's own (`active:translate-y-px`) plus the pending label —
            the number itself does not move until the server confirms, which is
            the rule about a write never running ahead of the database.
          */}
          <WriteAction
            action={`/api/users/${slug}/pee-log`}
            payload={{ action: 'add' }}
            size="lg"
            className="h-20 w-full text-lg"
            pendingLabel="Logging…"
          >
            Log a pee
          </WriteAction>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          {/*
            THE AVERAGE SITS ALONGSIDE THE CHART'S TITLE, which is what the
            spec asks for — "Alongside it, the daily average across those seven
            days" — and it is the mean of exactly the bars below it, computed
            from the same array (queries.ts's dailyAverage). It is drawn on the
            chart as a dashed line too, so the comparison the panel exists for
            does not have to happen in the reader's head.

            GATED ON `chartable`, THE SAME BOOLEAN AS THE CHART, deliberately:
            the average is the chart's reference line made legible, and it says
            nothing on its own that the panel's empty state does not say
            better. On day one it would repeat today's count back as an
            "average" of one day; on a dead week it would print "0 a day" over
            copy that already says nothing was logged. Both are true and
            neither is worth a number.
          */}
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last {TREND_DAYS} days
            </CardTitle>
            {chartable && average !== null && (
              <div className="text-right">
                <span className="text-2xl font-semibold tabular-nums">
                  {average.average}
                </span>{' '}
                <span className="text-sm text-muted-foreground">a day</span>
              </div>
            )}
          </div>
          {chartable && average !== null && average.days < TREND_DAYS && (
            /*
              The denominator is said out loud whenever it is not seven. The
              trend clips at the first logged day, so during run10's first week
              this averages fewer days — and a panel labelled "last 7 days"
              that quietly averaged two would be lying about its own basis.
            */
            <p className="text-xs text-muted-foreground">
              averaged over {average.days === 1 ? 'the first day' : `${average.days} days`} so far
            </p>
          )}
        </CardHeader>
        <CardContent>
          {trendFailed ? (
            // Honest degradation, never stale or partial data dressed as
            // current. The log button above still works.
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load the last {TREND_DAYS} days just now. Logging still works.
            </p>
          ) : chartable ? (
            <TrendChart data={trend!} average={average?.average} />
          ) : (
            /*
              A DAY BEFORE run10 STARTED IS NOT A DAY THEY LOGGED NOTHING.
              queries.ts clips the window at the first logged day, so this
              branch is what a first day looks like — never seven zero bars
              reporting a week of failure that predates the dashboard.
            */
            <p className="text-sm text-muted-foreground">
              {!everLogged
                ? 'Nothing to chart yet. Your first tap starts this.'
                : trend!.length < 2
                  ? 'One day so far — the chart fills in from tomorrow.'
                  : /*
                      The third case, and it is NOT "one day so far": the
                      window is full but every day in it is zero, which happens
                      when the last log predates the window entirely. Saying
                      "one day so far" there would be plainly false to someone
                      who used this for a month and then stopped.
                    */
                    `Nothing logged in the last ${TREND_DAYS} days.`}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
