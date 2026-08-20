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
//
// SPEC v2 CASHED THAT IN for the heat cutoff, and only for the heat cutoff.
// The no-go feels-like is now the friend's own stored number, so it is a
// PARAMETER on every function that judges a walk rather than a constant this
// file owns — `heatNoGoF(db)` reads it, and everything downstream is handed
// the number rather than reaching for it. Rain stays a constant here: he was
// asked whether he wanted to set both bands and said "Just the hard no
// number", and nothing has ever been said about rain.
//
// ─── AND SPEC v2 ADDED A SECOND SUBJECT ────────────────────────────────────
//
// Everything above the "WALK LOG" divider below is about a FORECAST — public
// data about a place, written by a refresh, read to answer one question.
// Everything below it is about what the friend TYPED IN. The two share this
// file and nothing else: the walk log reads no forecast row, the decider reads
// no walk, and spec v2 is explicit that the log "reads nothing from the
// forecast and shares no data with the decider". Do not join them.
import type { UserDb } from '@/lib/db/userDb'

/**
 * The walk spec v1 describes: 0.7 miles out and 0.7 miles back, about forty
 * minutes. Every window in this file is this long, and every check asks about
 * the whole of it rather than about the instant it starts.
 */
export const WALK_MINUTES = 40

/**
 * The RAIN cutoffs. Not the friend's to set — see the heat block below.
 *
 * RAIN IS TWO NUMBERS, not one, and that is a reading of "any precipitation
 * expected during the walk is a no" rather than an embellishment of it. A
 * forecast expresses expectation two ways, and each misses what the other
 * catches: 0.0 mm at 60% is a forecast that says it might rain, and 0.3 mm at
 * 20% is one that says it will drizzle. Either alone would let one of those
 * through as "clear".
 *
 * The heat cutoffs used to live here too, as `heatNoGoF: 90` and
 * `heatShortF: 85`. Spec v2 moved them out: they are per-friend now, and
 * leaving a stale 90 in this object would leave a second answer to "what is
 * the no-go temperature" sitting one import away from the real one.
 */
export const THRESHOLDS = {
  /** Millimetres in an hour that count as rain. */
  precipMm: 0.1,
  /** Percent chance of any precipitation that counts as rain. */
  precipChancePct: 30,
}

// ─── THE HEAT BAND, WHICH IS THE FRIEND'S ──────────────────────────────────
//
// spec v2: he sets ONE number, the hard no. The "short one, shade" band is
// always the five degrees directly below whatever he picks, so setting 92
// gives a shade band of 87–92. It is DERIVED and never stored — two stored
// numbers can disagree with each other, and one cannot.

/**
 * What the band is before he has ever set it.
 *
 * 90°F, which is exactly what v1 hardcoded, because spec v2 requires that "if
 * nothing has been set yet it defaults to the current 90°F so the screen
 * behaves exactly as it does today on first load". It is a constant HERE and
 * not a row written by 002: a migration never seeds rows, and a seeded default
 * would also make "he has never touched this" indistinguishable from "he set
 * it back to 90".
 */
export const DEFAULT_HEAT_NO_GO_F = 90

/** How far below the no-go number the "short one, shade" band reaches. */
export const HEAT_SHADE_BAND_F = 5

/**
 * How far the control will go in either direction.
 *
 * A guardrail on a stepper, not a product opinion he expressed — so it is
 * deliberately wide enough that he is unlikely to meet it, and it lives here
 * rather than as a CHECK in 002 (see that file: an applied migration cannot be
 * edited, and this bound is a judgement rather than a fact about the shape).
 *
 * Below 80°F almost nothing in a Houston summer clears the check and the
 * dashboard answers "don't go" every time it is opened; above 105°F almost
 * nothing fails it and the dashboard stops being an answer at all. Both ends
 * are a screen that has quietly stopped working, which is worse than a button
 * that will not go further.
 */
export const HEAT_NO_GO_MIN_F = 80
export const HEAT_NO_GO_MAX_F = 105

