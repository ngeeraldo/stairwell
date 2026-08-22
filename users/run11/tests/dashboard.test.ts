// users/run11/tests/dashboard.test.ts
//
// What run11 actually sees. queries.test.ts, walkLog.test.ts and
// noGoTemp.test.ts prove the arithmetic; this proves the panels put it on a
// screen, and — the part that matters most here — that the decider NEVER shows
// a verdict it cannot stand behind.
//
// TWO SCREENS as of spec v2, so `render` takes one. `screen` arrives already
// resolved against this module's own `screens` export (`activeScreen` in
// app/[user]/page.tsx does that before a dashboard sees anything), which is
// why the tests below pass ids from that array rather than arbitrary strings.
//
// WHAT THIS CANNOT SEE: the walk log's calendar is a CLIENT component
// (users/run11/MonthCalendar.tsx), and JSON.stringify of the returned element
// tree never runs its body — the same limitation lib/ui/useWriteAction.ts
// records about its own guard. So the assertions below reach the calendar's
// PROPS and stop there. That is deliberate rather than a gap papered over:
// every rule the calendar applies lives in `calendarGrid` in queries.ts, where
// walkLog.test.ts exercises it directly, and the component itself decides
// nothing.
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
/**
 * The render instant the page would have handed down for a given day.
 *
 * Derived from the same day the test asked for, so `today` and `now` agree
 * the way app/[user]/page.tsx guarantees they do.
 */
const atMidday = (day: string) => Date.parse(`${day}T12:00:00Z`)
const TOMORROW = '2026-08-21'
const SUNRISE = 6 * 60 + 53
const SUNSET = 19 * 60 + 56

const at = (day: string, minute: number) => Date.parse(`${day}T00:00:00Z`) + minute * 60_000

function freshDb(): UserDb {
  const db = new Database(':memory:')
  applyUserMigrations(db, 'run11')
  return db
}

function render(db: UserDb, today = TODAY, screen?: string): string {
  // JSON.stringify drops each element's `type` (a function is not JSON) and
  // keeps props and children — which is exactly what this needs: the copy each
  // panel chose, and the action URL the write control was handed.
  return JSON.stringify(Dashboard({ slug: 'run11', db, today, now: atMidday(today), timeZone: 'UTC', screen }))
}

/**
 * Every string and number in the returned element tree, in order.
 *
 * JSX splits an interpolated sentence into an ARRAY of children — "At ",
 * "95°F", " or hotter…" — so a JSON assertion cannot see a sentence that has a
 * value in the middle of it, which is most of the interesting copy on this
 * dashboard. This flattens the tree to the text a reader would actually see.
 * `render` above stays for assertions about PROPS (an action URL, a payload, a
 * disabled flag), which this deliberately drops.
 */
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  const props = (node as { props?: { children?: unknown } }).props
  return props === undefined ? '' : text(props.children)
}

/** What the screen READS AS, rather than what it is made of. */
function renderText(db: UserDb, today = TODAY, screen?: string): string {
  return text(Dashboard({ slug: 'run11', db, today, now: atMidday(today), timeZone: 'UTC', screen }))
}

/** The walk log screen, by its declared id. */
function renderLog(db: UserDb, today = TODAY): string {
  return render(db, today, 'walk_log')
}

/** Exactly what the walk-log route's `mark` arm writes. */
function markWalk(db: UserDb, day: string) {
  db.prepare('INSERT OR IGNORE INTO walk_log (day, at) VALUES (?, ?)').run(day, 0)
}

