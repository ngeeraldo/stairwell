// tests/admin/activityPane.test.tsx
//
// The Activity pane: which days a friend was in the app, as a picture Nico can
// read at a glance, plus the weekly and monthly rollups underneath it.
//
// Rendered output, never serialised props — the unified-loop ledger records
// exactly that mistake in the earlier admin tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityPane } from '@/app/admin/[user]/ActivityPane'

beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// 2026-08-22 is a Saturday; the week containing it starts Monday 2026-08-17.
const TODAY = '2026-08-22'

function markup(days: string[]): string {
  return renderToStaticMarkup(<ActivityPane days={days} today={TODAY} weeks={12} />)
}

describe('ActivityPane', () => {
  it('says so plainly when a friend has never been here', () => {
    // Not an empty grid. Twelve rows of blank cells for someone who has never
    // logged in reads as a friend who stopped coming, which is a different
    // thing entirely and would be acted on differently.
    const html = markup([])

    expect(html).toContain('No activity yet')
    expect(html).not.toContain('data-day=')
  })

  it('marks the days the friend was here and leaves the rest unmarked', () => {
    const html = markup(['2026-08-18', '2026-08-20'])

    expect(html).toContain('data-day="2026-08-18" data-active="true"')
    expect(html).toContain('data-day="2026-08-20" data-active="true"')
    expect(html).toContain('data-day="2026-08-19" data-active="false"')
  })

  it('draws no cell for a day that has not happened yet', () => {
    // 2026-08-23 is the Sunday after `today`. An unmarked cell for it is
    // indistinguishable from a day they missed.
    const html = markup(['2026-08-18'])

    expect(html).toContain('data-day="2026-08-22"')
    expect(html).not.toContain('data-day="2026-08-23"')
  })

  it('shows the first and last day they were here', () => {
    const html = markup(['2026-06-02', '2026-08-18'])

    expect(html).toContain('2026-06-02')
    expect(html).toContain('2026-08-18')
  })

  it('counts active days per month', () => {
    const html = markup(['2026-07-01', '2026-07-15', '2026-08-18'])

    expect(html).toContain('data-month="2026-08" data-active-count="1"')
    expect(html).toContain('data-month="2026-07" data-active-count="2"')
  })

  it('counts active days in each week of the window', () => {
    const html = markup(['2026-08-18', '2026-08-20'])

    expect(html).toContain('data-week="2026-08-17" data-active-count="2"')
    expect(html).toContain('data-week="2026-08-10" data-active-count="0"')
  })

  it('reaches back further than the grid for the monthly rollup', () => {
    // The grid is a 12-week window; the months table is all of history. A
    // friend's second month is exactly the number "monthly retention" means,
    // and it must not fall off the bottom of a fixed-length grid.
    const html = markup(['2025-11-04'])

    expect(html).toContain('data-month="2025-11" data-active-count="1"')
    expect(html).not.toContain('data-day="2025-11-04"')
  })
})
