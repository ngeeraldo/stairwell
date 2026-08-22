// users/run11/tests/spending.test.ts
//
// Spec v3's third screen: the pie, the transaction list, and every rule that
// decides what a slice IS. This is where the Spending screen is actually
// proved — the component renders whatever ./queries.ts returns, so a wrong
// window or a mis-netted category is a wrong dashboard that still renders
// perfectly (2026-08-12 hosting design §11.5 — the conventions sweep proves
// shape, not correctness).
//
// EVERY DAY IN THIS FILE IS A LITERAL. Nothing here reads a clock: `today` is a
// parameter precisely so a test can sit on a fixed day on any machine, on any
// day of the year.
//
// ─── WHAT THIS FILE CANNOT SEE ─────────────────────────────────────────────
//
// The pie itself (./SpendingPie.tsx) and the re-file controls
// (./CategoryControls.tsx) are CLIENT components, and JSON.stringify of the
// returned element tree never runs their bodies — the same limitation
// lib/ui/useWriteAction.ts records about its own guard. So the render
// assertions below reach their PROPS and stop there.
//
// That is deliberate rather than a gap papered over: every rule those
// components would otherwise apply lives in ./queries.ts — `categoryTotals`,
// `foldIntoOther`, `categoryLabel` — where the first half of this file
// exercises it directly. The components decide nothing.
//
// ─── AND WHAT IT DELIBERATELY DOES NOT REPRODUCE ───────────────────────────
//
// The write path. A user's test must not import a platform route, so the
// override rows below are written by hand — which means nothing here goes red
// if app/api/users/[user]/spending-category/route.ts changes. That half is
// tests/routing/spendingCategoryRoute.test.ts, and the two are deliberately
// separate halves of one path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as React from 'react'
import Database from 'better-sqlite3-multiple-ciphers'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard from '@/users/run11/dashboard'
import { applyUserMigrations, emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  CATEGORY_NAME_MAX,
  OTHER_CATEGORY,
  PIE_MAX_SLICES,
  SPENDING_WINDOW_DAYS,
  bankCategories,
  categoryLabel,
  categoryTotals,
  categoryVisibility,
  customCategories,
  foldIntoOther,
  isConnected,
  lastRefreshes,
  spendingAccounts,
  spendingTransactions,
  spendingWindowStart,
  type SpendingTransaction,
} from '@/users/run11/queries'

beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const TODAY = '2026-08-20'
/**
 * The render instant the page would have handed down for a given day.
 *
 * Derived from the same day the test asked for, so `today` and `now` agree
 * the way app/[user]/page.tsx guarantees they do.
 */
const atMidday = (day: string) => Date.parse(`${day}T12:00:00Z`)

let db: UserDb

function freshDb(): UserDb {
  const handle = new Database(':memory:')
  applyUserMigrations(handle, 'run11')
  return handle
}

/** A connected item, which is what decides connected-vs-not. */
function connect() {
  db.prepare(
    `INSERT INTO plaid_items (item_id, access_token, institution_id, available_products, payload, connected_at)
     VALUES ('item-TEST', 'access-NOT-A-REAL-TOKEN-TEST', 'ins_TEST', '[]', '{}', 1)`,
  ).run()
}

/**
 * An account, shaped the way the envelope really stores one: everything in the
 * payload, reached with json_extract. Defaults to the credit card, which is one
 * of the two kinds 004's view counts.
 */
function account(
  accountId: string,
  { type = 'credit', subtype = 'credit card', name = 'CARD TEST', mask = '3333' } = {},
) {
  db.prepare('INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)').run(
    accountId,
    'item-TEST',
    JSON.stringify({ name, mask, type, subtype }),
  )
}

let txnSeq = 0
/** A transaction. `amount` follows Plaid's sign: positive out, negative in. */
function txn({
  id,
  day,
  amount,
  category = 'FOOD_AND_DRINK',
  accountId = 'acct-card',
  merchant = 'COFFEE PALACE TEST',
  pending = false,
}: {
  id?: string
  day: string
  amount: number
  category?: string | null
  accountId?: string
  merchant?: string | null
  pending?: boolean
}): string {
  txnSeq += 1
  const transactionId = id ?? `txn-${txnSeq}-TEST`
  db.prepare(
    'INSERT INTO plaid_transactions (transaction_id, account_id, date, payload) VALUES (?, ?, ?, ?)',
  ).run(
    transactionId,
    accountId,
    day,
    JSON.stringify({
      amount,
      merchant_name: merchant,
      name: 'RAW DESCRIPTION TEST',
      pending,
      personal_finance_category: category === null ? null : { primary: category },
    }),
  )
  return transactionId
}

function refile(transactionId: string, category: string) {
  db.prepare(
    'INSERT INTO transaction_category_overrides (transaction_id, category, set_at) VALUES (?, ?, ?)',
  ).run(transactionId, category, 1)
}

function bucket(name: string) {
  db.prepare('INSERT INTO custom_categories (name, created_at) VALUES (?, ?)').run(name, 1)
}