/** Exactly what the no-go-temp route's upsert writes. */
function setNoGo(db: UserDb, value: number) {
  db.prepare('INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, ?, 0)').run(value)
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
  it('declares the three screens spec v3 asks for, decider first', () => {
    // THREE screens as of spec v3, so app/[user]/page.tsx draws a tab strip —
    // from this exact array, which is why the array is asserted whole rather
    // than by length. The titles are what spec.md calls them; the ids and
    // orders are the builder's, since a change-only spec carries no ids, and
    // users/run11/current.md's `## Screens` is where they are written down.
    //
    // `spending` is ORDER 3, which spec v3 asks for directly ("a third tab
    // alongside 'Walk the dog?' and 'Walk log', ordered after them"), and the
    // two dog screens keep the ids and orders they had — a screen id is what
    // `?screen=` names, so changing one would quietly break a bookmark.
    expect(screens).toEqual([
      { id: 'walk_the_dog', title: 'Walk the dog?', order: 1 },
      { id: 'walk_log', title: 'Walk log', order: 2 },
      { id: 'spending', title: 'Spending', order: 3 },
    ])
  })

  it('keeps walk_the_dog FIRST, which is what makes it the landing screen', () => {
    // `activeScreen` sorts by order and falls back to the lowest, so this is
    // the whole of spec v2's "'Walk the dog?' stays first and stays the
    // landing page" — there is no other switch for it, and spec v3 restates it
    // ("Nothing on the two dog screens changes"). Asserted separately from the
    // array above so a reordering failure says which rule it broke.
    const lowest = [...screens].sort((a, b) => a.order - b.order)[0]!
    expect(lowest.id).toBe('walk_the_dog')
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

describe('users/run11 — the no-go temperature control', () => {
  it('shows the default 90°F, and its band, before he has set anything', () => {
    // spec v2: "if nothing has been set yet it defaults to the current 90°F so
    // the screen behaves exactly as it does today on first load."
    const db = freshDb()
    try {
      const reads = renderText(db)
      expect(reads).toContain('My no-go temperature')
      // The band is the five degrees below, spelled out — he sets one number
      // and gets two, so the second one has to be visible.
      expect(reads).toContain('At 90°F or hotter it’s a no. 85–90°F is “go, but short and shady”.')
    } finally {
      db.close()
    }
  })

  it('shows what he SET, and moves the band with it', () => {
    // The wiring assertion. A control reading its own default while the stored
    // row said something else is the confident-wrong-answer failure wearing a
    // different hat: the verdict would be judged against one number and the
    // control would display another.
    const db = freshDb()
    try {
      setNoGo(db, 95)
      const reads = renderText(db)
      expect(reads).toContain('At 95°F or hotter it’s a no. 90–95°F')
      expect(reads).not.toContain('85–90°F')
    } finally {
      db.close()
    }
  })

  it('posts to a route of its OWN, not the one the calendar writes', () => {
    // lib/ui/WriteAction.tsx groups pending by ACTION URL. Sharing a route with
    // the walk log would put forty calendar squares into a pending state every
    // time he nudged the temperature, and vice versa.
    const db = freshDb()
    try {
      const json = render(db)
      expect(json).toContain('/api/users/run11/no-go-temp')
      expect(json).toContain('"action":"raise"')
      expect(json).toContain('"action":"lower"')
      expect(json).not.toContain('/api/users/run11/walk-log')
    } finally {
      db.close()
    }
  })

  it('DISABLES the control at each end of its range rather than hiding it', () => {
    // A disappearing button reads as a broken screen. The route enforces the
    // same bound — this is the affordance, not the rule.
    const db = freshDb()
    try {
      setNoGo(db, 105)
      const top = render(db)
      expect(top).toContain('"disabled":true')
      // The other direction is still available at the top of the range, so the
      // assertion above cannot be passing because BOTH are disabled.
      expect(top).toContain('"disabled":false')
    } finally {
      db.close()
    }
  })

  it('judges the verdict against HIS number, not against 90', () => {
    // The whole point of the change, asserted on the screen rather than in the
    // query layer: one forecast, two settings, two different headlines.
    const db = freshDb()
    try {
      seedDay(db, TODAY, () => 92)
      seedFetch(db, TODAY, 12 * 60)
      expect(render(db)).toContain('Don’t go')

      setNoGo(db, 95)
      const relaxed = render(db)
      expect(relaxed).toContain('Go — short one, shade')
      expect(relaxed).not.toContain('Don’t go')
    } finally {
      db.close()
    }
  })
})

describe('users/run11 — the walk log screen', () => {
  it('renders on an EMPTY log without throwing, and says so in words', () => {
    // A friend's first session on this screen: his own database, with nothing
    // in it. Not a confident zero, and not a month of days he "missed" — he
    // could not have logged anything before the screen existed.
    const db = emptyDbFromMigrations('run11')
    try {
      const reads = renderText(db, TODAY, 'walk_log')
      expect(reads).toContain('No walks logged yet')
      expect(reads).toContain('Nothing logged yet')
      // Never a confident zero — spec v2 asks for this by name.
      expect(reads).not.toContain('0%')
      // \b so "the last 30 days" in the panel's own waiting copy does not
      // read as a zero-day streak.
      expect(reads).not.toMatch(/\b0 days\b/)
    } finally {
      db.close()
    }
  })

  it('reads NOTHING from the forecast, and the decider reads no walk', () => {
    // spec v2 is explicit that the log "reads nothing from the forecast and
    // shares no data with the decider". Asserted both ways round, because
    // either half leaking would be invisible on a screen that looked fine.
    const db = freshDb()
    try {
      houstonDay(db)
      seedFetch(db, TODAY, 14 * 60)
      markWalk(db, '2026-08-19')

      const log = renderLog(db)
      expect(log).not.toContain('77006')
      expect(log).not.toContain('Next good window')
      expect(log).not.toContain('Right now')

      const decider = render(db)
      expect(decider).not.toContain('Current streak')
      expect(decider).not.toContain('Month calendar')
    } finally {
      db.close()
    }
  })

  it('counts a streak ending TODAY and says it includes today', () => {
    const db = freshDb()
    try {
      for (const day of ['2026-08-18', '2026-08-19', '2026-08-20']) markWalk(db, day)
      const json = renderLog(db)
      expect(json).toContain('3 days')
      expect(json).toContain('Including today.')
    } finally {
      db.close()
    }
  })

  it('says the streak runs THROUGH YESTERDAY when today is not marked', () => {
    // THE EDGE spec v2 asked to have decided, on the screen. He marks from his
    // desk later in the day, so the common case is a streak that has not been
    // extended yet — and a panel that silently counted today would be claiming
    // a walk he has not logged.
    const db = freshDb()
    try {
      for (const day of ['2026-08-18', '2026-08-19']) markWalk(db, day)
      const json = renderLog(db)
      expect(json).toContain('2 days')
      expect(json).toContain('Through yesterday — today isn’t marked yet.')
      expect(json).not.toContain('Including today.')
    } finally {
      db.close()
    }
  })

  it('shows a real zero differently from an empty log', () => {
    // He HAS logged walks and the run has ended. Saying when the last one was
    // is what stops "0" reading as though the log had been lost.
    const db = freshDb()
    try {
      markWalk(db, '2026-08-15')
      const json = renderLog(db)
      expect(json).toContain('No streak going')
      expect(json).toContain('5 days')
      expect(json).not.toContain('No walks logged yet')
    } finally {
      db.close()
    }
  })

  it('says "since you started" while the log is younger than the window', () => {
    // The pre-existence rule on the screen. One mark yesterday is 1 of 2 days,
    // not 1 of 30 — this project has shipped the other answer once already.
    const db = freshDb()
    try {
      markWalk(db, '2026-08-19')
      const json = renderLog(db)
      expect(json).toContain('1 of the 2 days since you started.')
      expect(json).not.toContain('of the last 30 days')
    } finally {
      db.close()
    }
  })

  it('reads "of the last 30 days" once the log is older than the window', () => {
    const db = freshDb()
    try {
      // A mark six weeks back, then fifteen of the last thirty days.
      markWalk(db, '2026-07-06')
      for (let n = 1; n <= 15; n += 1) {
        markWalk(db, new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000)
          .toISOString()
          .slice(0, 10))
      }
      expect(renderText(db, TODAY, 'walk_log')).toContain('50%15 of the last 30 days.')
    } finally {
      db.close()
    }
  })

  it('hands the calendar its own route, the friend’s day, and every mark', () => {
    // The calendar is a client component, so its body never runs here — these
    // are the PROPS it is handed, which is the whole of what this file can
    // see. What it does with them is `calendarGrid`'s job and walkLog.test.ts
    // proves that separately.
    const db = freshDb()
    try {
      markWalk(db, '2026-08-19')
      markWalk(db, '2026-07-30')
      const json = renderLog(db)
      expect(json).toContain('/api/users/run11/walk-log')
      expect(json).toContain('"today":"2026-08-20"')
      expect(json).toContain('"marked":["2026-07-30","2026-08-19"]')
      // A rolling year of history is reachable even though the first mark is
      // only three weeks old — back-filling is half of what he asked for.
      expect(json).toContain('"earliest":"2025-09"')
    } finally {
      db.close()
    }
  })

  it('falls back to the DECIDER for an unknown or absent screen', () => {
    // `activeScreen` already resolves an unrecognised `?screen=` to the
    // lowest-order screen before a dashboard sees it, so this is defence in
    // depth — but it is also what makes `/run11` with no query string the
    // decider, which spec v2 states directly.
    const db = freshDb()
    try {
      houstonDay(db)
      seedFetch(db, TODAY, 14 * 60)
      expect(render(db, TODAY, undefined)).toContain('Right now')
      expect(render(db, TODAY, 'walk_the_dog')).toContain('Right now')
    } finally {
      db.close()
    }
  })
})
