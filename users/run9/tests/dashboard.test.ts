// users/run9/tests/dashboard.test.ts
//
// What run9 actually sees. queries.test.ts proves the arithmetic; this proves
// the four panels put it on a screen — and, above all, that the chart is NEVER
// mounted over data that cannot be charted.
//
// THE CHART GUARD IS THE POINT OF THIS FILE. Nico's ruling of 2026-08-19
// sanctions a data-computing component (Recharts) inside a dashboard only
// because degenerate data renders the panel's empty state as host elements
// instead — the accepted residual is a throw on WELL-FORMED props, and these
// tests are what keep it to that. Without them the exception is unguarded and
// the first screen a friend ever sees is the one at risk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard, { screens } from '@/users/run9/dashboard'
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

function render(db: UserDb, today = '2026-08-19'): string {
  // JSON.stringify drops the `type` of every element (a function is not JSON)
  // and keeps props and children, which is exactly what this needs: the copy
  // each panel chose, and the `data` prop handed to the chart if one was
  // handed at all.
  return JSON.stringify(
    Dashboard({ slug: 'run9', db, today, now: Date.parse(`${today}T12:00:00Z`), timeZone: 'UTC' }),
  )
}

/**
 * Whether the Recharts component was handed anything to draw.
 *
 * `count` reaches the output through exactly one path — TrendChart's `data`
 * prop — so its presence is the honest question "was the chart mounted", not
 * a proxy for it.
 */
function chartMounted(json: string): boolean {
  return json.includes('"count":')
}

function seed(db: UserDb, day: string, n: number): void {
  const at = Date.parse(`${day}T08:00:00Z`)
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO pee_logs (day, at) VALUES (?, ?)').run(day, at + i * 3_600_000)
  }
}

function freshDb(): UserDb {
  const db = new Database(':memory:')
  applyUserMigrations(db, 'run9')
  return db
}

describe('users/run9 — screens', () => {
  it('declares the one screen the spec asks for', () => {
    // One screen, so app/[user]/page.tsx draws no tab strip at all. The title
    // is what spec.md calls it; the id and order are the builder's, and
    // users/run9/current.md's `## Screens` is where they are written down.
    expect(screens).toEqual([{ id: 'pee_tracker', title: 'Pee Tracker', order: 1 }])
  })
})

describe('users/run9 — an empty database', () => {
  it('renders on an EMPTY database without throwing', () => {
    // KEEP THIS ONE. There is no synthetic fallback: a friend's first session
    // renders THEIR database, and it has nothing in it. An empty dashboard is
    // an ordinary state, not an error (2026-08-15 migrations design, §9).
    const db = emptyDbFromMigrations('run9')
    try {
      expect(Dashboard({ slug: 'run9', db, today: '2026-08-19', now: Date.parse('2026-08-19T12:00:00Z'), timeZone: 'UTC' })).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('NEVER mounts the chart on an empty database', () => {
    // The explicit half of Nico's ruling: "The empty-database first render
    // must show empty states, not charts."
    const db = emptyDbFromMigrations('run9')
    try {
      const json = render(db)
      expect(chartMounted(json)).toBe(false)
      expect(json).toContain('Nothing to chart yet')
    } finally {
      db.close()
    }
  })

  it('invites a first tap rather than reporting a week of failure', () => {
    // A day before run9 started is not a day they logged nothing. The count
    // is a true zero and says so; the trend says nothing at all.
    const db = emptyDbFromMigrations('run9')
    try {
      const json = render(db)
      expect(json).toContain('Tap below to log your first one.')
      expect(json).toContain('Not enough days yet')
      expect(json).not.toContain('Nothing logged yet today.')
    } finally {
      db.close()
    }
  })
})

describe('users/run9 — the chart guard', () => {
  it('does not mount the chart on a single day', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 4)
      const json = render(db)
      expect(chartMounted(json)).toBe(false)
      expect(json).toContain('One day so far')
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
      seed(db, '2026-08-18', 6)
      seed(db, '2026-08-19', 4)
      const json = render(db)
      expect(chartMounted(json)).toBe(true)
      expect(json).not.toContain('Nothing to chart yet')
      expect(json).not.toContain('One day so far')
    } finally {
      db.close()
    }
  })

  it('hands the chart the baseline to draw its reference line against', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-18', 6)
      seed(db, '2026-08-19', 4)
      // Today is excluded from the average, so the line sits at the 18th's 6.
      expect(render(db)).toContain('"average":6')
    } finally {
      db.close()
    }
  })
})

