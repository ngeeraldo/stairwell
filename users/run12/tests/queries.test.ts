// users/run12/tests/queries.test.ts
//
// The rules that decide what a percentage on run12's pie MEANS, tested where
// they live rather than through a render. Three of them are product decisions
// spec v1 either made or explicitly handed to the builder, and each is a way the
// chart could be quietly wrong while every render test stayed green:
//
//   * the 30-day window's own boundaries (spec v1: "a rolling 30-day window
//     ending today, not the previous calendar month");
//   * netting signed amounts, so a refund reduces the category it came back from
//     instead of counting as money spent;
//   * `is_internal`, spec v1's third open question — transfers between his own
//     accounts, and card payments, kept out of the percentages.
//
// The VIEW-level tests build their fixture from the migration files, so 003's
// SQL is exercised as written rather than as a second copy of it here. The
// PURE-function tests hand `categoryTotals` and `foldIntoOther` rows they built
// themselves, which is what lets the fold and the nine-category edge be tested
// at all — synthetic data has six categories and could never reach them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserDb } from '@/lib/db/userDb'
import type { PlaidSource } from '@/modules/plaid/sources'
import { emptyDbFromMigrations } from '@/tests/support/userMigrations'
import {
  OTHER_CATEGORY,
  PIE_MAX_SLICES,
  UNCATEGORIZED,
  banksWithStaleTransactions,
  bankCategories,
  categoryLabel,
  categoryTotals,
  categoryVisibility,
  customCategories,
  foldIntoOther,
  frozenBanksInWindow,
  isConnected,
  resolveVisibility,
  shiftDay,
  spendingAccounts,
  spendingTransactions,
  spendingWindowStart,
  type SpendingTransaction,
} from '@/users/run12/queries'

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let db: UserDb

beforeEach(() => {
  db = emptyDbFromMigrations('run12')
  db.prepare(
    `INSERT INTO plaid_items
       (item_id, access_token, institution_id, institution_name, cursor,
        available_products, payload, connected_at)
     VALUES ('item_live', 'access-NOT-A-REAL-TOKEN-TEST', 'ins_test',
             'PLATYPUS BANK TEST', 'c', '[]', '{}', 1)`,
  ).run()
})

afterEach(() => {
  db.close()
})

/** An account of any Plaid type/subtype, so the allow-list can be probed. */
function account(
  accountId: string,
  type: string,
  subtype: string | null,
  name: string,
  itemId = 'item_live',
) {
  db.prepare('INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)').run(
    accountId,
    itemId,
    JSON.stringify({ name, mask: '0001', type, subtype }),
  )
}

