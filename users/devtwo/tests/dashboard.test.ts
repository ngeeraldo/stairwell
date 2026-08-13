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
import DevTwoDashboard from '@/users/devtwo/dashboard'
import { dayKeyOf } from '@/users/devtwo/queries'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

const DAY = 86_400_000
const today = () => dayKeyOf(Date.now())
const daysAgo = (n: number) => dayKeyOf(Date.now() - n * DAY)

function walked(...days: string[]) {
  const stmt = db.prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)')
  for (const day of days) stmt.run(day, 1)
}

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devtwo-dash-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('users/devtwo/dashboard.tsx', () => {
  it('shows today as walked, with the streak and percentage computed', async () => {
    walked(today(), daysAgo(1), daysAgo(2))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))

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
  })

  it('shows the not-yet state and offers the tap when today is unlogged', async () => {
    walked(daysAgo(1))

    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))

    expect(json).toContain('NOT YET')
    // The control is the whole product. It must post to the write path.
    expect(json).toContain('/api/users/devtwo/walk')
    expect(json).toContain('post')
  })

  it('renders 14 day markers whatever the data', async () => {
    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))
    // JSON.stringify renders an object key as `"data-day":`, never
    // `data-day=` — that HTML-attribute syntax only exists once Next
    // renders this element tree to a markup string, which this unit test
    // does not do.
    expect(json.match(/"data-day":/g) ?? []).toHaveLength(14)
  })

  it('renders an empty database without throwing', async () => {
    const json = JSON.stringify(await DevTwoDashboard({ slug: 'devtwo', db }))
    expect(json).toContain('NOT YET')
    expect(json).toContain('[0,"%"]')
  })
})