/** One press, one degree. See the panel in dashboard.tsx for why. */
export const HEAT_NO_GO_STEP_F = 1

/** The bottom of the "short one, shade" band, given the no-go number. */
export function shadeFloorF(noGoF: number): number {
  return noGoF - HEAT_SHADE_BAND_F
}

/** Hold a number inside the range the control can reach. */
export function clampNoGoF(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HEAT_NO_GO_F
  return Math.min(HEAT_NO_GO_MAX_F, Math.max(HEAT_NO_GO_MIN_F, Math.round(value)))
}

/**
 * The friend's no-go feels-like, or the default if he has never set one.
 *
 * CLAMPED ON READ as well as on write. The column carries no CHECK, so a row
 * outside the range is representable; rendering it would give him a screen
 * whose − and + buttons cannot bring the number back into a range they can
 * reach. Clamping here means the panel always shows a number its own controls
 * can move.
 */
export function heatNoGoF(db: UserDb): number {
  const row = db.prepare('SELECT heat_no_go_f FROM walk_settings WHERE id = 1').get() as
    | { heat_no_go_f: number }
    | undefined
  return row === undefined ? DEFAULT_HEAT_NO_GO_F : clampNoGoF(row.heat_no_go_f)
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
  /**
   * The friend's no-go feels-like. A PARAMETER as of spec v2, not a constant
   * read from this module: every caller already has to read it once per render
   * (`heatNoGoF(db)`), and a default value here would mean a call site that
   * forgot to pass it silently judged the walk against 90°F while the panel
   * above it said 95. Required, so the compiler catches that instead.
   */
  noGoF: number,
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
  if (peakFeelsLikeF >= noGoF) blockers.push('heat')
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

  // The shade band is the five degrees below his number, derived rather than
  // stored — so it moves with the number he set, in one place, for both panels.
  const verdict: Verdict =
    blockers.length > 0 ? 'no' : peakFeelsLikeF >= shadeFloorF(noGoF) ? 'short' : 'go'

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
export function rightNow(
  db: UserDb,
  day: string,
  nowMinute: number,
  noGoF: number,
): RightNow {
  const entries = timeline(db, day)
  if (entries.length === 0) return { state: 'no_forecast' }
  const reading = readWalk(entries, sunOn(db, day), nowMinute, noGoF)
  return reading === null ? { state: 'uncovered' } : { state: 'ok', reading }
}

/**
 * "Next good window" — the panel below.
 *
 * Clears all three checks at the NO-GO cutoff, not at the "short one, shade"
 * one: spec v1 says a window is "no rain, heat index below 90°F, and finishing
 * before sunset", so the middle verdict still counts as a window worth naming.
 * That is deliberate and is why this does not simply reuse `verdict === 'go'`.
 *
 * SPEC v2 KEEPS THAT EXACTLY AS IT WAS — "The Next good window panel keeps
 * using only the no-go number and not the shade band, as it does now" — so the
 * only thing that changed is that the cutoff is now his rather than 90.
 *
 * Scans today from `nowMinute`, then tomorrow from its own sunrise. Returns
 * null when neither day offers one — which the panel says plainly rather than
 * rendering an empty card.
 */
export function nextGoodWindow(
  db: UserDb,
  day: string,
  nowMinute: number,
  noGoF: number,
): GoodWindow | null {
  const today = scanDay(db, day, nowMinute, noGoF)
  if (today) return { ...today, isTomorrow: false }

  const tomorrow = shiftDay(day, 1)
  // From the very start of tomorrow: `readWalk`'s daylight check moves the
  // real floor to sunrise, so there is no second place that needs to know
  // when the day begins.
  const found = scanDay(db, tomorrow, 0, noGoF)
  return found ? { ...found, isTomorrow: true } : null
}

function scanDay(
  db: UserDb,
  day: string,
  fromMinute: number,
  noGoF: number,
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
    const reading = readWalk(entries, sun, minute, noGoF)
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
  const closedBy = readWalk(entries, sun, last + WINDOW_STEP_MINUTES, noGoF)

  return { day, startMinute: start, lastStartMinute: last, closedBy }
}

/** Round up to the next scan step. A window that starts at 18:03 is offered at 18:10. */
export function ceilToStep(minute: number): number {
  return Math.ceil(minute / WINDOW_STEP_MINUTES) * WINDOW_STEP_MINUTES
}

// ═══ WALK LOG ══════════════════════════════════════════════════════════════
//
// Spec v2's second screen, and a different subject entirely from everything
// above. Every row here was typed in by the friend; nothing here reads a
// forecast, and nothing above reads a walk. The two halves of this file share
// a database handle and a calendar and nothing else.
//
// THE DAY IS ALWAYS A PARAMETER, exactly as it is above. `today` is handed to
// the dashboard by the platform and threaded down; this file never asks what
// day it is, and the marks it reads were filed under the friend's own day by
// the write route from the same `stairwell_tz` cookie.

/**
 * The window "Percentage of days walked" reports over.
 *
 * Thirty days, which is the reading spec v2 itself calls "closest to what was
 * discussed" and the one that matches the "18 of the last 30 days" framing in
 * the conversation that prompted the panel. The spec leaves it as an open
 * question against "percentage of the month currently shown"; that reading was
 * not taken, because it would make the number change when he pages the
 * calendar back to look at July, which is a different question from the one
 * the panel is asking.
 */
export const WALK_RATE_DAYS = 30

/** How far back the calendar will page. See `earliestMonth`. */
export const CALENDAR_HISTORY_MONTHS = 12

export type WalkStreak = {
  /** Consecutive marked days ending today, or ending yesterday — see below. */
  days: number
  /**
   * True when the run ends at YESTERDAY because today is not marked yet.
   *
   * Carried rather than hidden, because the panel has to say it. A streak that
   * silently includes today would be claiming a walk he has not logged, and
   * one that dropped to zero at midnight would be punishing him for a day that
   * is not over.
   */
  throughYesterday: boolean
}

export type WalkRate = {
  /** Marked days inside the window. */
  walked: number
  /** Days in the window. Never zero when this is non-null. */
  total: number
  /** First day of the window, 'YYYY-MM-DD'. */
  from: string
  /**
   * Whether the window is the full WALK_RATE_DAYS.
   *
   * False while the log is younger than the window — see `walkRate` for why
   * that case is not simply thirty days with zeroes in front of it.
   */
  full: boolean
}

/**
 * Every day the friend has marked, ascending.
 *
 * ONE READ FEEDING ALL THREE PANELS, deliberately. The streak needs a run
 * backwards from today, the percentage needs a window, and the calendar needs
 * whichever month is on screen plus every month it can page to — three
 * different slices of one small table, and a query per panel would be three
 * reads returning overlapping rows and a third answer to "what counts as
 * marked".
 *
 * Unbounded, and it can be: the table holds at most one row per day the friend
 * has ever walked, so a decade of perfect attendance is under four thousand
 * short strings. A LIMIT here would silently truncate a long streak.
 */
export function markedDays(db: UserDb): string[] {
  const rows = db.prepare('SELECT day FROM walk_log ORDER BY day').all() as { day: string }[]
  return rows.map((r) => r.day)
}

/**
 * The current streak, and what it ends on.
 *
 * THE DECIDED EDGE, and it is the one spec v2 asks to have decided: "a day with
 * no mark yet should not break a streak built up through yesterday — show the
 * streak as it stands through yesterday rather than dropping it to zero the
 * moment the day rolls over."
 *
 * So the run starts at today if today is marked, and at YESTERDAY otherwise.
 * A friend who walked for nine days and has not yet sat down at his desk to
 * mark today sees nine, not zero. If yesterday is not marked either, the run
 * is genuinely over and the answer is zero.
 *
 * Days after `today` are ignored rather than counted. None can exist — the
 * write route refuses a future day — but a friend who flies west far enough to
 * move his own calendar backwards would have one, and a run that started in
 * the future would be a number he cannot explain.
 */
export function currentStreak(days: string[], today: string): WalkStreak {
  const marked = new Set(days)
  const startsToday = marked.has(today)
  let cursor = startsToday ? today : shiftDay(today, -1)
  let run = 0
  while (marked.has(cursor)) {
    run += 1
    cursor = shiftDay(cursor, -1)
  }
  return { days: run, throughYesterday: !startsToday && run > 0 }
}

/**
 * The share of days walked, over the last WALK_RATE_DAYS — bounded below by
 * the first day he ever marked.
 *
 * `null` means nothing has ever been logged, which the panel says in words
 * rather than as 0%: an empty log is not a month of failures, and there is no
 * denominator to divide by anyway.
 *
 * ─── WHY THE WINDOW IS BOUNDED BY THE FIRST MARK ───────────────────────────
 *
 * A friend whose first mark was yesterday has not walked on 1 of 30 days; he
 * has walked on 1 of the 1 day he has had this screen. Counting the twenty-nine
 * days before he could possibly have logged anything is exactly the failure
 * docs/dashboard-ui-ux-guidelines.md > States calls "Pre-existence days", and
 * it is the one this project has already shipped once — devtwo's dashboard
 * rendered fourteen "missed" rows on a friend's first morning, with every test
 * green (docs/dashboard-build-rules.md §6).
 *
 * So the window starts at the later of (today − 29) and his first mark, and
 * `full` says which of the two it was. Once the log is older than the window
 * this is a no-op and the panel reads "18 of the last 30 days", exactly the
 * framing that prompted it.
 *
 * The first mark is the only signal available for "when this started" — there
 * is no created-at anywhere — and it is the right one: a back-filled earlier
 * day extends the window backwards, which is correct, because he has just told
 * us he was walking then.
 */
export function walkRate(days: string[], today: string): WalkRate | null {
  const first = days[0]
  if (first === undefined) return null
  const rolling = shiftDay(today, -(WALK_RATE_DAYS - 1))
  // String comparison, not date arithmetic: 'YYYY-MM-DD' sorts as its own
  // calendar, which is the whole reason the day key has that shape.
  const start = first > rolling ? first : rolling
  // A first mark later than today cannot happen through the route, and would
  // otherwise give a window of zero or negative length to divide by.
  const from = start > today ? today : start
  const total = daysBetween(from, today) + 1
  const walked = days.filter((day) => day >= from && day <= today).length
  return { walked, total, from, full: total >= WALK_RATE_DAYS }
}

// ─── CALENDAR GEOMETRY, WITHOUT A CLOCK AND WITHOUT A ZONE ─────────────────
//
// Pure 'YYYY-MM-DD' and 'YYYY-MM' arithmetic, done in UTC the same way
// `shiftDay` above is and for the same reason: constructed from components,
// never from a clock, so it is correct in whatever zone the friend is in.
//
// It lives HERE rather than in the calendar component because it is data logic
// — which day sits in which square, which months exist — and data logic in a
// .tsx file can only be tested by rendering it. users/run11/MonthCalendar.tsx
// imports these and derives nothing of its own.

/** Midnight UTC of a day key, as epoch ms. Components in, never a clock. */
function utcOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year!, month! - 1, date!)
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86_400_000)
}

