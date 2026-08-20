'use client'

// users/run11/MonthCalendar.tsx
//
// The month calendar on the Walk log screen — spec v2's "Month calendar"
// panel, which is also that screen's INPUT SURFACE: each square is a tap that
// marks or unmarks that day.
//
// ─── why this is a CLIENT component, which is the thing to read first ──────
//
// Everything else on this dashboard renders on the server. This file does not,
// for one reason: **which month is on screen is state the platform has no way
// to carry.** A dashboard is handed `{ slug, db, today, timeZone, screen }`
// and nothing else (lib/dashboard/contract.ts) — `?screen=` is the only search
// param that reaches it, resolved by `activeScreen` before this dashboard sees
// anything. There is no `?month=` to read, so a server-rendered month stepper
// would need `searchParams` added to DashboardProps: a platform contract change
// touching every dashboard, which is not the builder's to make. It is flagged
// to Nico in the build report, exactly as v1 flagged wanting a `now`. If it
// lands, this file becomes host elements in dashboard.tsx and the state goes
// into the URL, where it belongs.
//
// ─── what that costs, said out loud ────────────────────────────────────────
//
// The displayed month is not in the URL, so it cannot be bookmarked or deep
// linked, and stepping to July writes no `dashboard_open` row. That is the
// right answer for a month step — paging a calendar is not opening a
// dashboard — but it is the same mechanism CLAUDE.md warns about for TABS, and
// the warning does not apply here only because this is not navigation: the tab
// strip is still the platform's, still plain `<a href="?screen=">` anchors, and
// this component draws none of it.
//
// ─── the component rule ────────────────────────────────────────────────────
//
// docs/dashboard-build-rules.md §3, arm 2: a component deriving layout or
// geometry from values is sanctioned, guarded by a states check. THE GEOMETRY
// HERE COMES FROM THE MONTH, NOT FROM THE FRIEND'S DATA — `calendarGrid` takes
// a 'YYYY-MM' and returns rows of already-decided squares, and the marks only
// decide which of them are filled. So there is no degenerate-data case for a
// states check to catch: an empty log renders a perfectly good empty calendar,
// which is exactly what a friend's first session must show, since this panel is
// the only way to put anything in it. The month string is validated by
// construction — it comes from `monthOf(today)` and moves through `shiftMonth`
// — and the bounds below stop it leaving the range the caller computed.
//
// Every square that writes is a lib/ui/WriteAction (arm 3, platform code, the
// default for every write). This file holds no fetch, no SQL and no writable
// handle, and IT DECIDES NOTHING: which square is today, which is in the
// future and therefore carries no control at all, and which is marked, all
// arrive from `calendarGrid` in ./queries.ts, where they are tested without a
// React renderer. A client component's body never runs in this dashboard's own
// vitest suite (see lib/ui/useWriteAction.ts's note on exactly that), so a rule
// left in this file would be a rule nothing here can check — which is why
// every one of them lives one import away.
//
// IT READS NO CLOCK. `today` arrives as a prop, from the platform, through
// dashboard.tsx — the same day key the write route files a mark under.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { WriteAction } from '@/lib/ui/WriteAction'
import {
  WEEKDAY_LABELS,
  calendarGrid,
  monthLabel,
  monthOf,
  shiftMonth,
} from './queries'

export function MonthCalendar({
  action,
  today,
  marked,
  earliest,
}: {
  /** The platform route a square posts to. Host-relative; WriteAction checks. */
  action: string
  /** The friend's today, 'YYYY-MM-DD'. Handed down, never derived. */
  today: string
  /** Every day he has marked, ascending. */
  marked: string[]
  /** The earliest month the back arrow will reach — ./queries.ts's earliestMonth. */
  earliest: string
}) {
  const [month, setMonth] = useState(() => monthOf(today))
  const thisMonth = monthOf(today)
  const canGoBack = month > earliest
  // NEVER FORWARD OF THE CURRENT MONTH. There is nothing there — every day in
  // it is a future day, and future days are not markable — so a month of dead
  // squares would read as the calendar being broken.
  const canGoForward = month < thisMonth

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!canGoBack}
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </Button>
        {/*
          aria-live, because the month name is the only thing that changes when
          the arrows are pressed — a screen reader that did not announce it
          would be reading a grid of numbers with no idea which month.
        */}
        <p aria-live="polite" className="text-sm font-medium">
          {monthLabel(month)}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!canGoForward}
          aria-label="Next month"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((label) => (
          <p
            key={label}
            aria-hidden
            className="pb-1 text-center text-[0.7rem] font-medium text-muted-foreground"
          >
            {/* One letter at phone width, three from `sm` up: seven columns of
                "Wed" do not fit at 375px without the squares going square-ish. */}
            <span className="sm:hidden">{label.slice(0, 1)}</span>
            <span className="hidden sm:inline">{label}</span>
          </p>
        ))}

        {/*
          EVERY SQUARE ARRIVES ALREADY DECIDED. `calendarGrid` in ./queries.ts
          says which cells are blank, which are in the future and which are
          marked; this map turns each into markup and decides nothing itself.
          That is what makes those rules testable without a React renderer —
          see that function's own docstring.
        */}
        {calendarGrid(month, today, marked).map((week, rowIndex) =>
          week.map((cell, columnIndex) => {
            if (cell.kind === 'blank') {
              // A cell outside the month. An empty div rather than nothing at
              // all, so the seven columns stay aligned.
              return <div key={`pad-${rowIndex}-${columnIndex}`} aria-hidden />
            }

            if (cell.kind === 'future') {
              /*
                FUTURE DAYS ARE NOT MARKABLE — spec v2 says so directly, and it
                is the right rule: a mark is a record that a walk happened.
                Rendered as a plain host element with no control at all rather
                than as a disabled button, so there is nothing to press and
                nothing that looks pressable.
              */
              return (
                <div
                  key={cell.day}
                  className="flex h-9 items-center justify-center rounded-lg text-sm text-muted-foreground/40"
                >
                  {cell.date}
                </div>
              )
            }

            return (
              <WriteAction
                key={cell.day}
                action={action}
                payload={{ action: cell.marked ? 'unmark' : 'mark', day: cell.day }}
                variant={cell.marked ? 'default' : 'outline'}
                /*
                  The label a screen reader hears, and the one place the state
                  of a square is stated in words rather than in colour. A grid
                  of numbers where the only difference between "walked" and
                  "didn't" is a fill is unreadable without it.
                */
                aria-label={
                  cell.marked
                    ? `Walked on ${monthLabel(month)} ${cell.date} — tap to unmark`
                    : `Mark ${monthLabel(month)} ${cell.date} as walked`
                }
                // No `size`: the button fills its grid cell, so the height and
                // padding are set here rather than by a fixed icon size that
                // twMerge would then have to be trusted to unpick.
                className={[
                  'h-9 w-full px-0 text-sm transition-transform active:scale-95',
                  // Today is outlined whether or not it is marked, so "which
                  // square is today" survives the fill.
                  cell.isToday ? 'ring-2 ring-ring ring-offset-1' : '',
                ].join(' ')}
              >
                {cell.date}
              </WriteAction>
            )
          }),
        )}
      </div>
    </div>
  )
}
