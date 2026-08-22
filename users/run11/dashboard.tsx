// users/run11/dashboard.tsx
//
// run11's dashboard — spec v3, users/run11/spec.md, read against
// users/run11/current.md. THREE screens now, so the platform draws a tab strip:
//
//   Walk the dog?  the decider. The verdict on top and large, the next good
//                  window below it, and the friend's own no-go temperature at
//                  the foot of the screen.
//   Walk log       a different product: a streak, a month calendar he taps to
//                  mark days, and a percentage. It reads no forecast and the
//                  decider reads no walk.
//   Spending       new in v3, and a third product again: a pie of the last 30
//                  days from his credit card and his debit card, and the
//                  transaction list he re-files from. It reads neither of the
//                  other two and neither reads it.
//
// NO SQL HERE. Every statement, every threshold behind the verdict, every piece
// of calendar arithmetic, and every rule about what counts as a slice lives in
// ./queries.ts.
//
// ─── WHERE "RIGHT NOW" COMES FROM, which is the one thing to read before
//     changing this file ───────────────────────────────────────────────────
//
// A dashboard is handed `{ slug, db, today, timeZone, screen }` and nothing
// else (lib/dashboard/contract.ts). There is no `now`: `today` is a day key,
// and a dashboard may not ask a clock for anything, including the time
// (tests/users/noLocalDay.test.ts). But every question spec v1 asks is about a
// POSITION IN THE DAY.
//
// So the reference instant is the last SUCCESSFUL REFRESH — a stored value,
// written by app/api/users/[user]/forecast/route.ts at the moment it fetched.
// Everything on this screen is "as of" that moment, and the panel says so
// rather than implying otherwise. Pressing Refresh makes that moment now, and
// lib/ui/WriteAction.tsx patches both panels in place when the server answers,
// so the friend is always one press away from a genuinely live answer.
//
// That is an honest v1 and not a workaround, but it is not what the spec's
// "in one look" describes, and the fix is not this file's to make: adding
// `now` to DashboardProps is a platform contract change touching every
// dashboard. It is flagged to Nico in the build report. If it lands, exactly
// one line here changes — the `reference` below — because queries.ts already
// takes the minute as a parameter.
//
// ─── COMPOSITION ────────────────────────────────────────────────────────────
//
// docs/dashboard-build-rules.md states the component rule in three arms:
//
//   arm 1, presentational — shadcn's Card, Button, Input. Trusted.
//   arm 2, data-computing — sanctioned BEHIND A STATES CHECK.
//     ./MonthCalendar.tsx's own header says why it has no degenerate-data case
//     to guard: its geometry comes from a month, not from the friend's marks.
//     ./SpendingPie.tsx DOES have one, and the check is in `spendingScreen`
//     below rather than inside the component — degenerate data renders the
//     panel's empty state as host elements and never mounts Recharts at all.
//     A guard inside the chart would run after it had already mounted.
//   arm 3, interaction controls — sanctioned, and the default for every write.
//     lib/ui/WriteAction.tsx is used unchanged for Refresh and for every
//     control on the first two screens. ./CategoryControls.tsx is the first
//     thing in this repo a labelled button cannot express (a menu, a typed
//     name, and a tick box that shows its own state), and it is built on
//     lib/ui/useWriteAction.ts — the escape hatch
//     that file's own header names — so the write LIFETIME is still platform
//     code and is not reimplemented per user.
//
// The accepted residual for all three is a throw on well-formed props landing
// outside app/[user]/page.tsx's try/catch.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PlaidConnect } from '@/lib/ui/PlaidConnect'
import { PlaidSources } from '@/lib/ui/PlaidSources'
import { readPlaidSources } from '@/modules/plaid/sources'
import { WriteAction } from '@/lib/ui/WriteAction'
import { MonthCalendar } from './MonthCalendar'
import { CategoryToggle, NewCategoryControl, RefileControl } from './CategoryControls'
import { SpendingPie, type PieSlice } from './SpendingPie'
import { OTHER_COLOR, sliceColor } from './palette'
import {
  CATEGORY_NAME_MAX,
  HEAT_NO_GO_MAX_F,
  HEAT_NO_GO_MIN_F,
  HEAT_NO_GO_STEP_F,
  OTHER_CATEGORY,
  WALK_MINUTES,
  WALK_RATE_DAYS,
  bankCategories,
  categoryLabel,
  categoryTotals,
  categoryVisibility,
  ceilToStep,
  currentStreak,
  customCategories,
  daysBetween,
  earliestMonth,
  foldIntoOther,
  heatNoGoF,
  isConnected,
  lastRefreshes,
  latestFetch,
  latestSuccessfulFetch,
  markedDays,
  nextGoodWindow,
  rightNow,
  shadeFloorF,
  spendingAccounts,
  spendingTransactions,
  walkRate,
} from './queries'
import type { GoodWindow, PlaidRefresh, RightNow, WalkReading } from './queries'