/** The month a day belongs to, 'YYYY-MM'. */
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** The month `delta` months after `month`, both 'YYYY-MM'. */
export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number)
  return new Date(Date.UTC(year!, index! - 1 + delta, 1)).toISOString().slice(0, 7)
}

/** Every day key in a month, ascending. */
export function monthDays(month: string): string[] {
  const [year, index] = month.split('-').map(Number)
  // Day 0 of the NEXT month is the last day of this one — the one piece of
  // calendar arithmetic worth not writing out by hand, leap years included.
  const length = new Date(Date.UTC(year!, index!, 0)).getUTCDate()
  const out: string[] = []
  for (let d = 1; d <= length; d += 1) {
    out.push(`${month}-${String(d).padStart(2, '0')}`)
  }
  return out
}

/** Which weekday a row starts on, Sunday = 0. See `calendarGrid` below. */
export const WEEK_STARTS_ON = 0

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Column headings for the grid, in the same order as its cells.
 *
 * DERIVED from WEEK_STARTS_ON rather than written out, so changing that
 * constant cannot leave the headings pointing at the wrong columns — which is
 * the one way a week-start change could ship looking fine and be wrong.
 */
export const WEEKDAY_LABELS = [
  ...WEEKDAY_NAMES.slice(WEEK_STARTS_ON),
  ...WEEKDAY_NAMES.slice(0, WEEK_STARTS_ON),
]