function refresh({ product = 'transactions', ok = 1, code = null as string | null, at = 1 } = {}) {
  db.prepare(
    'INSERT INTO plaid_refreshes (at, day, product, ok, code) VALUES (?, ?, ?, ?, ?)',
  ).run(at, TODAY, product, ok, code)
}

function render(handle: UserDb, today = TODAY, screen = 'spending'): string {
  return JSON.stringify(
    Dashboard({
      slug: 'run11',
      db: handle,
      today,
      now: atMidday(today),
      timeZone: 'America/Chicago',
      screen,
    }),
  )
}

/** Tick or untick a category explicitly, as pressing the legend's box does. */
function choose(category: string, included: boolean) {
  db.prepare(
    'INSERT INTO category_visibility (category, included, set_at) VALUES (?, ?, ?)',
  ).run(category, included ? 1 : 0, 1)
}

/** Just the categories and net amounts, which is what most cases are about. */
function totalsOf(handle: UserDb, today = TODAY) {
  const totals = categoryTotals(spendingTransactions(handle, today), categoryVisibility(handle))
  return {
    slices: totals.slices.map((s) => [s.category, s.amount] as const),
    /** Every category in the window that draws no wedge, in legend order. */
    unticked: totals.rows.filter((r) => !r.included).map((r) => r.category),
    rows: totals.rows.map((r) => [r.category, r.amount, r.included] as const),
    total: totals.total,
  }
}

beforeEach(() => {
  txnSeq = 0
  db = freshDb()
  connect()
  account('acct-card')
})

afterEach(() => {
  db.close()
})

describe('users/run11 — the 30-day window', () => {
  it('runs 30 days inclusive, ending today', () => {
    // The same reading walkRate uses for "the last 30 days", deliberately, so
    // two panels on one dashboard do not mean two different things by it.
    expect(spendingWindowStart('2026-08-20')).toBe('2026-07-22')
    expect(SPENDING_WINDOW_DAYS).toBe(30)
  })

  it('includes both boundary days and excludes the day before the window', () => {
    // THE OFF-BY-ONE THAT MATTERS: a transaction 30 days back is inside, one 31
    // days back is not, and today's is inside. All three tested, because each
    // is a different comparison.
    txn({ day: '2026-07-21', amount: 1 }) // out: the day before the window
    txn({ day: '2026-07-22', amount: 2 }) // in: the first day of it
    txn({ day: TODAY, amount: 4 }) // in: today
    txn({ day: '2026-08-21', amount: 8 }) // out: tomorrow, which can exist

    const amounts = spendingTransactions(db, TODAY).map((r) => r.amount)
    expect(amounts.sort((a, b) => a - b)).toEqual([2, 4])
  })

  it('returns rows newest first, which is the order the list renders in', () => {
    txn({ day: '2026-08-01', amount: 1 })
    txn({ day: TODAY, amount: 2 })
    txn({ day: '2026-08-10', amount: 3 })
    expect(spendingTransactions(db, TODAY).map((r) => r.day)).toEqual([
      TODAY,
      '2026-08-10',
      '2026-08-01',
    ])
  })

  it('does not read a clock — the same database gives different answers for different days', () => {
    // The guarantee tests/users/noLocalDay.test.ts enforces statically, stated
    // as behaviour: `today` is the only thing that moves the window.
    txn({ day: '2026-07-01', amount: 5 })
    expect(spendingTransactions(db, TODAY)).toHaveLength(0)
    expect(spendingTransactions(db, '2026-07-05')).toHaveLength(1)
  })
})

describe('users/run11 — which accounts count', () => {
  it('counts credit cards and checking accounts, and nothing else', () => {
    // Spec v3: "a connected credit card and a connected debit card". A debit
    // card IS a checking account. Savings, CD and money-market rows are
    // transfers between his own accounts, and letting them in is exactly the
    // "transfers can dominate a spending breakdown" the spec's own open
    // question warns about.
    account('acct-checking', { type: 'depository', subtype: 'checking', name: 'CHECKING TEST' })
    account('acct-savings', { type: 'depository', subtype: 'savings', name: 'SAVINGS TEST' })
    account('acct-invest', { type: 'investment', subtype: 'ira', name: 'IRA TEST' })
    account('acct-loan', { type: 'loan', subtype: 'student', name: 'LOAN TEST' })

    expect(spendingAccounts(db).map((a) => a.accountId).sort()).toEqual([
      'acct-card',
      'acct-checking',
    ])
  })

  it('drops a transaction on an account it does not cover', () => {
    account('acct-savings', { type: 'depository', subtype: 'savings' })
    txn({ day: TODAY, amount: 10, accountId: 'acct-card' })
    txn({ day: TODAY, amount: 5000, accountId: 'acct-savings', category: 'TRANSFER_OUT' })

    expect(spendingTransactions(db, TODAY)).toHaveLength(1)
    expect(totalsOf(db).slices).toEqual([['FOOD_AND_DRINK', 10]])
  })
})

