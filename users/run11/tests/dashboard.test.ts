// users/run11/tests/dashboard.test.ts
//
// What run11 actually sees. queries.test.ts proves the arithmetic; this proves
// the two panels put it on a screen, and — the part that matters most here —
// that the panel NEVER shows a verdict it cannot stand behind.
//
// THIS DASHBOARD'S CHARACTERISTIC FAILURE IS A CONFIDENT WRONG ANSWER, not a
// throw. It answers one question with one word, so an old forecast rendered
// without saying it is old, or a verdict computed from hours that are not
// there, is a friend standing outside in a thunderstorm with a green "Go" on
// the screen behind him. Every state below exists to make that impossible, and
// none of them is a state a rendering test would fail on by accident.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard, { screens } from '@/users/run11/dashboard'
import { applyUserMigrations, emptyDbFromMigrations } from '@/tests/support/userMigrations'

// JSX compiles to React.createElement, which this component's module expects
// to find globally — it is a server component rendered by CALLING it, not by
// mounting it, so nothing else brings React into scope.
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const TODAY = '2026-08-20'
const TOMORROW = '2026-08-21'
const SUNRISE = 6 * 60 + 53
const SUNSET = 19 * 60 + 56

const at = (day: string, minute: number) => Date.parse(`${day}T00:00:00Z`) + minute * 60_000

function freshDb(): UserDb {
  const db = new Database(':memory:')
  applyUserMigrations(db, 'run11')
  return db
}

function render(db: UserDb, today = TODAY): string {
  // JSON.stringify drops each element's `type` (a function is not JSON) and
  // keeps props and children — which is exactly what this needs: the copy each
  // panel chose, and the action URL the write control was handed.
  return JSON.stringify(Dashboard({ slug: 'run11', db, today, timeZone: 'UTC' }))
}

/**
 * A day of hours plus its sun row.
 *
 * `feelsAt` is asked per hour so a test states a shape rather than 24 numbers.
 */
function seedDay(
  db: UserDb,
  day: string,
  feelsAt: (hour: number) => number,
  rainyHours: number[] = [],
) {
  for (let h = 0; h < 24; h += 1) {
    const wet = rainyHours.includes(h)
    db.prepare(
      `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(at(day, h * 60), day, h * 60, wet ? 0.8 : 0, wet ? 70 : 10, feelsAt(h), at(day, 0))
  }
  db.prepare(
    'INSERT INTO forecast_days (day, sunrise_minute, sunset_minute, fetched_at) VALUES (?, ?, ?, ?)',
  ).run(day, SUNRISE, SUNSET, at(day, 0))
}

function seedFetch(db: UserDb, day: string, minute: number, ok = true) {
  db.prepare(
    'INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, ?)',
  ).run(at(day, minute), day, minute, ok ? 1 : 0)
}

/** A Houston August day: rain early, too hot all afternoon, walkable at 18:00. */
function houstonDay(db: UserDb, day = TODAY) {
  seedDay(db, day, (h) => (h < 8 ? 82 : h < 18 ? 99 : 88), [5, 6, 7, 8])
}

describe('users/run11 — screens', () => {
  it('declares the one screen the spec asks for', () => {
    // One screen, so app/[user]/page.tsx draws no tab strip at all. The title
    // is what spec.md calls it ("Add screen — Walk the dog?"); the id and
    // order are the builder's, since a change-only spec carries no ids, and
    // users/run11/current.md's `## Screens` is where they are written down.
    expect(screens).toEqual([{ id: 'walk_the_dog', title: 'Walk the dog?', order: 1 }])
  })
})

