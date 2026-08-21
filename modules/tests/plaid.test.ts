// modules/tests/plaid.test.ts
//
// The shared Plaid envelope, end to end and offline: apply the migration,
// run the Python seeder against it, then query it back the way a friend's
// queries.ts would.
//
// WHAT THIS IS ACTUALLY PROVING. Three separate things could each be
// individually correct and still not compose:
//
//   1. initial.sql applies and holds what the fixture contains.
//   2. seed_plaid.py's date shift produces a database whose "this month"
//      is not empty — the failure users/devtwo/seed.py already documents.
//   3. json_extract() reaches the fields a builder will actually want, which
//      is the entire bet of storing payloads verbatim (plan D2). If a
//      builder cannot get at merchant, category, balance and pending with
//      one expression each, the envelope has failed regardless of what the
//      other tests say.
//
// It runs the REAL seeder in a subprocess rather than reimplementing it in
// TypeScript, for the same reason the anti-drift rule exists: two
// implementations of "what shape is this database" are two things that can
// disagree.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MARKER } from '@/modules/plaid/scrub'

const MODULE_DIR = resolve(__dirname, '..', 'plaid')
const SCHEMA = join(MODULE_DIR, 'initial.sql')
const SEEDER = join(MODULE_DIR, 'seed_plaid.py')
const FIXTURE = join(MODULE_DIR, 'fixtures', 'sandbox.json')

/** A fixed day, so nothing here depends on when the suite runs. */
const TODAY = '2026-06-15'

let dir: string
let db: InstanceType<typeof Database>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plaid-module-'))
  const path = join(dir, 'synthetic.db')

  const built = new Database(path)
  built.exec(readFileSync(SCHEMA, 'utf8'))
  built.close()

  // THE DAY IS HANDED IN, never read from a clock on either side. Before
  // this, the seeder computed a LOCAL day while this file computed a UTC one,
  // and the test failed at 7pm on the same machine that had passed at noon.
  // docs/superpowers/ledgers/friend-timezone.md is about exactly this.
  execFileSync('python3', [SEEDER, path, TODAY], { stdio: 'pipe' })
  db = new Database(path, { readonly: true })
}, 60_000)

afterAll(() => {
  db?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const one = <T>(sql: string): T => db.prepare(sql).get() as T
const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[]

describe('the migration and the seeder compose', () => {
  it('creates every table the envelope declares', () => {
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plaid_%' ORDER BY name",
    ).map((r) => r.name)

    expect(tables).toEqual([
      'plaid_accounts',
      'plaid_holdings',
      'plaid_investment_transactions',
      'plaid_items',
      'plaid_recurring_streams',
      'plaid_refreshes',
      'plaid_securities',
      'plaid_transactions',
    ])
  })

  it('fills the data tables', () => {
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM plaid_transactions').n).toBeGreaterThan(0)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM plaid_accounts').n).toBeGreaterThan(0)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM plaid_holdings').n).toBeGreaterThan(0)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM plaid_recurring_streams').n).toBeGreaterThan(0)
  })

  it('leaves plaid_items and plaid_refreshes EMPTY, deliberately', () => {
    // An access token is a real bank credential and a synthetic database must
    // never hold one, not even a fake one — a row here would make "is this
    // connected?" answer yes on a database that can reach no bank. And a
    // refresh is something that HAPPENED; none has.
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM plaid_items').n).toBe(0)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM plaid_refreshes').n).toBe(0)
  })
})

describe('dates land on today, not on the day the fixture was recorded', () => {
  const todayKey = TODAY

  it('slides the newest transaction onto today', () => {
    expect(one<{ d: string }>('SELECT MAX(date) d FROM plaid_transactions').d).toBe(todayKey)
  })

  it('keeps a recent window non-empty, which is the whole point', () => {
    // A fixture replayed unchanged would render an empty "last 30 days" panel
    // and read as broken rather than as waiting.
    const recent = one<{ n: number }>(
      `SELECT COUNT(*) n FROM plaid_transactions WHERE date >= date('${TODAY}', '-30 days')`,
    ).n
    expect(recent).toBeGreaterThan(0)
  })

  it('preserves dates that point into the FUTURE', () => {
    // Recurring streams predict the next occurrence a month out. A shift that
    // clamped to the past would delete the only forward-looking value Plaid
    // sends, silently.
    const predicted = all<{ d: string }>(
      `SELECT json_extract(payload,'$.predicted_next_date') d FROM plaid_recurring_streams`,
    ).map((r) => r.d)
    expect(predicted.some((d) => d > todayKey)).toBe(true)
  })

  it('keeps the stored column and the payload agreeing about the date', () => {
    // If these diverged, `WHERE date = ?` and json_extract would return
    // different rows from the same table — a bug that looks like a mystery.
    const mismatched = one<{ n: number }>(
      `SELECT COUNT(*) n FROM plaid_transactions WHERE date != json_extract(payload,'$.date')`,
    ).n
    expect(mismatched).toBe(0)
  })
})

