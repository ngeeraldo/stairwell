// users/run12/tests/dashboard.test.ts
//
// What run12's one screen actually PUTS ON SCREEN, in each of the states it
// owes. The rules behind the numbers are proved in ./queries.test.ts, where
// they live; this file proves the panel reaches for the right state and says
// the right thing when it does — including the two states that are only
// reachable through data nobody would look at twice.
//
// EVERY DAY IN THIS FILE IS A LITERAL. Nothing here reads a clock: `today` is a
// parameter precisely so a test can sit on a fixed day, on any machine, on any
// day of the year.
//
// ─── WHAT THIS FILE CANNOT SEE ─────────────────────────────────────────────
//
// ../SpendingPie.tsx is a CLIENT component, and JSON.stringify of the returned
// element tree never runs its body. So the assertions below reach its PROPS and
// stop there — which is exactly why every rule that decides what a wedge IS
// lives in ../queries.ts (`categoryTotals`, `foldIntoOther`, `categoryLabel`)
// rather than in the chart. The chart decides nothing.
//
// The same is true of ../CategoryControls.tsx: the tick box, the re-file menu
// and the name field are all client components, so what these assertions reach
// is the PROPS the server handed them — which category a row is in, whether a
// box is ticked, what the menu is allowed to offer. That is the interesting
// half; the mechanics belong to lib/ui/useWriteAction.ts and are tested there.
//
// <PlaidSources> is a SERVER component and does render into this tree, so the
// shared bank surface is visible to these assertions — but it is platform code
// with its own tests, and nothing here asserts its wording. What this file
// checks is that it is THERE, which is the thing a builder can get wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { UserDb } from '@/lib/db/userDb'
import Dashboard, { screens } from '@/users/run12/dashboard'
import { applyUserMigrations, emptyDbFromMigrations } from '@/tests/support/userMigrations'
import { CATEGORY_NAME_MAX, PIE_MAX_SLICES } from '@/users/run12/queries'
import Database from 'better-sqlite3-multiple-ciphers'

// JSX compiles to React.createElement, which this component's module expects to
// find globally — it is a server component rendered by CALLING it, not by
// mounting it, so nothing else brings React into scope.
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const TODAY = '2026-08-22'

/**
 * The render instant the page would have handed down for a given day.
 *
 * Derived from the day the test asked for, so `today` and `now` agree the way
 * app/[user]/page.tsx guarantees they do.
 */
const atMidday = (day: string) => Date.parse(`${day}T12:00:00Z`)

let db: UserDb

function freshDb(): UserDb {
  const handle = new Database(':memory:')
  applyUserMigrations(handle, 'run12')
  return handle
}

function connect({
  itemId = 'item-TEST',
  name = 'PLATYPUS BANK TEST',
  disconnectedAt = null as number | null,
} = {}) {
  db.prepare(
    `INSERT INTO plaid_items
       (item_id, access_token, institution_id, institution_name, available_products,
        payload, connected_at, disconnected_at)
     VALUES (?, 'access-NOT-A-REAL-TOKEN-TEST', 'ins_TEST', ?, '[]', '{}', 1, ?)`,
  ).run(itemId, name, disconnectedAt)
}

function account(
  accountId: string,
  {
    type = 'credit',
    subtype = 'credit card',
    name = 'PLAID CREDIT CARD TEST',
    mask = '3333',
    itemId = 'item-TEST',
  } = {},
) {
  db.prepare('INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)').run(
    accountId,
    itemId,
    JSON.stringify({ name, mask, type, subtype }),
  )
}

