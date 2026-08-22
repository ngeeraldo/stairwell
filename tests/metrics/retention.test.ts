// tests/metrics/retention.test.ts
//
// Which days a friend was actually in the app, and the weekly/monthly rollups
// the admin Activity pane reads. The question this answers is retention —
// "did they come back" — so every case here is about DAY PRESENCE, never about
// how many times they opened anything.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import { openPlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript } from '@/lib/db/appendOnly'
import {
  REPORTING_TIME_ZONE,
  activeDays,
  monthlyActivity,
  weeklyGrid,
} from '@/lib/metrics/retention'

const ACCOUNT = 1
const OTHER = 2

describe('activeDays', () => {
  let dir: string
  let db: PlatformDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stairwell-retention-'))
    db = openPlatformDb(join(dir, 'synthetic.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function metric(event: string, at: string, accountId: number = ACCOUNT) {
    appendMetric(db, { accountId, event, at: Date.parse(at) })
  }

  it('is empty for an account that has never done anything', () => {
    expect(activeDays(db, ACCOUNT)).toEqual([])
  })

  it('reports one day per calendar day, however many rows that day holds', () => {
    // Three renders in one morning is one day of retention, not three. The
    // write path has no dedup by design (CLAUDE.md: "an open" is defined when
    // the log is READ), so collapsing is this function's job.
    metric('dashboard_open', '2026-08-18T15:00:00Z')
    metric('dashboard_open', '2026-08-18T15:00:04Z')
    metric('dashboard_write', '2026-08-18T15:00:03Z')
    metric('page_view', '2026-08-19T14:00:00Z')

    expect(activeDays(db, ACCOUNT)).toEqual(['2026-08-18', '2026-08-19'])
  })

  it('buckets a late-evening visit into the reporting zone, not UTC', () => {
    // 23:30 on the 17th in America/Chicago is 04:30Z on the 18th. Bucketing in
    // UTC would file this friend's evening under the next day and move a
    // week boundary with it — the same class of bug as the friend-timezone
    // ledger, applied to the report instead of to a dashboard.
    expect(REPORTING_TIME_ZONE).toBe('America/Chicago')
    metric('page_view', '2026-08-18T04:30:00Z')

    expect(activeDays(db, ACCOUNT)).toEqual(['2026-08-17'])
  })

  it('ignores events the friend did not cause', () => {
    // deploy_announced carries the friend's account_id and is written by
    // scripts/announce-deploy.ts — by Nico, on a day the friend may never have
    // opened the app. Counting it would manufacture retention out of our own
    // activity, which is the one way this report could lie in our favour.
    metric('deploy_announced', '2026-08-18T15:00:00Z')
    metric('alert_sent', '2026-08-19T15:00:00Z')
    metric('env_missing', '2026-08-20T15:00:00Z')

    expect(activeDays(db, ACCOUNT)).toEqual([])
  })

  it('counts a friend who only ever typed in the chat', () => {
    // A user transcript row is presence even if no metric event was written —
    // which is what makes history from before page_view existed readable.
    appendTranscript(db, {
      accountId: ACCOUNT,
      sessionId: 's',
      conversationId: 'c',
      promptSha: 'abc',
      role: 'user',
      body: 'COFFEE PALACE TEST',
      at: Date.parse('2026-08-18T15:00:00Z'),
    })

    expect(activeDays(db, ACCOUNT)).toEqual(['2026-08-18'])
  })

  it('does not count an assistant transcript row as presence', () => {
    // scripts/announce-deploy.ts writes an assistant turn into the transcript
    // on the day WE deploy. The friend need not have been there at all.
    appendTranscript(db, {
      accountId: ACCOUNT,
      sessionId: 's',
      conversationId: 'c',
      promptSha: 'abc',
      role: 'assistant',
      body: 'Your dashboard is updated.',
      at: Date.parse('2026-08-18T15:00:00Z'),
    })

    expect(activeDays(db, ACCOUNT)).toEqual([])
  })

  it('is scoped to one account', () => {
    metric('page_view', '2026-08-18T15:00:00Z', OTHER)

    expect(activeDays(db, ACCOUNT)).toEqual([])
  })
})

describe('weeklyGrid', () => {
  it('lays out Monday-start weeks ending on the given day', () => {
    const weeks = weeklyGrid(['2026-08-18'], '2026-08-22', 3)

    expect(weeks.map((w) => w.start)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17'])
  })

  it('stops the newest week at the given day rather than drawing days that have not happened', () => {
    // 2026-08-22 is a Saturday. A Sunday cell rendered as "not active" would
    // read as a day they missed.
    const weeks = weeklyGrid([], '2026-08-22', 1)

    expect(weeks[0]?.days.map((d) => d.day)).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ])
  })

  it('marks the days the friend was there and counts them', () => {
    const weeks = weeklyGrid(['2026-08-18', '2026-08-20'], '2026-08-22', 1)

    expect(weeks[0]?.activeCount).toBe(2)
    expect(weeks[0]?.days.filter((d) => d.active).map((d) => d.day)).toEqual([
      '2026-08-18',
      '2026-08-20',
    ])
  })

  it('ignores active days outside the window', () => {
    const weeks = weeklyGrid(['2026-07-01', '2026-08-18'], '2026-08-22', 1)

    expect(weeks[0]?.activeCount).toBe(1)
  })
})

describe('monthlyActivity', () => {
  it('counts active days per month, newest month first', () => {
    const months = monthlyActivity(['2026-06-30', '2026-07-01', '2026-07-15', '2026-08-18'])

    expect(months).toEqual([
      { month: '2026-08', activeCount: 1 },
      { month: '2026-07', activeCount: 2 },
      { month: '2026-06', activeCount: 1 },
    ])
  })

  it('is empty for a friend with no active days', () => {
    expect(monthlyActivity([])).toEqual([])
  })
})