describe('users/run11 — what a slice is', () => {
  it('nets signed amounts, so a refund reduces the category it came back from', () => {
    // Plaid signs an outflow positive and an inflow negative. A $500 flight
    // charged and refunded is not $500 that went to travel, and a pie saying it
    // did answers his one question with a number he did not spend.
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -200, category: 'TRAVEL' })
    expect(totalsOf(db).slices).toEqual([['TRAVEL', 300]])
  })

  it('unticks a category that nets to exactly zero, rather than hiding it', () => {
    // A real case, and one the synthetic database actually contains: a charge
    // and a matching refund. There is no such thing as a zero-width wedge — but
    // the transactions are still in the list below it, so a category that
    // simply vanished would look like a bug. It stays in the legend with an
    // empty box instead, which explains itself.
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 40, category: 'FOOD_AND_DRINK' })

    const totals = totalsOf(db)
    expect(totals.slices).toEqual([['FOOD_AND_DRINK', 40]])
    expect(totals.unticked).toEqual(['TRAVEL'])
    // …and it is still one of the four rows the friend can see and re-file.
    expect(spendingTransactions(db, TODAY)).toHaveLength(3)
  })

  it('draws no slice for a category that nets NEGATIVE either', () => {
    txn({ day: TODAY, amount: 100, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -250, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 40, category: 'FOOD_AND_DRINK' })
    expect(totalsOf(db).unticked).toEqual(['TRAVEL'])
  })

  it('rounds to cents BEFORE deciding whether a category survives', () => {
    // Float residue must not decide whether a category appears at all.
    txn({ day: TODAY, amount: 0.1, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 0.2, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -0.3, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 40, category: 'FOOD_AND_DRINK' })
    expect(totalsOf(db).unticked).toEqual(['TRAVEL'])
  })

  it('shares sum to 1 across the drawn slices', () => {
    txn({ day: TODAY, amount: 25, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 75, category: 'TRAVEL' })
    const totals = categoryTotals(spendingTransactions(db, TODAY))
    expect(totals.slices.map((s) => s.share)).toEqual([0.75, 0.25])
    expect(totals.total).toBe(100)
  })

  it('orders largest first, with ties broken by name so colours do not shuffle', () => {
    // Two categories at the same figure swapping places between renders would
    // look like the data moved. The palette is assigned by rank, so a stable
    // order is what makes the colours stable.
    txn({ day: TODAY, amount: 50, category: 'ZULU' })
    txn({ day: TODAY, amount: 50, category: 'ALPHA' })
    txn({ day: TODAY, amount: 90, category: 'MIDDLE' })
    expect(totalsOf(db).slices.map(([c]) => c)).toEqual(['MIDDLE', 'ALPHA', 'ZULU'])
  })

  it('counts a pending charge, and says it is pending', () => {
    // The money has left as far as he is concerned; it can still change amount
    // or vanish, which is why the row is labelled rather than dropped.
    txn({ day: TODAY, amount: 12, pending: true })
    const rows = spendingTransactions(db, TODAY)
    expect(rows[0]!.pending).toBeTruthy()
    expect(totalsOf(db).slices).toEqual([['FOOD_AND_DRINK', 12]])
  })

  it('files a transaction Plaid did not categorise into UNCATEGORIZED', () => {
    // A null category would collapse into a nameless slice. This is a bucket
    // he can see and re-file out of.
    txn({ day: TODAY, amount: 9, category: null })
    expect(totalsOf(db).slices).toEqual([['UNCATEGORIZED', 9]])
  })
})

