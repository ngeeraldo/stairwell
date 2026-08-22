// users/run10/tests/dashboard.test.ts
//
// What run10 actually sees. queries.test.ts proves the arithmetic; this proves
// the two panels put it on a screen — and, above all, that the chart is NEVER
// mounted over data that cannot be charted.
//
// THE CHART GUARD IS THE POINT OF THIS FILE. A data-computing component
// (Recharts) is sanctioned inside a dashboard only because degenerate data
// renders the panel's empty state as host elements instead
// (docs/dashboard-build-rules.md §3, arm 2) — the accepted residual is a throw
// on WELL-FORMED props, and these tests are what keep it to that. Without them
// the exception is unguarded and the first screen a friend ever sees is the
// one at risk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard, { screens } from '@/users/run10/dashboard'
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

// A Thursday, so the weekday labels below are stable and nameable.
const TODAY = '2026-08-20'
/**
 * The render instant the page would have handed down for a given day.
 *
 * Derived from the same day the test asked for, so `today` and `now` agree
 * the way app/[user]/page.tsx guarantees they do.
 */
const atMidday = (day: string) => Date.parse(`${day}T12:00:00Z`)
/** The render instant the page would have handed down, on TODAY. */
const NOW = Date.parse(`${TODAY}T12:00:00Z`)

function render(db: UserDb, today = TODAY): string {
  // JSON.stringify drops the `type` of every element (a function is not JSON)
  // and keeps props and children, which is exactly what this needs: the copy
  // each panel chose, and the `data` prop handed to the chart if one was
  // handed at all.
  return JSON.stringify(Dashboard({ slug: 'run10', db, today, now: atMidday(today), timeZone: 'UTC' }))
}

/**
 * Whether the Recharts component was handed anything to draw.
 *
 * `count` reaches the output through exactly one path — TrendChart's `data`
 * prop — so its presence is the honest question "was the chart mounted", not a
 * proxy for it.
 */
function chartMounted(json: string): boolean {
  return json.includes('"count":')
}

function seed(db: UserDb, day: string, n: number): void {
  const at = Date.parse(`${day}T07:00:00Z`)
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, at + i * 3_600_000)
  }
}

function freshDb(): UserDb {
  const db = new Database(':memory:')
  applyUserMigrations(db, 'run10')
  return db
}

describe('users/run10 — screens', () => {
  it('declares the one screen the spec asks for', () => {
    // One screen, so app/[user]/page.tsx draws no tab strip at all. The title
    // is what spec.md calls it ("Add screen — Pee Tracker"); the id and order
    // are the builder's, and users/run10/current.md's `## Screens` is where
    // they are written down.
    expect(screens).toEqual([{ id: 'pee_tracker', title: 'Pee Tracker', order: 1 }])
  })
})

describe('users/run10 — an empty database', () => {
  it('renders on an EMPTY database without throwing', () => {
    // KEEP THIS ONE. There is no synthetic fallback: a friend's first session
    // renders THEIR database, and it has nothing in it. An empty dashboard is
    // an ordinary state, not an error (2026-08-15 migrations design, §9).
    const db = emptyDbFromMigrations('run10')
    try {
      expect(Dashboard({ slug: 'run10', db, today: TODAY, now: NOW, timeZone: 'UTC' })).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('NEVER mounts the chart on an empty database', () => {
    // The explicit half of the rule: the empty-database first render must show
    // empty states, not charts.
    const db = emptyDbFromMigrations('run10')
    try {
      const json = render(db)
      expect(chartMounted(json)).toBe(false)
      expect(json).toContain('Nothing to chart yet. Your first tap starts this.')
    } finally {
      db.close()
    }
  })

  it('invites a first tap rather than reporting a week of failure', () => {
    // A day before run10 started is not a day they logged nothing. The count
    // is a true zero and says so; the week says nothing at all, and no average
    // is claimed over days that never existed.
    const db = emptyDbFromMigrations('run10')
    try {
      const json = render(db)
      expect(json).toContain('Tap below to log your first one.')
      expect(json).not.toContain('Nothing logged yet today.')
      expect(json).not.toContain('a day')
    } finally {
      db.close()
    }
  })

  it('still offers the log button, which is the only thing to do on day one', () => {
    const db = emptyDbFromMigrations('run10')
    try {
      expect(render(db)).toContain('/api/users/run10/pee-log')
    } finally {
      db.close()
    }
  })
})

describe('users/run10 — the chart guard', () => {
  it('does not mount the chart on a single day', () => {
    const db = freshDb()
    try {
      seed(db, TODAY, 4)
      const json = render(db)
      expect(chartMounted(json)).toBe(false)
      expect(json).toContain('One day so far — the chart fills in from tomorrow.')
    } finally {
      db.close()
    }
  })

  it('does not mount the chart when every day in the window is zero', () => {
    // Reachable, and it is not the single-day case: the last log predates the
    // window entirely, so the trend is seven real zeros. Saying "one day so
    // far" here would be false to someone who used this for a month and
    // stopped, which is why the copy has a third branch.
    const db = freshDb()
    try {
      seed(db, '2026-07-20', 5)
      const json = render(db)
      expect(chartMounted(json)).toBe(false)
      expect(json).toContain('Nothing logged in the last 7 days.')
      expect(json).not.toContain('One day so far')
    } finally {
      db.close()
    }
  })

  it('mounts the chart once there are two days with something in them', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 6)
      seed(db, TODAY, 4)
      const json = render(db)
      expect(chartMounted(json)).toBe(true)
      expect(json).not.toContain('Nothing to chart yet')
      expect(json).not.toContain('One day so far')
    } finally {
      db.close()
    }
  })
})

