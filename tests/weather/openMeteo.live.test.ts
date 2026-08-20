// tests/weather/openMeteo.live.test.ts
//
// THE FIRST LIVE SHAPE TEST IN THIS REPO. Read CLAUDE.md > Testing before
// changing anything here — it sets the rules this file is built to, and this
// file is what introduced the `*.live.test.ts` exclusion in vitest.config.ts
// and the `test:live` script in package.json, which that section requires be
// added together.
//
// WHY IT EXISTS. lib/weather/openMeteo.ts is the first third-party data source
// in this app, and tests/weather/openMeteo.test.ts pins it against a fixture
// that was WRITTEN BY HAND from Open-Meteo's documented response rather than
// recorded from a live call. A hand-written fixture is exactly the kind that
// can quietly stop describing reality: the provider renames a field, every
// test stays green, and run11 gets "No forecast yet" forever. This is the only
// thing that would notice.
//
// IT SHARES ITS ASSERTION with the fixture test — `expectForecastShape` — so
// the two cannot drift into testing different things.
//
// IT NEVER RUNS IN GATE E OR A DEPLOY. An upstream outage must not block
// shipping an unrelated fix. Run it deliberately:
//
//     npm run test:live
//
// IT ASSERTS SHAPE, NEVER VALUES. A live forecast is different every hour, so
// any assertion about a temperature would be a test that fails on a mild day.
//
// NO FIXTURE IS RECORDED FROM WHAT IT SEES. A zip's forecast is public and
// about a place — which is why this call is allowed at all — but the fixture
// next door stays hand-written and readable rather than becoming a paste of
// whatever the sky was doing.
import { describe, expect, it } from 'vitest'
import { fetchForecast, FORECAST_DAYS } from '@/lib/weather/openMeteo'
import { expectForecastShape } from '@/tests/support/forecastShape'

// The same public coordinates app/api/users/[user]/forecast/route.ts pins
// run11 to. Nothing about a friend is sent — see the fixture test's first
// describe block, which proves that structurally.
const LAT = 29.74
const LON = -95.39

describe('Open-Meteo still answers in the shape we parse', () => {
  it(
    'returns an hourly forecast and sun times for a public coordinate',
    async () => {
      const snapshot = await fetchForecast({
        fetch: globalThis.fetch,
        latitude: LAT,
        longitude: LON,
      })

      // The shared assertion. If this fails while the fixture test passes, the
      // fixture has become fiction and is what needs fixing.
      expectForecastShape(snapshot)

      // The two things users/run11/queries.ts assumes about coverage, which
      // shape alone does not say: enough hours to scan two days of windows,
      // and a sun row for each of those days.
      expect(snapshot.hours.length).toBeGreaterThanOrEqual(24 * FORECAST_DAYS - 1)
      expect(snapshot.sun.length).toBe(FORECAST_DAYS)
    },
    // Generous relative to FORECAST_TIMEOUT_MS: the client's own timeout is
    // what this is really exercising, so the test must not fail first.
    20_000,
  )
})
