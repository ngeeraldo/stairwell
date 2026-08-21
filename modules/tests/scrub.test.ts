// modules/tests/scrub.test.ts
//
// THE REAL GUARD ON THE COMMITTED FIXTURE, and it has to be, because the
// sweep that guards every other seed does not reach this one.
//
// tests/users/conventions.test.ts walks a generated database column by column
// and requires the literal marker TEST in free text. That works when a
// merchant name is its own column. Our envelope stores Plaid's whole object as
// ONE JSON string in `payload` (D2), so that sweep sees a single enormous
// string value and passes the moment ANY part of it contains TEST — its bar is
// "one marked value per seed". A fixture with one scrubbed merchant and forty
// unscrubbed ones would sail through it.
//
// So the field-by-field assertions below are the whole defence, and they are
// stated in BOTH directions:
//
//   1. Every field that can carry a real person's identity IS marked.
//   2. Every field a query might filter or group on is BYTE-IDENTICAL.
//
// The second half is not politeness. If `personal_finance_category.primary`
// became `FOOD_AND_DRINK TEST`, a builder's view would group on the synthetic
// value, every test would pass, and the panel would be empty for a real
// friend — a failure that is green all the way to their screen (plan D4).
import { describe, expect, it } from 'vitest'
import { scrub, MARKER, TEXT_FIELDS, URL_FIELDS } from '@/modules/plaid/scrub'

/** A real Sandbox transaction, trimmed. Values are Plaid's, not invented. */
const TRANSACTION = {
  account_id: 'G1KkNl5BDGUwG4eQpEQRUP3EdxglyXu66pQQA',
  amount: 5.4,
  date: '2026-08-12',
  authorized_date: '2026-08-11',
  iso_currency_code: 'USD',
  category: ['Travel', 'Taxi'],
  category_id: '22016000',
  merchant_category_code: '4121',
  merchant_name: 'Uber',
  name: 'Uber 063015 SF**POOL**',
  logo_url: 'https://plaid-merchant-logos.plaid.com/uber_1060.png',
  website: 'uber.com',
  merchant_entity_id: 'eyg8o776k0QmNgVpAmaQj4WgzW9Qzo6O51gdd',
  personal_finance_category_icon_url:
    'https://plaid-category-icons.plaid.com/PFC_TRANSPORTATION.png',
  personal_finance_category: {
    confidence_level: 'LOW',
    detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES',
    primary: 'TRANSPORTATION',
    version: 'v2',
  },
  pending: false,
  transaction_id: 'l8B1yrK5nXUnwa9KVBKkfv4koj1kkMuNkkyw9',
  counterparties: [
    {
      confidence_level: 'VERY_HIGH',
      entity_id: 'eyg8o776k0QmNgVpAmaQj4WgzW9Qzo6O51gdd',
      logo_url: 'https://plaid-merchant-logos.plaid.com/uber_1060.png',
      name: 'Uber',
      phone_number: null,
      type: 'merchant',
      website: 'uber.com',
    },
  ],
}

describe('identity is marked', () => {
  const out = scrub(TRANSACTION) as any

  it('marks the merchant name and the raw description', () => {
    // The promise is "a screenshot reads as fake", NOT "the merchant is
    // hidden" — Sandbox merchants are Plaid's public demo data, about nobody.
    // The brand stays readable on purpose, so a builder designing a merchant
    // column sees varied realistic strings (Gate 2, option A).
    expect(out.merchant_name).toBe('UBER TEST')
    expect(out.name).toBe('UBER 063015 SF**POOL** TEST')
  })

  it('replaces every URL so a synthetic render fetches nothing', () => {
    // Not a privacy rule. A dashboard rendering <img src={logo_url}> against
    // synthetic data would call plaid.com on every dev render and every
    // screenshot run. `.test` is a reserved TLD that can never resolve.
    for (const url of [out.logo_url, out.website, out.personal_finance_category_icon_url]) {
      expect(url).not.toContain('plaid.com')
      expect(url).toContain(MARKER)
    }
  })

  it('WALKS ARRAYS — counterparties carry their own name and urls', () => {
    // A scrubber visiting only top-level keys would leave an unmarked name
    // and a live plaid.com URL one level down, while looking like it worked.
    const cp = out.counterparties[0]
    expect(cp.name).toContain(MARKER)
    expect(cp.website).not.toContain('plaid.com')
    expect(cp.logo_url).not.toContain('plaid.com')
  })

  it('leaves an empty string empty rather than inventing a marked value', () => {
    // Real Sandbox recurring streams carry `merchant_name: ""`. A blank is
    // already carrying nothing; " TEST" would be a value we made up.
    expect((scrub({ merchant_name: '' }) as any).merchant_name).toBe('')
  })
})

describe('anything a query keys on is byte-identical', () => {
  const out = scrub(TRANSACTION) as any

  it('never touches the category enums', () => {
    expect(out.personal_finance_category).toEqual(TRANSACTION.personal_finance_category)
    expect(out.category).toEqual(['Travel', 'Taxi'])
    expect(out.category_id).toBe('22016000')
    expect(out.merchant_category_code).toBe('4121')
  })

  it('never touches ids, dates, amounts or currency', () => {
    expect(out.transaction_id).toBe(TRANSACTION.transaction_id)
    expect(out.account_id).toBe(TRANSACTION.account_id)
    expect(out.date).toBe('2026-08-12')
    expect(out.authorized_date).toBe('2026-08-11')
    expect(out.amount).toBe(5.4)
    expect(out.iso_currency_code).toBe('USD')
    expect(out.pending).toBe(false)
  })

  it('never touches the opaque merchant entity ids, which are join keys', () => {
    // Not human-readable, and a view may group on them. Marking them would
    // buy no privacy and create the D4 hazard.
    expect(out.merchant_entity_id).toBe(TRANSACTION.merchant_entity_id)
    expect(out.counterparties[0].entity_id).toBe('eyg8o776k0QmNgVpAmaQj4WgzW9Qzo6O51gdd')
  })

  it('never touches ticker_symbol, the sharpest D4 hazard in the payload', () => {
    // A view doing WHERE ticker_symbol = 'BTC' would match in synthetic and
    // silently match nothing in production. Tickers are public market
    // identifiers, the same kind of thing as an ISO currency code.
    const sec = scrub({ ticker_symbol: 'BTC', name: 'Bitcoin', security_id: 'abc' }) as any
    expect(sec.ticker_symbol).toBe('BTC')
    expect(sec.security_id).toBe('abc')
    expect(sec.name).toContain(MARKER)
  })
})

describe('the field lists are the decision, so they are asserted directly', () => {
  it('marks exactly these text fields', () => {
    expect([...TEXT_FIELDS].sort()).toEqual(
      [
        'description',
        'institution_name',
        'merchant_name',
        'name',
        'official_name',
        'original_description',
      ].sort(),
    )
  })

  it('replaces exactly these url fields', () => {
    expect(Object.keys(URL_FIELDS).sort()).toEqual([
      'logo_url',
      'personal_finance_category_icon_url',
      'website',
    ])
  })
})