describe('users/run11 — the empty database', () => {
  it('renders on an EMPTY database without throwing', () => {
    // KEEP THIS ONE. There is no synthetic fallback: run11's first session
    // renders THEIR database, and it has nothing in it until the first
    // refresh lands. An empty dashboard is an ordinary state, not an error
    // (2026-08-15 migrations design, §9).
    const db = emptyDbFromMigrations('run11')
    try {
      expect(() => render(db)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('says what it is waiting for, and shows the control that provides it', () => {
    const db = emptyDbFromMigrations('run11')
    try {
      const json = render(db)
      expect(json).toContain('No forecast yet')
      expect(json).toContain('Press Refresh')
      // THE EMPTY STATE MUST NOT BE A DEAD END. Refresh is the only thing that
      // ever puts data here, so a state that hid it would leave run11 with a
      // dashboard that could never start working.
      expect(json).toContain('/api/users/run11/forecast')
      // And no verdict invented from nothing.
      expect(json).not.toContain('Don’t go')
      expect(json).not.toContain('>Go<')
    } finally {
      db.close()
    }
  })
})

describe('users/run11 — the verdict', () => {
  it('says GO on a clear, mild, daylit afternoon', () => {
    const db = freshDb()
    try {
      seedDay(db, TODAY, () => 78)
      seedFetch(db, TODAY, 14 * 60)
      const json = render(db)
      expect(json).toContain('Go')
      expect(json).toContain('No rain, feels like 78°F')
      expect(json).toContain('as of')
    } finally {
      db.close()
    }
  })

  it('says SHORT ONE in the 85–90 band, and names the temperature', () => {
    const db = freshDb()
    try {
      seedDay(db, TODAY, () => 88)
      seedFetch(db, TODAY, 14 * 60)
      const json = render(db)
      expect(json).toContain('short one, shade')
      expect(json).toContain('keep it short and stay in the shade')
    } finally {
      db.close()
    }
  })

  it('says DON’T GO and names EVERY failing check, not just the first', () => {
    const db = freshDb()
    try {
      // 11pm, hot and raining: all three checks fail at once, which in Houston
      // in August is routine rather than exotic.
      seedDay(db, TODAY, () => 99, [23])
      seedFetch(db, TODAY, 23 * 60)
      const json = render(db)
      expect(json).toContain('Don’t go')
      // Capitalised because it leads the sentence — the reason line names
      // all three, in the order spec v1 lists the checks.
      expect(json).toContain('Rain is expected (70% chance)')
      expect(json).toContain('99°F')
      expect(json).toContain('daylight')
    } finally {
      db.close()
    }
  })
})

describe('users/run11 — never a verdict it cannot stand behind', () => {
  it('refuses to render a verdict from an EARLIER DAY’s forecast', () => {
    const db = freshDb()
    try {
      // A full, walkable forecast — but fetched yesterday. Rendering its
      // verdict would be stale data presented as current, which
      // docs/dashboard-ui-ux-guidelines.md > States forbids by name.
      seedDay(db, TODAY, () => 78)
      seedFetch(db, '2026-08-19', 14 * 60)
      const json = render(db)
      expect(json).toContain('Out of date')
      expect(json).toContain('from an earlier day')
      expect(json).toContain('2026-08-19')
      expect(json).not.toContain('No rain, feels like')
      // The window panel goes quiet with it rather than answering from the
      // same stale rows.
      expect(json).toContain('Nothing to show until there’s a current forecast')
    } finally {
      db.close()
    }
  })

  it('says so when the forecast does not cover the next 40 minutes', () => {
    const db = freshDb()
    try {
      // Only the morning is on file; the walk asked about is at 23:30.
      for (let h = 0; h < 12; h += 1) {
        db.prepare(
          `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
           VALUES (?, ?, ?, 0, 10, 78, ?)`,
        ).run(at(TODAY, h * 60), TODAY, h * 60, at(TODAY, 0))
      }
      seedFetch(db, TODAY, 23 * 60 + 30)
      const json = render(db)
      expect(json).toContain('No answer yet')
      // WALK_MINUTES is interpolated, so JSX splits the sentence into
      // children either side of the number — assert the halves.
      expect(json).toContain('doesn’t cover the next ')
      expect(json).toContain('40')
      expect(json).toContain(' minutes. Refresh to pull a current one.')
    } finally {
      db.close()
    }
  })

  it('keeps last-known data BUT SAYS the last refresh failed', () => {
    const db = freshDb()
    try {
      seedDay(db, TODAY, () => 78)
      seedFetch(db, TODAY, 9 * 60, true)
      seedFetch(db, TODAY, 14 * 60, false)
      const json = render(db)
      // This is a read refreshing, so the guidelines' pattern is last-known
      // data plus a quiet indicator — never a blank panel, and never silence.
      expect(json).toContain('No rain, feels like 78°F')
      expect(json).toContain('Couldn’t reach the forecast on the last try')
      // And the "as of" reads from the SUCCESSFUL fetch, not the failed one.
      expect(json).toContain('9:00 AM')
    } finally {
      db.close()
    }
  })
})

describe('users/run11 — next good window', () => {
  it('names tonight’s window and that it closes at dark', () => {
    const db = freshDb()
    try {
      houstonDay(db)
      seedFetch(db, TODAY, 14 * 60)
      const json = render(db)
      expect(json).toContain('From 6:00 PM')
      // AND WHY IT ENDS. Naming a closing time with no reason reads as a
      // glitch — Nico's v1 review, prompted by a legitimate 20-minute window
      // on a real Houston forecast.
      expect(json).toContain('Head out any time up to 7:10 PM')
      expect(json).toContain('you wouldn’t be back before dark')
    } finally {
      db.close()
    }
  })

  it('says the window is OPEN NOW rather than naming a time already past', () => {
    const db = freshDb()
    try {
      houstonDay(db)
      seedFetch(db, TODAY, 18 * 60 + 30)
      const json = render(db)
      expect(json).toContain('Open now')
      expect(json).not.toContain('From 6:00 PM')
    } finally {
      db.close()
    }
  })

  it('points at TOMORROW MORNING once today is gone', () => {
    const db = freshDb()
    try {
      houstonDay(db)
      seedDay(db, TOMORROW, (h) => (h < 10 ? 82 : 99))
      seedFetch(db, TODAY, 21 * 60)
      const json = render(db)
      expect(json).toContain('Tomorrow, from')
      // Bounded by HEAT rather than darkness, and it says so — with the
      // temperature that actually closes it, not the 90°F threshold. "up to
      // 99°F" is a fact about tomorrow; "above 90°F" is a fact about our own
      // settings, and the friend did not pick those.
      expect(json).toContain('any time up to')
      expect(json).toContain('it’s up to 99°F')
    } finally {
      db.close()
    }
  })

  it('reproduces the twenty-minute window from Nico’s v1 review, and now explains it', () => {
    // THE REGRESSION THIS PANEL'S SECOND LINE EXISTS FOR. A real Houston
    // August forecast dipped under 90°F for two scan steps around dawn and
    // peaked at 110°F; the panel said "good to head out any time up to
    // 7:20 AM" and gave no reason, which reads as a glitch rather than as a
    // forecast. The window was correct. The explanation was missing.
    const db = freshDb()
    try {
      houstonDay(db)
      seedDay(db, TOMORROW, (h) => (h < 8 ? 84 : 99))
      seedFetch(db, TODAY, 21 * 60)
      const json = render(db)
      expect(json).toContain('Tomorrow, from 7:00 AM')
      expect(json).toContain('Head out any time up to 7:20 AM')
      expect(json).toContain('after that it’s up to 99°F')
    } finally {
      db.close()
    }
  })

  it('says a one-slot window is the only good start, rather than "up to" its own start', () => {
    // Tomorrow clears the checks for a SINGLE scan step. "Head out any time up
    // to 7:20 AM" when it also starts at 7:20 AM reads as a bug, and this is
    // the window whose reason matters most.
    const db = freshDb()
    try {
      houstonDay(db)
      seedDay(db, TOMORROW, (h) => (h < 8 ? 84 : 99))
      // Sunrise at 7:20, so the first scan step is the last one too: 7:30
      // would run into the 8:00 hour.
      db.prepare('UPDATE forecast_days SET sunrise_minute = ? WHERE day = ?').run(
        7 * 60 + 20,
        TOMORROW,
      )
      seedFetch(db, TODAY, 21 * 60)
      const json = render(db)
      expect(json).toContain('That’s the only good start')
      expect(json).not.toContain('any time up to')
      expect(json).toContain('it’s up to 99°F')
    } finally {
      db.close()
    }
  })

  it('says plainly when neither day offers one', () => {
    const db = freshDb()
    try {
      seedDay(db, TODAY, () => 105)
      seedDay(db, TOMORROW, () => 105)
      seedFetch(db, TODAY, 14 * 60)
      const json = render(db)
      expect(json).toContain('-minute stretch today or tomorrow clears rain, heat and daylight')
    } finally {
      db.close()
    }
  })
})
