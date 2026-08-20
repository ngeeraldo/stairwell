// lib/weather/openMeteo.ts
//
// The only file that knows Open-Meteo exists.
//
// Modelled on lib/alerts/ntfy.ts, and for the same reason: a third party on
// the other end of a socket is a place a friend's data could leak to, so the
// guarantee is made a property of the FILE rather than of one careful caller.
//
// ─── THREE PROPERTIES HOLD THIS FILE TOGETHER ───
//
// 1. NO EXPORTED FUNCTION HAS A PATH THROUGH WHICH ANYTHING ABOUT A FRIEND
//    COULD REACH THE PROVIDER. The request carries a LATITUDE and a LONGITUDE
//    and nothing else — no slug, no account id, no cookie, no timezone, no
//    User-Agent we set. `timezone=auto` is used precisely so that not even an
//    IANA zone name leaves the process: the provider derives the place's zone
//    from the coordinates it already has. The coordinates themselves are a
//    CONSTANT chosen by the builder and held in the route (PLACES), never a
//    value that arrives on a request — see app/api/users/[user]/forecast/route.ts.
//
//    What a passive observer learns is that this droplet asked about a
//    neighbourhood. It cannot learn who asked, and the request would look
//    identical if nobody had a dashboard at all.
//
// 2. IT RETURNS INSTANTS, NEVER LOCAL TIMES. `timeformat=unixtime` makes every
//    timestamp a UTC epoch, and the caller converts to the friend's calendar
//    with lib/time/dayKey and localMinuteOfDay. That is deliberate: this app
//    has exactly one answer to "what day is it for this friend" and a weather
//    provider is not allowed to become a second one
//    (docs/superpowers/ledgers/friend-timezone.md).
//
// 3. IT THROWS ForecastError AND NOTHING ELSE. The caller is a route that must
//    turn any failure into a recorded failed attempt and a status code, and a
//    provider's prose must not reach a database, a metric or a log — same
//    bound ManifestError carries in lib/db/migrationFiles.ts. The `code` is a
//    small closed set.
//
// NO API KEY AND NO ENVIRONMENT VARIABLE, which is why nothing was added to
// deploy/required-env. Open-Meteo's forecast endpoint is open and unauthenticated
// for non-commercial use; a provider needing a key would have been a
// deploy/required-env decision before it was a package decision
// (CLAUDE.md > Build contract).
//
// NO SDK, for the same reason lib/alerts/ntfy.ts posts with plain fetch: a
// server-touching dependency shares a process with the keymap holding every
// unlocked friend's database key. This is one GET and a JSON parse.

export const OPEN_METEO_ORIGIN = 'https://api.open-meteo.com'

/**
 * A hung provider with no timeout holds a socket for the life of the request.
 * The friend is watching a pending button while this runs, so the number is
 * set by human patience rather than by generosity to the upstream.
 */
export const FORECAST_TIMEOUT_MS = 8_000

/**
 * How many days of forecast to ask for. TWO: today, and tomorrow — which is
 * exactly what spec v1 needs, because "if no qualifying window remains today,
 * give the first one tomorrow morning" is the deepest question it asks.
 */
export const FORECAST_DAYS = 2

export type ForecastErrorCode =
  | 'http'
  | 'network'
  | 'timeout'
  | 'unparseable'
  | 'incomplete'

/**
 * Carries a CODE, never the provider's message.
 *
 * A third party's error body is text we did not write, arriving on a path that
 * ends in a friend's database and a stderr line. A closed set of codes is
 * enough to tell "the droplet has no egress" from "the provider answered with
 * nonsense", which is the only operational question this failure raises.
 */
export class ForecastError extends Error {
  readonly code: ForecastErrorCode

  constructor(code: ForecastErrorCode) {
    super(`forecast failed: ${code}`)
    this.name = 'ForecastError'
    this.code = code
  }
}

/** One forecast hour, at a UTC instant. Local time is the caller's problem. */
export type ForecastHour = {
  /** Epoch milliseconds at the top of the hour. */
  at: number
  /** Millimetres of precipitation forecast for the hour. */
  precipMm: number
  /** Chance of any precipitation at all, percent, 0..100. */
  precipChance: number
  /** Apparent temperature ("feels like" / heat index), °F. */
  feelsLikeF: number
}

/** Sunrise and sunset for one forecast day, as UTC instants. */
export type ForecastSun = {
  sunrise: number
  sunset: number
}

export type ForecastSnapshot = {
  hours: ForecastHour[]
  sun: ForecastSun[]
}

export type ForecastDeps = {
  /** Injected so no test in the default suite reaches the network (CLAUDE.md > Testing). */
  fetch: typeof globalThis.fetch
  /** A CONSTANT from the caller. Never a value that arrived on a request. */
  latitude: number
  longitude: number
}

