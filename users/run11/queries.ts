// users/run11/queries.ts
//
// Every SQL statement for run11's dashboard, and every rule that turns a
// forecast into an answer. The component holds none of it: spec v1 asks two
// questions ("is now good", "when is the next good stretch") whose whole
// substance is arithmetic over windows and thresholds, and data logic in a
// .tsx file can only be tested by rendering it.
//
// ─── NOTHING HERE READS A CLOCK, AND NOTHING HERE KNOWS A TIMEZONE ──────────
//
// Both would be defects, and the second is unusual enough to say out loud.
// Every row this file reads was written with the friend's local day and local
// minute-of-day already resolved (001_initial.sql, and the route that fills
// it), so every question below is integer arithmetic on minutes since
// midnight. This file therefore does not import lib/time/dayKey at all — not
// because it may not (a queries.ts may, over a stored instant), but because
// there is nothing left for it to convert. The genuinely hard direction —
// wall-clock to instant — happens nowhere in this dashboard.
//
// The REFERENCE MINUTE that "right now" is measured from is a PARAMETER, and
// dashboard.tsx supplies it from the last successful refresh. See its header
// for why that is the honest answer today and what would improve it.
//
// ─── THE THRESHOLDS ARE THE POINT OF THIS FILE ─────────────────────────────
//
// spec v1 is explicit that they are "a starting point Nico picked from my
// suggestion, not a firm preference — build them so they can be adjusted later
// once he sees how the dog actually handles it". They are therefore one
// exported object, named in one place, with nothing derived from them inlined
// anywhere else.
import type { UserDb } from '@/lib/db/userDb'

/**
 * The walk spec v1 describes: 0.7 miles out and 0.7 miles back, about forty
 * minutes. Every window in this file is this long, and every check asks about
 * the whole of it rather than about the instant it starts.
 */
export const WALK_MINUTES = 40

/**
 * The three checks' cutoffs, all tunable, all in one place.
 *
 * HEAT is on apparent temperature (feels-like / heat index), never raw
 * temperature — Houston humidity is the entire reason this dashboard exists.
 *
 * RAIN IS TWO NUMBERS, not one, and that is a reading of "any precipitation
 * expected during the walk is a no" rather than an embellishment of it. A
 * forecast expresses expectation two ways, and each misses what the other
 * catches: 0.0 mm at 60% is a forecast that says it might rain, and 0.3 mm at
 * 20% is one that says it will drizzle. Either alone would let one of those
 * through as "clear".
 */
export const THRESHOLDS = {
  /** At or above this feels-like, the answer is no. */
  heatNoGoF: 90,
  /** At or above this (but below heatNoGoF): go, but keep it short and shady. */
  heatShortF: 85,
  /** Millimetres in an hour that count as rain. */
  precipMm: 0.1,
  /** Percent chance of any precipitation that counts as rain. */
  precipChancePct: 30,
}

/**
 * How finely "Next good window" scans for a start time.
 *
 * Ten minutes because that is the precision spec v1 itself writes the answer
 * in ("from 7:10pm, good until dark"), and because a minute-by-minute scan
 * would advertise a precision an hourly forecast does not have.
 */
export const WINDOW_STEP_MINUTES = 10

const MINUTES_PER_DAY = 1440
const MINUTES_PER_HOUR = 60

export type ForecastHour = {
  at: number
  day: string
  minuteOfDay: number
  precipMm: number
  precipChance: number
  feelsLikeF: number
}

export type SunDay = {
  day: string
  sunriseMinute: number
  sunsetMinute: number
}

export type FetchAttempt = {
  at: number
  day: string
  minuteOfDay: number
  ok: boolean
}

/** Which of the three checks said no. Never a sentence — the panel writes those. */
export type Blocker = 'rain' | 'heat' | 'dark'

export type Verdict = 'go' | 'short' | 'no'

/**
 * The reading for one candidate 40-minute walk.
 *
 * `peakFeelsLikeF` is the WORST feels-like across the whole walk, not the one
 * at the start: a walk that begins at 88°F and ends at 93°F is a walk that got
 * too hot, and the dog was out for all of it.
 */
export type WalkReading = {
  startMinute: number
  endMinute: number
  verdict: Verdict
  blockers: Blocker[]
  peakFeelsLikeF: number
  /** The highest chance of rain over the walk, for the panel's reason line. */
  peakPrecipChance: number
}

