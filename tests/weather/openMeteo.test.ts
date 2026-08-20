// tests/weather/openMeteo.test.ts
//
// The forecast client, against a fixture. NOTHING HERE REACHES THE NETWORK:
// fetch is injected, exactly as lib/alerts/ntfy.ts injects it, and CLAUDE.md >
// Testing is absolute that a test needing a real key — or a real socket — is a
// test that is wrong.
//
// TWO KINDS OF ASSERTION LIVE HERE, and the first is the more important:
//
//   1. PROPERTY 1 OF THE MODULE — that nothing about a friend can reach the
//      provider. That is a privacy guarantee made structurally, and a
//      structural guarantee needs a test that would notice it being weakened.
//   2. That an untrusted third-party response is refused rather than coerced
//      into a confident wrong forecast.
import { describe, expect, it, vi } from 'vitest'
import {
  FORECAST_DAYS,
  ForecastError,
  OPEN_METEO_ORIGIN,
  fetchForecast,
  forecastUrl,
  normalise,
} from '@/lib/weather/openMeteo'
import { expectForecastShape } from '@/tests/support/forecastShape'

// 77006, Montrose — the coordinates app/api/users/[user]/forecast/route.ts
// pins run11 to. A place, not a person: CLAUDE.md sanctions this fixture by
// name — "a zip's forecast is public and about a place; a friend's
// transactions are not".
const LAT = 29.74
const LON = -95.39

/**
 * A response in Open-Meteo's documented shape: parallel hourly arrays and one
 * entry per day of sun times, all timestamps unix seconds because the client
 * asks for `timeformat=unixtime`.
 */
function fixture(hours = 6) {
  const base = Math.floor(Date.parse('2026-08-20T12:00:00Z') / 1000)
  return {
    latitude: LAT,
    longitude: LON,
    utc_offset_seconds: -18000,
    timezone: 'America/Chicago',
    hourly: {
      time: Array.from({ length: hours }, (_, i) => base + i * 3600),
      apparent_temperature: Array.from({ length: hours }, (_, i) => 88 + i),
      precipitation: Array.from({ length: hours }, () => 0),
      precipitation_probability: Array.from({ length: hours }, (_, i) => i * 5),
    },
    daily: {
      sunrise: [Math.floor(Date.parse('2026-08-20T11:53:00Z') / 1000)],
      sunset: [Math.floor(Date.parse('2026-08-21T00:56:00Z') / 1000)],
    },
  }
}

function okFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
}

describe('nothing about a friend reaches the provider', () => {
  it('sends coordinates and nothing else that could identify anyone', () => {
    const url = forecastUrl(LAT, LON)
    expect(url.startsWith(`${OPEN_METEO_ORIGIN}/v1/forecast?`)).toBe(true)

    const params = new URL(url).searchParams
    // THE WHOLE PARAMETER LIST, asserted exhaustively rather than by spot
    // check. A new parameter carrying something friend-derived is exactly the
    // regression this guards, and it would slip past any assertion that only
    // named the keys it already knew about.
    expect([...params.keys()].sort()).toEqual([
      'daily',
      'forecast_days',
      'hourly',
      'latitude',
      'longitude',
      'precipitation_unit',
      'temperature_unit',
      'timeformat',
      'timezone',
    ])
    expect(params.get('latitude')).toBe(String(LAT))
    expect(params.get('longitude')).toBe(String(LON))
    // `timezone=auto` is the literal string, NOT an IANA name: the provider
    // derives the place's zone from coordinates it already has, so not even a
    // zone name leaves the process. A test that accepted any value here would
    // not notice someone "helpfully" forwarding the friend's own zone.
    expect(params.get('timezone')).toBe('auto')
    expect(params.get('timeformat')).toBe('unixtime')
    expect(params.get('forecast_days')).toBe(String(FORECAST_DAYS))
  })

  it('names no slug, session or account anywhere in the request', () => {
    const url = forecastUrl(LAT, LON)
    for (const leak of ['run11', 'slug', 'user', 'session', 'sid', 'account']) {
      expect(url.toLowerCase()).not.toContain(leak)
    }
  })

  it('sends no headers, no body and no credentials — a bare GET', async () => {
    const fetchSpy = okFetch(fixture())
    await fetchForecast({ fetch: fetchSpy, latitude: LAT, longitude: LON })
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.headers).toBeUndefined()
    // A cookie jar is the classic accidental channel; there is nothing here
    // that could opt into one.
    expect(init.credentials).toBeUndefined()
    // A timeout is set, so a hung provider cannot hold the friend's pending
    // button forever.
    expect(init.signal).toBeDefined()
  })
})

