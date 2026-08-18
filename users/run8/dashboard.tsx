// users/run8/dashboard.tsx
//
// Built toward users/run8/mockup.html: today's count with plus/minus, and a
// week chart that toggles between daily totals and weekly averages.
//
// ONE component with plain helpers, deliberately. app/[user]/page.tsx CALLS
// this function inside its own try/catch; a nested React function component's
// body would run later, during Next's render pass, outside that catch — turning
// a broken panel into a 500 for the whole page, after the dashboard_open metric
// row has already been written. Everything below is host elements.
//
// STYLING: Tailwind utilities and app/globals.css's own tokens, not the
// mockup's stylesheet. The mockup governs LAYOUT and content here — the
// two-panel grid, the oversized numeral, the 64/76px round tap targets the
// spec asked to work on a phone, the seven-column axis — while colour comes
// from the app's palette. run8 never asked for the mockup's green; it is the
// generator's choice, and their spec's Background says nothing about colour.
// The day a friend DOES ask for a colour, the cheap answer is one scoped
// custom property on this component's own wrapper, not a second stylesheet.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import {
  firstTrackedDay,
  dayTotal,
  sameDayLastWeek,
  weekDays,
  weeklyAverages,
  type DayTotal,
  type WeekAverage,
} from './queries'

// From spec.md's `## Screens`: `### \`tracker\` — Bathroom count`. The id and
// title are the spec's own words, never a second source that could drift from
// what the friend confirmed.
export const screens: DashboardScreen[] = [
  { id: 'tracker', title: 'Bathroom count', order: 1 },
]

const WEEKDAYS_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Which weekday a day key falls on, as a name.
 *
 * `new Date(y, m, d)` WITH arguments, which is calendar arithmetic over a
 * string the page handed down — not a clock read. The zero-argument form and
 * `Date.now()` are what tests/users/noLocalDay.test.ts forbids here, because
 * they would answer with the droplet's day rather than the friend's.
 */
function weekdayName(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return WEEKDAYS_LONG[(new Date(y!, m! - 1, d!).getDay() + 6) % 7]!
}

/** '2026-08-04' → 'Aug 4'. Pure string work; no Date at all. */
function shortDate(day: string): string {
  const [, m, d] = day.split('-').map(Number)
  return `${MONTHS_SHORT[m! - 1]} ${d}`
}

/** Bar height as a percentage of the tallest value, floored so a 1 is visible. */
function barHeight(value: number, max: number): string {
  if (max <= 0) return '4%'
  return `${Math.max(4, Math.round((value / max) * 100))}%`
}

const PANEL = 'rounded-xl border border-border bg-card p-4'
const PANEL_TITLE = 'text-sm font-semibold'
const NOTE = 'mt-3 text-sm text-muted-foreground'