export type RightNow =
  /** No successful refresh has ever landed, so there is nothing to read. */
  | { state: 'no_forecast' }
  /** A forecast exists but does not cover the next 40 minutes. */
  | { state: 'uncovered' }
  | { state: 'ok'; reading: WalkReading }

export type GoodWindow = {
  day: string
  /** Earliest start time that clears all three checks. */
  startMinute: number
  /** Latest start time still inside the same unbroken stretch. */
  lastStartMinute: number
  /**
   * WHY THE WINDOW ENDS: the reading for the first start time that fails,
   * one scan step past `lastStartMinute`.
   *
   * Carried as the whole reading rather than a flag, so the panel can say what
   * actually closes it AND how hard — "after that it's up to 96°F" rather than
   * a bare time the friend has to take on trust. Nico's review of v1 (2026-08-20):
   * a window can legitimately be twenty minutes wide in a Houston August, and
   * "good until 7:20 AM" with no reason reads as a glitch rather than as a
   * forecast. It replaced an `endsAtDark` boolean, which could only ever
   * explain one of the three ways a window closes.
   *
   * `null` means the forecast simply ran out — a real state, and a different
   * sentence from any of the three checks failing.
   */
  closedBy: WalkReading | null
  /** True when this window is on a later day than the one asked about. */
  isTomorrow: boolean
}

// ─── SQL ───────────────────────────────────────────────────────────────────

/**
 * The newest refresh attempt of any kind, successful or not.
 *
 * Read SEPARATELY from the newest successful one, and the pair is what makes
 * the panel's error state honest: when the newest attempt failed and an older
 * one succeeded, the dashboard has data AND knows it is not current.
 * docs/dashboard-ui-ux-guidelines.md > States forbids rendering the one
 * without saying the other.
 */
export function latestFetch(db: UserDb): FetchAttempt | null {
  return readFetch(db, 'SELECT at, day, minute_of_day, ok FROM forecast_fetches ORDER BY at DESC, id DESC LIMIT 1')
}

/** The newest attempt that actually returned a forecast. */
export function latestSuccessfulFetch(db: UserDb): FetchAttempt | null {
  return readFetch(
    db,
    'SELECT at, day, minute_of_day, ok FROM forecast_fetches WHERE ok = 1 ORDER BY at DESC, id DESC LIMIT 1',
  )
}

function readFetch(db: UserDb, sql: string): FetchAttempt | null {
  const row = db.prepare(sql).get() as
    | { at: number; day: string; minute_of_day: number; ok: number }
    | undefined
  if (!row) return null
  return { at: row.at, day: row.day, minuteOfDay: row.minute_of_day, ok: row.ok === 1 }
}

/** Every stored hour for one local day, earliest first. */
export function hoursOn(db: UserDb, day: string): ForecastHour[] {
  const rows = db
    .prepare(
      `SELECT at, day, minute_of_day, precip_mm, precip_chance, feels_like_f
         FROM forecast_hours
        WHERE day = ?
        ORDER BY minute_of_day`,
    )
    .all(day) as {
    at: number
    day: string
    minute_of_day: number
    precip_mm: number
    precip_chance: number
    feels_like_f: number
  }[]
  return rows.map((r) => ({
    at: r.at,
    day: r.day,
    minuteOfDay: r.minute_of_day,
    precipMm: r.precip_mm,
    precipChance: r.precip_chance,
    feelsLikeF: r.feels_like_f,
  }))
}

/** Sunrise and sunset for one local day, or null if the forecast has neither. */
export function sunOn(db: UserDb, day: string): SunDay | null {
  const row = db
    .prepare('SELECT day, sunrise_minute, sunset_minute FROM forecast_days WHERE day = ?')
    .get(day) as { day: string; sunrise_minute: number; sunset_minute: number } | undefined
  if (!row) return null
  return { day: row.day, sunriseMinute: row.sunrise_minute, sunsetMinute: row.sunset_minute }
}

// ─── CALENDAR ARITHMETIC, WITHOUT A CLOCK AND WITHOUT A ZONE ───────────────