let txnSeq = 0
/** A transaction. `amount` follows Plaid's sign: positive out, negative in. */
function txn({
  day,
  amount,
  category = 'FOOD_AND_DRINK',
  detailed,
  accountId = 'acct-card',
  itemId = 'item-TEST',
}: {
  day: string
  amount: number
  category?: string | null
  detailed?: string
  accountId?: string
  itemId?: string
}): string {
  txnSeq += 1
  const transactionId = `txn-${txnSeq}-TEST`
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
      name: 'RAW DESCRIPTION TEST',
      pending: false,
      personal_finance_category:
        category === null ? null : { primary: category, detailed: detailed ?? `${category}_OTHER` },
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

function choose(category: string, included: boolean) {
  db.prepare('INSERT INTO category_visibility (category, included, set_at) VALUES (?, ?, ?)').run(
    category,
    included ? 1 : 0,
    1,
  )
}

function refresh({
  product = 'transactions',
  ok = 1,
  code = null as string | null,
  at = 1,
  itemId = 'item-TEST' as string | null,
} = {}) {
  db.prepare(
    'INSERT INTO plaid_refreshes (at, day, product, ok, code, item_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(at, TODAY, product, ok, code, itemId)
}

function render(handle: UserDb, today = TODAY): string {
  return JSON.stringify(
    Dashboard({
      slug: 'run12',
      db: handle,
      today,
      now: atMidday(today),
      timeZone: 'America/Chicago',
      screen: 'spending',
    }),
  )
}

beforeEach(() => {
  txnSeq = 0
  db = freshDb()
})

afterEach(() => {
  db.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CONTRACT WITH THE PLATFORM
// ─────────────────────────────────────────────────────────────────────────────

describe('users/run12 — the module contract', () => {
  it('declares the one screen spec v1 asks for', () => {
    // A registered dashboard declaring zero screens throws at render
    // (lib/dashboard/contract.ts's activeScreen). The id and order are the
    // builder's — a change-only spec carries no ids — and are written down in
    // users/run12/current.md's `## Screens` so the next build reads the same set.
    expect(screens).toEqual([{ id: 'spending', title: 'Spending Breakdown', order: 1 }])
  })

  it('renders the shared bank surface, which is where Refresh lives', () => {
    // tests/users/plaidSurface.test.ts sweeps the SOURCE for this; the point
    // here is that it survives into the rendered tree in the connected state
    // too, not just as an import.
    connect()
    account('acct-card')
    expect(render(db)).toContain('Your banks')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR STATES A FINANCE PANEL OWES (docs/dashboard-build-rules.md §9.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('the states the panel owes', () => {
  it('renders on an EMPTY database without throwing', () => {
    // KEEP THIS ONE. There is no synthetic fallback: a friend's first session
    // renders THEIR database, and it has nothing in it. An empty dashboard is an
    // ordinary state, not an error (2026-08-15 migrations design, §9).
    const empty = emptyDbFromMigrations('run12')
    try {
      expect(Dashboard({ slug: 'run12', db: empty, today: TODAY, now: atMidday(TODAY), timeZone: 'UTC' }))
        .toBeDefined()
    } finally {
      empty.close()
    }
  })

  it('STATE 1 — not connected: invites a connection and shows no zero', () => {
    const json = render(db)
    expect(json).toContain('Connect your checking account and your credit card')
    // "$0" would be a confident false statement about someone's money.
    expect(json).not.toContain('$0')
  })

  it('decides "not connected" from the item, NEVER from an empty transaction table', () => {
    // A freshly connected bank has a token and zero rows for the seconds Plaid
    // spends backfilling. Inferring "not connected" here would tell the friend
    // his connection failed at the exact moment it was working.
    connect()
    account('acct-card')
    const json = render(db)
    expect(json).not.toContain('Connect your checking account and your credit card')
    expect(json).toContain('Nothing has come through')
  })

  it('STATE 2 — connected, nothing arrived: says what it is waiting for', () => {
    connect()
    account('acct-card')
    const json = render(db)
    expect(json).toContain('Nothing has come through')
    expect(json).toContain('press Refresh')
    expect(json).not.toContain('$0')
  })

  it('STATE 3 — the half-failure: says the figures predate the last refresh', () => {
    // A refresh can succeed and fail at the same time. The CONNECTION is live
    // while the product feeding the pie is not, so every figure on screen is the
    // previous value — and letting that read as current is what §9.6 forbids.
    connect()
    account('acct-card')
    txn({ day: '2026-08-20', amount: 30 })
    refresh({ product: 'balance', ok: 1, at: 10 })
    refresh({ product: 'transactions', ok: 0, code: 'INTERNAL_SERVER_ERROR', at: 10 })

    const json = render(db)
    expect(json).toContain('didn’t send transactions on the last refresh')
    expect(json).toContain('PLATYPUS BANK TEST')
  })

  it('does not cry failure over a product Plaid has merely not finished preparing', () => {
    // `not_ready` is the third outcome, not a failure — routine on the first
    // refresh after connecting. Calling it one puts "couldn't reach your bank"
    // on screen while everything works.
    connect()
    account('acct-card')
    txn({ day: '2026-08-20', amount: 30 })
    refresh({ product: 'transactions', ok: 0, code: 'not_ready', at: 10 })

    expect(render(db)).not.toContain('didn’t send transactions on the last refresh')
  })

  it('says so when a disconnected bank is still inside the window', () => {
    // A soft disconnect keeps every row it brought, so its transactions are still
    // in the pie. That is honest for "where did my money go" — but part of the
    // picture stopped moving, and rendering it silently is the orphan §9.6 exists
    // to remove.
    connect()
    account('acct-card')
    txn({ day: '2026-08-20', amount: 30 })
    connect({ itemId: 'item-OLD', name: 'FROZEN BANK TEST', disconnectedAt: 5 })
    account('acct-old', { itemId: 'item-OLD', name: 'PLAID OLD CARD TEST', mask: '9999' })
    txn({ day: '2026-08-18', amount: 40, accountId: 'acct-old', itemId: 'item-OLD' })

    const json = render(db)
    expect(json).toContain('FROZEN BANK TEST')
    expect(json).toContain('stopped updating, but what it already sent is still counted here')
  })

  it('does not caveat a disconnected bank with nothing in the window', () => {
    connect()
    account('acct-card')
    txn({ day: '2026-08-20', amount: 30 })
    connect({ itemId: 'item-OLD', name: 'ANCIENT BANK TEST', disconnectedAt: 5 })
    account('acct-old', { itemId: 'item-OLD', name: 'PLAID OLD CARD TEST', mask: '9999' })
    txn({ day: '2026-01-01', amount: 40, accountId: 'acct-old', itemId: 'item-OLD' })

    expect(render(db)).not.toContain('stopped updating, but what it already sent')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PANEL ITSELF
// ─────────────────────────────────────────────────────────────────────────────

describe('the pie panel', () => {
  beforeEach(() => {
    connect()
    account('acct-card')
    account('acct-check', {
      type: 'depository',
      subtype: 'checking',
      name: 'PLAID CHECKING TEST',
      mask: '0000',
    })
  })

  it('hands the chart slices biggest first, with matching labels and shares', () => {
    // Spec v1: "Slices should read biggest to smallest so the largest categories
    // are obvious at a glance", and "each slice is labelled with the category and
    // its percentage share of total spending".
    txn({ day: '2026-08-20', amount: 100, category: 'FOOD_AND_DRINK' })
    txn({ day: '2026-08-20', amount: 300, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 100, category: 'MEDICAL' })

    const json = render(db)
    // Matched on the PieSlice SHAPE — `"label"` immediately followed by
    // `"amount"` — because the tick boxes and the re-file menus carry a `label`
    // prop too, and a bare /"label"/ would sweep the whole legend into this.
    const labels = [...json.matchAll(/"label":"([^"]+)","amount":/g)].map((m) => m[1])
    expect(labels).toEqual(['Travel', 'Food and drink', 'Medical'])
    expect(json).toContain('"shareLabel":"60%"')
    expect(json).toContain('"amountLabel":"$300"')
  })

  it('never mounts the chart when there is nothing drawable', () => {
    // THE ARM-2 STATES CHECK (docs/dashboard-build-rules.md §3). Degenerate data
    // renders the empty state as host elements; a chart mounted over nothing is
    // the failure that rule names.
    txn({ day: '2026-08-20', amount: 100, category: 'TRAVEL' })
    txn({ day: '2026-08-21', amount: -100, category: 'TRAVEL' })

    const json = render(db)
    // The sentence is split by the {SPENDING_WINDOW_DAYS} interpolation, so
    // assert on a contiguous run of it rather than the whole thing.
    expect(json).toContain('Nothing to draw for these ')
    expect(json).toContain('every category is either unticked or nets to nothing')
    expect(json).not.toContain('"slices"')
  })

  it('lists every category in the legend, including one that netted away', () => {
    // Spec v1: "Every category is shown — this is not a watchlist of a few chosen
    // categories." A category that cancelled itself has to be explainable, or a
    // friend who saw travel here last week just watches it vanish.
    txn({ day: '2026-08-20', amount: 100, category: 'TRAVEL' })
    txn({ day: '2026-08-21', amount: -100, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 60, category: 'FOOD_AND_DRINK' })

    const json = render(db)
    expect(json).toContain('Travel')
    expect(json).toContain('Food and drink')
    // In the legend, not in the chart. Asserted on the PieSlice shape: the
    // legend's own tick box carries a `label` prop too.
    expect(json).not.toContain('"label":"Travel","amount":')
    expect(json).toContain('"label":"Food and drink","amount":')
  })

  it('says a netted-away category is a refund, not an absence', () => {
    // docs/dashboard-ui-ux-guidelines.md > States: a zero that is data and a
    // zero that is absence must not render identically. "Travel $0" sitting
    // beside rows with real figures reads as "you spent nothing on travel", and
    // the truth is the opposite — he spent, and it came back.
    txn({ day: '2026-08-20', amount: 100, category: 'TRAVEL' })
    txn({ day: '2026-08-21', amount: -100, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 60, category: 'FOOD_AND_DRINK' })

    const json = render(db)
    expect(json).toContain('shows nothing spent')
    expect(json).toContain('cancelled the charges out')
  })

  it('says nothing about refunds when every category drew a wedge', () => {
    txn({ day: '2026-08-20', amount: 100, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 60, category: 'FOOD_AND_DRINK' })
    expect(render(db)).not.toContain('shows nothing spent')
  })

  it('names the accounts it is counting, so a missing one is visible', () => {
    // The scope is an allow-list in 003, so a bank reporting a current account
    // under a different subtype would drop out of the picture silently.
    txn({ day: '2026-08-20', amount: 30 })
    const json = render(db)
    expect(json).toContain('PLAID CHECKING TEST ••0000')
    expect(json).toContain('PLAID CREDIT CARD TEST ••3333')
  })

  it('states the window it is describing, in the friend’s own dates', () => {
    txn({ day: '2026-08-20', amount: 30 })
    const json = render(db)
    expect(json).toContain('Jul 24')
    expect(json).toContain('Aug 22')
  })

  it('says how many internal transfers it left out, and only when there are any', () => {
    // Spec v1's third open question, handed to the builder. A rule that changed
    // his percentages without appearing on screen would be the silent version of
    // the thing he asked to have handled.
    txn({ day: '2026-08-20', amount: 60, category: 'FOOD_AND_DRINK' })
    expect(render(db)).not.toContain('between your own accounts')

    txn({
      day: '2026-08-20',
      amount: 400,
      category: 'LOAN_PAYMENTS',
      detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    })
    txn({ day: '2026-08-19', amount: 900, category: 'TRANSFER_OUT' })

    const json = render(db)
    expect(json).toContain('2 transfers')
    expect(json).toContain('between your own accounts')
    // And they are genuinely out of the denominator: food is the whole pie.
    expect(json).toContain('"shareLabel":"100%"')
  })

  it('admits what the fold swallowed once there is enough to fold', () => {
    for (let i = 0; i < PIE_MAX_SLICES + 2; i += 1) {
      txn({ day: '2026-08-20', amount: 100 - i, category: `CAT_${String(i).padStart(2, '0')}` })
    }
    const json = render(db)
    expect(json).toContain('"label":"Other"')
    expect(json).toContain('smallest categories combined')
    // Every folded category still has its own legend row.
    expect(json).toContain('Cat 08')
    expect(json).toContain('Cat 09')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE CONTROLS NICO ASKED FOR AT THE BUILD REVIEW
// ─────────────────────────────────────────────────────────────────────────────

describe('the transaction list — the audit surface', () => {
  beforeEach(() => {
    connect()
    account('acct-card')
    account('acct-check', {
      type: 'depository',
      subtype: 'checking',
      name: 'PLAID CHECKING TEST',
      mask: '0000',
    })
  })

  it('shows every transaction behind the pie, with cents', () => {
    // "The user should be able to see their transactions so they can audit what
    // is going into every category." Cents, because this is the one place on the
    // screen he reconciles a row against his own memory of it
    // (docs/dashboard-ui-ux-guidelines.md > Formatting).
    txn({ day: '2026-08-20', amount: 12.34, category: 'FOOD_AND_DRINK' })
    txn({ day: '2026-08-19', amount: 56.78, category: 'TRAVEL' })

    const json = render(db)
    expect(json).toContain('Transactions')
    expect(json).toContain('$12.34')
    expect(json).toContain('$56.78')
    // …while the pie and legend stay in whole dollars.
    expect(json).toContain('"amountLabel":"$57"')
  })

  it('shows an internal transfer, and says it is not counted', () => {
    // This is what makes 004's is_internal AUDITABLE instead of invisible: the
    // transfer is right there in the list, named, with the menu that overrides
    // it — rather than silently missing from a total he cannot reconcile.
    txn({ day: '2026-08-20', amount: 60, category: 'FOOD_AND_DRINK' })
    txn({ day: '2026-08-19', amount: 900, category: 'TRANSFER_OUT' })

    const json = render(db)
    expect(json).toContain('not counted (transfer)')
    expect(json).toContain('$900.00')
    expect(json).toContain('"shareLabel":"100%"')
  })

  it('marks a row the friend moved himself', () => {
    // Without it, a category that disagrees with his bank's own app looks like
    // the dashboard got it wrong rather than like something he did on purpose.
    const id = txn({ day: '2026-08-20', amount: 60, category: 'GENERAL_MERCHANDISE' })
    bucket('EATING OUT TEST')
    refile(id, 'EATING OUT TEST')

    const json = render(db)
    expect(json).toContain('moved by you')
    expect(json).toContain('EATING OUT TEST')
  })

  it('posts every control to run12’s OWN route, never run11’s', () => {
    // run11's spending-category route would serve run12 verbatim, and that is
    // exactly why this is pinned: a shared handler makes a change to one
    // friend's dashboard a silent change to another's.
    txn({ day: '2026-08-20', amount: 60 })
    const json = render(db)
    expect(json).toContain('/api/users/run12/spending-breakdown')
    expect(json).not.toContain('/api/users/run12/spending-category')
  })

  it('offers the friend’s own buckets and every bank category in the menu', () => {
    txn({ day: '2026-08-20', amount: 60, category: 'FOOD_AND_DRINK' })
    bucket('EATING OUT TEST')

    const json = render(db)
    expect(json).toContain('"choices"')
    expect(json).toContain('{"value":"EATING OUT TEST","label":"EATING OUT TEST","custom":true}')
    expect(json).toContain('{"value":"FOOD_AND_DRINK","label":"Food and drink","custom":false}')
  })

  it('renders the new-category field with the route’s own bound', () => {
    txn({ day: '2026-08-20', amount: 60 })
    expect(render(db)).toContain(`"maxLength":${CATEGORY_NAME_MAX}`)
  })

  it('shows no transaction card at all before a bank is connected', () => {
    // The pie panel above is already asking him to connect one; a second empty
    // card saying so is noise. Asserted on the card's own copy rather than on
    // the bare word, which <PlaidSources> also uses when it explains what
    // connecting a bank brings in.
    const empty = freshDb()
    try {
      const json = JSON.stringify(
        Dashboard({
          slug: 'run12',
          db: empty,
          today: TODAY,
          now: atMidday(TODAY),
          timeZone: 'UTC',
          screen: 'spending',
        }),
      )
      expect(json).not.toContain('newest first')
      expect(json).not.toContain('New category name')
    } finally {
      empty.close()
    }
  })
})

describe('the legend’s tick boxes', () => {
  beforeEach(() => {
    connect()
    account('acct-card')
  })

  it('keeps an unticked category on screen, out of the pie and out of the percentages', () => {
    // It HAS to keep its row, or he could never tick it back.
    txn({ day: '2026-08-20', amount: 300, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 100, category: 'FOOD_AND_DRINK' })
    choose('TRAVEL', false)

    const json = render(db)
    expect(json).toContain('Travel')
    expect(json).not.toContain('"label":"Travel","amount":')
    // Food is now the whole pie, not a quarter of it.
    expect(json).toContain('"shareLabel":"100%"')
    expect(json).toContain('Percentages are of the ticked categories only')
  })

  it('hands each box the state the server last rendered', () => {
    txn({ day: '2026-08-20', amount: 300, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 100, category: 'FOOD_AND_DRINK' })
    choose('TRAVEL', false)

    const json = render(db)
    expect(json).toContain('{"action":"/api/users/run12/spending-breakdown","category":"TRAVEL","label":"Travel","included":false}')
    expect(json).toContain('"category":"FOOD_AND_DRINK","label":"Food and drink","included":true')
  })

  it('says nothing about the denominator until he has actually unticked something', () => {
    txn({ day: '2026-08-20', amount: 300, category: 'TRAVEL' })
    expect(render(db)).not.toContain('Percentages are of the ticked categories only')
  })

  it('does not blame a refund for a category HE unticked', () => {
    // The "shows nothing spent: refunds cancelled the charges out" caption is
    // about money coming back. An unticked category draws no wedge because he
    // said so, and the empty box beside it already explains that.
    txn({ day: '2026-08-20', amount: 300, category: 'TRAVEL' })
    txn({ day: '2026-08-20', amount: 100, category: 'FOOD_AND_DRINK' })
    choose('TRAVEL', false)
    expect(render(db)).not.toContain('shows nothing spent')
  })

  it('falls back to the empty state when he unticks everything', () => {
    // Not a chart mounted over nothing — the arm-2 states check still holds when
    // the reason there is nothing to draw is his own choice.
    txn({ day: '2026-08-20', amount: 300, category: 'TRAVEL' })
    choose('TRAVEL', false)

    const json = render(db)
    expect(json).toContain('every category is either')
    expect(json).not.toContain('"slices"')
    // And the list is still there, so he can find his way back.
    expect(json).toContain('Transactions')
  })
})