function dailyChart(days: DayTotal[]) {
  const max = Math.max(...days.filter((d) => d.tracked).map((d) => d.total), 0)
  return (
    <>
      <div className="mt-5 grid h-[150px] grid-cols-7 items-end gap-2 md:h-[200px] md:gap-3.5">
        {days.map((d) => (
          <div key={d.day} className="flex h-full flex-col justify-end gap-1.5 text-center">
            {/*
              An untracked day gets no bar and no number — not a zero bar.
              A day before this friend's first tap is not a day they went
              nowhere, and a day later this week has not happened yet. devtwo
              shipped the opposite of this and told a friend on their first
              morning that they had missed fourteen days (build-rules §6).
            */}
            {d.tracked ? (
              <>
                <b className="text-xs font-semibold tabular-nums">{d.total}</b>
                <i
                  className="block rounded-t-[5px] bg-primary/35 last:bg-primary"
                  style={{ height: barHeight(d.total, max) }}
                />
              </>
            ) : (
              <span className="text-xs text-muted-foreground/50">·</span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-2 text-center text-[0.7rem] uppercase tracking-wider text-muted-foreground md:gap-3.5">
        {WEEKDAYS_SHORT.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </>
  )
}

function weeklyChart(weeks: WeekAverage[]) {
  const max = Math.max(...weeks.map((w) => w.average), 0)
  return (
    // Horizontally scrollable because this view is deliberately unbounded —
    // run8 asked for as many weeks as we have, so it grows by one column a
    // week forever and must not squeeze the axis into unreadability.
    <div className="mt-5 overflow-x-auto">
      <div className="flex h-[150px] items-end gap-3 md:h-[200px]">
        {weeks.map((w) => (
          <div
            key={w.weekStart}
            className="flex h-full min-w-[44px] flex-1 flex-col justify-end gap-1.5 text-center"
          >
            <b className="text-xs font-semibold tabular-nums">{w.average}</b>
            <i
              className="block rounded-t-[5px] bg-primary/35 last:bg-primary"
              style={{ height: barHeight(w.average, max) }}
            />
            <span className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">
              {shortDate(w.weekStart)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function RunEightDashboard({ slug, db, today }: DashboardProps) {
  // Handed down, never derived: the count route files a tap under a day, and a
  // dashboard computing its own would let the two disagree about the calendar.
  const total = dayTotal(db, today)
  const started = firstTrackedDay(db) !== undefined
  const days = weekDays(db, today)
  const weeks = weeklyAverages(db, today)
  const lastWeek = sameDayLastWeek(db, today)
  const thisWeek = weeks[weeks.length - 1]

  return (
    // The frame is THIS DASHBOARD'S, not the platform's. app/[user]/Shell.tsx
    // gives every dashboard padding and no measure, deliberately: there is no
    // knowing what a friend will want theirs to look like, and a shell-wide cap
    // would be a decision made once for people who have not asked for anything
    // yet. 60rem is what run8's own mockup.html frames its content at.
    <section className="mx-auto max-w-[60rem]">
      <h2 className="mb-3.5 text-[1.05rem] font-semibold uppercase tracking-wide text-muted-foreground">
        Bathroom count
      </h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(260px,340px)_1fr] md:items-stretch">
        <div className={`${PANEL} flex flex-col justify-center`}>
          <div className={PANEL_TITLE}>Today</div>
          {/*
            Two separate forms rather than one with two submit buttons. A
            button's `value` only reaches the server when that button is the
            one that submitted, which is true here — but it also means the
            payload depends on WHICH control was activated, and a stray Enter
            in the form would post whichever button the browser considers
            default. Two forms make each button mean exactly one thing.

            A form POST, not a client-side fetch: this stays a server
            component, and the write goes to a platform route because a
            dashboard never holds a writable handle (build-rules §4).
          */}
          <div className="mt-1.5 flex items-center justify-between gap-3.5">
            <form method="post" action={`/api/users/${slug}/count`}>
              <input type="hidden" name="delta" value="-1" />
              <button
                type="submit"
                aria-label="Remove one from today"
                className="flex size-16 items-center justify-center rounded-full border-[1.5px] border-border bg-muted/50 text-3xl leading-none hover:bg-muted disabled:opacity-40"
                disabled={total <= 0}
              >
                −
              </button>
            </form>

            <div className="text-[5.5rem] font-semibold leading-[0.9] tabular-nums md:text-[6.5rem]">
              {total}
            </div>

            <form method="post" action={`/api/users/${slug}/count`}>
              <input type="hidden" name="delta" value="1" />
              <button
                type="submit"
                aria-label="Add one to today"
                className="flex size-[76px] items-center justify-center rounded-full bg-primary text-[2.4rem] leading-none text-primary-foreground hover:opacity-90"
              >
                +
              </button>
            </form>
          </div>
          <p className={NOTE}>
            {weekdayName(today)}
            {lastWeek !== undefined ? ` · last week this day: ${lastWeek}` : ''}
          </p>
        </div>

        {/*
          The daily/weekly toggle, with no JavaScript and no client component.

          Two radio inputs carry the state and CSS reads it through :has() on
          this panel. A <Tabs> component would be a nested function component,
          whose body React defers to its own render pass — outside the page's
          try/catch (build-rules §3). Radios also make the control keyboard
          operable and announce as a radio group for free, which a pair of
          styled <div>s would not.
        */}
        <div className={`${PANEL} group`}>
          <input
            type="radio"
            id="run8-view-daily"
            name="run8-view"
            defaultChecked
            className="sr-only"
          />
          <input type="radio" id="run8-view-weekly" name="run8-view" className="sr-only" />

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className={PANEL_TITLE}>This week</div>
            <div className="inline-flex overflow-hidden rounded-full border border-border text-[0.72rem] uppercase tracking-wider">
              <label
                htmlFor="run8-view-daily"
                className="cursor-pointer px-3 py-[5px] text-muted-foreground group-has-[#run8-view-daily:checked]:bg-primary/10 group-has-[#run8-view-daily:checked]:font-semibold group-has-[#run8-view-daily:checked]:text-primary"
              >
                Daily
              </label>
              <label
                htmlFor="run8-view-weekly"
                className="cursor-pointer px-3 py-[5px] text-muted-foreground group-has-[#run8-view-weekly:checked]:bg-primary/10 group-has-[#run8-view-weekly:checked]:font-semibold group-has-[#run8-view-weekly:checked]:text-primary"
              >
                Weekly avg
              </label>
            </div>
          </div>

          {/*
            NOTHING LOGGED EVER IS NOT A WEEK OF ZEROES.

            On a friend's first morning this panel renders over their own empty
            database — there is no synthetic fallback standing in front of it.
            Seven empty bars would read as a week of failure about days the
            product has nothing to say on. The counter above still shows 0,
            which is different: at 7am "0 today" is true and is the cue to
            press plus.
          */}
          {!started ? (
            <p className={NOTE}>Nothing logged yet — press + to start.</p>
          ) : (
            <>
              <div className="hidden group-has-[#run8-view-daily:checked]:block">
                {dailyChart(days)}
                {thisWeek !== undefined ? (
                  <p className={NOTE}>
                    Averaging {thisWeek.average} a day this week
                    {thisWeek.days < 7 ? ` (${thisWeek.days} days so far)` : ''}
                  </p>
                ) : null}
              </div>
              <div className="hidden group-has-[#run8-view-weekly:checked]:block">
                {weeklyChart(weeks)}
                <p className={NOTE}>
                  {weeks.length === 1
                    ? 'One week so far — this fills in as you go.'
                    : `Average a day, each week since ${shortDate(weeks[0]!.weekStart)}.`}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
