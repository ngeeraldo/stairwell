// tests/plaid/fixtureShape.test.ts
//
// The committed fixture, checked against the SHARED shape assertion — the
// same one tests/plaid/client.live.test.ts runs against a live Sandbox
// response.
//
// This half is free and always runs. Its live twin is opt-in and never runs
// in Gate E or a deploy, because an upstream outage must not block shipping an
// unrelated fix (CLAUDE.md > Testing). When the live one fails and this one
// passes, this file's input is what has gone stale.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expectAccountShape,
  expectHoldingShape,
  expectInvestmentTransactionShape,
  expectRecurringStreamShape,
  expectSecurityShape,
  expectTransactionShape,
} from '@/tests/support/plaidShape'

const FIXTURE = resolve(__dirname, '..', '..', 'modules', 'plaid', 'fixtures', 'sandbox.json')
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

describe('the recorded fixture still has the shape we parse', () => {
  it('every transaction', () => {
    expect(fixture.transactions.length).toBeGreaterThan(0)
    for (const transaction of fixture.transactions) expectTransactionShape(transaction)
  })

  it('every account', () => {
    expect(fixture.accounts.length).toBeGreaterThan(0)
    for (const account of fixture.accounts) expectAccountShape(account)
  })

  it('every holding and security', () => {
    expect(fixture.holdings.length).toBeGreaterThan(0)
    for (const holding of fixture.holdings) expectHoldingShape(holding)
    for (const security of fixture.securities) expectSecurityShape(security)
  })

  it('every recurring stream', () => {
    const streams = [...fixture.recurring_inflow, ...fixture.recurring_outflow]
    expect(streams.length).toBeGreaterThan(0)
    for (const stream of streams) expectRecurringStreamShape(stream)
  })

  it('every investment transaction', () => {
    expect(fixture.investment_transactions.length).toBeGreaterThan(0)
    for (const transaction of fixture.investment_transactions) {
      expectInvestmentTransactionShape(transaction)
    }
  })
})