/**
 * One square of the calendar, already DECIDED.
 *
 * `blank` is a cell outside the month, kept so the seven columns stay aligned.
 * `future` is a day that has not happened: spec v2 says future days are not
 * markable, so it carries no `marked` flag and the component renders no
 * control at all for it.
 */
export type CalendarCell =
  | { kind: 'blank' }
  | { kind: 'future'; day: string; date: number }
  | { kind: 'day'; day: string; date: number; marked: boolean; isToday: boolean }

/**
 * A month as rows of seven decided squares.
 *
 * THE DECISION LIVES HERE, NOT IN THE COMPONENT, and that is the point of this
 * function existing rather than the component doing this inline. "Which square
 * is today", "which square is in the future and therefore not markable",
 * "which square is filled" are data logic, and data logic in a .tsx file can
 * only be tested by rendering it — which for a client component means a React
 * renderer, a router context and a mounted store, none of which a query test
 * has. users/run11/MonthCalendar.tsx maps these to markup and decides nothing.
 *
 * WEEKS START ON SUNDAY. Nothing in the spec or the conversation says which,
 * and it is the kind of thing only the friend can settle — so this is the US
 * convention for a friend in Houston, flagged to Nico in the build report
 * rather than presented as decided. Changing it is one constant here and no
 * change at all in the component.
 */
