// users/run11/tests/noGoTemp.test.ts
//
// Spec v2's other addition: the no-go feels-like is the friend's number now,
// not a constant in users/run11/queries.ts.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is the same one the whole of
// dashboard.test.ts is about — a confident wrong answer. A cutoff that is read
// from the wrong place, or defaulted when a row exists, gives a verdict the
// screen cannot stand behind: the panel says "Go" against 90°F while the
// control under it says 95. So it is not enough to test that the setting is
// stored and read; every function that judges a walk has to be shown MOVING
// when the number moves.
//
// EVERY VALUE HERE IS A LITERAL, and the writes are reproduced rather than
// imported — a user's own test must not import a platform route. The real
// route is pinned by tests/routing/noGoTempRoute.test.ts.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  DEFAULT_HEAT_NO_GO_F,
  HEAT_NO_GO_MAX_F,
  HEAT_NO_GO_MIN_F,
  HEAT_NO_GO_STEP_F,
  HEAT_SHADE_BAND_F,
  clampNoGoF,
  heatNoGoF,
  nextGoodWindow,
  rightNow,
  shadeFloorF,
} from '@/users/run11/queries'

const DAY = '2026-08-20'
const SUNRISE = 6 * 60 + 53
const SUNSET = 19 * 60 + 56

const at = (day: string, minute: number) => Date.parse(`${day}T00:00:00Z`) + minute * 60_000

let db: Database.Database

beforeEach(() => {
  db = emptyDbFromMigrations('run11')
})
afterEach(() => {
  db.close()
})

/** Exactly what the no-go-temp route's upsert does. */
function setNoGo(value: number) {
  db.prepare(
    `INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET heat_no_go_f = excluded.heat_no_go_f,
                                     set_at       = excluded.set_at`,
  ).run(value, 0)
}

/** A whole day of one temperature, dry, with sun. */
function flatDay(feels: number, day = DAY) {
  for (let h = 0; h < 24; h += 1) {
    db.prepare(
      `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
       VALUES (?, ?, ?, 0, 10, ?, ?)`,
    ).run(at(day, h * 60), day, h * 60, feels, at(day, 0))
  }
  db.prepare(
    'INSERT INTO forecast_days (day, sunrise_minute, sunset_minute, fetched_at) VALUES (?, ?, ?, ?)',
  ).run(day, SUNRISE, SUNSET, at(day, 0))
}

describe('users/run11 — reading the friend’s no-go temperature', () => {
  it('defaults to 90°F when he has never set one', () => {
    // spec v2: "if nothing has been set yet it defaults to the current 90°F so
    // the screen behaves exactly as it does today on first load." This is the
    // whole of run11's first session on the new version.
    expect(heatNoGoF(db)).toBe(90)
    expect(DEFAULT_HEAT_NO_GO_F).toBe(90)
  })

  it('reads back what he set', () => {
    setNoGo(95)
    expect(heatNoGoF(db)).toBe(95)
  })

  it('holds a stored value inside the range the control can reach', () => {
    // The column carries no CHECK — see 002's header — so a value outside the
    // range is representable. Rendering it would give him − and + buttons that
    // cannot bring the number back, which is a screen that has quietly stopped
    // working.
    setNoGo(HEAT_NO_GO_MAX_F + 20)
    expect(heatNoGoF(db)).toBe(HEAT_NO_GO_MAX_F)
    setNoGo(HEAT_NO_GO_MIN_F - 20)
    expect(heatNoGoF(db)).toBe(HEAT_NO_GO_MIN_F)
  })

  it('cannot be handed a NaN at all — the column refuses it', () => {
    // Worth pinning rather than assuming: SQLite binds a JavaScript NaN as
    // NULL, so `NOT NULL` rejects the write outright. The clamp's own
    // non-finite guard is therefore defence in depth against a value that
    // cannot reach the column through any code in this repo, not a live case.
    expect(() => setNoGo(Number.NaN)).toThrow(/NOT NULL/)
    expect(clampNoGoF(Number.NaN)).toBe(DEFAULT_HEAT_NO_GO_F)
  })

  it('falls back to the default rather than rendering a non-number', () => {
    // A value that CAN sit in the column: SQLite's INTEGER affinity keeps a
    // non-numeric string as text. Nothing in this repo writes one — the route
    // clamps a number — so this is the last line rather than the first, and
    // what it buys is that the panel shows a number its own buttons can move
    // instead of "NaN°F".
    db.prepare('INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, ?, 0)').run(
      'not a temperature',
    )
    expect(heatNoGoF(db)).toBe(DEFAULT_HEAT_NO_GO_F)
  })

  it('derives the shade band as the five degrees below, never storing it', () => {
    // spec v2, and his own words: he sets "just the hard no number", and
    // "setting 92 gives a shade band of 87–92". Two stored numbers could
    // disagree with each other; one cannot.
    expect(shadeFloorF(92)).toBe(87)
    expect(HEAT_SHADE_BAND_F).toBe(5)
    setNoGo(92)
    expect(shadeFloorF(heatNoGoF(db))).toBe(87)
  })
})