// TWO screens as of spec v2, so the platform now draws a tab strip above
// whatever this file returns — plain `<a href="?screen=">` anchors in
// app/[user]/page.tsx, never drawn here. `walk_the_dog` keeps order 1 and stays
// the landing screen, which spec v2 states directly.
//
// The titles are what the spec calls them ("Walk the dog?", "Walk log"); the
// ids and orders are the builder's, since a change-only spec carries no ids,
// and they are written down in users/run11/current.md's `## Screens` — the
// only place the next build and the chat agent can read them. `walk_the_dog`
// keeps the id it had in v1: a screen id is what `?screen=` names, so changing
// one would quietly break a bookmark.
export const screens: DashboardScreen[] = [
  { id: 'walk_the_dog', title: 'Walk the dog?', order: 1 },
  { id: 'walk_log', title: 'Walk log', order: 2 },
  // THIRD, and after the two dog screens — spec v3: "A third tab alongside
  // 'Walk the dog?' and 'Walk log', ordered after them." The landing screen is
  // unchanged, which the spec also states ("Nothing on the two dog screens
  // changes"): a friend who opens this to decide about a walk should not have
  // to walk past his own spending to do it.
  { id: 'spending', title: 'Spending', order: 3 },
]

/**
 * A stored minute-of-day as a wall clock, e.g. 1145 -> "7:05 PM".
 *
 * Pure integer formatting. It reads no clock and knows no timezone, because
 * the zone was already applied when the row was written — see
 * users/run11/migrations/001_initial.sql.
 */
