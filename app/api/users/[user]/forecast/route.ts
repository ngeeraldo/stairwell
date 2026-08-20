import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { readDeviceClass, readTimeZone } from '@/lib/metrics/deviceClass'
import { openUserDataForWrite } from '@/lib/db/userData'
import { logDbFailure } from '@/lib/db/failureLog'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { writeAnswer } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'
import type { UserDb } from '@/lib/db/userDb'
// Both live in lib/time, not here. A route module may export only Next's own
// route fields — anything else fails `next build` with "is not a valid Route
// export field". See lib/time/dayKey.ts.
import { dayKey } from '@/lib/time/dayKey'
import { localMinuteOfDay } from '@/lib/time/minuteOfDay'
import { fetchForecast, ForecastError } from '@/lib/weather/openMeteo'
import type { ForecastSnapshot } from '@/lib/weather/openMeteo'

/**
 * REFRESH THE STORED FORECAST for a friend whose dashboard is fed by one.
 *
 * Written from platform/templates/route/route.ts.tmpl and keeping its four
 * ordered checks verbatim — they ARE the security property and are cheaper to
 * read twice than to trace through an abstraction. What is different here, and
 * why:
 *
 * ── THIS IS A READ REFRESHING, NOT A FRIEND LOGGING SOMETHING ───────────────
 *
 * Every other write route in this app files something the friend did. This one
 * writes PUBLIC DATA ABOUT A PLACE into their database, and it exists at all
 * because of the rule it is shaped by: nothing writes to a friend's database
 * except from their own session (CLAUDE.md > Dashboard folder conventions).
 * Their data key lives only in the in-process keymap while they are unlocked,
 * so no scheduled job could open the file to cache a forecast even if one
 * existed. V1's two sanctioned triggers are a control the friend presses and a
 * one-time action at login; THIS IS THE FIRST OF THOSE — the Refresh control
 * in users/run11/dashboard.tsx.
 *
 * ── WHERE THE COORDINATES COME FROM, and why not from the request ───────────
 *
 * PLACES below is a CONSTANT map, and that is a security boundary rather than
 * a convenience. lib/weather/openMeteo.ts's first property is that nothing
 * about a friend can reach the provider; a latitude that arrived in a form
 * body would break it immediately, turning this route into an open proxy that
 * forwards caller-chosen values to a third party. The slug indexes a table, and
 * a slug with no entry is a 404.
 *
 * ── EVERY ATTEMPT IS RECORDED, INCLUDING THE FAILURES ───────────────────────
 *
 * `forecast_fetches` gets a row whether or not the provider answered. Without
 * it a failed refresh is indistinguishable from no refresh: the hour rows stay
 * as they were and the dashboard would render an old verdict as if it were
 * current, which docs/dashboard-ui-ux-guidelines.md > States forbids by name.
 * The panel's honest error state is built on that row existing.
 */

/**
 * The coordinates each slug's forecast is pinned to.
 *
 * run11: zip 77006, Montrose, Houston — the neighbourhood centroid, at the
 * precision a forecast is actually computed on. Deliberately NOT the street
 * address from the interview: the forecast for a 1km grid cell is identical
 * either way, and this file is committed to the repo, where a friend's home
 * address has no business being (CLAUDE.md > Data safety — never commit real
 * user data). The address stays in the transcript, which is gitignored.
 */
const PLACES: Record<string, { latitude: number; longitude: number }> = {
  run11: { latitude: 29.74, longitude: -95.39 },
}