describe('users/run10 — the average alongside the chart', () => {
  it('draws the average as a reference line over the bars it averages', () => {
    // "Alongside it, the daily average across those seven days" — and it is
    // the mean of exactly these bars, today included: (6 + 4) / 2.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 6)
      seed(db, TODAY, 4)
      expect(render(db)).toContain('"average":5')
    } finally {
      db.close()
    }
  })

  it('says its denominator out loud while the window is still clipped', () => {
    // A panel labelled "last 7 days" that quietly averaged two days would be
    // lying about its own basis.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 6)
      seed(db, TODAY, 4)
      const json = render(db)
      expect(json).toContain('averaged over')
      expect(json).toContain('2 days')
      expect(json).toContain(' so far')
    } finally {
      db.close()
    }
  })

  it('shows NO average on day one, where it would only repeat today’s count', () => {
    // The average is the chart's reference line made legible, so it appears
    // with the chart and not without it. On a single day it would print the
    // number already sitting at the top of the screen and call it an average.
    const db = freshDb()
    try {
      seed(db, TODAY, 4)
      const json = render(db)
      expect(chartMounted(json)).toBe(false)
      expect(json).not.toContain('a day')
      expect(json).not.toContain('averaged over')
    } finally {
      db.close()
    }
  })

  it('shows NO average over a week with nothing in it', () => {
    // "0 a day" over copy that already says nothing was logged in the last
    // seven days is a true number that adds nothing.
    const db = freshDb()
    try {
      seed(db, '2026-07-20', 5)
      const json = render(db)
      expect(json).toContain('Nothing logged in the last 7 days.')
      expect(json).not.toContain('a day')
    } finally {
      db.close()
    }
  })

  it('drops the caption once a full week is being averaged', () => {
    const db = freshDb()
    try {
      for (let back = 0; back < 9; back++) {
        seed(db, `2026-08-${String(20 - back).padStart(2, '0')}`, 5)
      }
      const json = render(db)
      expect(json).toContain('"average":5')
      expect(json).not.toContain('averaged over')
    } finally {
      db.close()
    }
  })
})

