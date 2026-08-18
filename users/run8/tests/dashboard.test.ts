// users/run8/tests/dashboard.test.ts
//
// What the component renders, over the two databases that actually occur: an
// empty one (a friend's first morning) and one with history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard, { screens } from '@/users/run8/dashboard'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'

// JSX compiles to React.createElement, which this component's module expects
// to find globally — it is a server component rendered by CALLING it, not by
// mounting it, so nothing else brings React into scope.
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const TODAY = '2026-08-16' // a Sunday, so a full Mon–Sun week is in range

function render(db: UserDb, today = TODAY): string {
  return JSON.stringify(Dashboard({ slug: 'run8', db, today, timeZone: 'UTC' }))
}

function tap(db: UserDb, day: string, delta: number, times = 1): void {
  const insert = db.prepare('INSERT INTO pee_events (day, at, delta) VALUES (?, ?, ?)')
  for (let i = 0; i < times; i++) insert.run(day, 1, delta)
}

describe('users/run8 dashboard', () => {
  let db: UserDb

  beforeEach(() => {
    db = emptyDbFromMigrations('run8')
  })
  afterEach(() => {
    db.close()
  })

  it('declares the screen spec.md confirmed', () => {
    // The id and title are the spec's own words (`### \`tracker\` — Bathroom
    // count`), never a second source that could drift from what was confirmed.
    expect(screens).toEqual([{ id: 'tracker', title: 'Bathroom count', order: 1 }])
  })

  it('renders on an EMPTY database without throwing', () => {
    // KEEP THIS ONE. A friend's first session renders THEIR database, and it
    // has nothing in it — there is no synthetic fallback standing in front of
    // it. Anything reaching for rows[0] without a guard is a defect this
    // catches before the friend does.
    expect(render(db)).toBeDefined()
  })

  it('says nothing is logged yet rather than drawing a week of zeroes', () => {
    // The devtwo mistake, in this dashboard's shape: seven empty bars on a
    // first morning would report days the friend had no dashboard on as days
    // they went nowhere (build-rules §6).
    const html = render(db)
    expect(html).toContain('Nothing logged yet')
    expect(html).not.toContain('Averaging')
  })

  it('still shows a live zero counter on an empty database', () => {
    // "0 today" at 7am is TRUE and is the cue to press plus — unlike a week of
    // zero bars, which is a claim about days nobody has any standing to judge.
    // So the counter renders, and the plus button is present and enabled.
    const html = render(db)
    expect(html).toContain('Add one to today')
  })

  it('disables minus at zero so the button cannot lie about what it will do', () => {
    // The route refuses a minus that would take a day below zero. If the
    // control stayed live it would invite a press that silently does nothing.
    expect(render(db)).toContain('"disabled":true')

    tap(db, TODAY, 1)
    expect(render(db)).toContain('"disabled":false')
  })

  it("shows today's net total, not its number of rows", () => {
    tap(db, TODAY, 1, 5)
    tap(db, TODAY, -1)
    // Six rows, net four. A panel counting rows would say 6.
    expect(render(db)).toContain('4')
  })

  it('posts each button to the platform count route', () => {
    // A dashboard never holds a writable handle; the widget POSTs to a route
    // (build-rules §4). Both buttons, and the delta each carries.
    const html = render(db)
    expect(html).toContain('/api/users/run8/count')
    expect(html).toContain('"value":"-1"')
    expect(html).toContain('"value":"1"')
  })

  it('names the weekday from the day it was handed, not from a clock', () => {
    expect(render(db, '2026-08-16')).toContain('Sunday')
    expect(render(db, '2026-08-12')).toContain('Wednesday')
  })

  it('renders both chart views so CSS alone switches between them', () => {
    // Both are in the markup at once and :has() decides which is visible —
    // no client component, and therefore no nested function component whose
    // body would render outside the page's try/catch (build-rules §3).
    tap(db, TODAY, 1, 3)
    const html = render(db)
    expect(html).toContain('run8-view-daily')
    expect(html).toContain('run8-view-weekly')
    expect(html).toContain('Averaging')
  })
})
