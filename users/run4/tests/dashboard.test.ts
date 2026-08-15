// users/run4/tests/dashboard.test.ts
//
// SCAFFOLD TESTS. Everything here is about the folder being wired up, not
// about run4's dashboard, because that has not been designed yet. Replace
// these as you build — but keep the empty-database one, whatever else changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import Dashboard from '@/users/run4/dashboard'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'

// JSX compiles to React.createElement, which this component's module expects
// to find globally — it is a server component rendered by calling it, not by
// mounting it, so nothing else brings React into scope.
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('users/run4', () => {
  it('says it is not built yet', () => {
    const db = emptyDbFromMigrations('run4')
    try {
      const json = JSON.stringify(
        Dashboard({ slug: 'run4', db, today: '2026-01-01', timeZone: 'UTC' }),
      )
      expect(json).toContain('Under construction')
      expect(json).toContain('run4')
    } finally {
      db.close()
    }
  })

  it('renders on an EMPTY database without throwing', () => {
    // KEEP THIS ONE. There is no synthetic fallback: a friend's first session
    // renders THEIR database, and it has nothing in it. An empty dashboard is
    // an ordinary state, not an error (2026-08-15 migrations design, §9), so
    // anything that reaches for rows[0] without a guard is a defect this
    // catches — before the friend does, on the first screen they ever see.
    //
    // It passes trivially today, because the scaffold reads no data at all.
    // It stops being trivial the moment you write a query, which is exactly
    // when it starts earning its place.
    const db = emptyDbFromMigrations('run4')
    try {
      expect(
        Dashboard({ slug: 'run4', db, today: '2026-01-01', timeZone: 'UTC' }),
      ).toBeDefined()
    } finally {
      db.close()
    }
  })
})

// ─── what to add as you build ───
//
// THE DAY IS THE FRIEND'S. One instant, two zones, two different rendered
// days — an assertion impossible for an implementation that reads any clock,
// and one that means the same thing on every machine that runs it. The version
// of this test that asserted the HOST's calendar date passed on a UTC host
// while guarding a bug that cost a whole ledger
// (docs/superpowers/ledgers/friend-timezone.md):
//
//   expect(someQuery(db, 'Asia/Tokyo')[0]!.day).toBe('2026-03-15')
//   expect(someQuery(db, 'America/New_York')[0]!.day).toBe('2026-03-14')
//
// THE WRITE PATH, if this dashboard has one — a platform route that inserts
// into its shape, e.g. app/api/users/[user]/walk/route.ts. Cover it here, not
// only the read side. The step-6a ledger's headline defect existed ONLY where
// a write path and a read path met: seed.py always marked today walked, and
// the dashboard hid its tap control once today was walked, and each half was
// correct alone. Reviewing either in isolation could not have found it.
// users/devtwo/tests/write.test.ts is the worked example.
