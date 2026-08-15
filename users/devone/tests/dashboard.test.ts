// users/devone/tests/dashboard.test.ts
//
// The component's WIRING, not its queries. The step-4 ledger's first residual
// is a component whose extracted pure functions were thoroughly tested while
// all nine of its call-site mutations survived — a suite that stayed green
// while the product did nothing. These tests fail if the component stops
// calling a query or stops putting its result in the output.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import DevOneDashboard from '@/users/devone/dashboard'
import { applyUserMigrations } from '@/tests/support/userMigrations'


let dir: string
let db: UserDb

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devone-dash-'))
  db = new Database(join(dir, 'synthetic.db'))
  applyUserMigrations(db, 'devone')
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function add(merchant: string, category: string, cents: number, at: number) {
  db.prepare(
    'INSERT INTO transactions (merchant, category, amount_cents, at) VALUES (?, ?, ?, ?)',
  ).run(merchant, category, cents, at)
}

describe('users/devone/dashboard.tsx', () => {
  it('renders the eating-out total and the recent list from the database', async () => {
    const now = Date.now()
    add('COFFEE PALACE TEST', 'eating out', 450, now - 1000)
    add('BURRITO BARN TEST', 'eating out', 1550, now - 2000)
    add('GROCERY WORLD TEST', 'groceries', 8000, now - 3000)

    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db, today: '2026-08-14', timeZone: 'UTC' }))

    // $20.00 = 450 + 1550, i.e. the aggregate actually ran and reached the
    // output. A hard-coded panel would not produce this.
    expect(json).toContain('$20.00')
    expect(json).toContain('COFFEE PALACE TEST')
    expect(json).toContain('BURRITO BARN TEST')
    // The recent list is not filtered by category.
    expect(json).toContain('GROCERY WORLD TEST')
  })

  it('renders both panels with an empty database instead of throwing', async () => {
    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db, today: '2026-08-14', timeZone: 'UTC' }))
    expect(json).toContain('$0.00')
    expect(json).toContain('No transactions yet')
  })

  it('renders each transaction under the day the FRIEND was living, not the host', () => {
    // REWRITTEN when the day became the friend's. The version this replaces
    // asserted that each row rendered under the HOST'S local calendar date,
    // built from getFullYear/getMonth/getDate so it would "pass in every
    // timezone" — and it did, because it and the code it guarded were reading
    // the same wrong clock. Its own comment admitted it could not redden on a
    // UTC host. The droplet is a UTC host.
    //
    // Now: one instant, two zones, two different rendered days. That
    // assertion is impossible for an implementation that reads any clock at
    // all, and it means the same thing on every machine that runs it.
    const at = Date.parse('2026-09-01T02:00:00Z') // 22:00 on 31 Aug in New York
    add('LATE NIGHT TEST', 'eating out', 200, at)

    const inNewYork = JSON.stringify(
      DevOneDashboard({ slug: 'devone', db, today: '2026-08-31', timeZone: 'America/New_York' }),
    )
    const inUtc = JSON.stringify(
      DevOneDashboard({ slug: 'devone', db, today: '2026-09-01', timeZone: 'UTC' }),
    )

    // Matched against the merchant, in the exact shape the <li>'s children
    // serialise to, so a correct render of some OTHER row cannot satisfy it.
    expect(inNewYork).toContain('"2026-08-31"," \u2014 ","LATE NIGHT TEST"')
    expect(inUtc).toContain('"2026-09-01"," \u2014 ","LATE NIGHT TEST"')

    // And the total moves with it: the same transaction is August's money in
    // New York and September's in UTC. This is the row label and the panel
    // total proved to be reading the same calendar, which is the disagreement
    // the original day() helper was written to prevent and got backwards.
    expect(inNewYork).toContain('$2.00')
    expect(inUtc).toContain('$2.00')
    expect(
      JSON.stringify(
        DevOneDashboard({ slug: 'devone', db, today: '2026-09-01', timeZone: 'America/New_York' }),
      ),
    ).toContain('$0.00')
  })
})