describe('a well-formed response', () => {
  it('normalises to instants and °F, in the shape the live test also asserts', async () => {
    const snapshot = await fetchForecast({
      fetch: okFetch(fixture()),
      latitude: LAT,
      longitude: LON,
    })
    expectForecastShape(snapshot)
    // Seconds in, milliseconds out — everything downstream of here is epoch
    // milliseconds, which is what every other timestamp in this repo is.
    expect(snapshot.hours[0]!.at).toBe(Date.parse('2026-08-20T12:00:00Z'))
    expect(snapshot.hours[0]!.feelsLikeF).toBe(88)
    expect(snapshot.sun[0]!.sunset).toBe(Date.parse('2026-08-21T00:56:00Z'))
  })

  it('rounds a fractional precipitation probability rather than refusing it', () => {
    const body = fixture(2)
    body.hourly.precipitation_probability = [12.4, 0]
    expect(normalise(body).hours[0]!.precipChance).toBe(12)
  })
})

describe('an untrusted response is refused, never coerced', () => {
  it('refuses a null hour instead of reading it as "no rain"', () => {
    // Open-Meteo returns null for an hour it has no data for. Coerced to 0.0
    // that is a confident "no precipitation expected" invented from an
    // absence — which would reach a friend as a green "Go".
    const body = fixture(3)
    ;(body.hourly.precipitation as unknown[])[1] = null
    expect(() => normalise(body)).toThrow(ForecastError)
    expect(() => normalise(body)).toThrow(/incomplete/)
  })

  it('refuses parallel arrays of different lengths', () => {
    const body = fixture(4)
    body.hourly.apparent_temperature = [88, 89]
    expect(() => normalise(body)).toThrow(/incomplete/)
  })

  it('refuses a response with no hourly or no daily block at all', () => {
    expect(() => normalise({ hourly: fixture().hourly })).toThrow(/incomplete/)
    expect(() => normalise({ daily: fixture().daily })).toThrow(/incomplete/)
    expect(() => normalise({})).toThrow(/incomplete/)
    expect(() => normalise(null)).toThrow(/unparseable/)
    expect(() => normalise('a forecast, honest')).toThrow(/unparseable/)
  })

  it('refuses an empty forecast', () => {
    // Zero hours parses fine and means nothing. Downstream it would render as
    // "no forecast yet" forever while the fetch log claimed success.
    const body = fixture(0)
    expect(() => normalise(body)).toThrow(/incomplete/)
  })
})

describe('transport failures carry a CODE, never the provider’s prose', () => {
  it('reports http on a non-2xx', async () => {
    const fetchSpy = vi.fn(async () => new Response('rate limited, dear caller', { status: 429 }))
    await expect(
      fetchForecast({ fetch: fetchSpy, latitude: LAT, longitude: LON }),
    ).rejects.toMatchObject({ name: 'ForecastError', code: 'http' })
  })

  it('reports unparseable when the body is not JSON', async () => {
    const fetchSpy = vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 }))
    await expect(
      fetchForecast({ fetch: fetchSpy, latitude: LAT, longitude: LON }),
    ).rejects.toMatchObject({ code: 'unparseable' })
  })

  it('separates a timeout from a dead network — the operator’s actual question', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    })
    await expect(
      fetchForecast({
        fetch: vi.fn(async () => {
          throw timeout
        }),
        latitude: LAT,
        longitude: LON,
      }),
    ).rejects.toMatchObject({ code: 'timeout' })

    await expect(
      fetchForecast({
        fetch: vi.fn(async () => {
          throw new TypeError('fetch failed')
        }),
        latitude: LAT,
        longitude: LON,
      }),
    ).rejects.toMatchObject({ code: 'network' })
  })

  it('never puts the provider’s message in the error', async () => {
    // The message is what reaches a stderr line and (as a code) a friend's
    // database. A third party's prose belongs in neither.
    const fetchSpy = vi.fn(async () => new Response('SECRET UPSTREAM DETAIL', { status: 500 }))
    // `.catch` returning the error widens the awaited type to a union with the
    // snapshot, so this asserts the rejection happened before reading it.
    let caught: unknown
    try {
      await fetchForecast({ fetch: fetchSpy, latitude: LAT, longitude: LON })
      expect.unreachable('a 500 must reject')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ForecastError)
    expect((caught as Error).message).not.toContain('SECRET UPSTREAM DETAIL')
    expect((caught as Error).message).toBe('forecast failed: http')
  })
})