/**
 * The URL, built here so the query string has exactly one author.
 *
 * Exported for the test that pins property 1 above — the assertion that no
 * friend-derived value appears in it is worth more when it reads the real
 * string this module sends rather than a reconstruction of it.
 */
export function forecastUrl(latitude: number, longitude: number): string {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    // Everything spec v1's three checks need, and nothing else. A forecast
    // field we do not read is a field a future reader assumes is meaningful.
    hourly: 'apparent_temperature,precipitation,precipitation_probability',
    daily: 'sunrise,sunset',
    // Fahrenheit because every threshold in users/run11/queries.ts is °F and
    // the friend said "feels like above 90". Converting here rather than there
    // keeps the thresholds readable as the numbers he agreed to.
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'mm',
    // Property 2: UTC epochs, so this module never states an opinion about
    // what day it is anywhere.
    timeformat: 'unixtime',
    // Property 1: the PLACE's zone, derived by the provider from the
    // coordinates it already has, so no zone name leaves this process. It
    // affects only which local days sunrise/sunset are computed for.
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
  })
  return `${OPEN_METEO_ORIGIN}/v1/forecast?${params.toString()}`
}

/**
 * Fetch and normalise a forecast for one coordinate.
 *
 * Every failure is a ForecastError; nothing else escapes.
 */
export async function fetchForecast(deps: ForecastDeps): Promise<ForecastSnapshot> {
  let response: Response
  try {
    response = await deps.fetch(forecastUrl(deps.latitude, deps.longitude), {
      method: 'GET',
      signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS),
    })
  } catch (error) {
    // Both arrive as a rejection. AbortSignal.timeout raises TimeoutError
    // specifically, which is the only thing separating "the provider is slow"
    // from "this host has no egress" — the same distinction lib/alerts/ntfy.ts
    // draws, and for the same operational reason.
    throw new ForecastError(
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
    )
  }

  if (!response.ok) throw new ForecastError('http')

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ForecastError('unparseable')
  }

  return normalise(body)
}

/**
 * Turn the provider's JSON into our own shape, or refuse it.
 *
 * EVERY FIELD IS CHECKED. This is untrusted third-party input landing in a
 * friend's encrypted database, and a NaN or a short array here becomes a
 * verdict that is silently wrong rather than a panel that says it could not
 * load. `incomplete` is the honest answer to a response that parsed as JSON
 * but is not a forecast.
 *
 * Exported for tests: a fixture is the only way to pin this without reaching
 * the network, and CLAUDE.md sanctions recording one here by name — "a zip's
 * forecast is public and about a place".
 */
export function normalise(body: unknown): ForecastSnapshot {
  if (typeof body !== 'object' || body === null) throw new ForecastError('unparseable')
  const root = body as Record<string, unknown>

  const hourly = root.hourly
  const daily = root.daily
  if (typeof hourly !== 'object' || hourly === null) throw new ForecastError('incomplete')
  if (typeof daily !== 'object' || daily === null) throw new ForecastError('incomplete')

  const h = hourly as Record<string, unknown>
  const d = daily as Record<string, unknown>

  const time = numbers(h.time)
  const feels = numbers(h.apparent_temperature)
  const precip = numbers(h.precipitation)
  const chance = numbers(h.precipitation_probability)

  // Open-Meteo returns parallel arrays and nothing correlates them but their
  // index, so an index that exists in one and not another is not something to
  // paper over with a default — it means the response is not the shape this
  // module was written against.
  if (
    time.length === 0 ||
    feels.length !== time.length ||
    precip.length !== time.length ||
    chance.length !== time.length
  ) {
    throw new ForecastError('incomplete')
  }

  const sunrise = numbers(d.sunrise)
  const sunset = numbers(d.sunset)
  if (sunrise.length === 0 || sunset.length !== sunrise.length) {
    throw new ForecastError('incomplete')
  }

  return {
    hours: time.map((seconds, i) => ({
      at: seconds * 1000,
      feelsLikeF: feels[i]!,
      precipMm: precip[i]!,
      // Percent, stored as an integer. Rounded rather than trusted to be one:
      // the field is documented as an integer and is not worth a refusal if a
      // provider ever returns 12.0.
      precipChance: Math.round(chance[i]!),
    })),
    sun: sunrise.map((rise, i) => ({ sunrise: rise * 1000, sunset: sunset[i]! * 1000 })),
  }
}

/**
 * An array of finite numbers, or a refusal.
 *
 * `null` is a legitimate Open-Meteo value for an hour it has no data for, and
 * it is refused rather than coerced to zero: a missing precipitation reading
 * that became 0.0 would read as "no rain expected" — a confident answer
 * invented from an absence, which is exactly what
 * docs/dashboard-ui-ux-guidelines.md's Empty state forbids, arriving one layer
 * too early to be caught there.
 */
function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw new ForecastError('incomplete')
  return value.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ForecastError('incomplete')
    return v
  })
}