describe('users/run10 — the glance and its control', () => {
  it('shows today’s count as a number, not a chart', () => {
    const db = freshDb()
    try {
      seed(db, TODAY, 5)
      const json = render(db)
      expect(json).toContain('5')
      expect(json).toContain('times today')
    } finally {
      db.close()
    }
  })

  it('says "time today" in the singular', () => {
    const db = freshDb()
    try {
      seed(db, TODAY, 1)
      expect(render(db)).toContain('time today')
    } finally {
      db.close()
    }
  })

  it('renders a confident zero on a day with nothing logged YET', () => {
    // A zero here is data, not absence: "you have not been yet today" is true
    // and useful, and the midnight reset means every day starts there. It is
    // only the never-logged-anything case that gets an empty state instead.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 3)
      const json = render(db)
      expect(json).toContain('Nothing logged yet today.')
      expect(json).not.toContain('Tap below to log your first one.')
    } finally {
      db.close()
    }
  })

  it('wires the log button to WriteAction with the right action URL and payload', () => {
    // `action` (the URL prop) and `payload` (the body) are checked together in
    // one string, so a control wired to the right URL with the wrong payload —
    // or vice versa — fails this test. run10 posts to its OWN route, not
    // run9's /pee.
    const db = freshDb()
    try {
      seed(db, TODAY, 2)
      const json = render(db)
      expect(json).toContain(
        '"action":"/api/users/run10/pee-log","payload":{"action":"add"},"size":"lg"',
      )
      expect(json).toContain('"pendingLabel":"Logging…"')
    } finally {
      db.close()
    }
  })

  it('renders exactly one control, and nothing that takes a tap back', () => {
    // v1 asks for a tap button and nothing else that writes. A correction
    // control is a spec version away, not something to slip in — and the route
    // refuses any action but `add`, so a stray control here would be a button
    // that 400s.
    const db = freshDb()
    try {
      seed(db, TODAY, 2)
      const json = render(db)
      expect(json.match(/"payload":\{"action":"add"\}/g)).toHaveLength(1)
      expect(json).not.toContain('remove')
    } finally {
      db.close()
    }
  })
})

describe('users/run10 — a failing read degrades the panel, not the product', () => {
  /**
   * A handle whose history reads throw and whose today-count read does not.
   *
   * Narrow on purpose: it fails exactly the statements the week panel adds
   * (the MIN(day) probe and the GROUP BY), leaving countOn's own statement
   * working. That is the real-world shape of this failure — one table, one
   * handle, and a query that trips over something the simplest read does not.
   */
  function brokenHistory(db: UserDb): UserDb {
    return {
      prepare(sql: string) {
        if (sql.includes('GROUP BY') || sql.includes('MIN(day)')) {
          throw new Error('no such table: pee_logs')
        }
        return db.prepare(sql)
      },
    } as unknown as UserDb
  }

  it('keeps the count and the log button when the week cannot be read', () => {
    // The log button IS the product — the spec calls this "the panel used in
    // the moment, several times a day". Letting a history failure propagate
    // would hand the whole render to app/[user]/page.tsx's catch and replace
    // every panel with "This dashboard failed to load", including the only
    // control that lets run10 record anything.
    const db = freshDb()
    try {
      seed(db, TODAY, 2)
      const json = render(brokenHistory(db))
      expect(json).toContain('/api/users/run10/pee-log')
      expect(json).toContain('2')
      expect(json).toContain('times today')
    } finally {
      db.close()
    }
  })

  it('says so rather than showing a stale, empty or zeroed week', () => {
    // Degrades HONESTLY: it never renders partial data as if it were current,
    // and it never renders the "nothing logged yet" empty state over data it
    // simply could not read — those mean different things to the reader.
    const db = freshDb()
    try {
      seed(db, TODAY, 2)
      const json = render(brokenHistory(db))
      expect(json).toContain("Couldn't load the last ")
      expect(json).toContain(' days just now. Logging still works.')
      expect(json).not.toContain('Nothing to chart yet')
      expect(json).not.toContain('Nothing logged in the last')
    } finally {
      db.close()
    }
  })

  it('claims no average it could not compute', () => {
    const db = freshDb()
    try {
      seed(db, TODAY, 2)
      const json = render(brokenHistory(db))
      expect(json).not.toContain('a day')
      expect(json).not.toContain('averaged over')
    } finally {
      db.close()
    }
  })

  it('does not mount the chart over a failed read', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 6)
      seed(db, TODAY, 4)
      expect(chartMounted(render(brokenHistory(db)))).toBe(false)
    } finally {
      db.close()
    }
  })

  it('never claims a first tap it cannot prove', () => {
    // With no rows today AND no readable history, "Tap below to log your first
    // one" would be a guess — this account may have months of data.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 3)
      const json = render(brokenHistory(db))
      expect(json).not.toContain('Tap below to log your first one.')
      expect(json).toContain('Nothing logged yet today.')
    } finally {
      db.close()
    }
  })
})
