// tests/support/forecastShape.ts
//
// ONE assertion about what a forecast looks like, shared by the fixture test
// and the opt-in live test.
//
// CLAUDE.md > Testing requires exactly this sharing: "They assert shape, never
// values, and share their assertion with the fixture test, so a fixture that
// has drifted from reality is caught instead of quietly becoming fiction."
// lib/weather/openMeteo.ts's fixture is hand-written against Open-Meteo's
// documented response, and a hand-written fixture is precisely the kind that
// can quietly stop describing the thing it stands in for.
import { expect } from 'vitest'
import type { ForecastSnapshot } from '@/lib/weather/openMeteo'

/**
 * Shape only — never a temperature, never a time.
 *
 * A live forecast is different every hour, so anything asserted about a VALUE
 * here would be a test that fails on a mild day. What must hold on both sides
 * is that the snapshot is usable at all: hours in order, finite numbers, a
 * sunrise before its sunset.
 */
export function expectForecastShape(snapshot: ForecastSnapshot): void {
  expect(snapshot.hours.length).toBeGreaterThan(0)
  expect(snapshot.sun.length).toBeGreaterThan(0)

  for (const hour of snapshot.hours) {
    expect(Number.isFinite(hour.at)).toBe(true)
    expect(Number.isFinite(hour.feelsLikeF)).toBe(true)
    expect(Number.isFinite(hour.precipMm)).toBe(true)
    expect(Number.isInteger(hour.precipChance)).toBe(true)
    expect(hour.precipChance).toBeGreaterThanOrEqual(0)
    expect(hour.precipChance).toBeLessThanOrEqual(100)
    expect(hour.precipMm).toBeGreaterThanOrEqual(0)
  }

  // An hourly forecast that is not hourly, or not in order, would break every
  // window scan in users/run11/queries.ts — which walks these in sequence and
  // assumes each covers the 60 minutes after the one before it.
  for (let i = 1; i < snapshot.hours.length; i += 1) {
    expect(snapshot.hours[i]!.at - snapshot.hours[i - 1]!.at).toBe(3_600_000)
  }

  for (const day of snapshot.sun) {
    expect(Number.isFinite(day.sunrise)).toBe(true)
    expect(day.sunset).toBeGreaterThan(day.sunrise)
  }
}