describe('users/run11 — the verdict follows his number', () => {
  it('turns the same forecast from "go" to "no" as the cutoff comes down', () => {
    // 88°F all day. The verdict is entirely a function of where he puts the
    // line, and this is the assertion that would fail if any caller had kept
    // reaching for a module constant instead of passing the parameter.
    flatDay(88)
    const noon = 12 * 60
    const verdictAt = (noGo: number) => {
      const reading = rightNow(db, DAY, noon, noGo)
      return reading.state === 'ok' ? reading.reading.verdict : reading.state
    }
    // Cutoff 95: 88 is below the shade floor of 90, so it is a clean go.
    expect(verdictAt(95)).toBe('go')
    // Cutoff 92: the shade band is 87–92, and 88 is inside it.
    expect(verdictAt(92)).toBe('short')
    // Cutoff 88: at or above the no-go number is a no.
    expect(verdictAt(88)).toBe('no')
  })

  it('names heat as the blocker at exactly his number, and not one below it', () => {
    // The cutoff is an inclusive floor, the same way v1's was.
    flatDay(93)
    const noon = 12 * 60
    const hot = rightNow(db, DAY, noon, 93)
    expect(hot.state === 'ok' && hot.reading.blockers).toEqual(['heat'])
    const fine = rightNow(db, DAY, noon, 94)
    expect(fine.state === 'ok' && fine.reading.verdict).toBe('short')
  })

  it('moves the NEXT GOOD WINDOW too, and still ignores the shade band', () => {
    // spec v2: "The Next good window panel keeps using only the no-go number
    // and not the shade band, as it does now." So a day at 88°F offers a
    // window under a 92 cutoff even though the verdict there is only "short",
    // and offers none at all under an 88 cutoff.
    flatDay(88)
    const under92 = nextGoodWindow(db, DAY, SUNRISE, 92)
    expect(under92).not.toBeNull()
    expect(under92!.startMinute).toBeGreaterThanOrEqual(SUNRISE)
    expect(nextGoodWindow(db, DAY, SUNRISE, 88)).toBeNull()
  })

  it('recomputes both panels from ONE stored value, so they cannot disagree', () => {
    // The dashboard reads heatNoGoF once and hands the same number to both.
    // This is that contract asserted end to end: the verdict and the window
    // agree about the cutoff because there is only one of it.
    flatDay(88)
    setNoGo(92)
    const noGo = heatNoGoF(db)
    const verdict = rightNow(db, DAY, 12 * 60, noGo)
    expect(verdict.state === 'ok' && verdict.reading.verdict).toBe('short')
    expect(nextGoodWindow(db, DAY, SUNRISE, noGo)).not.toBeNull()
  })
})

describe('users/run11 — the control’s bounds and the route’s bounds agree', () => {
  it('pins the route’s duplicated constants against queries.ts', () => {
    // app/api/users/[user]/no-go-temp/route.ts DUPLICATES the bounds, the step
    // and the default rather than importing them: a platform route importing a
    // user folder would make one friend's dashboard a build dependency of the
    // platform. Duplication is the right call there and this is what keeps it
    // honest — the dashboard's disabled buttons are an affordance, and the
    // route's clamp is the rule, and they are meant to be the same numbers.
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', join('app', 'api', 'users', '[user]', 'no-go-temp', 'route.ts')),
      'utf8',
    )
    const constant = (name: string) => {
      const found = new RegExp(`const ${name} = (-?\\d+)\\b`).exec(source)
      expect(found, `${name} not found in the route`).not.toBeNull()
      return Number(found![1])
    }
    expect(constant('MIN_F')).toBe(HEAT_NO_GO_MIN_F)
    expect(constant('MAX_F')).toBe(HEAT_NO_GO_MAX_F)
    expect(constant('STEP_F')).toBe(HEAT_NO_GO_STEP_F)
    expect(constant('DEFAULT_F')).toBe(DEFAULT_HEAT_NO_GO_F)
  })

  it('keeps the default inside the range, so the first press is never a jump', () => {
    // If the default sat outside the bounds, the first press would clamp to an
    // edge instead of stepping — the number would leap and he would have no
    // idea why.
    expect(DEFAULT_HEAT_NO_GO_F).toBeGreaterThanOrEqual(HEAT_NO_GO_MIN_F)
    expect(DEFAULT_HEAT_NO_GO_F).toBeLessThanOrEqual(HEAT_NO_GO_MAX_F)
    // And the shade band stays a real band at the bottom of the range.
    expect(shadeFloorF(HEAT_NO_GO_MIN_F)).toBeLessThan(HEAT_NO_GO_MIN_F)
  })
})
