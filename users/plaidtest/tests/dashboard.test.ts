// users/plaidtest/tests/dashboard.test.ts
//
// The component's WIRING, not its queries. The step-4 ledger's first residual
// is a component whose extracted pure functions were thoroughly tested while
// all nine of its call-site mutations survived — a suite that stayed green
// while the product did nothing.
//
// THE ONE THAT MATTERS MOST is the not-connected / connected split. Which
// screen renders is decided by whether a stored connection exists, NEVER by
// whether any transactions have arrived. A freshly connected bank has a token
// and no rows for the first few seconds while Plaid backfills, and a dashboard
// that inferred "not connected" from an empty table would tell a friend their
// connection failed while it was still working. That case is asserted
// directly, because it is invisible in every other test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard, { screens } from '@/users/plaidtest/dashboard'
import { applyUserMigrations } from '@/tests/support/userMigrations'

let dir: string
let db: UserDb

// JSX compiles to React.createElement, which this component's module expects
// to find globally — it is a server component rendered by CALLING it, not by
// mounting it, so nothing else brings React into scope.
beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-plaidtest-'))
  db = new Database(join(dir, 'synthetic.db'))
  applyUserMigrations(db, 'plaidtest')
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const render = () =>
  JSON.stringify(
    Dashboard({ slug: 'plaidtest', db, today: '2026-08-21', timeZone: 'America/Chicago' }),
  )

/** A stored connection. No transactions — that is the point of it. */
function connect(): void {
  db.prepare(
    `INSERT INTO plaid_items (item_id, access_token, available_products, connected_at)
     VALUES ('item_1', 'access-sandbox-x', '["balance","recurring_transactions"]', 1)`,
  ).run()
}

describe('the contract', () => {
  it('declares exactly one screen', () => {
    expect(screens).toEqual([{ id: 'money', title: 'Money', order: 1 }])
  })
})

describe('with no bank connected', () => {
  it('renders the connect screen over an empty database', () => {
    // An empty database is an ordinary state and every dashboard must render
    // one. This is a friend's first session.
    const out = render()
    expect(out).toContain('No bank connected')
    expect(out).toContain('/api/users/plaidtest/plaid/link-token')
    expect(out).toContain('/api/users/plaidtest/plaid/connect')
  })

  it('promises that the bank login never reaches the server', () => {
    // A claim about where credentials go is a promise to a person, not copy.
    expect(render()).toContain('never reaches this')
  })

  it('shows no account or transaction panel at all', () => {
    const out = render()
    expect(out).not.toContain('Recent transactions')
    expect(out).not.toContain('Disconnect')
  })
})

describe('with a bank connected but nothing synced yet', () => {
  it('does NOT fall back to the connect screen', () => {
    // The failure this whole test file is built around: for the first few
    // seconds after connecting, a real connection has zero rows.
    connect()
    const out = render()
    expect(out).not.toContain('No bank connected')
    expect(out).toContain('Accounts')
  })

  it('says nothing has arrived rather than showing a zero balance', () => {
    // "$0.00" is a confident false statement about someone's money.
    connect()
    const out = render()
    expect(out).toContain('Nothing has arrived yet')
    expect(out).not.toContain('$0.00')
  })

  it('offers reconnect and disconnect', () => {
    connect()
    const out = render()
    expect(out).toContain('Log in to your bank again')
    expect(out).toContain('Disconnect this bank')
    // It must NOT read as a prompt: nothing here knows the connection is
    // broken, so implying it would be a claim with no grounds.
    expect(out).toContain('only known after a refresh')
    expect(out).toContain('/api/users/plaidtest/plaid/disconnect')
  })

  it('disconnects through WriteAction, so a failure does not replace the app', () => {
    // A bare <form> navigates on failure: a 403 replaced the entire page with
    // the browser's own error, losing the dashboard, the chat surface and any
    // way back. WriteAction renders a real form too — the no-JS path is
    // identical — but intercepts when JavaScript is available.
    connect()
    const out = render()
    // `pendingLabel` is a WriteAction prop and appears in the element tree; a
    // bare <form> has no such thing. That is what distinguishes the two here —
    // the X-Stairwell-Write header is set inside the hook at fetch time and
    // never appears in a server render.
    expect(out).toContain('Disconnecting…')
  })

  it('reports what the connection can serve', () => {
    connect()
    expect(render()).toContain('recurring_transactions')
  })
})

describe('with synced data', () => {
  beforeEach(() => {
    execFileSync(
      'python3',
      [resolve(__dirname, '..', '..', '..', 'modules', 'plaid', 'seed_plaid.py'), join(dir, 'synthetic.db'), '2026-08-21'],
      { stdio: 'pipe' },
    )
    connect()
  })

  it('lists accounts with balances', () => {
    const out = render()
    expect(out).toContain('Accounts')
    // The seeded fixture is loudly fake, which is what makes this readable as
    // synthetic on a screenshot.
    expect(out).toContain('TEST')
  })

  it('lists recent transactions', () => {
    expect(render()).toContain('Recent transactions')
  })

  it('says a refresh has never happened rather than implying data is current', () => {
    // plaid_refreshes is seeded empty on purpose: a refresh is something that
    // HAPPENED, and none has. "Up to date" would be a confident false
    // statement about someone's money.
    expect(render()).toContain('Never refreshed')
  })

  it('does not claim nothing was recorded when a failed refresh records rows', () => {
    // A total refresh failure still writes a plaid_refreshes row per product,
    // and those rows render directly above the error. The shared WRITE_FAILED
    // sentence ("nothing was recorded") contradicted them on screen.
    // (This block's beforeEach already connected — connect() again would
    // violate plaid_items' primary key.)
    expect(render()).toContain('What happened is recorded above')
  })

  it('offers Refresh, which is the ONLY trigger that exists', () => {
    // A friend's data key lives only in the in-process keymap while they are
    // unlocked, so nothing can pull on their behalf while they are away. There
    // is no scheduled job and there cannot be one — pressing this is what
    // "fresh" means.
    const out = render()
    expect(out).toContain('/api/users/plaidtest/plaid/refresh')
    expect(out).toContain('Checking with your bank…')
  })

  it('reports a failed refresh instead of letting stale numbers read as current', () => {
    db.prepare(
      `INSERT INTO plaid_refreshes (at, day, product, ok, code)
       VALUES (1, '2026-08-21', 'transactions', 0, 'network')`,
    ).run()
    const out = render()
    expect(out).toContain('couldn’t reach your bank')
  })

  it('names re-authentication as the friend’s job, not as a fault', () => {
    // The one failure only they can fix. "couldn't reach your bank (
    // item_login_required)" would leave them with nothing to do.
    db.prepare(
      `INSERT INTO plaid_refreshes (at, day, product, ok, code)
       VALUES (1, '2026-08-21', 'transactions', 0, 'item_login_required')`,
    ).run()
    expect(render()).toContain('needs you to log in again')
  })

  it('does NOT call a not-ready product a failure', () => {
    // Recurring cannot be requested when an item is created and becomes
    // available about ten seconds later, so the first refresh after connecting
    // routinely sees this. Saying "couldn't reach your bank" then would be
    // wrong in a way the friend can see.
    db.prepare(
      `INSERT INTO plaid_refreshes (at, day, product, ok, code)
       VALUES (1, '2026-08-21', 'recurring', 0, 'not_ready')`,
    ).run()
    const out = render()
    expect(out).toContain('still being prepared')
    expect(out).not.toContain('couldn’t reach your bank')
  })
})