describe('users/run11 — ticking a category in or out of the pie', () => {
  it('ticks a positive category by default, without storing anything', () => {
    // The default is resolved at READ time. Nothing is written on his behalf —
    // a render never writes, and the handle is read-only anyway.
    txn({ day: TODAY, amount: 40, category: 'FOOD_AND_DRINK' })
    expect(totalsOf(db).rows).toEqual([['FOOD_AND_DRINK', 40, true]])
    expect(categoryVisibility(db).size).toBe(0)
  })

  it('unticks a zero or negative category by default, also without storing', () => {
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -500, category: 'TRAVEL' })
    expect(totalsOf(db).rows).toEqual([['TRAVEL', 0, false]])
    expect(categoryVisibility(db).size).toBe(0)
  })

  it('takes a category OUT of the pie and out of the percentages', () => {
    // The whole point: spec v3's own open question is that a transfer or a card
    // payment can dominate a breakdown and make it read wrong. Unticking it
    // rescales everything else, because the denominator is only what is ticked.
    txn({ day: TODAY, amount: 900, category: 'LOAN_PAYMENTS' })
    txn({ day: TODAY, amount: 75, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 25, category: 'TRANSPORTATION' })

    const before = categoryTotals(spendingTransactions(db, TODAY), categoryVisibility(db))
    expect(before.total).toBe(1000)

    choose('LOAN_PAYMENTS', false)
    const after = categoryTotals(spendingTransactions(db, TODAY), categoryVisibility(db))
    expect(after.total).toBe(100)
    expect(after.slices.map((s) => [s.category, s.share])).toEqual([
      ['FOOD_AND_DRINK', 0.75],
      ['TRANSPORTATION', 0.25],
    ])
    // It is still a LEGEND row, with its amount, so he can put it back.
    expect(after.rows.map((r) => r.category)).toContain('LOAN_PAYMENTS')
    expect(after.rows.find((r) => r.category === 'LOAN_PAYMENTS')!.amount).toBe(900)
  })

  it('lets him tick a zero-net category back on, overriding the default', () => {
    // Both directions have to be expressible, which is why the table stores a
    // boolean rather than a presence.
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -500, category: 'TRAVEL' })
    choose('TRAVEL', true)
    const row = totalsOf(db).rows.find(([c]) => c === 'TRAVEL')!
    expect(row[2]).toBe(true)
    // …and it STILL draws no wedge, because there is no zero-width wedge. The
    // tick governs the denominator; the geometry refuses it either way.
    expect(totalsOf(db).slices).toEqual([])
  })

  it('brings a defaulted-off category back on its own when it goes positive', () => {
    // THE REASON THE DEFAULT IS NOT WRITTEN DOWN. A category that nets to zero
    // this fortnight and goes positive next month must not stay silently
    // switched off because of one quiet spell he was not watching.
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    const refund = txn({ day: TODAY, amount: -500, category: 'TRAVEL' })
    expect(totalsOf(db).rows).toEqual([['TRAVEL', 0, false]])

    // A new charge lands — nothing about his choices changed, because he made
    // none.
    db.prepare('DELETE FROM plaid_transactions WHERE transaction_id = ?').run(refund)
    expect(totalsOf(db).rows).toEqual([['TRAVEL', 500, true]])
  })

  it('keeps an explicit untick even when the amount would default it on', () => {
    // The mirror of the case above: a choice he DID make must survive the
    // amount moving, or the control would silently undo itself.
    txn({ day: TODAY, amount: 900, category: 'LOAN_PAYMENTS' })
    choose('LOAN_PAYMENTS', false)
    txn({ day: TODAY, amount: 100, category: 'LOAN_PAYMENTS' })
    expect(totalsOf(db).rows).toEqual([['LOAN_PAYMENTS', 1000, false]])
  })

  it('reads back only the choices he actually made', () => {
    txn({ day: TODAY, amount: 40, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 10, category: 'TRAVEL' })
    choose('TRAVEL', false)
    expect(categoryVisibility(db)).toEqual(new Map([['TRAVEL', false]]))
    const rows = totalsOf(db).rows
    expect(rows).toEqual([
      ['FOOD_AND_DRINK', 40, true],
      ['TRAVEL', 10, false],
    ])
  })

  it('gives an unticked category no percentage, because it is not in the denominator', () => {
    txn({ day: TODAY, amount: 900, category: 'LOAN_PAYMENTS' })
    txn({ day: TODAY, amount: 100, category: 'FOOD_AND_DRINK' })
    choose('LOAN_PAYMENTS', false)
    const totals = categoryTotals(spendingTransactions(db, TODAY), categoryVisibility(db))
    expect(totals.rows.find((r) => r.category === 'LOAN_PAYMENTS')!.share).toBe(0)
    expect(totals.rows.find((r) => r.category === 'FOOD_AND_DRINK')!.share).toBe(1)
  })
})

describe('users/run11 — re-filing', () => {
  it('lets the override win over Plaid, and the pie follows it', () => {
    // Spec v3: "the change sticks — it survives future syncs and it is what the
    // pie above is drawn from".
    const id = txn({ day: TODAY, amount: 30, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 10, category: 'FOOD_AND_DRINK' })
    bucket('Eating out')
    refile(id, 'Eating out')

    expect(totalsOf(db).slices).toEqual([
      ['Eating out', 30],
      ['FOOD_AND_DRINK', 10],
    ])
  })

  it('leaves the synced row alone, so a refresh cannot trample the re-filing', () => {
    // THE ANNOTATION RULE, as behaviour. The override is keyed to the
    // transaction in the friend's OWN table; the payload still says what the
    // bank said.
    const id = txn({ day: TODAY, amount: 30, category: 'FOOD_AND_DRINK' })
    refile(id, 'Eating out')
    const row = spendingTransactions(db, TODAY)[0]!
    expect(row.plaidCategory).toBe('FOOD_AND_DRINK')
    expect(row.overrideCategory).toBe('Eating out')
    expect(row.category).toBe('Eating out')
  })

  it('marks a row as moved only when it really was', () => {
    // The list says "moved by you" from this field. Without it, a category that
    // disagrees with his bank's own app looks like the dashboard got it wrong
    // rather than like something he did on purpose weeks ago.
    const id = txn({ day: TODAY, amount: 30 })
    txn({ day: TODAY, amount: 10 })
    refile(id, 'Eating out')
    const flags = spendingTransactions(db, TODAY).map((r) => r.overrideCategory !== null)
    expect(flags.filter(Boolean)).toHaveLength(1)
  })
})