describe('json_extract reaches what a builder will actually want', () => {
  // This is the bet of storing payloads verbatim. If a panel cannot be built
  // with one expression per value, the envelope has failed.

  it('a spending-by-merchant panel', () => {
    const rows = all<{ merchant: string; spent: number }>(
      `SELECT json_extract(payload,'$.merchant_name') merchant,
              SUM(json_extract(payload,'$.amount')) spent
         FROM plaid_transactions
        WHERE merchant IS NOT NULL AND merchant != ''
        GROUP BY merchant ORDER BY spent DESC`,
    )
    expect(rows.length).toBeGreaterThan(1)
    // Distinctness survived scrubbing — a scrubber that collapsed every name
    // to one string would make every GROUP BY panel render a single row.
    expect(new Set(rows.map((r) => r.merchant)).size).toBe(rows.length)
  })

  it('a spending-by-category panel, on the enum rather than the display name', () => {
    const rows = all<{ category: string; n: number }>(
      `SELECT json_extract(payload,'$.personal_finance_category.primary') category,
              COUNT(*) n
         FROM plaid_transactions GROUP BY category`,
    )
    expect(rows.length).toBeGreaterThan(1)
    // The category enum must be Plaid's, unmarked, or this view matches
    // nothing in production (plan D4).
    for (const row of rows) expect(row.category).not.toContain(MARKER)
  })

  it('a settled-only panel — the "I only care about processed" case', () => {
    const settled = one<{ n: number }>(
      `SELECT COUNT(*) n FROM plaid_transactions
        WHERE json_extract(payload,'$.pending') = 0`,
    ).n
    expect(settled).toBeGreaterThan(0)
  })

  it('a balances panel, reading the nested balance object', () => {
    const rows = all<{ name: string; current: number }>(
      `SELECT json_extract(payload,'$.name') name,
              json_extract(payload,'$.balances.current') current
         FROM plaid_accounts WHERE current IS NOT NULL`,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(typeof rows[0]?.current).toBe('number')
  })

  it('a holdings panel, joining holdings to securities', () => {
    const rows = all<{ ticker: string; value: number }>(
      `SELECT json_extract(s.payload,'$.ticker_symbol') ticker,
              json_extract(h.payload,'$.institution_value') value
         FROM plaid_holdings h JOIN plaid_securities s USING (security_id)`,
    )
    expect(rows.length).toBeGreaterThan(0)
    // Tickers are public market identifiers and must be usable as filter
    // keys in both worlds.
    expect(rows.some((r) => typeof r.ticker === 'string' && !r.ticker.includes(MARKER))).toBe(true)
  })

  it('a subscriptions panel, from recurring outflow streams', () => {
    const rows = all<{ description: string; amount: number }>(
      `SELECT json_extract(payload,'$.description') description,
              json_extract(payload,'$.last_amount.amount') amount
         FROM plaid_recurring_streams WHERE direction = 'outflow'`,
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('the committed fixture is loudly fake', () => {
  // The real guard. tests/users/conventions.test.ts cannot do this job: it
  // checks column VALUES, and the envelope stores one JSON blob per row, so
  // it sees a single string and passes on the first TEST anywhere in it.
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

  it('marks every merchant name on every transaction', () => {
    const names = fixture.transactions
      .map((t: any) => t.merchant_name)
      .filter((n: string) => n)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(name).toContain(MARKER)
  })

  it('marks every account name and official name', () => {
    for (const account of fixture.accounts) {
      expect(account.name).toContain(MARKER)
      if (account.official_name) expect(account.official_name).toContain(MARKER)
    }
  })

  it('marks every security name and every counterparty name', () => {
    for (const security of fixture.securities) expect(security.name).toContain(MARKER)
    for (const transaction of fixture.transactions) {
      for (const cp of transaction.counterparties ?? []) expect(cp.name).toContain(MARKER)
    }
  })

  it('points no url at a third party', () => {
    // A synthetic render must not fetch a merchant logo from plaid.com.
    for (const transaction of fixture.transactions) {
      if (transaction.logo_url) expect(transaction.logo_url).toContain('example.test')
    }
  })
})
