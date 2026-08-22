import { monthlyActivity, weeklyGrid, REPORTING_TIME_ZONE } from '@/lib/metrics/retention'

/**
 * Which days one friend was actually in the app.
 *
 * ── Why a picture and not a number ──────────────────────────────────────────
 *
 * "Weekly / monthly retention" is a shape, not a scalar. Three active days
 * spread across three weeks and three active days in one burst are the same
 * number and opposite situations, and the grid is the only thing that shows
 * the difference at a glance. The rollups underneath give the number once the
 * shape has told you which number to read.
 *
 * ── Pure, and deliberately so ───────────────────────────────────────────────
 *
 * It takes the already-computed day list rather than a database handle. The
 * definition of a visit lives in lib/metrics/retention.ts and the query lives
 * in the page; this file only draws. That is what lets the interesting cases —
 * a clipped current week, a month older than the grid — be tested as markup
 * without standing up a platform database.
 *
 * ── No user values, same bound as the metrics it reads ──────────────────────
 *
 * Days and counts. Never a panel, a merchant, a screen name or a transcript
 * line: this pane answers "did they come back", and the Transcript tab beside
 * it is where "what did they say" already lives.
 */
export function ActivityPane({
  days,
  today,
  weeks,
}: {
  /** Active days, 'YYYY-MM-DD', oldest first — lib/metrics/retention.ts. */
  days: string[]
  /** Today in REPORTING_TIME_ZONE. Passed in, never read from a clock here. */
  today: string
  /** How many weeks the grid covers. */
  weeks: number
}) {
  if (days.length === 0) {
    // Not an empty grid. Twelve rows of blank cells for someone who has never
    // arrived reads as a friend who stopped coming — a different situation,
    // acted on differently, and the wrong one to be nudged toward.
    return <p className="py-4 text-sm text-muted-foreground">No activity yet.</p>
  }

  const grid = weeklyGrid(days, today, weeks)
  const months = monthlyActivity(days)
  const first = days[0]!
  const last = days[days.length - 1]!

  return (
    <div className="space-y-6 py-4">
      <p className="text-sm">
        <span className="font-medium">{days.length}</span>
        {days.length === 1 ? ' active day' : ' active days'}
        <span className="text-muted-foreground">
          {` — first ${first}, last ${last}`}
        </span>
      </p>

      <div>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Last {weeks} weeks
        </h2>
        <div className="space-y-1">
          {/* Monday-start weeks, so the columns line up under fixed headers.
              Only the newest week is ever short (it stops at today), which is
              why the clipping cannot break the alignment of the rows above. */}
          {/* The SAME flex structure as a week row, with an empty span where
              the date label goes — not `pl-[5.5rem]`, which loses the row's
              first `gap-1` and slides every letter 4px off its column. The
              screenshot review is what caught that. */}
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="w-[5.5rem]" />
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((letter, index) => (
              <span key={index} className="w-4 text-center">
                {letter}
              </span>
            ))}
          </div>
          {grid.map((week) => (
            <div
              key={week.start}
              data-week={week.start}
              data-active-count={week.activeCount}
              className="flex items-center gap-1"
            >
              <span className="w-[5.5rem] text-[10px] tabular-nums text-muted-foreground">
                {week.start}
              </span>
              {week.days.map((cell) => (
                <span
                  key={cell.day}
                  data-day={cell.day}
                  data-active={cell.active ? 'true' : 'false'}
                  title={cell.day}
                  className={
                    cell.active
                      ? 'h-4 w-4 rounded-sm bg-foreground'
                      : 'h-4 w-4 rounded-sm border bg-muted'
                  }
                />
              ))}
              <span className="ml-2 text-[10px] tabular-nums text-muted-foreground">
                {week.activeCount}/{week.days.length}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          By month
        </h2>
        {/* ALL of history, not the grid's window. A friend's second and third
            month are the whole of "monthly retention", and a fixed-length grid
            would drop them off the bottom exactly when they start mattering. */}
        <ul className="divide-y text-sm">
          {months.map((month) => (
            <li
              key={month.month}
              data-month={month.month}
              data-active-count={month.activeCount}
              className="flex items-baseline justify-between py-1"
            >
              <span className="tabular-nums">{month.month}</span>
              <span className="text-muted-foreground">
                {month.activeCount} {month.activeCount === 1 ? 'day' : 'days'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">
        Days are {REPORTING_TIME_ZONE}. A day counts once however many times
        they opened it.
      </p>
    </div>
  )
}