describe('users/run11 — the categories he can choose from', () => {
  it('offers his own buckets, including ones nothing is filed into yet', () => {
    // Spec v3 has a custom category becoming a slice "once anything is filed
    // there", which makes an empty one a legitimate state — and it must still
    // be offered, or a bucket he just made cannot be used.
    bucket('Dog stuff')
    bucket('Eating out')
    expect(customCategories(db)).toEqual(['Dog stuff', 'Eating out'])
    expect(totalsOf(db).slices).toEqual([])
  })

  it('offers every category his bank has produced, including outside the window', () => {
    // A category on screen last month has to stay reachable, or a transaction
    // re-filed by mistake can never be put back where it came from.
    txn({ day: TODAY, amount: 5, category: 'FOOD_AND_DRINK' })
    txn({ day: '2026-01-01', amount: 5, category: 'TRAVEL' })
    expect(bankCategories(db)).toEqual(['FOOD_AND_DRINK', 'TRAVEL'])
  })

  it('humanises a bank category and leaves his own name exactly as typed', () => {
    // `FOOD_AND_DRINK` on a pie slice reads as a database. His own bucket is
    // his sentence, not ours to reformat — including one deliberately in caps.
    const custom = new Set(['ALL CAPS BUCKET', 'Eating out'])
    expect(categoryLabel('FOOD_AND_DRINK', custom)).toBe('Food and drink')
    expect(categoryLabel('UNCATEGORIZED', custom)).toBe('Uncategorized')
    expect(categoryLabel('Eating out', custom)).toBe('Eating out')
    expect(categoryLabel('ALL CAPS BUCKET', custom)).toBe('ALL CAPS BUCKET')
  })
})

describe('users/run11 — the fold into Other', () => {
  const slice = (category: string, amount: number) => ({ category, amount, share: 0, count: 1 })

  it('draws everything when there is nothing to gain from folding', () => {
    const slices = Array.from({ length: PIE_MAX_SLICES }, (_, i) => slice(`C${i}`, 10 - i))
    expect(foldIntoOther(slices)).toEqual({ drawn: slices, folded: [] })
  })

  it('draws the eighth rather than hiding one category behind "Other"', () => {
    // An "Other" wedge holding a single category hides its name for no gain.
    const slices = Array.from({ length: PIE_MAX_SLICES + 1 }, (_, i) => slice(`C${i}`, 10 - i))
    expect(foldIntoOther(slices).folded).toEqual([])
    expect(foldIntoOther(slices).drawn).toHaveLength(PIE_MAX_SLICES + 1)
  })

  it('folds from the ninth, keeping the largest and combining the rest', () => {
    const slices = Array.from({ length: PIE_MAX_SLICES + 2 }, (_, i) => slice(`C${i}`, 10 - i))
    const { drawn, folded } = foldIntoOther(slices)
    expect(drawn).toHaveLength(PIE_MAX_SLICES + 1)
    // NAMED, not counted: each still needs its own legend row and tick box.
    expect(folded).toEqual(['C7', 'C8'])
    const other = drawn[drawn.length - 1]!
    expect(other.category).toBe(OTHER_CATEGORY)
    // The two smallest, combined — nothing is dropped, only combined.
    expect(other.amount).toBe(slices[7]!.amount + slices[8]!.amount)
    expect(other.count).toBe(2)
  })
})

describe('users/run11 — the connection states', () => {
  it('decides connected by whether an ITEM exists, never by whether rows do', () => {
    // A freshly connected bank has a token and no rows for the seconds Plaid
    // spends backfilling. Inferring "not connected" from an empty table would
    // tell him his connection failed while it was working.
    expect(isConnected(db)).toBe(true)
    expect(spendingTransactions(db, TODAY)).toHaveLength(0)

    const empty = emptyDbFromMigrations('run11')
    try {
      expect(isConnected(empty)).toBe(false)
    } finally {
      empty.close()
    }
  })

  it('reports the LAST attempt per product, failures included', () => {
    refresh({ product: 'transactions', ok: 0, code: 'api_error', at: 1 })
    refresh({ product: 'transactions', ok: 1, at: 2 })
    refresh({ product: 'recurring', ok: 0, code: 'not_ready', at: 2 })
    expect(lastRefreshes(db).map((r) => [r.product, r.ok, r.code])).toEqual([
      ['recurring', 0, 'not_ready'],
      ['transactions', 1, null],
    ])
  })

  // `needsReauth` used to live here. It is gone, and deliberately not
  // replaced: whether a bank needs a re-login is now decided once, in
  // modules/plaid/sources.ts, for every friend with a bank — and that
  // precedence (a sign-in failure outranks a plain one, because it is the only
  // one they can act on) is pinned in modules/tests/plaidSources.test.ts. Two
  // implementations of one question is the fork the shared-module rule
  // forbids, applied to a read instead of to a table.
})