function clock(minute: number): string {
  const total = ((minute % 1440) + 1440) % 1440
  const hour24 = Math.floor(total / 60)
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${hour12}:${String(total % 60).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`
}

/** Whole degrees. A tenth of a degree of heat index is precision nobody has. */
function degrees(f: number): string {
  return `${Math.round(f)}°F`
}

const HEADLINE: Record<WalkReading['verdict'], string> = {
  go: 'Go',
  short: 'Go — short one, shade',
  no: 'Don’t go',
}

/**
 * Colour carries the verdict, and the words carry it too.
 *
 * Never colour alone: the whole panel is one word plus one line, so a reader
 * who cannot separate green from amber would otherwise be reading a headline
 * with no verdict in it at all.
 */
const TONE: Record<WalkReading['verdict'], string> = {
  go: 'text-emerald-700 dark:text-emerald-400',
  short: 'text-amber-700 dark:text-amber-400',
  no: 'text-rose-700 dark:text-rose-400',
}

/**
 * The one-line reason under the verdict.
 *
 * EVERY failing check is named, not just the first. It is routinely both too
 * hot and about to rain in Houston in August, and a panel that named one of
 * them would look wrong to anyone who had glanced out of a window.
 */
function reason(reading: WalkReading): string {
  if (reading.verdict === 'go') {
    return `No rain, feels like ${degrees(reading.peakFeelsLikeF)}, and you’ll be back before dark.`
  }
  if (reading.verdict === 'short') {
    return `Feels like ${degrees(reading.peakFeelsLikeF)} — keep it short and stay in the shade.`
  }
  const parts = reading.blockers.map((blocker) =>
    blocker === 'rain'
      ? `rain is expected (${reading.peakPrecipChance}% chance)`
      : blocker === 'heat'
        ? `it feels like ${degrees(reading.peakFeelsLikeF)}`
        : 'there isn’t enough daylight left',
  )
  const joined =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`
}

/**
 * WHY THE WINDOW ENDS, in words.
 *
 * Nico's review of v1: "Tomorrow, from 7:00 AM / good to head out any time up
 * to 7:20 AM" names a time and gives no reason, and a twenty-minute window
 * reads as a glitch rather than as a forecast. In a Houston August it is
 * neither — the real forecast that prompted this dips below 90°F for about two
 * hours around dawn and peaks at 110°F — so the panel has to say that, or the
 * friend is left doubting the one number the screen exists to give him.
 *
 * Every failing check is named, the same way the verdict's reason line names
 * them, and each arrives with the figure behind it rather than the threshold:
 * "up to 96°F" is a fact about tomorrow, where "above 90°F" is a fact about
 * our own settings.
 */
function closingPhrase(closing: GoodWindow['closedBy']): string {
  // The forecast ran out rather than a check failing — a different thing, and
  // it must not be dressed up as weather.
  if (closing === null) return 'that’s as far as the forecast goes'
  const parts = closing.blockers.map((blocker) =>
    blocker === 'rain'
      ? `rain moves in (${closing.peakPrecipChance}% chance)`
      : blocker === 'heat'
        ? `it’s up to ${degrees(closing.peakFeelsLikeF)}`
        : 'you wouldn’t be back before dark',
  )
  if (parts.length === 0) return 'the window closes'
  const joined =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `after that ${joined}`
}

/** How the window panel reads, given where "now" sits relative to it. */
function windowLine(window: GoodWindow, nowMinute: number): { headline: string; detail: string } {
  const openNow = !window.isTomorrow && window.startMinute <= ceilToStep(nowMinute)
  const why = closingPhrase(window.closedBy)
  // A window one scan step wide has no "up to" to offer — saying "any time up
  // to 7:00 AM" when it also starts at 7:00 AM reads as a bug. It is a real
  // case on a hot day and it is the one where the reason matters most.
  const detail =
    window.startMinute === window.lastStartMinute
      ? `That’s the only good start — ${why}.`
      : `Head out any time up to ${clock(window.lastStartMinute)} — ${why}.`
  if (openNow) {
    return { headline: 'Open now', detail }
  }
  return {
    headline: window.isTomorrow
      ? `Tomorrow, from ${clock(window.startMinute)}`
      : `From ${clock(window.startMinute)}`,
    detail,
  }
}

/** "1 day" / "3 days", so no caption on this dashboard reads "1 days". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * THE DECIDER SCREEN — spec v1's two panels, plus v2's temperature control.
 *
 * A PLAIN FUNCTION, CALLED, never `<DeciderScreen />`. A nested function
 * component's body is deferred to React's own render pass, which runs after
 * app/[user]/page.tsx's renderDashboard has returned — outside the try/catch
 * that turns a broken dashboard into a degraded panel rather than a 500 with
 * the chat surface gone. Called, it runs inside it. Same reason page.tsx calls
 * `tabStrip(...)` rather than nesting it.
 */
function deciderScreen({ slug, db, today }: { slug: string; db: DashboardProps['db']; today: string }) {
  // THE THREE READS EVERYTHING ELSE DEPENDS ON, and deliberately outside any
  // catch of this file's own: if the fetch log cannot be read there is no
  // reference instant, so there is no honest thing to render in either panel
  // and app/[user]/page.tsx's "This dashboard failed to load" is the right
  // answer. All three are single-row reads against tiny tables.
  const newest = latestFetch(db)
  const reference = latestSuccessfulFetch(db)
  // HIS NO-GO NUMBER, and it is in this group rather than defaulted on failure
  // for the reason the whole of users/run11/tests/dashboard.test.ts is about:
  // this dashboard's characteristic failure is a CONFIDENT WRONG ANSWER. If
  // the setting cannot be read we do not know his cutoff, and quietly judging
  // the walk against 90°F while he has set 95 is a verdict the screen cannot
  // stand behind. Failing loudly is the honest answer; the default is for a
  // friend who has never set one, not for a read that broke.
  const noGoF = heatNoGoF(db)

  // The refresh control, rendered in every state including the empty one — it
  // is the only way any of this gets data, so a state that hid it would be a
  // dead end. lib/ui/WriteAction.tsx patches every panel in place when the
  // server answers; the route it posts to is the only writable handle.
  const refresh = (
    <WriteAction
      action={`/api/users/${slug}/forecast`}
      payload={{}}
      pendingLabel="Checking…"
      variant="outline"
      size="sm"
    >
      Refresh
    </WriteAction>
  )

  // STALE IS ITS OWN STATE, and it is decided from `today` — the one piece of
  // real present-tense information this component is handed. A forecast fetched
  // on an earlier day says nothing trustworthy about the next 40 minutes, and
  // rendering its verdict would be exactly the "stale data as if it were
  // current" that docs/dashboard-ui-ux-guidelines.md > States forbids.
  const staleDay = reference !== null && reference.day !== today

  // Whether the most recent ATTEMPT failed while an older one still holds data.
  // The panel keeps rendering that data — this is a read refreshing, and the
  // guidelines' pattern for it is last-known data plus a quiet indicator — but
  // it never does so silently.
  const refreshFailed = newest !== null && !newest.ok

  const nowMinute = reference?.minuteOfDay ?? 0
  const verdict: RightNow =
    reference === null || staleDay
      ? { state: 'no_forecast' }
      : rightNow(db, today, nowMinute, noGoF)

  // THE SECOND PANEL READS BEHIND ITS OWN CATCH. Both panels read the same
  // three tables through the same handle, so per-panel isolation is mostly
  // theatre — except across this line. The verdict IS the product; a failure
  // scanning the rest of the day must not take away the answer to "can I go
  // right now", which is what letting this throw would do.
  let window: GoodWindow | null = null
  let windowFailed = false
  if (reference !== null && !staleDay) {
    try {
      window = nextGoodWindow(db, today, nowMinute, noGoF)
    } catch {
      windowFailed = true
    }
  }

  return (
    // Fluid and centred, one column at every width, capped well short of the
    // guidelines' 1200px default — a deliberate deviation, named here so it is
    // judged on a screen rather than discovered. The spec fixes these two
    // panels in a vertical order ("Sits directly below the 'Right now'
    // panel"), so a second column at desktop width would put the answer and
    // the fallback side by side and make neither the thing you look at first.
    // A verdict is one word; stretching it across 1200px makes it harder to
    // read, not easier.
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Right now
          </CardTitle>
          {refresh}
        </CardHeader>
        <CardContent className="space-y-4">
          {verdict.state === 'ok' ? (
            <div>
              {/*
                THE GLANCE. One verdict, large, readable without scrolling at
                375px — the spec asks for "an answer, not a weather report",
                so the reasoning is deliberately secondary type below it.
              */}
              <p
                className={`text-4xl leading-tight font-semibold sm:text-5xl ${TONE[verdict.reading.verdict]}`}
              >
                {HEADLINE[verdict.reading.verdict]}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{reason(verdict.reading)}</p>
            </div>
          ) : verdict.state === 'uncovered' ? (
            /*
              A forecast exists but does not reach across the next 40 minutes —
              the tail of an old snapshot. NOT a verdict computed from the hours
              that happen to be there: missing hours are missing information,
              and the hour with the storm in it is exactly the one that would be
              missing.
            */
            <div>
              <p className="text-2xl font-semibold">No answer yet</p>
              <p className="mt-2 text-sm text-muted-foreground">
                The forecast on file doesn’t cover the next {WALK_MINUTES} minutes. Refresh to
                pull a current one.
              </p>
            </div>
          ) : (
            /*
              THE EMPTY STATE, and the first thing run11 ever sees. Their own
              database starts empty — there is no synthetic fallback in front of
              it — so this is the whole panel on the morning it ships. It says
              what the panel is waiting for and shows the control that provides
              it; it never shows a confident verdict computed from nothing.
            */
            <div>
              <p className="text-2xl font-semibold">
                {staleDay ? 'Out of date' : 'No forecast yet'}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {staleDay
                  ? 'The forecast on file is from an earlier day. Refresh to check today.'
                  : 'Press Refresh to pull the forecast for 77006 and get an answer.'}
              </p>
            </div>
          )}

          {/*
            THE "AS OF" LINE. Prominent rather than buried, because it is what
            makes everything above it honest: the verdict is true as of this
            moment, not necessarily as of the moment you are reading it.
          */}
          {reference !== null && (
            <p className="text-xs text-muted-foreground">
              Forecast for 77006, as of {clock(reference.minuteOfDay)}
              {staleDay ? ` on ${reference.day}` : ''}.
            </p>
          )}

          {refreshFailed && (
            /*
              THE ERROR STATE. The last attempt did not come back, and saying so
              is the whole job — a panel that quietly kept showing the previous
              forecast would be the one thing the States section forbids by
              name. Contained here: it never takes down the page, and the
              verdict above it stays rendered with its own "as of" line.
            */
            <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
              Couldn’t reach the forecast on the last try. Anything above is from the previous
              refresh.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Next good window
          </CardTitle>
        </CardHeader>
        <CardContent>
          {windowFailed ? (
            <p className="text-sm text-muted-foreground">
              Couldn’t work out the next window. The answer above is unaffected.
            </p>
          ) : window !== null ? (
            (() => {
              const line = windowLine(window, nowMinute)
              return (
                <div>
                  <p className="text-2xl font-semibold sm:text-3xl">{line.headline}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{line.detail}</p>
                </div>
              )
            })()
          ) : reference === null || staleDay ? (
            <p className="text-sm text-muted-foreground">
              Nothing to show until there’s a current forecast.
            </p>
          ) : (
            /*
              A real, and in Houston a routine, answer: nothing today and
              nothing tomorrow clears all three checks. Said plainly rather than
              rendered as an empty card.
            */
            <p className="text-sm text-muted-foreground">
              No {WALK_MINUTES}-minute stretch today or tomorrow clears rain, heat and daylight.
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        MY NO-GO TEMPERATURE — spec v2's only addition to this screen, and
        LAST on it deliberately. The two panels above are the answer; this is
        the setting behind the answer, and putting a control above the verdict
        would make a screen that exists to be glanced at open with a knob.

        It is a −/+ STEPPER rather than a typed field, and that is a real
        choice rather than a limitation of WriteAction. A stepper cannot
        produce a value that is not a whole degree inside the range, so there
        is nothing to validate in the browser and nothing to reject; and
        because every press recomputes both panels above in place, nudging the
        number is how he SEES what it does — the verdict flips under his hand
        at the degree where it flips. A field with a Save button would give him
        one answer for one guess. One degree a press, because the numbers that
        matter to him are one or two degrees apart: he was offered both bands
        and asked for "just the hard no number", which is a person tuning, not
        someone typing in an arbitrary figure.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            My no-go temperature
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            {/*
              Both controls post to the SAME route, so lib/ui/WriteAction.tsx
              locks them together while a write is in flight — that grouping is
              by action URL, and it is why the walk log's own control on the
              other screen has a route of its own rather than sharing this one.
              The bounds are the dashboard's affordance; the route enforces them
              again, because a disabled button is not a rule.
            */}
            <WriteAction
              action={`/api/users/${slug}/no-go-temp`}
              payload={{ action: 'lower' }}
              disabled={noGoF <= HEAT_NO_GO_MIN_F}
              pendingLabel="…"
              variant="outline"
              aria-label={`Lower the no-go temperature by ${HEAT_NO_GO_STEP_F} degree`}
            >
              −
            </WriteAction>
            {/*
              tabular-nums so 89 and 90 occupy the same width — without it the
              number jiggles sideways on every press, which reads as the layout
              breaking rather than as the value changing.
            */}
            <p className="text-3xl font-semibold tabular-nums">{degrees(noGoF)}</p>
            <WriteAction
              action={`/api/users/${slug}/no-go-temp`}
              payload={{ action: 'raise' }}
              disabled={noGoF >= HEAT_NO_GO_MAX_F}
              pendingLabel="…"
              variant="outline"
              aria-label={`Raise the no-go temperature by ${HEAT_NO_GO_STEP_F} degree`}
            >
              +
            </WriteAction>
          </div>
          {/*
            The band, spelled out, because he sets one number and gets two. It
            is derived from the number beside it rather than stored, so these
            two lines cannot disagree.
          */}
          <p className="mt-3 text-sm text-muted-foreground">
            At {degrees(noGoF)} or hotter it’s a no. {shadeFloorF(noGoF)}–{degrees(noGoF)} is “go,
            but short and shady”.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Feels-like, at the hottest point of the whole {WALK_MINUTES} minutes.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}

/**
 * THE WALK LOG SCREEN — spec v2's second screen. Three panels, one table, and
 * nothing at all from the forecast.
 *
 * ONE READ, THREE PANELS, AND NO PER-PANEL CATCH, unlike the decider above.
 * Everything here comes from `markedDays`, and the streak and the percentage
 * are PURE FUNCTIONS of the array it returns — so there is no second failure
 * for a catch to isolate. If that read fails, the calendar is gone too and
 * there is nothing on this screen left to degrade to; that is exactly what
 * app/[user]/page.tsx's "This dashboard failed to load" is for. A try/catch
 * here would be theatre.
 */
function walkLogScreen({ slug, db, today }: { slug: string; db: DashboardProps['db']; today: string }) {
  const days = markedDays(db)
  const streak = currentStreak(days, today)
  const rate = walkRate(days, today)
  const last = days[days.length - 1]

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      {/*
        The two one-number panels pair up at desktop width and stack at phone
        width — one responsive implementation, the same panels either way. The
        calendar goes underneath because it is the tallest thing on the screen
        and the two numbers above it are what the screen is opened to see.
      */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Current streak
            </CardTitle>
          </CardHeader>
          <CardContent>
            {days.length === 0 ? (
              /*
                EMPTY, and this is the first thing he sees on the morning this
                ships — his own database, with nothing in it. It says what the
                panel is waiting for. It does NOT show a confident zero, and it
                does not count the days before this screen existed as missed:
                a day before he started is not a day he failed.
              */
              <div>
                <p className="text-2xl font-semibold">No walks logged yet</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Mark a day on the calendar below and the streak starts there.
                </p>
              </div>
            ) : streak.days === 0 ? (
              /*
                A real zero, and a different thing from the empty state above:
                he HAS logged walks, and the run has ended. Saying when the last
                one was is what stops "0" reading as though the log were lost.
              */
              <div>
                <p className="text-3xl font-semibold tabular-nums sm:text-4xl">0</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  No streak going. Your last marked day was{' '}
                  {plural(daysBetween(last!, today), 'day')} ago.
                </p>
              </div>
            ) : (
              <div>
                <p className="text-3xl font-semibold tabular-nums sm:text-4xl">
                  {plural(streak.days, 'day')}
                </p>
                {/*
                  THE DECIDED EDGE, said out loud rather than left to be
                  inferred. spec v2: a day with no mark yet must not break a
                  streak built through yesterday. So the number can be counting
                  up to yesterday, and a panel that did not say which would be
                  claiming a walk he has not logged.
                */}
                <p className="mt-2 text-sm text-muted-foreground">
                  {streak.throughYesterday
                    ? 'Through yesterday — today isn’t marked yet.'
                    : 'Including today.'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Days walked
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rate === null ? (
              /*
                spec v2 asks for this by name: "Should say there is nothing
                logged yet rather than show 0% on an empty log." An empty log
                has no denominator, and 0% would be a claim about days he never
                had the screen for.
              */
              <div>
                <p className="text-2xl font-semibold">Nothing logged yet</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Once you’ve marked a day, this shows how many of the last {WALK_RATE_DAYS}{' '}
                  days you walked.
                </p>
              </div>
            ) : (
              <div>
                <p className="text-3xl font-semibold tabular-nums sm:text-4xl">
                  {Math.round((rate.walked / rate.total) * 100)}%
                </p>
                {/*
                  THE COUNT UNDER THE PERCENTAGE, which spec v2 asks for
                  ("showing the underlying count alongside the percentage makes
                  it legible") — 3 of 5 days and 60 of 100 are the same
                  percentage and very different facts.

                  The two phrasings are the pre-existence rule showing through:
                  until the log is thirty days old the window is bounded by his
                  first mark, so the sentence says "since you started" rather
                  than claiming a rate over days he could not have logged. See
                  walkRate in ./queries.ts.
                */}
                <p className="mt-2 text-sm text-muted-foreground">
                  {rate.full
                    ? `${rate.walked} of the last ${rate.total} days.`
                    : `${rate.walked} of the ${plural(rate.total, 'day')} since you started.`}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Month calendar
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/*
            THE PANEL AND THE INPUT SURFACE AT ONCE — spec v2: "This is also the
            input surface — each square is tappable to mark or unmark that day."
            Every square is a lib/ui/WriteAction posting to the walk-log route,
            which is the only thing holding a writable handle. Nothing on screen
            moves until the server answers, and then the streak and the
            percentage above patch in together with the square: they all read
            the same table, so a square that filled before they updated would be
            three panels disagreeing about one fact.
          */}
          <MonthCalendar
            action={`/api/users/${slug}/walk-log`}
            today={today}
            marked={days}
            earliest={earliestMonth(days, today)}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Tap a day to mark it as walked. Tap it again to unmark it. One walk a day is all
            this records.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}

// ─── SPENDING, spec v3 ──────────────────────────────────────────────────────

/**
 * A dollar figure as this screen writes it.
 *
 * WHOLE DOLLARS on the pie and its legend, CENTS in the transaction list.
 * docs/dashboard-ui-ux-guidelines.md > Formatting draws exactly that line:
 * "Whole dollars in glance positions ($1,284, not $1,284.31); cents only in
 * transaction rows and anywhere the user is reconciling." The pie is the
 * glance; the list is where he reconciles a row against his own memory of it.
 */
function money(amount: number, { cents }: { cents: boolean }): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })
}

/**
 * A share as a percentage.
 *
 * One decimal place below 10%, none above. A slice worth 0.1% of the window
 * rendering as "0%" would read as a bug, and "14.3%" where "14%" will do is
 * precision nobody asked for.
 */
function percent(share: number): string {
  const pct = share * 100
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

/**
 * A transaction's date, in the friend's own terms.
 *
 * Relative within the week, absolute beyond it, no year — the day is already
 * inside a 30-day window, so a year would be noise
 * (docs/dashboard-ui-ux-guidelines.md > Formatting). Pure string and UTC
 * arithmetic over a day key Plaid stated and `today` the platform handed down:
 * NO CLOCK IS READ, which `tests/users/noLocalDay.test.ts` enforces over this
 * file.
 */
function dayLabel(day: string, today: string): string {
  const ago = daysBetween(day, today)
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  const parts = day.split('-').map(Number)
  const date = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!))
  if (ago > 1 && ago < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Join names the way a sentence does: "A", "A and B", "A, B and C".
 *
 * He has two accounts today, so a bare " and " read correctly right up until
 * the synthetic database showed three and produced "A and B and C". A friend
 * with a second card is one connection away from the same sentence.
 */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What one product's last refresh attempt should say, in the friend's words. */
function describeRefresh(refresh: PlaidRefresh): string | null {
  // THREE OUTCOMES, NOT TWO (docs/dashboard-build-rules.md §9.6). `not_ready`
  // means Plaid holds the connection and has not finished preparing that
  // product — routine on the first refresh after connecting. Reporting it as a
  // failure would put "couldn't reach your bank" on screen at the moment
  // everything is working.
  if (refresh.ok) return null
  if (refresh.code === 'not_ready') return 'your bank is still preparing this — try again shortly'
  if (refresh.code === 'item_login_required') return 'your bank needs you to log in again'
  return `couldn’t reach your bank (${refresh.code ?? 'error'})`
}

function spendingScreen({
  slug,
  db,
  today,
  now,
  timeZone,
}: {
  slug: string
  db: DashboardProps['db']
  today: string
  /** The render instant, handed down. This screen never reads a clock. */
  now: number
  timeZone: string | undefined
}) {
  const linkTokenAction = `/api/users/${slug}/plaid/link-token`
  const connectAction = `/api/users/${slug}/plaid/connect`
  const categoryAction = `/api/users/${slug}/spending-category`
  const returnTo = `/${slug}?screen=spending`

  // STATE 1 of the four a finance panel owes: NOT CONNECTED, decided by whether
  // an item exists and NEVER by whether transactions exist. A freshly connected
  // bank has a token and no rows for the seconds Plaid spends backfilling, and
  // inferring "not connected" from an empty table would tell him his connection
  // failed while it was working (docs/dashboard-build-rules.md §9.6).
  if (!isConnected(db)) {
    return (
      <section className="mx-auto w-full max-w-3xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Connect a card to see where it went</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="max-w-[42rem] text-sm text-muted-foreground">
              This screen groups the last 30 days from your credit card and your debit card
              into categories. Connect each one and it fills in — connecting runs on your own
              device, and your bank login never reaches this server.
            </p>
            <PlaidConnect
              linkTokenAction={linkTokenAction}
              connectAction={connectAction}
              returnTo={returnTo}
            />
          </CardContent>
        </Card>
      </section>
    )
  }

  // ONE READ FEEDS BOTH PANELS, so the pie and the list can never disagree
  // about where a dollar sits — which spec v3 asks for by name.
  const rows = spendingTransactions(db, today)
  // His ticked/unticked choices, and only those — every category he has never
  // pressed takes the default `categoryTotals` resolves from the amount.
  const totals = categoryTotals(rows, categoryVisibility(db))
  const custom = customCategories(db)
  const customSet = new Set(custom)
  const accounts = spendingAccounts(db)
  const refreshes = lastRefreshes(db)
  // Every bank he has, and what each is doing — the shared read behind the
  // shared surface (modules/plaid/sources.ts).
  const sources = readPlaidSources(db)
  const problems = refreshes
    .map((r) => ({ product: r.product, bank: r.bank, said: describeRefresh(r) }))
    .filter((r): r is { product: string; bank: string | null; said: string } => r.said !== null)

  // THE ARM-2 STATES CHECK, and it lives here rather than inside the chart:
  // degenerate data renders the panel's empty state as host elements and never
  // mounts Recharts at all (docs/dashboard-build-rules.md §3). `categoryTotals`
  // has already dropped anything netting to zero or less, so a surviving slice
  // is finite and positive by construction; what is left to check is whether
  // there is anything to draw.
  const { drawn, folded } = foldIntoOther(totals.slices)
  const drawable = drawn.length > 0 && totals.total > 0
  const pieSlices: PieSlice[] = drawn.map((slice, index) => ({
    label:
      slice.category === OTHER_CATEGORY
        ? OTHER_CATEGORY
        : categoryLabel(slice.category, customSet),
    amount: slice.amount,
    share: slice.share,
    color: sliceColor(index),
    amountLabel: money(slice.amount, { cents: false }),
    shareLabel: percent(slice.share),
  }))

  // Which colour each legend row wears, so a swatch can never disagree with the
  // wedge it stands for. A category folded into "Other" takes the neutral,
  // because that is genuinely the wedge it is part of; an unticked one gets no
  // swatch at all, because it has no wedge.
  const colorFor = new Map<string, string>()
  drawn.forEach((slice, index) => colorFor.set(slice.category, sliceColor(index)))
  for (const category of folded) colorFor.set(category, OTHER_COLOR)

  // Categories he has actually kept OUT of a denominator they would otherwise
  // be in. A category at zero or less is not in it either way — unticking one
  // changes no percentage — so counting those here would put a caveat on screen
  // explaining a difference that does not exist.
  const excluded = totals.rows.filter((row) => !row.included && row.amount > 0)

  // Every category a row may be moved into: his own buckets first, then every
  // category his bank has ever produced. Built once for the whole list rather
  // than per row — forty rows building the same array forty times is the same
  // answer computed forty times.
  const choices = [
    ...custom.map((name) => ({ value: name, label: name, custom: true })),
    ...bankCategories(db).map((name) => ({
      value: name,
      label: categoryLabel(name, customSet),
      custom: false,
    })),
  ]

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Your connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/*
            STATE 3: an outcome per product, including the failures. Without
            these rows a failed refresh is invisible and the figures above
            render as though they were current, which
            docs/dashboard-ui-ux-guidelines.md > States forbids by name.
          */}
          {refreshes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Never refreshed. What is above is whatever arrived when you connected.
            </p>
          ) : problems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Your bank answered last time this was refreshed.
            </p>
          ) : (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {problems.map((p) => (
                // The BANK is named. He has two cards by design, so "couldn't
                // reach your bank" without saying WHICH is a sentence he
                // cannot act on.
                <li key={`${p.bank ?? ''}-${p.product}`}>
                  {p.bank ? `${p.bank} — ` : ''}
                  {p.product}: {p.said}
                </li>
              ))}
            </ul>
          )}

          {/*
            THE SHARED BANK SURFACE, identical on every finance dashboard
            (2026-08-21 plan D4, swept by tests/users/plaidSurface.test.ts).

            This screen used to hand-wire a Refresh control and a conditional
            reconnect, and that was the whole of it: he could connect one card
            and then had no way to add his second, see which one had gone
            stale, change which accounts either shared, or remove one. Nothing
            was violated — §9.5 listed the controls as available parts and this
            build used the parts spec v3 asked for.

            THE ONLY TRIGGER THERE IS is still a control he presses. His data
            key exists only while he is unlocked, so nothing can pull on his
            behalf while he is away — there is no scheduled job and there
            cannot be one. The surface carries a last-updated time beside the
            button, which this screen's own version never did.
          */}
          <PlaidSources slug={slug} sources={sources} now={now} timeZone={timeZone} />
          <p className="text-xs text-muted-foreground">
            This updates when you press Refresh, and at no other time.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where it went</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {rows.length === 0 ? (
            /*
              STATE 2: connected, nothing arrived yet — or a genuinely quiet
              month. Either way NOT "$0.00", which is a confident false
              statement about someone's money (docs/dashboard-build-rules.md
              §9.6). It says what it is waiting for and leaves the Refresh
              control below reachable.
            */
            <p className="text-sm text-muted-foreground">
              Nothing has come through for the last 30 days yet. If you have just connected,
              give it a moment and press Refresh.
            </p>
          ) : !drawable ? (
            /*
              Rows exist and none of them nets to money going out — every
              category cancelled itself, which a month of refunds really can do.
              Host elements, no chart: there is no pie to draw and a chart
              mounted over nothing is the arm-2 failure.
            */
            <p className="text-sm text-muted-foreground">
              Nothing to draw: every category is either unticked or nets to nothing. The
              transactions are all still listed below.
            </p>
          ) : (
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
              <SpendingPie slices={pieSlices} title="Spending by category, last 30 days" />
              {/*
                THE LEGEND, and it is not decoration. Three of the palette's
                colours sit below 3:1 against this page, and the rule for that
                is "relief required — visible labels or a table view"; this is
                the table view. It is also what carries the amount and the
                percentage spec v3 asks each slice to show, and what keeps a
                slice from being identified by colour alone.
              */}
              <ul className="w-full min-w-0 space-y-2">
                {totals.rows.map((row) => {
                  const label = categoryLabel(row.category, customSet)
                  const color = colorFor.get(row.category)
                  return (
                    <li key={row.category} className="flex items-center gap-2 text-sm">
                      <CategoryToggle
                        action={categoryAction}
                        category={row.category}
                        label={label}
                        included={row.included}
                      />
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[2px] border"
                        style={
                          color === undefined
                            ? { borderColor: 'var(--border)' }
                            : { backgroundColor: color, borderColor: color }
                        }
                      />
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          row.included ? '' : 'text-muted-foreground'
                        }`}
                      >
                        {label}
                      </span>
                      <span
                        className={`shrink-0 tabular-nums ${
                          row.included ? 'font-medium' : 'text-muted-foreground'
                        }`}
                      >
                        {money(row.amount, { cents: false })}
                      </span>
                      {/*
                        A percentage ONLY for what is in the pie. An unticked
                        category is not in the denominator, so printing a share
                        for it would be a number of nothing.
                      */}
                      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                        {row.drawable ? percent(row.share) : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/*
            THE FOLD ADMITS WHAT IT SWALLOWED. A grey "Other" wedge with no
            explanation is silent truncation; naming the count is what makes it
            a reading of the data rather than a limit of the chart. Each folded
            category still has its own legend row and its own tick box above,
            so it is combined in the chart and never out of reach.
          */}
          {folded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              “Other” is the {folded.length} smallest categories combined.
            </p>
          )}

          {/*
            THE DENOMINATOR IS NOW HIS, so the percentages have to say so. Only
            shown once something is actually unticked — before that it is a
            sentence about a control he has not used.
          */}
          {excluded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Percentages are of the ticked categories only. Unticked ones stay in the list
              below.
            </p>
          )}

          {/*
            WHICH ACCOUNTS THIS IS. The scope is an allow-list in 004 — every
            credit account plus every checking account — so a bank reporting a
            debit account under a different subtype would drop out of the
            picture. Naming the accounts is what makes that visible rather than
            silent, and it is also the honest answer to "is this all of it".
          */}
          <p className="text-xs text-muted-foreground">
            {accounts.length === 0
              ? 'No card or checking account is feeding this yet.'
              : `Counting ${listSentence(
                  accounts.map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`),
                )}.`}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The last 30 days. Move anything into a different category and the pie above
            follows it — the change sticks through future refreshes.
          </p>

          <NewCategoryControl action={categoryAction} maxLength={CATEGORY_NAME_MAX} />

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to show for the last 30 days.</p>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => {
                const description = row.merchant ?? row.description ?? 'Unknown'
                return (
                  <li
                    key={row.transactionId}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {description}
                        {/*
                          A pending charge can still change amount or vanish.
                          Saying so is the difference between a number and a
                          claim — and it is still counted, because the money has
                          left as far as he is concerned.
                        */}
                        {row.pending ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">pending</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {dayLabel(row.day, today)} · {row.accountName}
                        {row.accountMask ? ` ••${row.accountMask}` : ''}
                        {/*
                          A row he has moved says so. Without it, a category
                          that disagrees with his bank's own app looks like the
                          dashboard got it wrong rather than like something he
                          did on purpose weeks ago.
                        */}
                        {row.overrideCategory !== null ? ' · moved by you' : ''}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 tabular-nums text-sm ${
                        row.amount < 0 ? 'text-green-700' : ''
                      }`}
                    >
                      {/*
                        A sign, never parentheses (guidelines > Formatting), and
                        a negative is money coming back — green, because for
                        spending that is the good direction.
                      */}
                      {row.amount < 0 ? '+' : ''}
                      {money(Math.abs(row.amount), { cents: true })}
                    </span>
                    <RefileControl
                      action={categoryAction}
                      transactionId={row.transactionId}
                      current={row.category}
                      choices={choices}
                      labelFor={categoryLabel(row.category, customSet)}
                      describedBy={description}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

    </section>
  )
}

export default function Run11Dashboard({ slug, db, today, now, timeZone, screen }: DashboardProps) {
  // `screen` has already been resolved against this module's own `screens`
  // export by `activeScreen` in app/[user]/page.tsx, so it is either one of
  // the three ids above or undefined — never an arbitrary `?screen=` value. The
  // fallback is the decider, which is also what `activeScreen` returns for
  // anything it does not recognise: `walk_the_dog` is order 1 and the landing
  // screen, which spec v2 states directly and spec v3 leaves alone.
  if (screen === 'walk_log') return walkLogScreen({ slug, db, today })
  if (screen === 'spending') return spendingScreen({ slug, db, today, now, timeZone })
  return deciderScreen({ slug, db, today })
}