/** The panel a metric row names. A constant, never anything derived. */
const PANEL = 'forecast_refresh'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    return new Response(null, { status: 403 })
  }
  if (!canSeeUserSpace(db, sessionId, user)) {
    return new Response(null, { status: 404 })
  }
  if (!dashboardLoaderFor(user)) {
    return new Response(null, { status: 404 })
  }

  const accountId = accountIdFor(db, sessionId)
  const key = getKey(sessionId!)
  // resolveState already proved a live key existed; this closes the window
  // where it expired between the two reads rather than throwing on undefined.
  if (accountId === undefined || !key) {
    return new Response(null, { status: 403 })
  }

  // CHECKED AFTER the auth checks, deliberately, exactly like the template
  // parses its body there: resolving a place is work done on behalf of the
  // caller, and an unauthenticated caller gets none of it.
  const place = PLACES[user]
  if (!place) return new Response(null, { status: 404 })

  const device_class = await readDeviceClass()
  // The zone the friend's browser reports, and the ONLY zone this route
  // consults. Every row it writes is filed against the friend's own calendar
  // through the same dayKey the dashboard's `today` comes from, so a query
  // comparing `day = today` cannot be comparing two different calendars. The
  // provider is asked for UTC instants precisely so it never gets a vote.
  const timeZone = await readTimeZone()

  // ONE clock read for the whole request. Two reads can straddle midnight and
  // file a row whose `day` and `at` disagree about the calendar, which is the
  // exact class of bug the timezone ledger is about.
  const now = Date.now()
  const attempt = {
    at: now,
    day: dayKey(now, timeZone),
    minuteOfDay: localMinuteOfDay(now, timeZone),
  }

  // FETCHED BEFORE THE DATABASE IS OPENED. The provider is allowed up to
  // FORECAST_TIMEOUT_MS, and holding an open handle on a friend's encrypted
  // database across a network round trip buys nothing — the failure still has
  // to be recorded afterwards either way, so the handle is opened once, at the
  // point there is an outcome to write.
  let snapshot: ForecastSnapshot | undefined
  let failure: string | undefined
  try {
    snapshot = await fetchForecast({
      fetch: globalThis.fetch,
      latitude: place.latitude,
      longitude: place.longitude,
    })
  } catch (error) {
    // A CODE, never the provider's prose — see ForecastError. Anything that is
    // not a ForecastError is a defect in our own normalisation rather than an
    // upstream problem, and 'error' says so without quoting it.
    failure = error instanceof ForecastError ? error.code : 'error'
  }

  let userDb: UserDb
  try {
    userDb = openUserDataForWrite(user, key)
  } catch (error) {
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: PANEL, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  }

  try {
    if (snapshot === undefined) {
      // THE FAILED ATTEMPT IS ITSELF A WRITE. It is what lets the panel say
      // "couldn't reach the forecast" instead of quietly showing the last one.
      recordAttempt(userDb, attempt, false)
    } else {
      replaceForecast(userDb, snapshot, attempt, timeZone)
    }
  } catch (error) {
    // A full disk, a SQLITE_BUSY outliving the driver's timeout, or a missing
    // table would otherwise throw straight out of POST: the friend gets Next's
    // default error page in response to a form submit, with no dashboard, no
    // chat surface and no way back, and no metric row, so it is invisible to
    // the operator too.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: PANEL, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  } finally {
    userDb.close()
  }

  // Permanent policy: a slug and a panel, never a value. Not the verdict, not
  // a temperature, not the place — `metrics` is the unencrypted platform
  // database, and this row is what makes the login page's "I can see when you
  // use it ... but not what you log" true.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel: PANEL, device_class },
    at: now,
  })

  // 502 ON AN UPSTREAM FAILURE, and the attempt row above is already written.
  // WriteAction surfaces a non-ok status to the friend as its own inline
  // error, and the refreshed page then renders the panel's "couldn't reach the
  // forecast" state from that row — the two agree because both are reading the
  // same recorded outcome.
  if (snapshot === undefined) {
    logDbFailure('forecast_fetch_failed', user, new Error(failure ?? 'error'))
    return new Response(null, { status: 502 })
  }

  // A native form post gets the host-relative 303 (the app runs behind a
  // reverse proxy, so request.url names the internal origin — see
  // lib/http/redirect.ts); a fetch-initiated write gets 204, so the browser
  // never follows a redirect it would otherwise render into a second
  // dashboard_open row.
  return writeAnswer(request, `/${user}`)
}

type Attempt = { at: number; day: string; minuteOfDay: number }

function recordAttempt(userDb: UserDb, attempt: Attempt, ok: boolean): void {
  userDb
    .prepare('INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, ?)')
    .run(attempt.at, attempt.day, attempt.minuteOfDay, ok ? 1 : 0)
}

/**
 * Swap in a whole new forecast, atomically.
 *
 * DELETE-THEN-INSERT RATHER THAN UPSERT, and inside one transaction. A
 * forecast is a SNAPSHOT, not a history: yesterday's guess about this
 * afternoon is worth nothing once a newer one exists, and leaving stale hours
 * behind would let a query walk off the end of the new forecast into rows the
 * provider no longer stands behind. The transaction is what stops a crash
 * mid-swap from leaving a database with no forecast at all AND a fetch row
 * claiming success.
 */
function replaceForecast(
  userDb: UserDb,
  snapshot: ForecastSnapshot,
  attempt: Attempt,
  timeZone: string | undefined,
): void {
  const hours = snapshot.hours.map((h) => ({
    at: h.at,
    day: dayKey(h.at, timeZone),
    minuteOfDay: localMinuteOfDay(h.at, timeZone),
    precipMm: h.precipMm,
    precipChance: h.precipChance,
    feelsLikeF: h.feelsLikeF,
  }))

  // A sunrise and a sunset that land on DIFFERENT local days are dropped
  // rather than stored. The pair is keyed by one day, and every daylight check
  // in users/run11/queries.ts compares minutes within a day — a pair split
  // across midnight would compare two clocks that never meet. It cannot happen
  // at 29°N; it is dropped rather than clamped because a missing day makes the
  // panel say it has no sunset for that day, and a clamped one would make it
  // confidently wrong.
  const sun = snapshot.sun
    .map((s) => ({
      day: dayKey(s.sunrise, timeZone),
      sunsetDay: dayKey(s.sunset, timeZone),
      sunriseMinute: localMinuteOfDay(s.sunrise, timeZone),
      sunsetMinute: localMinuteOfDay(s.sunset, timeZone),
    }))
    .filter((s) => s.day === s.sunsetDay)

  const insertHour = userDb.prepare(
    `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertDay = userDb.prepare(
    `INSERT INTO forecast_days (day, sunrise_minute, sunset_minute, fetched_at)
     VALUES (?, ?, ?, ?)`,
  )

  userDb.transaction(() => {
    userDb.prepare('DELETE FROM forecast_hours').run()
    userDb.prepare('DELETE FROM forecast_days').run()
    for (const h of hours) {
      insertHour.run(
        h.at,
        h.day,
        h.minuteOfDay,
        h.precipMm,
        h.precipChance,
        h.feelsLikeF,
        attempt.at,
      )
    }
    for (const s of sun) {
      insertDay.run(s.day, s.sunriseMinute, s.sunsetMinute, attempt.at)
    }
    recordAttempt(userDb, attempt, true)
  })()
}