/** A transaction with a Plaid-shaped payload. `detailed` matters for 003. */
function txn(
  transactionId: string,
  accountId: string,
  day: string,
  amount: number,
  primary: string | null,
  detailed?: string,
  itemId = 'item_live',
) {
  db.prepare(
    `INSERT INTO plaid_transactions (transaction_id, account_id, item_id, date, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    transactionId,
    accountId,
    itemId,
    day,
    JSON.stringify({
      amount,
      merchant_name: 'COFFEE PALACE TEST',
      name: 'COFFEE PALACE TEST 001',
      pending: false,
      personal_finance_category:
        primary === null ? null : { primary, detailed: detailed ?? `${primary}_OTHER` },
    }),
  )
}

/** Re-file one transaction by hand, as pressing Move does. */
function refile(transactionId: string, category: string) {
  db.prepare(
    'INSERT INTO transaction_category_overrides (transaction_id, category, set_at) VALUES (?, ?, ?)',
  ).run(transactionId, category, 1)
}

/** Make one of the friend's own buckets. */
function bucket(name: string) {
  db.prepare('INSERT INTO custom_categories (name, created_at) VALUES (?, ?)').run(name, 1)
}

/** Tick or untick a category explicitly, as pressing the legend's box does. */
function choose(category: string, included: boolean) {
  db.prepare('INSERT INTO category_visibility (category, included, set_at) VALUES (?, ?, ?)').run(
    category,
    included ? 1 : 0,
    1,
  )
}

/** A pure `SpendingTransaction`, for the functions that never touch SQL. */
function row(over: Partial<SpendingTransaction> = {}): SpendingTransaction {
  return {
    transactionId: 't1',
    day: '2026-08-10',
    itemId: 'item_live',
    accountName: 'PLAID CHECKING TEST',
    accountMask: '0001',
    merchant: 'COFFEE PALACE TEST',
    description: 'COFFEE PALACE TEST 001',
    amount: 10,
    pending: 0,
    plaidCategory: 'FOOD_AND_DRINK',
    plaidDetail: 'FOOD_AND_DRINK_COFFEE',
    overrideCategory: null,
    category: 'FOOD_AND_DRINK',
    isInternal: 0,
    ...over,
  }
}

function source(over: Partial<PlaidSource> = {}): PlaidSource {
  return {
    itemId: 'item_live',
    name: 'PLATYPUS BANK TEST',
    status: 'live',
    connectedAt: 1,
    disconnectedAt: null,
    lastRefreshAt: 2,
    lastAttemptAt: 2,
    accountCount: 2,
    failedProducts: [],
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WINDOW
// ─────────────────────────────────────────────────────────────────────────────

describe('the 30-day window', () => {
  it('is inclusive at both ends, so it is exactly 30 days long', () => {
    // A rolling window "ending today" that ran today-30..today would be 31 days,
    // and every percentage on the pie would be a share of a slightly different
    // month than the caption claims.
    expect(spendingWindowStart('2026-08-22')).toBe('2026-07-24')
    expect(shiftDay('2026-07-24', 29)).toBe('2026-08-22')
  })

  it('crosses a month and a year boundary by the calendar, not by arithmetic on 30', () => {
    expect(spendingWindowStart('2026-03-01')).toBe('2026-01-31')
    expect(spendingWindowStart('2026-01-05')).toBe('2025-12-07')
    // 2028 is a leap year: the window over the 29th has to exist.
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('takes the day as a parameter and never asks a clock', () => {
    // The same call with two different days must give two different windows —
    // an assertion impossible for an implementation that read a clock, and the
    // shape the friend-timezone ledger exists to keep.
    expect(spendingWindowStart('2026-08-22')).not.toBe(spendingWindowStart('2026-08-23'))
  })

  it('includes both boundary days and excludes the day before the window', () => {
    account('acc_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    txn('t_before', 'acc_check', '2026-07-23', 10, 'FOOD_AND_DRINK')
    txn('t_first', 'acc_check', '2026-07-24', 11, 'FOOD_AND_DRINK')
    txn('t_last', 'acc_check', '2026-08-22', 12, 'FOOD_AND_DRINK')
    txn('t_after', 'acc_check', '2026-08-23', 13, 'FOOD_AND_DRINK')

    expect(
      spendingTransactions(db, '2026-08-22')
        .map((r) => r.transactionId)
        .sort(),
    ).toEqual(['t_first', 't_last'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCOUNT ALLOW-LIST (003's `spending_accounts`)
// ─────────────────────────────────────────────────────────────────────────────

describe('which accounts feed the screen', () => {
  it('counts every credit account and every checking account, and nothing else', () => {
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    account('a_card', 'credit', 'credit card', 'PLAID CREDIT CARD TEST')
    account('a_card2', 'credit', 'paypal', 'PLAID SECOND CARD TEST')
    account('a_save', 'depository', 'savings', 'PLAID SAVING TEST')
    account('a_cd', 'depository', 'cd', 'PLAID CD TEST')
    account('a_mm', 'depository', 'money market', 'PLAID MONEY MARKET TEST')
    account('a_hsa', 'depository', 'hsa', 'PLAID HSA TEST')
    account('a_ira', 'investment', 'ira', 'PLAID IRA TEST')
    account('a_loan', 'loan', 'mortgage', 'PLAID MORTGAGE TEST')

    expect(
      spendingAccounts(db)
        .map((a) => a.accountId)
        .sort(),
    ).toEqual(['a_card', 'a_card2', 'a_check'])
  })

  it('keeps a transaction out of the picture when its account is out of scope', () => {
    // The savings transfer that the fixture happens to put on a savings account.
    // It is excluded here by the ACCOUNT rule, before `is_internal` is consulted
    // — the two mechanisms overlap on purpose and neither is load-bearing alone.
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    account('a_save', 'depository', 'savings', 'PLAID SAVING TEST')
    txn('t_in', 'a_check', '2026-08-10', 10, 'FOOD_AND_DRINK')
    txn('t_out', 'a_save', '2026-08-10', 1000, 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER')

    expect(spendingTransactions(db, '2026-08-22').map((r) => r.transactionId))
      .toEqual(['t_in'])
  })

  it('drops a transaction whose account has left plaid_accounts, and keeps the row', () => {
    // The join through plaid_accounts is what keeps an account the friend removed
    // in Plaid Link off his screen. Plaid's picker only ever ADDS, so an unticked
    // account loses its accounts row on the next refresh while its transactions
    // stay — docs/dashboard-build-rules.md §9.6. Nothing was destroyed; it simply
    // stops being counted.
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    account('a_gone', 'credit', 'credit card', 'PLAID REMOVED CARD TEST')
    txn('t_keep', 'a_check', '2026-08-10', 10, 'FOOD_AND_DRINK')
    txn('t_orphan', 'a_gone', '2026-08-10', 999, 'TRAVEL')

    db.prepare("DELETE FROM plaid_accounts WHERE account_id = 'a_gone'").run()

    expect(spendingTransactions(db, '2026-08-22').map((r) => r.transactionId))
      .toEqual(['t_keep'])
    expect(
      (db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as { n: number }).n,
    ).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `is_internal` — SPEC v1'S THIRD OPEN QUESTION
// ─────────────────────────────────────────────────────────────────────────────

describe('internal transfers', () => {
  beforeEach(() => {
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    account('a_card', 'credit', 'credit card', 'PLAID CREDIT CARD TEST')
  })

  it('flags income and both directions of transfer', () => {
    txn('t_income', 'a_check', '2026-08-10', -3000, 'INCOME', 'INCOME_WAGES')
    txn('t_in', 'a_check', '2026-08-10', -200, 'TRANSFER_IN', 'TRANSFER_IN_DEPOSIT')
    txn('t_out', 'a_check', '2026-08-10', 200, 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER')
    txn('t_food', 'a_check', '2026-08-10', 12, 'FOOD_AND_DRINK')

    const flags = new Map(
      spendingTransactions(db, '2026-08-22').map((r) => [
        r.transactionId,
        r.isInternal,
      ]),
    )
    expect(flags.get('t_income')).toBe(1)
    expect(flags.get('t_in')).toBe(1)
    expect(flags.get('t_out')).toBe(1)
    expect(flags.get('t_food')).toBe(0)
  })

  it('flags a credit-card payment but NOT a mortgage, car or student loan payment', () => {
    // THE ONE PLACE THE RULE READS THE DETAILED KEY. LOAN_PAYMENTS is the only
    // Plaid family that is internal in part: paying the connected card from the
    // connected checking account is money moving between his own accounts, while
    // a mortgage is money leaving and not coming back. A friend whose
    // rent-sized mortgage vanished from his own spending picture would be looking
    // at a chart that quietly disagrees with his bank.
    txn('t_card', 'a_check', '2026-08-10', 400, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
    txn('t_mortgage', 'a_check', '2026-08-10', 1800, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT')
    txn('t_car', 'a_check', '2026-08-10', 300, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT')
    txn('t_student', 'a_check', '2026-08-10', 250, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT')

    const flags = new Map(
      spendingTransactions(db, '2026-08-22').map((r) => [
        r.transactionId,
        r.isInternal,
      ]),
    )
    expect(flags.get('t_card')).toBe(1)
    expect(flags.get('t_mortgage')).toBe(0)
    expect(flags.get('t_car')).toBe(0)
    expect(flags.get('t_student')).toBe(0)
  })

  it('files an uncategorised transaction under a named bucket rather than null', () => {
    // Plaid returns personal_finance_category as null on some transactions. A
    // null category would collapse into a nameless slice the friend cannot read.
    txn('t_none', 'a_check', '2026-08-10', 42, null)
    const [only] = spendingTransactions(db, '2026-08-22')
    // Asserted against the exported constant, not a second copy of the string:
    // 003's SQL writes the literal and this is what keeps the two in step.
    expect(only!.category).toBe(UNCATEGORIZED)
    expect(only!.plaidCategory).toBeNull()
    expect(only!.isInternal).toBe(0)
  })

  it('keeps the internal rows in the query so the panel can count them', () => {
    // A query that filtered them in SQL would make the exclusion unprovable from
    // the screen — the silent version of the thing spec v1 asked to have handled.
    txn('t_out', 'a_check', '2026-08-10', 200, 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER')
    txn('t_food', 'a_check', '2026-08-10', 12, 'FOOD_AND_DRINK')

    const rows = spendingTransactions(db, '2026-08-22')
    expect(rows).toHaveLength(2)

    const totals = categoryTotals(rows)
    expect(totals.internal).toBe(1)
    expect(totals.counted).toBe(1)
    expect(totals.rows.map((r) => r.category)).toEqual(['FOOD_AND_DRINK'])
    expect(totals.total).toBe(12)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `categoryTotals` — NETTING, SHARES, AND THE ORDER
// ─────────────────────────────────────────────────────────────────────────────

describe('categoryTotals', () => {
  it('nets a refund against the category it came back from', () => {
    // A flight charged and refunded inside the window is not money that went to
    // travel. Summing positives would report $500 the friend did not spend.
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'TRAVEL', amount: 500 }),
      row({ transactionId: 'b', category: 'TRAVEL', amount: -300 }),
      row({ transactionId: 'c', category: 'FOOD_AND_DRINK', amount: 100 }),
    ])
    // Travel is 200, not the 500 a positives-only sum would report — and that
    // is also what puts it above food rather than below it.
    expect(totals.rows.map((r) => [r.category, r.amount])).toEqual([
      ['TRAVEL', 200],
      ['FOOD_AND_DRINK', 100],
    ])
    expect(totals.total).toBe(300)
    expect(totals.rows[0]!.count).toBe(2)
  })

  it('cancels a card payment whose two sides are both on screen', () => {
    // It leaves the checking account as an outflow and lands on the card as an
    // inflow under the same category. Netting is what stops that pair
    // double-counting spending the card's own charges already carry.
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'LOAN_PAYMENTS', amount: 400 }),
      row({ transactionId: 'b', category: 'LOAN_PAYMENTS', amount: -400 }),
      row({ transactionId: 'c', category: 'FOOD_AND_DRINK', amount: 50 }),
    ])
    expect(totals.slices.map((s) => s.category)).toEqual(['FOOD_AND_DRINK'])
    expect(totals.rows.find((r) => r.category === 'LOAN_PAYMENTS')).toMatchObject({
      amount: 0,
      drawable: false,
      share: 0,
    })
  })

  it('keeps a category that nets to zero or less in the legend, out of the pie', () => {
    // Spec v1: "Every category is shown". A category that netted away has to be
    // explainable — a friend who saw travel here last week deserves a row saying
    // where it went, not a silent disappearance.
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'TRAVEL', amount: 100 }),
      row({ transactionId: 'b', category: 'TRAVEL', amount: -250 }),
      row({ transactionId: 'c', category: 'FOOD_AND_DRINK', amount: 80 }),
    ])
    expect(totals.rows.map((r) => r.category)).toContain('TRAVEL')
    expect(totals.slices.map((s) => s.category)).not.toContain('TRAVEL')
    expect(totals.rows.find((r) => r.category === 'TRAVEL')!.amount).toBe(-150)
    // The negative category is NOT in the denominator: 80/80.
    expect(totals.total).toBe(80)
    expect(totals.rows.find((r) => r.category === 'FOOD_AND_DRINK')!.share).toBe(1)
  })

  it('rounds to cents before deciding whether a category is drawable', () => {
    // A float residue of a fraction of a penny must not decide whether a wedge
    // exists. 0.1 + 0.2 - 0.3 is 5.55e-17 in IEEE 754, not 0.
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'TRAVEL', amount: 0.1 }),
      row({ transactionId: 'b', category: 'TRAVEL', amount: 0.2 }),
      row({ transactionId: 'c', category: 'TRAVEL', amount: -0.3 }),
      row({ transactionId: 'd', category: 'FOOD_AND_DRINK', amount: 5 }),
    ])
    expect(totals.rows.find((r) => r.category === 'TRAVEL')).toMatchObject({
      amount: 0,
      drawable: false,
    })
  })

  it('sorts biggest first and breaks ties by name, so a colour is stable', () => {
    // Spec v1: "Slices should read biggest to smallest so the largest categories
    // are obvious at a glance." Two categories at the same figure swapping places
    // on a refresh would look like the data moved — and since colour is assigned
    // by rank (./palette.ts), it would repaint them too.
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'ZED_TEST', amount: 50 }),
      row({ transactionId: 'b', category: 'ALPHA_TEST', amount: 50 }),
      row({ transactionId: 'c', category: 'TRAVEL', amount: 900 }),
    ])
    expect(totals.rows.map((r) => r.category)).toEqual(['TRAVEL', 'ALPHA_TEST', 'ZED_TEST'])
  })

  it('shares sum to 1 across the drawn slices', () => {
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'TRAVEL', amount: 300 }),
      row({ transactionId: 'b', category: 'FOOD_AND_DRINK', amount: 100 }),
      row({ transactionId: 'c', category: 'MEDICAL', amount: 100 }),
    ])
    expect(totals.slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10)
  })

  it('is empty and safe on no rows at all', () => {
    // A friend's first morning: their own database, connected, nothing pulled.
    expect(categoryTotals([])).toEqual({
      rows: [],
      slices: [],
      total: 0,
      counted: 0,
      internal: 0,
    })
  })

  it('reports every row internal when every row is a transfer', () => {
    const totals = categoryTotals([
      row({ transactionId: 'a', category: 'TRANSFER_OUT', amount: 900, isInternal: 1 }),
      row({ transactionId: 'b', category: 'INCOME', amount: -3000, isInternal: 1 }),
    ])
    expect(totals).toMatchObject({ counted: 0, internal: 2, total: 0 })
    expect(totals.slices).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE FOLD
// ─────────────────────────────────────────────────────────────────────────────

describe('foldIntoOther', () => {
  const slices = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      category: `CAT_${String(i).padStart(2, '0')}`,
      amount: 100 - i,
      share: (100 - i) / 1000,
      count: 1,
    }))

  it('draws every category when there are no more than the palette holds', () => {
    const { drawn, folded } = foldIntoOther(slices(PIE_MAX_SLICES))
    expect(drawn).toHaveLength(PIE_MAX_SLICES)
    expect(folded).toEqual([])
  })

  it('draws the ninth rather than folding a bucket of one', () => {
    // An "Other" wedge holding a single category hides its name for no gain, so
    // the one over the limit is simply drawn — in the neutral, and named.
    const { drawn, folded } = foldIntoOther(slices(PIE_MAX_SLICES + 1))
    expect(drawn).toHaveLength(PIE_MAX_SLICES + 1)
    expect(folded).toEqual([])
  })

  it('folds at two over, and names what it swallowed', () => {
    const { drawn, folded } = foldIntoOther(slices(PIE_MAX_SLICES + 2))
    expect(drawn).toHaveLength(PIE_MAX_SLICES + 1)
    expect(drawn.at(-1)!.category).toBe(OTHER_CATEGORY)
    // NAMES, not a count — every folded category still gets its own legend row.
    expect(folded).toEqual(['CAT_08', 'CAT_09'])
  })

  it("carries the folded categories' amount, share and count into the bucket", () => {
    const { drawn } = foldIntoOther(slices(PIE_MAX_SLICES + 3))
    const other = drawn.at(-1)!
    const rest = slices(PIE_MAX_SLICES + 3).slice(PIE_MAX_SLICES)
    expect(other.amount).toBe(Math.round(rest.reduce((s, r) => s + r.amount, 0) * 100) / 100)
    expect(other.count).toBe(rest.length)
    expect(other.share).toBeCloseTo(
      rest.reduce((s, r) => s + r.share, 0),
      10,
    )
  })

  it('leaves an empty list empty rather than inventing an Other of nothing', () => {
    expect(foldIntoOther([])).toEqual({ drawn: [], folded: [] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LABELS AND THE TWO CAVEAT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

describe('categoryLabel', () => {
  it('humanises a SCREAMING_SNAKE key', () => {
    // `FOOD_AND_DRINK` on a pie slice reads as a database, not as his lunch.
    expect(categoryLabel('FOOD_AND_DRINK')).toBe('Food and drink')
    expect(categoryLabel('RENT_AND_UTILITIES')).toBe('Rent and utilities')
    expect(categoryLabel('UNCATEGORIZED')).toBe('Uncategorized')
    expect(categoryLabel('TRAVEL')).toBe('Travel')
  })

  it("returns the friend's own bucket exactly as he typed it", () => {
    // His bucket is his sentence, not ours to reformat. A name that happens to
    // look like a Plaid key comes back unchanged — inferring from capitalisation
    // instead would quietly rewrite a bucket someone named in capitals on
    // purpose.
    const mine = new Set(['Eating out', 'BIG NIGHT OUT TEST'])
    expect(categoryLabel('Eating out', mine)).toBe('Eating out')
    expect(categoryLabel('BIG NIGHT OUT TEST', mine)).toBe('BIG NIGHT OUT TEST')
    // Not one of his: humanised as before.
    expect(categoryLabel('BIG NIGHT OUT TEST')).toBe('Big night out test')
  })
})

describe('the caveats the panel owes', () => {
  it('names a bank whose newest round failed to bring transactions', () => {
    // A refresh can succeed and fail at the same time: the CONNECTION is live
    // while the product feeding the pie is not, so every figure on screen is the
    // previous value and must say so.
    expect(
      banksWithStaleTransactions([
        source({ itemId: 'a', name: 'ZED BANK TEST', failedProducts: ['transactions'] }),
        source({ itemId: 'b', name: 'ALPHA BANK TEST', failedProducts: ['transactions', 'balance'] }),
        source({ itemId: 'c', name: 'FINE BANK TEST', failedProducts: ['balance'] }),
        source({ itemId: 'd', name: 'CLEAN BANK TEST' }),
      ]),
    ).toEqual(['ALPHA BANK TEST', 'ZED BANK TEST'])
  })

  it('names a disconnected bank only when it still has a row inside the window', () => {
    // A soft disconnect keeps every row, so a frozen bank can still be in the
    // pie and §9.6 forbids rendering those rows silently. But a bank
    // disconnected two months ago contributes nothing to this window, and a
    // caveat about it would explain a difference that does not exist.
    const rows = [
      row({ transactionId: 'a', itemId: 'item_live' }),
      row({ transactionId: 'b', itemId: 'item_frozen' }),
    ]
    const sources = [
      source({ itemId: 'item_live' }),
      source({ itemId: 'item_frozen', name: 'FROZEN BANK TEST', status: 'disconnected' }),
      source({ itemId: 'item_ancient', name: 'ANCIENT BANK TEST', status: 'disconnected' }),
    ]
    expect(frozenBanksInWindow(rows, sources)).toEqual(['FROZEN BANK TEST'])
    expect(frozenBanksInWindow([rows[0]!], sources)).toEqual([])
  })
})

describe('isConnected', () => {
  it('counts items and never transactions', () => {
    // A freshly connected bank has a token and zero rows for the seconds Plaid
    // spends backfilling. Inferring "not connected" from an empty transaction
    // table tells the friend his connection failed while it is working.
    expect(isConnected(db)).toBe(true)
    expect(
      (db.prepare('SELECT COUNT(*) n FROM plaid_transactions').get() as { n: number }).n,
    ).toBe(0)

    db.prepare('DELETE FROM plaid_items').run()
    expect(isConnected(db)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RE-FILING — THE ANNOTATION THAT SURVIVES A REFRESH
// ─────────────────────────────────────────────────────────────────────────────

describe('re-filing a transaction', () => {
  beforeEach(() => {
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
  })

  it("puts the transaction in the friend's category, over Plaid's", () => {
    txn('t1', 'a_check', '2026-08-10', 40, 'GENERAL_MERCHANDISE')
    bucket('EATING OUT TEST')
    refile('t1', 'EATING OUT TEST')

    const [only] = spendingTransactions(db, '2026-08-22')
    expect(only!.category).toBe('EATING OUT TEST')
    expect(only!.overrideCategory).toBe('EATING OUT TEST')
    // Plaid's own answer is still there, unedited — the override is an
    // annotation beside the synced row, never a change to it.
    expect(only!.plaidCategory).toBe('GENERAL_MERCHANDISE')
  })

  it('SURVIVES a refresh that rewrites the synced row', () => {
    // THE POINT OF THE WHOLE TABLE. Plaid's sync stream UPSERTS on `modified`,
    // so a merchant name being cleaned up or a pending charge settling rewrites
    // the payload. A category written INTO that row would be trampled; an
    // annotation keyed to transaction_id is not.
    txn('t1', 'a_check', '2026-08-10', 40, 'GENERAL_MERCHANDISE')
    bucket('EATING OUT TEST')
    refile('t1', 'EATING OUT TEST')

    // Exactly what the shared refresh route does to a modified transaction.
    db.prepare(
      `INSERT INTO plaid_transactions (transaction_id, account_id, item_id, date, payload)
       VALUES ('t1', 'a_check', 'item_live', '2026-08-11', ?)
       ON CONFLICT(transaction_id) DO UPDATE SET date = excluded.date,
                                                 payload = excluded.payload`,
    ).run(
      JSON.stringify({
        amount: 41.5,
        merchant_name: 'COFFEE PALACE TEST (CLEANED)',
        pending: false,
        personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' },
      }),
    )

    const [only] = spendingTransactions(db, '2026-08-22')
    expect(only!.amount).toBe(41.5)
    expect(only!.plaidCategory).toBe('TRAVEL')
    // Still his.
    expect(only!.category).toBe('EATING OUT TEST')
  })

  it('CLEARS is_internal, because his explicit act outranks the bank’s guess', () => {
    // 004's header argues this at length. A control that silently does nothing
    // for one class of row is a broken control: he moves a transfer, presses
    // Move, and the pie does not change with nothing on screen explaining why.
    txn('t1', 'a_check', '2026-08-10', 400, 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER')
    expect(spendingTransactions(db, '2026-08-22')[0]!.isInternal).toBe(1)

    bucket('GUILT FREE TEST')
    refile('t1', 'GUILT FREE TEST')

    const rows = spendingTransactions(db, '2026-08-22')
    expect(rows[0]!.isInternal).toBe(0)
    // And it now counts, which is the whole observable effect.
    expect(categoryTotals(rows).total).toBe(400)
  })

  it('is inert when it points at a transaction that no longer exists', () => {
    // No foreign key, deliberately (004): `removed` deletes a synced row and
    // Plaid can re-send it later, so a cascade would destroy a fact the friend
    // entered by hand at the moment his bank restated something.
    txn('t1', 'a_check', '2026-08-10', 40, 'FOOD_AND_DRINK')
    refile('t_never_existed', 'EATING OUT TEST')

    expect(spendingTransactions(db, '2026-08-22')).toHaveLength(1)
    expect(
      (
        db.prepare('SELECT COUNT(*) n FROM transaction_category_overrides').get() as { n: number }
      ).n,
    ).toBe(1)
  })

  it('moves a transaction back to a bank category with the same mechanism', () => {
    // `category` is not constrained to the custom set, precisely so that undoing
    // a re-filing is expressible with the control that made it.
    txn('t1', 'a_check', '2026-08-10', 40, 'GENERAL_MERCHANDISE')
    bucket('EATING OUT TEST')
    refile('t1', 'EATING OUT TEST')
    db.prepare('UPDATE transaction_category_overrides SET category = ? WHERE transaction_id = ?')
      .run('FOOD_AND_DRINK', 't1')

    expect(spendingTransactions(db, '2026-08-22')[0]!.category).toBe('FOOD_AND_DRINK')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE TICK BOXES
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveVisibility', () => {
  it('defaults a category that consumed money to ticked', () => {
    expect(resolveVisibility(120, undefined)).toBe(true)
  })

  it('defaults a category that netted to nothing or less to unticked', () => {
    // It cannot be drawn as a wedge anyway, and defaulting it off means the
    // legend shows it at its net figure with an empty box, which explains
    // itself, instead of the panel needing a sentence about where it went.
    expect(resolveVisibility(0, undefined)).toBe(false)
    expect(resolveVisibility(-40, undefined)).toBe(false)
  })

  it('lets his own press win in BOTH directions', () => {
    // This is why the table stores a boolean rather than a presence: the default
    // is conditional, so both "untick something that would default on" and "tick
    // something that would default off" have to be expressible.
    expect(resolveVisibility(120, false)).toBe(false)
    expect(resolveVisibility(-40, true)).toBe(true)
  })
})

describe('category visibility in the totals', () => {
  it('keeps an unticked category in the legend and out of the pie', () => {
    const rows = [
      row({ transactionId: 'a', category: 'TRAVEL', amount: 300 }),
      row({ transactionId: 'b', category: 'FOOD_AND_DRINK', amount: 100 }),
    ]
    const totals = categoryTotals(rows, new Map([['TRAVEL', false]]))

    expect(totals.rows.map((r) => r.category)).toEqual(['TRAVEL', 'FOOD_AND_DRINK'])
    expect(totals.slices.map((s) => s.category)).toEqual(['FOOD_AND_DRINK'])
    expect(totals.rows[0]).toMatchObject({ included: false, chosen: true, drawable: false })
  })

  it('takes an unticked category OUT OF THE DENOMINATOR', () => {
    // "What categories are currently being included in the pie chart and
    // percentages" — the percentages half is this assertion. Food is 100% of
    // what is left, not 25% of everything.
    const totals = categoryTotals(
      [
        row({ transactionId: 'a', category: 'TRAVEL', amount: 300 }),
        row({ transactionId: 'b', category: 'FOOD_AND_DRINK', amount: 100 }),
      ],
      new Map([['TRAVEL', false]]),
    )
    expect(totals.total).toBe(100)
    expect(totals.rows.find((r) => r.category === 'FOOD_AND_DRINK')!.share).toBe(1)
    // No share is printed for the unticked one: it is a number of nothing.
    expect(totals.rows.find((r) => r.category === 'TRAVEL')!.share).toBe(0)
  })

  it('lets him tick a netted-away category back on, and still draws no wedge', () => {
    // `included` and `drawable` are different questions. Ticking a category that
    // nets to nothing is a legitimate press — it says "count this when it has
    // something" — but there is still no positive amount to draw.
    const totals = categoryTotals(
      [
        row({ transactionId: 'a', category: 'TRAVEL', amount: 100 }),
        row({ transactionId: 'b', category: 'TRAVEL', amount: -100 }),
        row({ transactionId: 'c', category: 'FOOD_AND_DRINK', amount: 50 }),
      ],
      new Map([['TRAVEL', true]]),
    )
    const travel = totals.rows.find((r) => r.category === 'TRAVEL')!
    expect(travel).toMatchObject({ included: true, drawable: false, amount: 0 })
    expect(totals.slices.map((s) => s.category)).toEqual(['FOOD_AND_DRINK'])
  })

  it('marks a category he has never pressed as not chosen', () => {
    // The panel uses this to tell "he decided" from "we defaulted", which is
    // what keeps the caveat about the denominator off screen until he has
    // actually used the control.
    const totals = categoryTotals([row({ transactionId: 'a', category: 'TRAVEL', amount: 300 })])
    expect(totals.rows[0]).toMatchObject({ included: true, chosen: false })
  })

  it('reads his stored choices back exactly, and only his', () => {
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    txn('t1', 'a_check', '2026-08-10', 40, 'FOOD_AND_DRINK')
    choose('FOOD_AND_DRINK', false)

    const visibility = categoryVisibility(db)
    expect(visibility.get('FOOD_AND_DRINK')).toBe(false)
    // A category he has never pressed has NO ROW, which is what lets the default
    // stay conditional and re-resolve every render.
    expect(visibility.has('TRAVEL')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE RE-FILE MENU OFFERS
// ─────────────────────────────────────────────────────────────────────────────

describe('the categories a transaction can be moved into', () => {
  it("lists the friend's own buckets alphabetically, case-insensitively", () => {
    bucket('zebra test')
    bucket('APPLE TEST')
    expect(customCategories(db)).toEqual(['APPLE TEST', 'zebra test'])
  })

  it('offers a bucket that has nothing in it yet', () => {
    // A bucket he just made and has not filled is a legitimate state; hiding it
    // would make the Add control look broken.
    bucket('EMPTY BUCKET TEST')
    expect(customCategories(db)).toEqual(['EMPTY BUCKET TEST'])
  })

  it('offers every bank category ever seen, not just this window’s', () => {
    // A category that was on screen last month has to stay reachable, or a
    // transaction re-filed by mistake can never be put back where it came from.
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    txn('t_old', 'a_check', '2026-01-15', 40, 'TRAVEL')
    txn('t_new', 'a_check', '2026-08-10', 40, 'FOOD_AND_DRINK')

    expect(spendingTransactions(db, '2026-08-22')).toHaveLength(1)
    expect(bankCategories(db)).toEqual(['FOOD_AND_DRINK', 'TRAVEL'])
  })

  it('offers UNCATEGORIZED so a nameless row can be filed out of and back into', () => {
    account('a_check', 'depository', 'checking', 'PLAID CHECKING TEST')
    txn('t1', 'a_check', '2026-08-10', 40, null)
    expect(bankCategories(db)).toEqual([UNCATEGORIZED])
  })
})
