// users/run11/tests/queries.test.ts
//
// The verdict and the window, against a fixture built from run11's own
// migrations. This is where the dashboard is actually proved: the component
// renders whatever these return, so a wrong threshold or a mis-scanned window
// is a wrong dashboard that still renders perfectly (2026-08-12 hosting design
// §11.5 — the conventions sweep proves shape, not correctness).
//
// EVERY TIME IN THIS FILE IS A LITERAL. Nothing here reads a clock: `today` and
// the reference minute are parameters precisely so a test can sit at 4:15pm on
// a rainy August afternoon on any machine, on any day of the year.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3-multiple-ciphers'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  THRESHOLDS,
  WALK_MINUTES,
  ceilToStep,
  isRainy,
  latestFetch,
  latestSuccessfulFetch,
  nextGoodWindow,
  readWalk,
  rightNow,
  shiftDay,
  timeline,
} from '@/users/run11/queries'

const DAY = '2026-08-20'
const NEXT = '2026-08-21'

const at = (day: string, minute: number) => Date.parse(`${day}T00:00:00Z`) + minute * 60_000

let db: Database.Database

/** Insert one forecast hour. Defaults are a mild, dry hour. */
function hour(
  day: string,
  hourOfDay: number,
  { feels = 78, mm = 0, chance = 10 }: { feels?: number; mm?: number; chance?: number } = {},
) {
  db.prepare(
    `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(at(day, hourOfDay * 60), day, hourOfDay * 60, mm, chance, feels, at(day, 0))
}

/** A whole day of identical hours, so a test only has to state its exceptions. */
function flatDay(day: string, feels: number) {
  for (let h = 0; h < 24; h += 1) hour(day, h, { feels })
}

function sun(day: string, sunriseMinute: number, sunsetMinute: number) {
  db.prepare(
    'INSERT INTO forecast_days (day, sunrise_minute, sunset_minute, fetched_at) VALUES (?, ?, ?, ?)',
  ).run(day, sunriseMinute, sunsetMinute, at(day, 0))
}

function fetchRow(day: string, minute: number, ok = true) {
  db.prepare(
    'INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, ?)',
  ).run(at(day, minute), day, minute, ok ? 1 : 0)
}

// 6:53am and 7:56pm — late-August Houston, matching seed.py.
const SUNRISE = 6 * 60 + 53
const SUNSET = 19 * 60 + 56

beforeEach(() => {
  db = emptyDbFromMigrations('run11')
})
afterEach(() => {
  db.close()
})

describe('the three checks', () => {
  it('calls an hour rainy on EITHER signal, which is the whole reason both are stored', () => {
    const dry = { at: 0, day: DAY, minuteOfDay: 0, precipMm: 0, precipChance: 10, feelsLikeF: 80 }
    expect(isRainy(dry)).toBe(false)
    // Millimetres with a low chance: the forecast says it will drizzle.
    expect(isRainy({ ...dry, precipMm: THRESHOLDS.precipMm })).toBe(true)
    // Zero millimetres with a real chance: the forecast says it might rain.
    // An amount-only check would call this a clear hour, which is the case
    // seed.py's 16:00 row exists to keep honest.
    expect(isRainy({ ...dry, precipChance: THRESHOLDS.precipChancePct })).toBe(true)
    // Both thresholds are inclusive floors, so one below is still dry.
    expect(isRainy({ ...dry, precipChance: THRESHOLDS.precipChancePct - 1 })).toBe(false)
  })

  it('reads heat at the BOUNDARIES, in both directions', () => {
    flatDay(DAY, THRESHOLDS.heatShortF - 1)
    sun(DAY, SUNRISE, SUNSET)
    const noon = 12 * 60
    expect(readWalk(timeline(db, DAY), { day: DAY, sunriseMinute: SUNRISE, sunsetMinute: SUNSET }, noon)!.verdict).toBe('go')

    db.prepare('UPDATE forecast_hours SET feels_like_f = ?').run(THRESHOLDS.heatShortF)
    expect(readWalk(timeline(db, DAY), { day: DAY, sunriseMinute: SUNRISE, sunsetMinute: SUNSET }, noon)!.verdict).toBe('short')

    db.prepare('UPDATE forecast_hours SET feels_like_f = ?').run(THRESHOLDS.heatNoGoF)
    const hot = readWalk(timeline(db, DAY), { day: DAY, sunriseMinute: SUNRISE, sunsetMinute: SUNSET }, noon)!
    expect(hot.verdict).toBe('no')
    expect(hot.blockers).toEqual(['heat'])
  })

  it('takes the WORST hour of the walk, not the hour it starts in', () => {
    // A walk from 10:40 to 11:20 spends most of itself in the 11:00 hour.
    flatDay(DAY, 80)
    db.prepare('UPDATE forecast_hours SET feels_like_f = 99 WHERE minute_of_day = ?').run(11 * 60)
    sun(DAY, SUNRISE, SUNSET)
    const reading = rightNow(db, DAY, 10 * 60 + 40)
    expect(reading.state).toBe('ok')
    expect(reading.state === 'ok' && reading.reading.peakFeelsLikeF).toBe(99)
    expect(reading.state === 'ok' && reading.reading.verdict).toBe('no')
  })

  it('requires DAYLIGHT AT BOTH ENDS — the in-spirit half of the sunset rule', () => {
    flatDay(DAY, 78)
    sun(DAY, SUNRISE, SUNSET)
    // The last start that still finishes before sunset.
    const lastStart = SUNSET - WALK_MINUTES
    expect(rightNow(db, DAY, lastStart).state === 'ok' && rightNow(db, DAY, lastStart).state).toBe('ok')
    const justOk = rightNow(db, DAY, lastStart)
    expect(justOk.state === 'ok' && justOk.reading.verdict).toBe('go')

    const tooLate = rightNow(db, DAY, lastStart + 1)
    expect(tooLate.state === 'ok' && tooLate.reading.blockers).toEqual(['dark'])

    // BEFORE SUNRISE IS ALSO DARK. spec v1 writes only the sunset half; a
    // walk at 4am is the case that shows why both are needed, and it is why
    // "the first window tomorrow morning" is not midnight.
    const predawn = rightNow(db, DAY, 4 * 60)
    expect(predawn.state === 'ok' && predawn.reading.blockers).toEqual(['dark'])
  })

  it('names EVERY failing check, not the first one', () => {
    flatDay(DAY, 99)
    db.prepare('UPDATE forecast_hours SET precip_chance = 80').run()
    sun(DAY, SUNRISE, SUNSET)
    const reading = rightNow(db, DAY, 23 * 60)
    expect(reading.state === 'ok' && reading.reading.blockers).toEqual(['rain', 'heat', 'dark'])
  })

  it('treats a MISSING sunset as dark rather than as fine', () => {
    // No forecast_days row at all. An unknown sunset is not a licence to send
    // someone out at dusk.
    flatDay(DAY, 78)
    const reading = rightNow(db, DAY, 12 * 60)
    expect(reading.state === 'ok' && reading.reading.blockers).toEqual(['dark'])
  })
})

describe('coverage', () => {
  it('reports no_forecast on an EMPTY database', () => {
    expect(rightNow(db, DAY, 12 * 60)).toEqual({ state: 'no_forecast' })
    expect(nextGoodWindow(db, DAY, 12 * 60)).toBeNull()
  })

  it('reports "uncovered" rather than a verdict when the walk runs past the last hour', () => {
    // Only the morning is on file. A walk at 23:30 has nothing describing it,
    // and inventing a cheerful verdict from the hours that exist is exactly
    // the failure mode this state prevents.
    for (let h = 0; h < 12; h += 1) hour(DAY, h)
    sun(DAY, SUNRISE, SUNSET)
    expect(rightNow(db, DAY, 23 * 60 + 30)).toEqual({ state: 'uncovered' })
  })

  it('reads ACROSS MIDNIGHT into the next day’s hours', () => {
    // A walk starting at 23:50 ends at 00:30 tomorrow. The hour that matters
    // is on the other side of the day boundary; the heat there is what the
    // reading must pick up.
    flatDay(DAY, 78)
    flatDay(NEXT, 99)
    sun(DAY, SUNRISE, SUNSET)
    const reading = rightNow(db, DAY, 23 * 60 + 50)
    expect(reading.state).toBe('ok')
    expect(reading.state === 'ok' && reading.reading.peakFeelsLikeF).toBe(99)
  })
})

describe('next good window', () => {
  beforeEach(() => {
    // A Houston August day, the same shape seed.py draws: rain through the
    // morning, too hot all afternoon, dropping back under 90 at 18:00.
    for (let h = 0; h < 24; h += 1) {
      const feels = h < 8 ? 82 : h < 18 ? 99 : 88
      const wet = h >= 5 && h <= 8
      hour(DAY, h, { feels, mm: wet ? 0.5 : 0, chance: wet ? 70 : 10 })
    }
    sun(DAY, SUNRISE, SUNSET)
  })

  it('finds the evening window and reports it as bounded by DARK', () => {
    const found = nextGoodWindow(db, DAY, 14 * 60)!
    expect(found.isTomorrow).toBe(false)
    expect(found.day).toBe(DAY)
    expect(found.startMinute).toBe(18 * 60)
    // The last start sunset allows, rounded down to a scan step: 19:56 − 40 =
    // 19:16, so 19:10 is the last offer.
    expect(found.lastStartMinute).toBe(19 * 60 + 10)
    // AND WHY IT ENDS. Sunset closes this one: the next start, 19:20, would put
    // the walk back at 20:00 against a 19:56 sunset. The panel says so —
    // naming the time alone reads as a glitch (Nico's v1 review).
    expect(found.closedBy!.blockers).toEqual(['dark'])
  })

  it('never offers a window in the past', () => {
    // Asked at 18:30, the window that opened at 18:00 is not the answer —
    // the next STEP from now is.
    const found = nextGoodWindow(db, DAY, 18 * 60 + 30)!
    expect(found.startMinute).toBe(18 * 60 + 30)
    expect(found.startMinute).toBeGreaterThanOrEqual(ceilToStep(18 * 60 + 30))
  })

  it('falls through to TOMORROW MORNING once today is gone, starting at sunrise not midnight', () => {
    // Tomorrow is clear and cool until 10:00.
    for (let h = 0; h < 24; h += 1) hour(NEXT, h, { feels: h < 10 ? 82 : 99 })
    sun(NEXT, SUNRISE + 1, SUNSET - 1)

    const found = nextGoodWindow(db, DAY, 21 * 60)!
    expect(found.isTomorrow).toBe(true)
    expect(found.day).toBe(NEXT)
    // Sunrise is 6:54; the first scan step at or after it is 7:00. NOT 00:00,
    // which is what the sunset-only reading of the spec would have produced.
    expect(found.startMinute).toBe(7 * 60)
    // Closed by heat at 10:00, not by darkness: a walk starting at 9:20 ends
    // at 10:00 and never touches the hot hour.
    expect(found.lastStartMinute).toBe(9 * 60 + 20)
    // HEAT closes this one, not darkness, and the reading carries the figure
    // the panel quotes: 9:30 would run into the 10:00 hour at 99°F.
    expect(found.closedBy!.blockers).toEqual(['heat'])
    expect(found.closedBy!.peakFeelsLikeF).toBe(99)
  })

  it('names RAIN when that is what closes the window, with the chance behind it', () => {
    // Rain through 07:00, clear and mild from 08:00, a storm arriving at
    // 12:00. The window opens once the morning rain stops and closes on the
    // afternoon one — a third distinct reason, and the one an "ends at dark"
    // boolean could never have expressed.
    db.prepare('DELETE FROM forecast_hours').run()
    for (let h = 0; h < 24; h += 1) {
      const wet = h < 8 || h >= 12
      hour(DAY, h, { feels: 80, mm: wet ? 0.6 : 0, chance: wet ? 65 : 5 })
    }
    const found = nextGoodWindow(db, DAY, 8 * 60)!
    expect(found.startMinute).toBe(8 * 60)
    // 11:30 would run to 12:10 and catch the storm, so 11:20 is the last out.
    expect(found.lastStartMinute).toBe(11 * 60 + 20)
    expect(found.closedBy!.blockers).toEqual(['rain'])
    expect(found.closedBy!.peakPrecipChance).toBe(65)
  })

  it('reports the forecast RUNNING OUT as its own thing, not as weather', () => {
    // A truncated forecast is not a check failing, and saying "after that it's
    // too hot" about hours nobody has would be inventing a reason.
    db.prepare('DELETE FROM forecast_hours').run()
    for (let h = 8; h <= 12; h += 1) hour(DAY, h, { feels: 80 })
    const found = nextGoodWindow(db, DAY, 8 * 60)!
    expect(found.startMinute).toBe(8 * 60)
    expect(found.closedBy).toBeNull()
  })

  it('returns null when neither day clears the checks', () => {
    for (let h = 0; h < 24; h += 1) hour(NEXT, h, { feels: 99 })
    sun(NEXT, SUNRISE, SUNSET)
    expect(nextGoodWindow(db, DAY, 21 * 60)).toBeNull()
  })

  it('counts a "short one, shade" stretch as a window — spec v1 sets it at 90°F', () => {
    // 88°F is the middle verdict for "Right now" and still a window here.
    const found = nextGoodWindow(db, DAY, 14 * 60)!
    const reading = rightNow(db, DAY, found.startMinute)
    expect(reading.state === 'ok' && reading.reading.verdict).toBe('short')
  })
})

describe('the fetch log', () => {
  it('separates the newest attempt from the newest SUCCESSFUL one', () => {
    fetchRow(DAY, 9 * 60, true)
    fetchRow(DAY, 15 * 60, false)
    expect(latestFetch(db)!.minuteOfDay).toBe(15 * 60)
    expect(latestFetch(db)!.ok).toBe(false)
    // This pair is what lets the panel render last-known data AND say the
    // refresh failed, instead of choosing one of the two.
    expect(latestSuccessfulFetch(db)!.minuteOfDay).toBe(9 * 60)
    expect(latestSuccessfulFetch(db)!.ok).toBe(true)
  })

  it('is null on an empty database, for both', () => {
    expect(latestFetch(db)).toBeNull()
    expect(latestSuccessfulFetch(db)).toBeNull()
  })
})

describe('calendar arithmetic', () => {
  it('shifts days across a month boundary without a clock', () => {
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    // A leap day, which is where naive +86400000 arithmetic on a local
    // calendar tends to go wrong.
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('rounds a start time up to the scan step', () => {
    expect(ceilToStep(18 * 60 + 3)).toBe(18 * 60 + 10)
    expect(ceilToStep(18 * 60)).toBe(18 * 60)
  })
})
