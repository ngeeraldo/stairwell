// modules/tests/plaidSources.test.ts
//
// What the shared management surface is allowed to say about a connection.
//
// This is a READ over the envelope, shared for the same reason the envelope is
// shared: every finance dashboard shows the same source list with the same
// capabilities (2026-08-21 plan, D4), and two implementations of "is this bank
// live" would be two answers to a question a friend asks once.
//
// The states matter more than they look. docs/dashboard-ui-ux-guidelines.md
// forbids rendering stale data as current, and every wrong answer here is
// exactly that: a disconnected bank reported as live is frozen numbers with a
// confident label on them, and a bank needing re-login reported as merely
// "couldn't reach" hides the one failure the friend can actually fix.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserDb } from '@/lib/db/userDb'
import { readPlaidSources } from '@/modules/plaid/sources'

const moduleSql = (name: string) =>
  readFileSync(resolve(__dirname, '..', 'plaid', name), 'utf8')
const SCHEMA = [moduleSql('initial.sql'), moduleSql('002_multi_source.sql')].join('\n')

let db: UserDb

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SCHEMA)
})
afterEach(() => db.close())

function item(
  itemId: string,
  over: { name?: string | null; connectedAt?: number; disconnectedAt?: number | null } = {},
) {
  db.prepare(
    `INSERT INTO plaid_items
       (item_id, access_token, institution_id, institution_name, available_products,
        connected_at, disconnected_at)
     VALUES (?, 'token', 'ins_1', ?, '[]', ?, ?)`,
  ).run(
    itemId,
    over.name === undefined ? 'FIRST PLATYPUS BANK TEST' : over.name,
    over.connectedAt ?? 1,
    over.disconnectedAt ?? null,
  )
}

function account(itemId: string, accountId: string) {
  db.prepare('INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)').run(
    accountId,
    itemId,
    '{}',
  )
}

function refresh(
  itemId: string,
  over: { at?: number; product?: string; ok?: boolean; code?: string | null } = {},
) {
  db.prepare(
    'INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    over.at ?? 1_000,
    '2026-08-21',
    over.product ?? 'transactions',
    over.ok === false ? 0 : 1,
    over.code ?? null,
    itemId,
  )
}

describe('the source list', () => {
  it('is empty when the friend has connected nothing', () => {
    expect(readPlaidSources(db)).toEqual([])
  })

  it('lists every bank, oldest connection first', () => {
    item('item_b', { connectedAt: 2 })
    item('item_a', { connectedAt: 1 })

    expect(readPlaidSources(db).map((s) => s.itemId)).toEqual(['item_a', 'item_b'])
  })

  it('lists a disconnected bank too, because its history is still on screen', () => {
    // Hiding it would be the orphan again: the friend's transactions stay
    // visible with nothing that explains them and no control to remove them.
    item('item_a', { disconnectedAt: 5 })

    expect(readPlaidSources(db)).toHaveLength(1)
  })

  it('carries the institution name, so two banks can be told apart', () => {
    item('item_a')
    expect(readPlaidSources(db)[0]!.name).toBe('FIRST PLATYPUS BANK TEST')
  })

  it('falls back to a plain phrase when Plaid gave no name', () => {
    // NOT the institution id. `ins_109508` in place of a bank's name reads as a
    // broken row, and a friend cannot act on it.
    item('item_a', { name: null })
    expect(readPlaidSources(db)[0]!.name).toBe('Your bank')
  })

  it('counts the accounts under each bank, and only its own', () => {
    item('item_a')
    item('item_b', { connectedAt: 2 })
    account('item_a', 'acc_1')
    account('item_a', 'acc_2')
    account('item_b', 'acc_3')

    expect(readPlaidSources(db).map((s) => s.accountCount)).toEqual([2, 1])
  })
})

describe('what did NOT come through', () => {
  // THE GAP A REAL SESSION FOUND. A refresh can succeed and fail at the same
  // time — one bank's transactions land while its balances don't — and the
  // status stayed 'live' saying "Updated just now", which is a true statement
  // about the connection and a false one about the numbers on the page.
  // docs/dashboard-ui-ux-guidelines.md > States forbids exactly that.
  //
  // The rows were always written. They were just thrown away once anything
  // succeeded.
  it('names a product that failed while others succeeded', () => {
    item('item_a')
    refresh('item_a', { at: 2_000, product: 'transactions' })
    refresh('item_a', { at: 2_000, product: 'accounts', ok: false, code: 'http' })

    const source = readPlaidSources(db)[0]!
    // Still live — the connection works, and the dot should say so.
    expect(source.status).toBe('live')
    expect(source.failedProducts).toEqual(['accounts'])
  })

  it('does NOT count a still-preparing product as a failure', () => {
    // Routine on the first refresh after connecting. Telling a friend
    // something went wrong here would be wrong at the moment it is working.
    item('item_a')
    refresh('item_a', { at: 2_000, product: 'transactions' })
    refresh('item_a', { at: 2_000, product: 'recurring', ok: false, code: 'not_ready' })

    expect(readPlaidSources(db)[0]!.failedProducts).toEqual([])
  })

  it('forgets a failure the friend has already refreshed past', () => {
    // It describes the LAST attempt, not the history. A caveat that lingered
    // after a successful retry would train someone to ignore it.
    item('item_a')
    refresh('item_a', { at: 1_000, product: 'accounts', ok: false, code: 'http' })
    refresh('item_a', { at: 5_000, product: 'accounts' })

    expect(readPlaidSources(db)[0]!.failedProducts).toEqual([])
  })

  it('reads only its own bank’s failures', () => {
    item('item_a')
    item('item_b', { connectedAt: 2 })
    refresh('item_a', { at: 2_000, product: 'transactions' })
    refresh('item_b', { at: 2_000, product: 'transactions' })
    refresh('item_b', { at: 2_000, product: 'holdings', ok: false, code: 'http' })

    expect(readPlaidSources(db).map((s) => s.failedProducts)).toEqual([[], ['holdings']])
  })

  it('lists every product that failed, not just the first', () => {
    item('item_a')
    refresh('item_a', { at: 2_000, product: 'transactions' })
    refresh('item_a', { at: 2_000, product: 'holdings', ok: false, code: 'http' })
    refresh('item_a', { at: 2_000, product: 'accounts', ok: false, code: 'timeout' })

    expect(readPlaidSources(db)[0]!.failedProducts.sort()).toEqual(['accounts', 'holdings'])
  })
})

