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

  it('renders a transaction under its LOCAL calendar date, not the UTC date the same instant falls on', async () => {
    // queries.ts's monthRange buckets transactions by the LOCAL calendar
    // (its own comment says so). If the dashboard rendered the UTC date
    // instead, a transaction near a local day boundary could show a date
    // implying a different month than the total it was counted in.
    //
    // This machine's timezone (America/Chicago, UTC-5 at the time this was
    // written) is WEST of Greenwich, where UTC runs AHEAD of local time — so
    // a local instant late enough in the day lands on the NEXT calendar date
    // in UTC, not the previous one. Pick a fixture that crosses that
    // boundary and prove it really does (the guard below), so the assertion
    // is not vacuous on a host where local and UTC happen to agree.
    const local = new Date(2026, 2, 15, 23, 30, 0) // 2026-03-15 23:30 local
    const at = local.getTime()
    const utcDate = new Date(at).toISOString().slice(0, 10)
    const localDate = '2026-03-15'
    expect(utcDate).not.toBe(localDate) // guards against a vacuous test

    add('LATE NIGHT TEST', 'eating out', 100, at)
    const json = JSON.stringify(await DevOneDashboard({ slug: 'devone', db }))
    expect(json).toContain(localDate)
    expect(json).not.toContain(utcDate)
  })
})
