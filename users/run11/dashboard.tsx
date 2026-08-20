// users/run11/dashboard.tsx
//
// run11's dashboard — spec v1, users/run11/spec.md. One screen, two panels, in
// the order the spec fixes them: the verdict on top and large, the next good
// window directly below it.
//
// NO SQL HERE. Every statement, and every threshold behind the verdict, lives
// in ./queries.ts.
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
// presentational components (shadcn's Card) are trusted; data-computing ones
// (Recharts) are sanctioned behind a states check — there are none here, this
// dashboard draws no chart; interaction controls (lib/ui/WriteAction.tsx) are
// sanctioned and are the default for every write. The accepted residual for
// all three is a throw on well-formed props landing outside
// app/[user]/page.tsx's try/catch.
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { WriteAction } from '@/lib/ui/WriteAction'
import {
  WALK_MINUTES,
  ceilToStep,
  latestFetch,
  latestSuccessfulFetch,
  nextGoodWindow,
  rightNow,
} from './queries'
import type { GoodWindow, RightNow, WalkReading } from './queries'

// ONE screen, so the platform draws no tab strip — a single tab is chrome that
// explains nothing. The title is what the spec calls it ("Add screen — Walk
// the dog?"); the id and order are the builder's, since a change-only spec
// carries no ids, and they are written down in users/run11/current.md's
// `## Screens`.
export const screens: DashboardScreen[] = [
  { id: 'walk_the_dog', title: 'Walk the dog?', order: 1 },
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

export default function Run11Dashboard({ slug, db, today }: DashboardProps) {
  // THE TWO READS EVERYTHING ELSE DEPENDS ON, and deliberately outside any
  // catch of this file's own: if the fetch log cannot be read there is no
  // reference instant, so there is no honest thing to render in either panel
  // and app/[user]/page.tsx's "This dashboard failed to load" is the right
  // answer. Both are single-row reads against a tiny table.
  const newest = latestFetch(db)
  const reference = latestSuccessfulFetch(db)

  // The refresh control, rendered in every state including the empty one — it
  // is the only way any of this gets data, so a state that hid it would be a
  // dead end. lib/ui/WriteAction.tsx patches both panels in place when the
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
    reference === null || staleDay ? { state: 'no_forecast' } : rightNow(db, today, nowMinute)

  // THE SECOND PANEL READS BEHIND ITS OWN CATCH. Both panels read the same
  // three tables through the same handle, so per-panel isolation is mostly
  // theatre — except across this line. The verdict IS the product; a failure
  // scanning the rest of the day must not take away the answer to "can I go
  // right now", which is what letting this throw would do.
  let window: GoodWindow | null = null
  let windowFailed = false
  if (reference !== null && !staleDay) {
    try {
      window = nextGoodWindow(db, today, nowMinute)
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
    </section>
  )
}
