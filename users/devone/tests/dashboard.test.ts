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

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devone-dash-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
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

    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db }))

    // $20.00 = 450 + 1550, i.e. the aggregate actually ran and reached the
    // output. A hard-coded panel would not produce this.
    expect(json).toContain('$20.00')
    expect(json).toContain('COFFEE PALACE TEST')
    expect(json).toContain('BURRITO BARN TEST')
    // The recent list is not filtered by category.
    expect(json).toContain('GROCERY WORLD TEST')
  })

  it('renders both panels with an empty database instead of throwing', async () => {
    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db }))
    expect(json).toContain('$0.00')
    expect(json).toContain('No transactions yet')
  })

  it('renders each transaction under the LOCAL calendar date of its "at" instant, in every timezone', async () => {
    // queries.ts's monthRange buckets transactions by the LOCAL calendar
    // (its own comment says so), so day() must render the same local date or
    // a transaction near a local-day boundary could show a date implying a
    // different month than the total it was counted in.
    //
    // The expected string is built from the FIXTURE INSTANT'S OWN local
    // calendar components (getFullYear/getMonth/getDate), never a hardcoded
    // literal — that is what makes this pass in EVERY timezone rather than
    // only the one it happened to be written in. An earlier version of this
    // test hardcoded '2026-03-15' as the expected string and asserted the
    // UTC rendering must differ from it; that "vacuity guard" itself failed
    // under TZ=UTC and TZ=Asia/Tokyo, because at those offsets the local and
    // UTC calendar dates for the fixture instant are the identical string —
    // the guard fired, and the whole test never got to the real assertion.
    // Deploying to a UTC host (the repo pins no timezone anywhere, and a
    // DigitalOcean droplet's default image normally runs UTC) would have
    // reddened the vitest gate in deploy.sh on every future deploy.
    //
    // Two boundary instants are covered: the first and last millisecond of a
    // local day, both constructed from local components (never a UTC
    // literal) so the boundary lands in the right place regardless of host
    // offset.
    //
    // What the guard-deletion drill for this test CAN and CANNOT show:
    // reverting day() to toISOString().slice(0, 10) reddens this test on any
    // host whose UTC offset is nonzero, because there the UTC and local
    // renderings of the same instant differ. It CANNOT redden at UTC,
    // because at UTC the two renderings are the identical string — there is
    // no instant on a UTC host where they would disagree. That is a real
    // limit of running this drill on a UTC host, not a bug in the test.
    function localDateOf(at: number): string {
      const d = new Date(at)
      const year = d.getFullYear()
      const month = String(d.getMonth() + 1).padStart(2, '0')
      const date = String(d.getDate()).padStart(2, '0')
      return `${year}-${month}-${date}`
    }

    const startOfDay = new Date(2026, 2, 15, 0, 0, 0, 0).getTime()
    const endOfDay = new Date(2026, 2, 15, 23, 59, 59, 999).getTime()

    add('DAY START TEST', 'eating out', 100, startOfDay)
    add('DAY END TEST', 'eating out', 200, endOfDay)

    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db }))
    // localDateOf(startOfDay) and localDateOf(endOfDay) are the SAME string
    // (both are the first and last instant of one local day), so a bare
    // `toContain(localDateOf(x))` cannot tell which transaction produced
    // it — one correct render would satisfy both checks even if the other
    // transaction rendered a different, wrong date. Match each date to its
    // OWN merchant, in the exact shape the JSON serialisation of the
    // recent-transactions <li> produces (day, ' — ', merchant, ...).
    expect(json).toContain(`"${localDateOf(startOfDay)}"," — ","DAY START TEST"`)
    expect(json).toContain(`"${localDateOf(endOfDay)}"," — ","DAY END TEST"`)
  })
})