/**
 * The day `delta` days after `day`, both 'YYYY-MM-DD'.
 *
 * Constructed and formatted entirely in UTC, which makes it pure calendar
 * arithmetic that is correct whatever zone the friend is in — the same shape
 * users/devtwo/queries.ts uses, and for the same reason. It never reads a
 * clock: `Date.UTC` takes the components it is given.
 */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(year!, month! - 1, date! + delta))
  return shifted.toISOString().slice(0, 10)
}

// ─── THE THREE CHECKS ──────────────────────────────────────────────────────

/** Whether a forecast hour counts as rain under either half of the rule. */
export function isRainy(hour: ForecastHour): boolean {
  return (
    hour.precipMm >= THRESHOLDS.precipMm || hour.precipChance >= THRESHOLDS.precipChancePct
  )
}

/**
 * A timeline of hours in "minutes since midnight of `day`" coordinates,
 * covering `day` and the day after it.
 *
 * The second day is not padding. A walk starting at 23:50 runs into tomorrow,
 * and an hour lookup that stopped at midnight would silently report a walk as
 * clear because it could not see the half of it that was not.
 */
export function timeline(db: UserDb, day: string): { minute: number; hour: ForecastHour }[] {
  const today = hoursOn(db, day).map((hour) => ({ minute: hour.minuteOfDay, hour }))
  const next = hoursOn(db, shiftDay(day, 1)).map((hour) => ({
    minute: hour.minuteOfDay + MINUTES_PER_DAY,
    hour,
  }))
  return [...today, ...next]
}

/**
 * The forecast hours a walk over [start, end) actually overlaps.
 *
 * An hour row describes [minute, minute + 60). A walk touching even one minute
 * of an hour is a walk exposed to that hour — there is no partial credit for a
 * dog that was outside when it started raining.
 */
export function hoursTouched(
  entries: { minute: number; hour: ForecastHour }[],
  startMinute: number,
  endMinute: number,
): ForecastHour[] {
  return entries
    .filter((e) => e.minute < endMinute && e.minute + MINUTES_PER_HOUR > startMinute)
    .map((e) => e.hour)
}

/**
 * Read one candidate walk against all three checks.
 *
 * Returns null when the forecast does not cover the whole walk — deliberately
 * NOT a cheerful verdict computed from the hours that happen to exist. A
 * missing hour is missing information, and the panel's job then is to say so.
 *
 * BLOCKERS ARE COLLECTED, NOT SHORT-CIRCUITED. When it is both raining and
 * about to be dark, naming only the first check to fail would make the panel
 * look wrong to anyone who glanced out of a window, and would make the answer
 * depend on the order these are written in.
 */
export function readWalk(
  entries: { minute: number; hour: ForecastHour }[],
  sun: SunDay | null,
  startMinute: number,
): WalkReading | null {
  const endMinute = startMinute + WALK_MINUTES
  const touched = hoursTouched(entries, startMinute, endMinute)
  // Every hour the walk spans must be present, not merely some of them: a
  // 40-minute walk touches one hour or two, and a gap is exactly the case
  // where a peak could hide.
  const expected = Math.floor(endMinute / MINUTES_PER_HOUR) - Math.floor(startMinute / MINUTES_PER_HOUR) + 1
  const spans = endMinute % MINUTES_PER_HOUR === 0 ? expected - 1 : expected
  if (touched.length < spans) return null

  const peakFeelsLikeF = Math.max(...touched.map((h) => h.feelsLikeF))
  const peakPrecipChance = Math.max(...touched.map((h) => h.precipChance))

  const blockers: Blocker[] = []
  if (touched.some(isRainy)) blockers.push('rain')
  if (peakFeelsLikeF >= THRESHOLDS.heatNoGoF) blockers.push('heat')
  // DAYLIGHT IS BOTH ENDS, and only the sunset half is written in spec v1.
  //
  // The spec states the rule as "the walk must finish before sunset". Applied
  // alone it would call 4am a fine time to walk the dog, and would answer "the
  // first window tomorrow morning" with midnight. The friend's own words are
  // "if it will be dark before we finish" — pre-dawn is dark, so the check is
  // that the WHOLE walk sits between sunrise and sunset. Recorded as an
  // in-spirit adjustment in users/run11/notes.
  //
  // No sun row at all is treated as dark rather than as fine: an unknown
  // sunset is not a licence to send someone out at dusk.
  if (sun === null || startMinute < sun.sunriseMinute || endMinute > sun.sunsetMinute) {
    blockers.push('dark')
  }

  const verdict: Verdict =
    blockers.length > 0 ? 'no' : peakFeelsLikeF >= THRESHOLDS.heatShortF ? 'short' : 'go'

  return { startMinute, endMinute, verdict, blockers, peakFeelsLikeF, peakPrecipChance }
}

