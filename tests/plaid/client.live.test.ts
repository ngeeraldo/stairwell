// tests/plaid/client.live.test.ts
//
// THE CONNECTION HEARTBEAT. Read CLAUDE.md > Testing before changing anything
// here, and read tests/weather/openMeteo.live.test.ts, which established this
// pattern and which this file follows deliberately rather than inventing a
// second one.
//
// WHY IT EXISTS. modules/plaid/fixtures/sandbox.json is a RECORDING, and a
// recording quietly stops describing reality: Plaid renames a field or changes
// a product's behaviour, every offline test stays green, and a friend's panel
// goes blank. This is the only thing that would notice.
//
// IT SHARES ITS ASSERTIONS with tests/plaid/fixtureShape.test.ts —
// expectTransactionShape and friends — so the two cannot drift into testing
// different things. If this file fails while that one passes, THE FIXTURE HAS
// BECOME FICTION. Re-record it:
//
//     npx tsx --env-file=.env scripts/record-plaid-fixture.ts
//
// IT NEVER RUNS IN GATE E OR A DEPLOY. vitest.config.ts excludes
// *.live.test.ts unless VITEST_LIVE=1. An upstream outage must not block
// shipping an unrelated fix. Run it deliberately:
//
//     npm run test:live
//
// IT SKIPS RATHER THAN FAILS WITHOUT CREDENTIALS, so a fresh clone is never
// red. Unlike the weather provider, Plaid needs a key, and someone who has
// not set one up has not broken anything.
//
// IT ASSERTS SHAPE, NEVER VALUES. Sandbox regenerates its data, and any claim
// about a merchant or an amount would be a test that fails on Plaid's whim.
//
// NOTHING IT SEES IS RECORDED. The fixture is written by the recorder script,
// by hand, and stays scrubbed — this file must never become a second, silent
// path by which unscrubbed data reaches the repo.
//
// IT CLEANS UP AFTER ITSELF. Every run creates a throwaway Sandbox item and
// removes it, so repeated runs do not accumulate items against the 200 cap.
import { afterAll, describe, expect, it } from 'vitest'
import type { PlaidApi } from 'plaid'
import {
  createSandboxItem,
  getAccounts,
  getHoldings,
  plaidApiFromEnv,
  syncTransactions,
} from '@/lib/plaid/client'
import {
  expectAccountShape,
  expectHoldingShape,
  expectSecurityShape,
  expectTransactionShape,
} from '@/tests/support/plaidShape'

/** The Sandbox institution the fixture was recorded from. */
const INSTITUTION = 'ins_109508'

/** Sandbox needs a few seconds after item creation before a sync has data. */
const ATTEMPTS = 10
const WAIT_MS = 3_000
const TIMEOUT_MS = 120_000

const configured =
  process.env.PLAID_ENV === 'sandbox' &&
  Boolean(process.env.PLAID_CLIENT_ID) &&
  Boolean(process.env.PLAID_SECRET)

let api: PlaidApi | undefined
let accessToken: string | undefined

afterAll(async () => {
  // Leave nothing behind in Plaid's world. Investments and Recurring are
  // capped at 200 items each, and a test that leaked one per run would
  // eventually exhaust a real quota.
  if (api && accessToken) await api.itemRemove({ access_token: accessToken }).catch(() => {})
})

describe.skipIf(!configured)('Plaid Sandbox still answers in the shape we parse', () => {
  it(
    'returns transactions, accounts, holdings and securities in the recorded shape',
    async () => {
      api = plaidApiFromEnv()
      const item = await createSandboxItem(api, {
        institutionId: INSTITUTION,
        // recurring_transactions is deliberately absent: Plaid rejects it in
        // initial_products outright, and it arrives on its own ~10s later.
        products: ['transactions', 'investments'],
      })
      accessToken = item.accessToken

      let page = await syncTransactions(api, item.accessToken)
      for (let attempt = 1; attempt < ATTEMPTS && page.added.length === 0; attempt++) {
        await new Promise((r) => setTimeout(r, WAIT_MS))
        page = await syncTransactions(api, item.accessToken)
      }

      // THE SHARED ASSERTIONS. A failure in any of these while
      // tests/plaid/fixtureShape.test.ts passes means the fixture is stale.
      expect(page.added.length).toBeGreaterThan(0)
      for (const transaction of page.added) expectTransactionShape(transaction)

      // The cursor is the whole basis of incremental refresh — without it we
      // would re-pull two years of history on every button press.
      expect(page.nextCursor.length).toBeGreaterThan(0)

      const accounts = await getAccounts(api, item.accessToken)
      expect(accounts.length).toBeGreaterThan(0)
      for (const account of accounts) expectAccountShape(account)

      const holdings = await getHoldings(api, item.accessToken)
      expect(holdings.holdings.length).toBeGreaterThan(0)
      for (const holding of holdings.holdings) expectHoldingShape(holding)
      for (const security of holdings.securities) expectSecurityShape(security)
    },
    TIMEOUT_MS,
  )

  it(
    'still returns only what changed when handed a cursor',
    async () => {
      // The property the whole refresh design rests on: pass the stored cursor
      // and Plaid returns the delta, not the history. If this ever stopped
      // being true, every friend's refresh would silently re-pull 24 months.
      const live = plaidApiFromEnv()
      const item = await createSandboxItem(live, {
        institutionId: INSTITUTION,
        products: ['transactions'],
      })
      try {
        let first = await syncTransactions(live, item.accessToken)
        for (let attempt = 1; attempt < ATTEMPTS && first.added.length === 0; attempt++) {
          await new Promise((r) => setTimeout(r, WAIT_MS))
          first = await syncTransactions(live, item.accessToken)
        }
        expect(first.added.length).toBeGreaterThan(0)

        const second = await syncTransactions(live, item.accessToken, first.nextCursor)
        expect(second.added.length).toBe(0)
        expect(second.modified.length).toBe(0)
      } finally {
        await live.itemRemove({ access_token: item.accessToken }).catch(() => {})
      }
    },
    TIMEOUT_MS,
  )
})