describe('what a source says about itself', () => {
  it('says never refreshed when nothing has been pulled yet', () => {
    // A freshly connected bank has a token and zero rows for several seconds
    // while Plaid backfills. Calling that a failure tells a friend their
    // connection broke at the moment it is working.
    item('item_a')
    expect(readPlaidSources(db)[0]!.status).toBe('never_refreshed')
  })

  it('says live once a refresh has succeeded', () => {
    item('item_a')
    refresh('item_a', { at: 2_000 })
    const source = readPlaidSources(db)[0]!
    expect(source.status).toBe('live')
    expect(source.lastRefreshAt).toBe(2_000)
  })

  it('says no longer updating for a disconnected bank, whatever its history', () => {
    // Precedence matters: this bank refreshed successfully an hour before it
    // was disconnected, and reporting it live would put a confident label on
    // frozen numbers.
    item('item_a', { disconnectedAt: 9_000 })
    refresh('item_a', { at: 2_000 })

    expect(readPlaidSources(db)[0]!.status).toBe('disconnected')
  })

  it('says the friend must sign in again when their bank says so', () => {
    // The one failure only they can fix. Reporting it as a generic error
    // hides the single action that resolves it.
    item('item_a')
    refresh('item_a', { at: 2_000, ok: false, code: 'item_login_required' })

    expect(readPlaidSources(db)[0]!.status).toBe('needs_login')
  })

  it('prefers sign-in-again over a plain failure when both are recorded', () => {
    item('item_a')
    refresh('item_a', { at: 2_000, product: 'accounts', ok: false, code: 'network' })
    refresh('item_a', { at: 2_000, product: 'transactions', ok: false, code: 'item_login_required' })

    expect(readPlaidSources(db)[0]!.status).toBe('needs_login')
  })

  it('says it could not be reached when the last attempt simply failed', () => {
    item('item_a')
    refresh('item_a', { at: 2_000, ok: false, code: 'network' })

    expect(readPlaidSources(db)[0]!.status).toBe('unreachable')
  })

  it('does NOT call a still-preparing product a failure', () => {
    // `not_ready` means Plaid holds the connection and has not finished
    // preparing that product — routine on the first refresh after connecting.
    item('item_a')
    refresh('item_a', { at: 2_000, product: 'transactions' })
    refresh('item_a', { at: 2_000, product: 'recurring', ok: false, code: 'not_ready' })

    expect(readPlaidSources(db)[0]!.status).toBe('live')
  })

  it('is still live when an older attempt failed and the newest succeeded', () => {
    // Status describes the connection NOW. A failure the friend already
    // recovered from is history, not a state.
    item('item_a')
    refresh('item_a', { at: 1_000, ok: false, code: 'network' })
    refresh('item_a', { at: 5_000 })

    expect(readPlaidSources(db)[0]!.status).toBe('live')
  })

  it('reads only its own bank’s refresh history', () => {
    // Two banks, one broken. Sharing a status between them would send the
    // friend to re-authenticate a bank that is fine.
    item('item_a')
    item('item_b', { connectedAt: 2 })
    refresh('item_a', { at: 2_000, ok: false, code: 'item_login_required' })
    refresh('item_b', { at: 2_000 })

    expect(readPlaidSources(db).map((s) => s.status)).toEqual(['needs_login', 'live'])
  })

  it('ignores refresh rows written before a bank was named on them', () => {
    // plaid_refreshes rows predating 002_multi_source carry a NULL item_id and
    // do not know which connection they described. Attributing one to a bank
    // would be inventing what an old row meant.
    item('item_a')
    db.prepare(
      'INSERT INTO plaid_refreshes (at, day, product, ok, code) VALUES (9000, ?, ?, 1, NULL)',
    ).run('2026-08-21', 'transactions')

    const source = readPlaidSources(db)[0]!
    expect(source.status).toBe('never_refreshed')
    expect(source.lastRefreshAt).toBeNull()
  })
})