/**
 * "Right now" — the top panel.
 *
 * `nowMinute` is minutes since midnight of `day`, and it is a PARAMETER for
 * the reason every other query in this repo takes its day as one: a function
 * that read the clock would be reading the droplet's, and would be untestable
 * at every hour but the one the suite happens to run at.
 */
export function rightNow(db: UserDb, day: string, nowMinute: number): RightNow {
  const entries = timeline(db, day)
  if (entries.length === 0) return { state: 'no_forecast' }
  const reading = readWalk(entries, sunOn(db, day), nowMinute)
  return reading === null ? { state: 'uncovered' } : { state: 'ok', reading }
}

/**
 * "Next good window" — the panel below.
 *
 * Clears all three checks at the NO-GO cutoff (90°F), not at the "short one,
 * shade" one: spec v1 says a window is "no rain, heat index below 90°F, and
 * finishing before sunset", so the middle verdict still counts as a window
 * worth naming. That is deliberate and is why this does not simply reuse
 * `verdict === 'go'`.
 *
 * Scans today from `nowMinute`, then tomorrow from its own sunrise. Returns
 * null when neither day offers one — which the panel says plainly rather than
 * rendering an empty card.
 */
export function nextGoodWindow(db: UserDb, day: string, nowMinute: number): GoodWindow | null {
  const today = scanDay(db, day, nowMinute)
  if (today) return { ...today, isTomorrow: false }

  const tomorrow = shiftDay(day, 1)
  // From the very start of tomorrow: `readWalk`'s daylight check moves the
  // real floor to sunrise, so there is no second place that needs to know
  // when the day begins.
  const found = scanDay(db, tomorrow, 0)
  return found ? { ...found, isTomorrow: true } : null
}

function scanDay(
  db: UserDb,
  day: string,
  fromMinute: number,
): Omit<GoodWindow, 'isTomorrow'> | null {
  const entries = timeline(db, day)
  if (entries.length === 0) return null
  const sun = sunOn(db, day)
  if (sun === null) return null

  // The last start that still finishes before sunset. Everything past it fails
  // the daylight check anyway, so the scan stops rather than walking the rest
  // of the day to be told so 40 times.
  const lastPossible = sun.sunsetMinute - WALK_MINUTES
  const walkable = (minute: number) => {
    const reading = readWalk(entries, sun, minute)
    // 'short' still counts — see this function's docstring.
    return reading !== null && !reading.blockers.includes('rain') && !reading.blockers.includes('heat') && !reading.blockers.includes('dark')
  }

  const first = ceilToStep(Math.max(fromMinute, sun.sunriseMinute))
  let start: number | null = null
  for (let minute = first; minute <= lastPossible; minute += WINDOW_STEP_MINUTES) {
    if (walkable(minute)) {
      start = minute
      break
    }
  }
  if (start === null) return null

  let last = start
  for (
    let minute = start + WINDOW_STEP_MINUTES;
    minute <= lastPossible && walkable(minute);
    minute += WINDOW_STEP_MINUTES
  ) {
    last = minute
  }

  // WHAT CLOSES IT. The loop stopped either because the next start fails a
  // check or because it runs past sunset, and `readWalk` reports both the same
  // way — a start whose walk ends after sunset carries the 'dark' blocker. So
  // there is one question to ask, not two, and the answer arrives with the
  // temperature or the rain chance already attached.
  const closedBy = readWalk(entries, sun, last + WINDOW_STEP_MINUTES)

  return { day, startMinute: start, lastStartMinute: last, closedBy }
}

/** Round up to the next scan step. A window that starts at 18:03 is offered at 18:10. */
export function ceilToStep(minute: number): number {
  return Math.ceil(minute / WINDOW_STEP_MINUTES) * WINDOW_STEP_MINUTES
}