describe('users/run9 — the glance and its controls', () => {
  it('shows today’s count as a number, not a chart', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 5)
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
      seed(db, '2026-08-19', 1)
      expect(render(db)).toContain('time today')
    } finally {
      db.close()
    }
  })

  it('renders a confident zero on a day with nothing logged YET', () => {
    // A zero here is data, not absence: "you have not been yet today" is true
    // and useful. It is only the never-logged-anything case that gets an
    // empty state instead.
    const db = freshDb()
    try {
      seed(db, '2026-08-18', 3)
      const json = render(db)
      expect(json).toContain('Nothing logged yet today.')
      expect(json).not.toContain('Tap below to log your first one.')
    } finally {
      db.close()
    }
  })

  it('posts to run9’s own route, with an explicit action on every control', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 2)
      const json = render(db)
      expect(json).toContain('/api/users/run9/pee')
      expect(json).toContain('"payload":{"action":"add"}')
      expect(json).toContain('"payload":{"action":"remove"}')
    } finally {
      db.close()
    }
  })

  it('wires the log button to WriteAction with the right action URL and payload', () => {
    // Asserts the NEW control, not a substring that would also match the old
    // <form>/<input> markup. `action` (the URL prop) and `payload` (the body)
    // are both checked together, in one string, so a control wired to the
    // right URL with the wrong payload — or vice versa — fails this test.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 2)
      const json = render(db)
      expect(json).toContain(
        '"action":"/api/users/run9/pee","payload":{"action":"add"},"size":"lg"',
      )
      expect(json).toContain('"pendingLabel":"Logging…"')
    } finally {
      db.close()
    }
  })

  it('wires the −1/+1 correction controls to WriteAction with the right payloads', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 2)
      const json = render(db)
      expect(json).toContain(
        '"action":"/api/users/run9/pee","payload":{"action":"remove"},"variant":"outline","size":"sm"',
      )
      expect(json).toContain(
        '"action":"/api/users/run9/pee","payload":{"action":"add"},"variant":"outline","size":"sm"',
      )
    } finally {
      db.close()
    }
  })

  it('disables the −1 control at zero, so the count cannot be nudged negative', () => {
    // The affordance, not the rule — the route enforces the bound too, and
    // tests/routing/peeRoute.test.ts is what pins that half.
    const db = freshDb()
    try {
      expect(render(db)).toContain('"disabled":true')
      seed(db, '2026-08-19', 1)
      expect(render(db)).toContain('"disabled":false')
    } finally {
      db.close()
    }
  })
})

describe('users/run9 — a failing read degrades the panel, not the product', () => {
  /**
   * A handle whose history reads throw and whose today-count read does not.
   *
   * Narrow on purpose: it fails exactly the statements the two derived panels
   * add (the MIN(day) probe and the GROUP BY), leaving countOn's own statement
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

  it('keeps the count and the log button when the history cannot be read', () => {
    // The log button IS the product. Letting a history failure propagate would
    // hand the whole render to app/[user]/page.tsx's catch and replace every
    // panel with "This dashboard failed to load" — including the only control
    // that lets run9 record anything.
    //
    // This test caught exactly that: firstLoggedDay was being called outside
    // the component's own try/catch, so this threw instead of degrading.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 2)
      const json = render(brokenHistory(db))
      expect(json).toContain('/api/users/run9/pee')
      expect(json).toContain('2')
      expect(json).toContain('times today')
    } finally {
      db.close()
    }
  })

  it('says so in both derived panels rather than showing a stale or empty one', () => {
    // Degrades HONESTLY: it never renders partial data as if it were current,
    // and it never renders the "nothing logged yet" empty state over data it
    // simply could not read — those mean different things to the reader.
    const db = freshDb()
    try {
      seed(db, '2026-08-19', 2)
      const json = render(brokenHistory(db))
      expect(json).toContain("Couldn't load the trend just now")
      expect(json).toContain("Couldn't load the average just now")
      expect(json).not.toContain('Nothing to chart yet')
      expect(json).not.toContain('Not enough days yet')
    } finally {
      db.close()
    }
  })

  it('does not mount the chart over a failed read', () => {
    const db = freshDb()
    try {
      seed(db, '2026-08-18', 6)
      seed(db, '2026-08-19', 4)
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
      seed(db, '2026-08-18', 3)
      const json = render(brokenHistory(db))
      expect(json).not.toContain('Tap below to log your first one.')
      expect(json).toContain('Nothing logged yet today.')
    } finally {
      db.close()
    }
  })
})
