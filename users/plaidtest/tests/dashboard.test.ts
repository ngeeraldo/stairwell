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
import { PlaidSources } from '@/lib/ui/PlaidSources'
import type { PlaidSource } from '@/modules/plaid/sources'
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

const tree = () =>
  Dashboard({
    slug: 'plaidtest',
    db,
    today: '2026-08-21',
    now: Date.parse('2026-08-21T12:00:00Z'),
    timeZone: 'America/Chicago',
  })

const render = () => JSON.stringify(tree())

/**
 * The props this dashboard handed the shared bank surface.
 *
 * Its OUTPUT is not reachable from here: a server component is rendered by
 * CALLING it, so a child component element in the returned tree still holds
 * its props and has not produced any DOM. That is the honest boundary anyway —
 * this dashboard's job is to hand the shared surface the friend's connections,
 * and what the surface then says is pinned once, in
 * tests/ui/plaidSources.test.tsx, rather than re-asserted in every folder.
 */
function surface(): { slug: string; sources: PlaidSource[]; now: number } | null {
  let found: { slug: string; sources: PlaidSource[]; now: number } | null = null
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (!node || typeof node !== 'object') return
    const element = node as { type?: unknown; props?: Record<string, unknown> }
    if (element.type === PlaidSources) {
      found = element.props as { slug: string; sources: PlaidSource[]; now: number }
      return
    }
    if (element.props) walk(element.props.children)
  }
  walk(tree())
  return found
}

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
    expect(render()).toContain('No bank connected')
    // And the shared surface is still handed the (empty) list, so the friend
    // gets a connect control from the same place everyone else does.
    expect(surface()).toMatchObject({ slug: 'plaidtest', sources: [] })
  })

  it('promises that the bank login never reaches the server', () => {
    // A claim about where credentials go is a promise to a person, not copy.
    expect(render()).toContain('never reaches this')
  })

  it('shows no account or transaction panel at all', () => {
    const out = render()
    expect(out).not.toContain('Recent transactions')
    expect(out).not.toContain('Stop updating')
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

  it('hands every bank control to the shared surface', () => {
    // WHAT THIS DASHBOARD NO LONGER DOES. It used to hand-wire a refresh, a
    // reconnect and a disconnect, and offered no way to add a second bank,
    // change which accounts one shared, or delete one. Every friend with a
    // bank now gets the same controls from lib/ui/PlaidSources.tsx, swept for
    // by tests/users/plaidSurface.test.ts — so what is asserted here is that
    // the delegation happened, not what each control says. That belongs to
    // tests/ui/plaidSources.test.tsx, where there is one copy of it.
    connect()
    const props = surface()
    expect(props?.sources.map((s) => s.itemId)).toEqual(['item_1'])
    // A freshly connected bank is WORKING, not broken.
    expect(props?.sources[0]!.status).toBe('never_refreshed')
  })

  it('does NOT say "no bank connected" when the only bank is disconnected', () => {
    // Disconnecting is a soft delete: the row survives and so does every
    // transaction under it. Falling back to the connect screen would put "No
    // bank connected" above a page still full of that bank's data, and would
    // hide the only control that can delete it.
    connect()
    db.prepare('UPDATE plaid_items SET disconnected_at = 9000').run()
    const out = render()
    expect(out).not.toContain('No bank connected')
    expect(surface()?.sources.map((s) => s.status)).toEqual(['disconnected'])
  })

  it('hands down the render instant rather than reading a clock', () => {
    // "Updated 5 minutes ago" needs an instant, and a dashboard is not allowed
    // to ask for one — tests/users/noLocalDay.test.ts sweeps for it. The page
    // resolves it once, from the same Date.now() that produced `today`.
    connect()
    expect(surface()?.now).toBe(Date.parse('2026-08-21T12:00:00Z'))
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
    // The seeder now writes its own loudly-fake item, so this block is already
    // connected — connect() again would violate the primary key.
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

  it('leaves Refresh to the shared surface, which puts a time next to it', () => {
    // A friend's data key lives only in the in-process keymap while they are
    // unlocked, so nothing can pull on their behalf while they are away. There
    // is no scheduled job and there cannot be one — pressing this is what
    // "fresh" means.
    //
    // The control moved to lib/ui/PlaidSources.tsx along with everything else
    // a friend does to a bank, and gained something this dashboard's own
    // version never had: a last-updated time beside it
    // (docs/dashboard-ui-ux-guidelines.md > States). Its wording, including
    // the failure sentence that must not say "nothing was recorded" when a
    // failed refresh writes a row per product, is pinned in
    // tests/ui/plaidSources.test.tsx.
    //
    // (This block's beforeEach already connected — connect() again would
    // violate plaid_items' primary key.)
    // TWO banks, because that is what modules/plaid/seed_plaid.py now seeds —
    // one live and one disconnected, so every finance dashboard renders the
    // multi-source states by default rather than only after a friend hits
    // them.
    const sources = surface()?.sources ?? []
    expect(sources).toHaveLength(2)
    expect(sources.filter((s) => s.status === 'disconnected')).toHaveLength(1)
  })

  it('stops showing an account the bank no longer shares, without deleting it', () => {
    // Nothing deletes the data of an unticked account — the picker only adds
    // — so the JOIN to plaid_accounts is what keeps it off the screen. Without
    // it this list would keep showing an account the friend removed, forever,
    // with nothing to explain why it is there.
    // An account that actually HAS transactions — most of the fixture's
    // fourteen are investment or loan accounts with none.
    const shown = db
      .prepare(
        `SELECT t.transaction_id, t.account_id
           FROM plaid_transactions t
           JOIN plaid_accounts a ON a.account_id = t.account_id
          ORDER BY t.date DESC LIMIT 1`,
      )
      .get() as { transaction_id: string; account_id: string }
    expect(render()).toContain(shown.transaction_id)

    // What the next refresh does when Plaid stops returning that account.
    db.prepare('DELETE FROM plaid_accounts WHERE account_id = ?').run(shown.account_id)

    expect(render()).not.toContain(shown.transaction_id)
    // And the rows are still there, ready to come back if it is re-ticked.
    expect(
      (
        db
          .prepare('SELECT COUNT(*) n FROM plaid_transactions WHERE account_id = ?')
          .get(shown.account_id) as { n: number }
      ).n,
    ).toBeGreaterThan(0)
  })

  it('names which BANK each refresh line is about', () => {
    // THE BUG A REAL SESSION FOUND. Grouping by product alone rendered
    // "transactions: ok / transactions: ok / transactions: ok" for a friend
    // with three connections — three true statements that together said
    // nothing anyone could act on, while one of those banks was failing and
    // the list could not say which.
    const items = db.prepare('SELECT item_id FROM plaid_items ORDER BY connected_at').all() as {
      item_id: string
    }[]
    // DIFFERENT instants per bank, which is the case that separates "latest
    // per bank per product" from "latest per product". Refreshing is per-press
    // and a disconnected bank is skipped, so two banks routinely have their
    // last attempt at different times — and grouping by product alone drops
    // the older bank's line entirely rather than showing it as stale.
    for (const [index, item] of items.entries()) {
      db.prepare(
        `INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id)
         VALUES (?, '2026-08-21', 'transactions', ?, ?, ?)`,
      ).run(9_000 - index * 1_000, index === 0 ? 1 : 0, index === 0 ? null : 'network', item.item_id)
    }

    const out = render()
    expect(out).toContain('FIRST PLATYPUS BANK TEST — ')
    expect(out).toContain('SECOND PLATYPUS BANK TEST — ')
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