describe('users/run11 — the Spending screen on a screen', () => {
  it('renders on an EMPTY database without throwing, and offers to connect', () => {
    // A friend's first session on this screen: their own database, with no bank
    // in it at all. An empty dashboard is an ordinary state, not an error.
    const empty = emptyDbFromMigrations('run11')
    try {
      expect(() => render(empty)).not.toThrow()
      const json = render(empty)
      expect(json).toContain('Connect a card')
      expect(json).toContain('/api/users/run11/plaid/link-token')
      // NOT a confident zero about someone's money.
      expect(json).not.toContain('$0')
    } finally {
      empty.close()
    }
  })

  it('says what it is waiting for when connected with nothing through yet', () => {
    // STATE 2, and the one most likely to be missed: a token exists, Plaid is
    // still backfilling. "$0.00" here is a confident false statement.
    const json = render(db)
    expect(json).toContain('Nothing has come through')
    expect(json).not.toContain('$0')
    // And the shared bank surface is on the page, so the state is not a dead
    // end: refresh, reconnect and the rest all live there now
    // (lib/ui/PlaidSources.tsx). Its own contents are pinned once, in
    // tests/ui/plaidSources.test.tsx — a server component is rendered by
    // CALLING it, so a child component element in this tree still holds its
    // props and has produced no output to search.
    expect(json).toContain('"sources"')
  })

  it('never mounts the chart when there is nothing drawable', () => {
    // THE ARM-2 STATES CHECK. Degenerate data renders the panel's empty state
    // as host elements; the chart is never mounted at all. Asserted through the
    // props the pie would have been given — `slices` reaches the element tree
    // even though the component's body does not run.
    txn({ day: TODAY, amount: 100, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -100, category: 'TRAVEL' })
    const json = render(db)
    expect(json).toContain('Nothing to draw')
    expect(json).not.toContain('"slices"')
  })

  it('puts each category on screen with its amount and its share', () => {
    // Spec v3 asks each slice to carry both. They are in the legend beside the
    // pie, which is also the table view the palette's contrast result requires.
    txn({ day: TODAY, amount: 750, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 250, category: 'TRANSPORTATION' })
    const json = render(db)
    expect(json).toContain('Food and drink')
    expect(json).toContain('$750')
    expect(json).toContain('75%')
    expect(json).toContain('Transportation')
    expect(json).toContain('$250')
    expect(json).toContain('25%')
  })

  it('shows NO grand total anywhere, which he asked for by correcting himself', () => {
    // He asked for a total, then said in the same conversation that he had
    // misspoken and meant per-category amounts. `categoryTotals` computes one
    // as a denominator; nothing renders it.
    txn({ day: TODAY, amount: 750, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 250, category: 'TRANSPORTATION' })
    const json = render(db)
    expect(json).not.toContain('$1,000')
    expect(json).not.toContain('Total')
    expect(json).not.toContain('total')
  })

  it('names the accounts it is counting, so a missing one is visible', () => {
    // The scope is an allow-list, so a bank reporting his debit account under a
    // different subtype would drop out of the picture. Naming them is what
    // makes that visible rather than silent.
    account('acct-checking', { type: 'depository', subtype: 'checking', name: 'CHECKING TEST' })
    txn({ day: TODAY, amount: 10 })
    const json = render(db)
    expect(json).toContain('CARD TEST')
    expect(json).toContain('CHECKING TEST')
  })

  it('lists three accounts as a sentence, not as "A and B and C"', () => {
    // Two accounts read fine with a bare " and " right up until the synthetic
    // database showed three. He is one connection away from the same sentence.
    account('acct-checking', {
      type: 'depository',
      subtype: 'checking',
      name: 'CHECKING TEST',
      mask: '0000',
    })
    account('acct-card2', { name: 'SECOND CARD TEST', mask: '9999' })
    txn({ day: TODAY, amount: 10 })
    const json = render(db)
    expect(json).toContain(
      'CARD TEST \u2022\u20223333, SECOND CARD TEST \u2022\u20229999 and CHECKING TEST \u2022\u20220000',
    )
    expect(json).not.toContain('and SECOND CARD TEST \u2022\u20229999 and')
  })

  it('keeps a zero-net category on screen with an unticked box', () => {
    // It draws no wedge, but it stays in the legend showing $0 — so he can see
    // where its transactions went, and tick it back if he wants it counted.
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 40, category: 'FOOD_AND_DRINK' })
    const json = render(db)
    expect(json).toContain('Travel')
    // Through the toggle's PROPS, not its markup: CategoryToggle is a client
    // component and JSON.stringify never runs its body, so the aria-label it
    // renders is not reachable from here. The props are what this file can
    // honestly assert, and they are what decide the box.
    expect(json).toContain('"category":"TRAVEL","label":"Travel","included":false')
    expect(json).toContain('$0')
    // And the sentence that used to explain the disappearance is gone with it.
    expect(json).not.toContain('what went out came back')
  })

  it('says how many categories went into "Other" rather than truncating silently', () => {
    for (let i = 0; i < PIE_MAX_SLICES + 2; i += 1) {
      txn({ day: TODAY, amount: 100 - i, category: `CATEGORY_${String(i).padStart(2, '0')}` })
    }
    const json = render(db)
    expect(json).toContain('smallest categories combined')
  })

  it('gives every legend row a tick box, unticked ones included', () => {
    txn({ day: TODAY, amount: 900, category: 'LOAN_PAYMENTS' })
    txn({ day: TODAY, amount: 100, category: 'FOOD_AND_DRINK' })
    choose('LOAN_PAYMENTS', false)
    const json = render(db)
    // Both rows carry a toggle, and the unticked one is still on screen with
    // its amount — a control he cannot reach is a choice he cannot undo.
    expect(json).toContain('"category":"LOAN_PAYMENTS","label":"Loan payments","included":false')
    expect(json).toContain('"category":"FOOD_AND_DRINK","label":"Food and drink","included":true')
    expect(json).toContain('$900')
  })

  it('does NOT caveat the percentages for a category that is only unticked at $0', () => {
    // Unticking a category worth nothing changes no percentage, so a caveat
    // explaining a difference that does not exist is just noise on the panel.
    txn({ day: TODAY, amount: 500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: -500, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 100, category: 'FOOD_AND_DRINK' })
    const json = render(db)
    expect(json).toContain('Travel')
    expect(json).not.toContain('ticked categories only')
  })

  it('says the percentages are of the ticked categories, once something is unticked', () => {
    // Only once he has actually used the control. Before that it is a sentence
    // about something he has not done.
    txn({ day: TODAY, amount: 900, category: 'LOAN_PAYMENTS' })
    txn({ day: TODAY, amount: 100, category: 'FOOD_AND_DRINK' })
    expect(render(db)).not.toContain('ticked categories only')
    choose('LOAN_PAYMENTS', false)
    expect(render(db)).toContain('ticked categories only')
  })

  it('rescales the percentages on screen when a category is unticked', () => {
    txn({ day: TODAY, amount: 900, category: 'LOAN_PAYMENTS' })
    txn({ day: TODAY, amount: 75, category: 'FOOD_AND_DRINK' })
    txn({ day: TODAY, amount: 25, category: 'TRANSPORTATION' })
    expect(render(db)).toContain('90%')

    choose('LOAN_PAYMENTS', false)
    const json = render(db)
    expect(json).toContain('75%')
    expect(json).toContain('25%')
    expect(json).not.toContain('90%')
  })

  it('gives every transaction a re-file control posting to the platform route', () => {
    // The route is the only thing holding a writable handle. The control is the
    // dashboard's; the write is not.
    txn({ day: TODAY, amount: 10 })
    txn({ day: TODAY, amount: 20 })
    const json = render(db)
    expect(json).toContain('/api/users/run11/spending-category')
    // Both rows carry one, and so does the create-a-bucket control.
    expect(json.split('/api/users/run11/spending-category').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('shows cents in the transaction list and whole dollars in the legend', () => {
    // docs/dashboard-ui-ux-guidelines.md > Formatting: whole dollars in glance
    // positions, cents in transaction rows where he is reconciling.
    txn({ day: TODAY, amount: 12.34 })
    const json = render(db)
    expect(json).toContain('$12.34') // the row
    expect(json).toContain('$12') // the legend
  })

  it('marks money coming back with a sign rather than parentheses', () => {
    txn({ day: TODAY, amount: -25.5, category: 'TRAVEL' })
    txn({ day: TODAY, amount: 40 })
    const json = render(db)
    expect(json).toContain('$25.50')
    // Scoped to the CURRENCY form. A bare '(' also matches CSS like
    // `var(--border)` in a swatch's inline style, which is not what this rule
    // is about — the guidelines forbid parenthesised NEGATIVE AMOUNTS.
    expect(json).not.toContain('($')
  })

  it('names which BANK a failing product belongs to', () => {
    // He has two cards by design, so "couldn't reach your bank" without saying
    // WHICH is a sentence he cannot act on — and grouping by product alone
    // dropped the older bank's line entirely, which is routine once one bank
    // has been refreshed more recently than the other.
    // A second card, which is what spec v3 describes him having.
    db.prepare(
      `INSERT INTO plaid_items
         (item_id, access_token, institution_id, institution_name, available_products, payload, connected_at)
       VALUES ('item-TWO-TEST', 'access-NOT-A-REAL-TOKEN-TEST', 'ins_TWO_TEST', 'SECOND CARD TEST', '[]', '{}', 2)`,
    ).run()
    db.prepare("UPDATE plaid_items SET institution_name = 'FIRST CARD TEST' WHERE item_id = 'item-TEST'").run()
    // DIFFERENT instants, which is the case that separates "latest per bank
    // per product" from "latest per product" — routine, since each press
    // writes one instant and a disconnected bank is skipped entirely.
    db.prepare(
      `INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id)
       VALUES (9000, '2026-08-20', 'transactions', 0, 'network', 'item-TEST')`,
    ).run()
    db.prepare(
      `INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id)
       VALUES (8000, '2026-08-20', 'transactions', 0, 'network', 'item-TWO-TEST')`,
    ).run()

    const json = render(db)
    expect(json).toContain('FIRST CARD TEST — ')
    expect(json).toContain('SECOND CARD TEST — ')
  })

  it('offers a re-login only when a refresh actually said so', () => {
    txn({ day: TODAY, amount: 10 })
    refresh({ ok: 0, code: 'api_error' })
    expect(render(db)).not.toContain('log in to your bank again'.toLowerCase())

    db.prepare('DELETE FROM plaid_refreshes').run()
    refresh({ ok: 0, code: 'item_login_required' })
    expect(render(db)).toContain('needs you to log in again')
  })

  it('calls a not_ready product what it is, rather than a failure', () => {
    // THREE OUTCOMES, NOT TWO. Recurring routinely reports not_ready on the
    // first refresh after connecting; calling it a failure puts "couldn't reach
    // your bank" on screen while everything works.
    txn({ day: TODAY, amount: 10 })
    refresh({ product: 'recurring', ok: 0, code: 'not_ready' })
    const json = render(db)
    expect(json).toContain('still preparing')
    expect(json).not.toContain('couldn’t reach your bank (')
  })

  it('leaves the two dog screens untouched, which spec v3 states directly', () => {
    // The regression this build could most easily cause. The decider reads no
    // transaction and the spending screen reads no forecast — three products on
    // one dashboard, and the joins between them are to be proposed, not slipped
    // in.
    txn({ day: TODAY, amount: 500, category: 'FOOD_AND_DRINK' })
    const decider = render(db, TODAY, 'walk_the_dog')
    const log = render(db, TODAY, 'walk_log')
    for (const json of [decider, log]) {
      expect(json).not.toContain('COFFEE PALACE TEST')
      expect(json).not.toContain('Food and drink')
      expect(json).not.toContain('spending-category')
    }
    expect(decider).toContain('/api/users/run11/forecast')
    expect(log).toContain('/api/users/run11/walk-log')
  })

  it('does not put a forecast or a walk on the spending screen either', () => {
    db.prepare('INSERT INTO walk_log (day, at) VALUES (?, ?)').run(TODAY, 1)
    txn({ day: TODAY, amount: 10 })
    const json = render(db)
    expect(json).not.toContain('/api/users/run11/walk-log')
    expect(json).not.toContain('/api/users/run11/forecast')
    expect(json).not.toContain('streak')
  })
})

describe('users/run11 — the shape queries return', () => {
  it('hands the component a row it can render without reaching for SQL', () => {
    // The full row shape, asserted once, so a field renamed in the view fails
    // here rather than as a silently blank column on screen.
    txn({ day: TODAY, amount: 12.5, merchant: 'COFFEE PALACE TEST' })
    const row: SpendingTransaction = spendingTransactions(db, TODAY)[0]!
    expect(row).toEqual({
      transactionId: 'txn-1-TEST',
      day: TODAY,
      accountName: 'CARD TEST',
      accountMask: '3333',
      merchant: 'COFFEE PALACE TEST',
      description: 'RAW DESCRIPTION TEST',
      amount: 12.5,
      pending: 0,
      plaidCategory: 'FOOD_AND_DRINK',
      overrideCategory: null,
      category: 'FOOD_AND_DRINK',
    })
  })

  it('falls back to the raw description when the bank names no merchant', () => {
    // Real and common: Plaid returns merchant_name null on plenty of rows, and
    // the synthetic database has several. A row reading "Unknown" when the bank
    // did say something would be the dashboard throwing information away.
    txn({ day: TODAY, amount: 5, merchant: null })
    const row = spendingTransactions(db, TODAY)[0]!
    expect(row.merchant).toBeNull()
    expect(row.description).toBe('RAW DESCRIPTION TEST')
    expect(render(db)).toContain('RAW DESCRIPTION TEST')
  })
})

describe('users/run11 — the control’s bound and the route’s bound agree', () => {
  it('pins the route’s duplicated name length against queries.ts', () => {
    // app/api/users/[user]/spending-category/route.ts DUPLICATES the length
    // bound rather than importing it, exactly as the no-go-temp route
    // duplicates its four numbers: a platform route importing a user folder
    // would make one friend's dashboard a build dependency of the platform.
    // Duplication is the right call there and this is what keeps it honest —
    // the input's maxLength is an affordance, the route's check is the rule,
    // and they are meant to be the same number.
    const source = readFileSync(
      resolve(
        __dirname,
        '..',
        '..',
        '..',
        join('app', 'api', 'users', '[user]', 'spending-category', 'route.ts'),
      ),
      'utf8',
    )
    const found = /const MAX_NAME = (\d+)\b/.exec(source)
    expect(found, 'MAX_NAME not found in the route').not.toBeNull()
    expect(Number(found![1])).toBe(CATEGORY_NAME_MAX)
  })

  it('never writes to a plaid_* table from this folder', () => {
    // Exactly one thing writes those: the shared refresh route
    // (docs/dashboard-build-rules.md §9.4). The handle a dashboard gets is
    // read-only in both dev and production, so this is already enforced — but
    // a statement written here would fail at RUNTIME, in front of the friend,
    // and this fails at test time instead.
    const queries = readFileSync(resolve(__dirname, '..', 'queries.ts'), 'utf8')
    for (const verb of ['INSERT INTO plaid_', 'UPDATE plaid_', 'DELETE FROM plaid_']) {
      expect(queries).not.toContain(verb)
    }
  })

  it('never imports lib/plaid from anywhere in this folder', () => {
    // A dashboard never knows a network exists (CLAUDE.md > Testing). Every
    // Plaid CALL lives in one of four shared platform routes that no builder
    // writes or copies.
    for (const file of ['queries.ts', 'dashboard.tsx', 'SpendingPie.tsx', 'CategoryControls.tsx']) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8')
      expect(source, file).not.toContain("from '@/lib/plaid")
    }
  })
})
