// tests/support/plaidShape.ts
//
// ONE description of what Plaid's payloads must look like, asserted against
// two different sources:
//
//   tests/plaid/fixtureShape.test.ts   the committed fixture, offline, always
//   tests/plaid/client.live.test.ts    a live Sandbox response, opt-in
//
// THE SHARING IS THE POINT, exactly as in tests/support/forecastShape.ts. The
// fixture is a recording, and a recording quietly stops describing reality:
// Plaid renames a field, every offline test stays green, and a friend's panel
// goes blank. When the live test fails while the fixture test passes, THE
// FIXTURE HAS BECOME FICTION and is what needs re-recording — run
// `npx tsx --env-file=.env scripts/record-plaid-fixture.ts`.
//
// IT ASSERTS SHAPE, NEVER VALUES. The committed fixture is scrubbed and a
// live response is not, so any assertion about a merchant name would have to
// be true of both `UBER TEST` and `Uber` — which means it could only ever
// assert that a string is a string. Value-level claims about the fixture
// belong in modules/tests/plaid.test.ts, which knows it is looking at
// scrubbed data.
//
// WHAT IS ASSERTED IS WHAT WE DEPEND ON, and nothing else. Every field named
// below is either a column in modules/plaid/initial.sql or a json_extract()
// path a dashboard is expected to use. Asserting a field we never read would
// make an upstream change that costs us nothing look like a breakage.
import { expect } from 'vitest'

const isString = (value: unknown): value is string => typeof value === 'string' && value !== ''
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A transaction from /transactions/sync.
 *
 * The three keyed fields are what modules/plaid/initial.sql stores as columns;
 * losing any one of them breaks the upsert rather than a panel.
 */
export function expectTransactionShape(transaction: unknown): void {
  const t = transaction as Record<string, any>

  expect(isString(t.transaction_id)).toBe(true)
  expect(isString(t.account_id)).toBe(true)
  expect(t.date).toMatch(ISO_DATE)

  expect(typeof t.amount).toBe('number')
  expect(typeof t.pending).toBe('boolean')
  // `merchant_name` may legitimately be null on a transaction Plaid could not
  // attribute, so the assertion is about the KEY existing, not its value.
  expect('merchant_name' in t).toBe(true)
  expect(isString(t.name)).toBe(true)

  // The category enum a spending panel groups on. `primary` is the field the
  // scrubber is forbidden from touching (plan D4).
  expect(isString(t.personal_finance_category?.primary)).toBe(true)
  expect(isString(t.personal_finance_category?.detailed)).toBe(true)
}

/** An account from /accounts/get, including the nested balance object. */
export function expectAccountShape(account: unknown): void {
  const a = account as Record<string, any>

  expect(isString(a.account_id)).toBe(true)
  expect(isString(a.type)).toBe(true)
  expect(isString(a.name)).toBe(true)

  // The balances object is why /accounts/get is enough and the per-call
  // /accounts/balance/get is an opt-in rather than the default (plan F8).
  expect('current' in (a.balances ?? {})).toBe(true)
  expect('available' in (a.balances ?? {})).toBe(true)
}

/** A holding from /investments/holdings/get. */
export function expectHoldingShape(holding: unknown): void {
  const h = holding as Record<string, any>

  // No id of its own — the pair IS the key, which is why initial.sql declares
  // a composite primary key rather than inventing one.
  expect(isString(h.account_id)).toBe(true)
  expect(isString(h.security_id)).toBe(true)
  expect(typeof h.quantity).toBe('number')
  expect(typeof h.institution_value).toBe('number')
}

/** A security from /investments/holdings/get. */
export function expectSecurityShape(security: unknown): void {
  const s = security as Record<string, any>

  expect(isString(s.security_id)).toBe(true)
  expect('ticker_symbol' in s).toBe(true)
  expect('name' in s).toBe(true)
  // NOT asserted: cusip, isin, sector, industry, close_price. Sandbox returns
  // all of them null while production likely populates them (plan F7), so an
  // assertion here would fail against Sandbox for a field that is fine.
}

/** A recurring stream from /transactions/recurring/get. */
export function expectRecurringStreamShape(stream: unknown): void {
  const s = stream as Record<string, any>

  expect(isString(s.stream_id)).toBe(true)
  expect(isString(s.account_id)).toBe(true)
  expect(isString(s.frequency)).toBe(true)
  expect(typeof s.is_active).toBe('boolean')
  expect(s.last_date).toMatch(ISO_DATE)
  expect(typeof s.last_amount?.amount).toBe('number')
}

/** An investment transaction from /investments/transactions/get. */
export function expectInvestmentTransactionShape(transaction: unknown): void {
  const t = transaction as Record<string, any>

  expect(isString(t.investment_transaction_id)).toBe(true)
  expect(isString(t.account_id)).toBe(true)
  expect(t.date).toMatch(ISO_DATE)
  expect(typeof t.amount).toBe('number')
  expect(typeof t.quantity).toBe('number')
}
