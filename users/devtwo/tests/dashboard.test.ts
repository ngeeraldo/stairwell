// users/devtwo/tests/dashboard.test.ts
//
// The component's WIRING. Each panel's computed value must reach the output —
// the mutation devone's suite proved worth pinning, and the one that survived
// undetected for ChatPanel through all of step 4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import DevTwoDashboard, { screens } from '@/users/devtwo/dashboard'
import { dayKey } from '@/lib/time/dayKey'
import { applyUserMigrations, emptyDbFromMigrations } from '@/tests/support/userMigrations'


let dir: string
let db: UserDb

const DAY = 86_400_000

/**
 * The day the DASHBOARD will be told it is, and the days around it.
 *
 * A fixed zone, so the fixtures are the same wherever this suite runs — and
 * the same function the platform uses, so a test can never assert against a
 * calendar the product does not have. `dayKeyOf` used to be imported from
 * queries.ts for this; it is private now, because exporting it is what let the
 * dashboard derive its own day.
 */
const ZONE = 'America/New_York'
const today = () => dayKey(Date.now(), ZONE)
/** The render instant the page would have handed down, from the same clock. */
const NOW = Date.now()
const daysAgo = (n: number) => dayKey(Date.now() - n * DAY, ZONE)

function walked(...days: string[]) {
  const stmt = db.prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)')
  for (const day of days) stmt.run(day, 1)
}

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devtwo-dash-'))
  db = new Database(join(dir, 'synthetic.db'))
  applyUserMigrations(db, 'devtwo')
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('users/devtwo/dashboard.tsx', () => {
  it('shows today as walked, with the streak and percentage computed', async () => {
    walked(today(), daysAgo(1), daysAgo(2))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))

    expect(json).toContain('WALKED')
    // 3 of 30 = 10%. A hard-coded panel cannot produce this.
    //
    // Matched against the SERIALIZED shape, not naive concatenation:
    // `<p>{month.percent}%</p>` compiles to two JSX children (a number and a
    // literal '%'), so JSON.stringify renders them as a comma-separated
    // array element — `[10,"%"]` — never the substring "10%". Same
    // convention users/devone/tests/dashboard.test.ts already pins for its
    // own multi-child <li>.
    expect(json).toContain('[10,"%"]')
    expect(json).toContain('[3," of ",30," days"]')
    // The streak panel: this test's own title claims to cover it, and until
    // now nothing here did — deleting the whole Current-streak panel, or
    // replacing {streak} with a literal, left every assertion above green.
    // `"children":3}` (no trailing comma) is the single-number child of
    // <p>{streak}</p>; it cannot be confused with month.walked's `3`, which
    // only ever appears inside the array child above.
    expect(json).toContain('{"type":"p","key":null,"props":{"children":3}')
    expect(json).toContain('"children":"days in a row"}')
  })

  it('singularises the streak label to "day in a row" at exactly one', async () => {
    walked(today())

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))

    expect(json).toContain('{"type":"p","key":null,"props":{"children":1}')
    expect(json).toContain('"children":"day in a row"}')
  })

  it('shows the not-yet state and offers the tap when today is unlogged', async () => {
    walked(daysAgo(1))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))

    expect(json).toContain('NOT YET')
    // The control is the whole product. It must post to the write path.
    expect(json).toContain('/api/users/devtwo/walk')
  })

  it('wires the tap to WriteAction with the walk route and an empty payload', async () => {
    // Asserts the NEW control by its own props — action and payload together
    // in one string — rather than a substring that would also have matched
    // the old <form>/<button> markup. The walk route reads no form field (see
    // app/api/users/[user]/walk/route.ts), so an empty payload is correct,
    // not a placeholder pending a field that never arrives.
    walked(daysAgo(1))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))

    expect(json).toContain('"action":"/api/users/devtwo/walk","payload":{}')
    expect(json).toContain('"pendingLabel":"Marking…"')
  })

  it('renders 14 day markers once anything has been logged', async () => {
    // WAS "whatever the data", and that was the bug. Rendering the grid
    // unconditionally meant a friend's first morning showed fourteen rows
    // reading "missed" — days that passed before their dashboard existed.
    walked(daysAgo(3))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))
    // JSON.stringify renders an object key as `"data-day":`, never
    // `data-day=` — that HTML-attribute syntax only exists once Next
    // renders this element tree to a markup string, which this unit test
    // does not do.
    expect(json.match(/"data-day":/g) ?? []).toHaveLength(14)
  })

  it('does NOT call fourteen untouched days missed before anything is logged', async () => {
    // The empty database every friend has on the morning their dashboard
    // ships. "Missed" is a judgement, and there is nothing yet to judge.
    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))

    expect(json).toContain('Nothing logged yet')
    expect(json).not.toContain('missed')
    expect(json.match(/"data-day":/g) ?? []).toHaveLength(0)
  })

  it('renders the 14 days oldest-first ending today, each correctly marked', async () => {
    // A component emitting fourteen hard-coded <li data-day="x"
    // data-walked="no"> markers satisfies a bare length-14 count. This pins
    // the actual values, their order, and that data-walked genuinely
    // differs between a walked and a missed day in the SAME render — the
    // query->output wiring queries.test.ts cannot cover from the query side
    // alone.
    walked(today(), daysAgo(2))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))

    const order = [...json.matchAll(/"data-day":"([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(Array.from({ length: 14 }, (_, i) => daysAgo(13 - i)))

    expect(json).toContain(`"data-day":"${today()}","data-walked":"yes"`)
    expect(json).toContain(`"data-day":"${daysAgo(1)}","data-walked":"no"`)
  })

  it('renders an empty database without throwing', async () => {
    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db, today: today(), now: NOW, timeZone: ZONE }))
    expect(json).toContain('NOT YET')
    expect(json).toContain('[0,"%"]')
  })
})

it('declares exactly one honest screen — devtwo predates spec.md', () => {
  // Task 23: devtwo is hand-written and pre-spec, so there is no spec.md to
  // pull an id/title from — see the comment above `export const screens` in
  // dashboard.tsx.
  expect(screens).toEqual([{ id: 'morning', title: 'Daily walk', order: 1 }])
})

it('renders on an EMPTY database without throwing', async () => {
  // There is no synthetic fallback any more: a friend's first session renders
  // THEIR database, and it has no rows in it. That is an ordinary state, not
  // an error (2026-08-15 migrations design, §9), so this is a required test
  // for every dashboard rather than a nicety.
  //
  // Awaited, because the page CALLS the component rather than returning an
  // element — a throw inside a nested component would otherwise be deferred
  // past this assertion into React's render pass.
  const empty = emptyDbFromMigrations('devtwo')
  try {
    // Promise.resolve so this holds whether the component is async or
    // not — two of the three dashboards are synchronous, and a test that
    // assumed otherwise would pass for the wrong reason.
    const rendered = await Promise.resolve(
      DevTwoDashboard({ slug: 'devtwo', db: empty, today: '2026-01-01', now: Date.parse('2026-01-01T12:00:00Z'), timeZone: 'UTC' }),
    )
    expect(rendered).toBeDefined()
  } finally {
    empty.close()
  }
})