export function calendarGrid(
  month: string,
  today: string,
  marked: Iterable<string>,
): CalendarCell[][] {
  const filled = new Set(marked)
  const days = monthDays(month)
  const lead = (new Date(utcOf(days[0]!)).getUTCDay() - WEEK_STARTS_ON + 7) % 7
  const cells: CalendarCell[] = [
    ...Array.from({ length: lead }, () => ({ kind: 'blank' }) as CalendarCell),
    ...days.map((day): CalendarCell => {
      const date = Number(day.slice(8))
      // Strict `>`: today is never the future, whether or not it is marked.
      // String comparison, not date arithmetic — 'YYYY-MM-DD' sorts as its own
      // calendar, which is the whole reason the day key has that shape.
      if (day > today) return { kind: 'future', day, date }
      return { kind: 'day', day, date, marked: filled.has(day), isToday: day === today }
    }),
  ]
  while (cells.length % 7 !== 0) cells.push({ kind: 'blank' })
  const rows: CalendarCell[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** 'August 2026'. A fixed table rather than Intl: one month, one name, no locale. */
export function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number)
  return `${MONTH_NAMES[index! - 1]} ${year}`
}

/**
 * The earliest month the calendar will page back to.
 *
 * A rolling year of history, plus any month that already holds a mark. The
 * rolling year is what keeps back-filling possible for a friend who has logged
 * nothing yet — bounding at his first mark instead would mean a brand-new log
 * could not reach last month at all, and back-filling is half of what he asked
 * the calendar for. The first-mark arm is what keeps a long history reachable
 * once it exists.
 *
 * There is a bound at all because the alternative is a button that pages back
 * to 1970 through empty grids.
 */
export function earliestMonth(days: string[], today: string): string {
  const rolling = shiftMonth(monthOf(today), -(CALENDAR_HISTORY_MONTHS - 1))
  const first = days[0]
  if (first === undefined) return rolling
  const firstMonth = monthOf(first)
  return firstMonth < rolling ? firstMonth : rolling
}
