/**
 * Record a real Plaid Sandbox response, scrub it, and commit it.
 *
 *   npx tsx --env-file=.env scripts/record-plaid-fixture.ts
 *
 * PHASE 2 OF docs/superpowers/plans/2026-08-20-plaid-connection.md. It replaces
 * the hand-written faker every other dashboard in this repo has, and the
 * reason is the one that motivated the whole envelope design: a hand-written
 * faker is a second author's guess at Plaid's field shape, and NOTHING
 * NOTICES WHEN IT DRIFTS. A panel built against a guessed shape breaks for a
 * real friend and passes every test on the way there.
 *
 * ── WHY RECORDING IS ALLOWED HERE ───────────────────────────────────────────
 *
 * CLAUDE.md > Testing: "A fixture is never recorded from a real person's data
 * — a zip's forecast is public and about a place; a friend's transactions are
 * not." Sandbox transactions are FABRICATED BY PLAID and belong to nobody,
 * which puts them on the forecast side of that line. They are scrubbed on top
 * of that, so the committed file is fake twice over.
 *
 * This is the ONE sanctioned recording path. It must never be pointed at
 * PLAID_ENV=production, and it refuses to run if it is.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not shift dates. The fixture keeps the dates Plaid returned, and
 * modules/plaid/seed_plaid.py slides them onto today at seed time — so
 * re-recording is not required to keep a synthetic database current, and the
 * committed file stays a faithful recording rather than a thing that has been
 * edited twice.
 *
 * It writes no database and leaves no Sandbox item behind.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { plaidApiFromEnv } from '../lib/plaid/client'
import { scrub } from '../modules/plaid/scrub'

const INSTITUTION = 'ins_109508'
const INITIAL_PRODUCTS = ['transactions', 'investments']
const OUT = resolve(__dirname, '..', 'modules', 'plaid', 'fixtures', 'sandbox.json')

/** Recurring needs ~10s after the item exists (plan F1); sync needs 2–6s. */
const ATTEMPTS = 15
const WAIT_MS = 4_000

/**
 * A Plaid error's `error_code` and NOTHING ELSE.
 *
 * A raw SDK error object carries our PLAID-SECRET in its request headers. This
 * is not hypothetical — it leaked into a transcript once during Phase 1, from a
 * throwaway script with a bare handler. Every catch in every Plaid-touching
 * script goes through a helper like this one.
 */
const codeOf = (error: unknown): string =>
  (error as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
  'non-plaid-error'

async function poll<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const code = codeOf(error)
      console.log(`  ${label}: ${code} (attempt ${attempt}/${ATTEMPTS})`)
      if (attempt === ATTEMPTS) throw new Error(`${label} never became ready: ${code}`)
      await new Promise((r) => setTimeout(r, WAIT_MS))
    }
  }
  throw new Error('unreachable')
}

async function main(): Promise<void> {
  // A recording from production would be a real person's transactions in a
  // committed file — the exact thing CLAUDE.md forbids by name.
  if (process.env.PLAID_ENV !== 'sandbox') {
    console.error(`refusing to record from PLAID_ENV=${process.env.PLAID_ENV ?? '(unset)'}`)
    process.exit(1)
  }

  const api = plaidApiFromEnv()
  console.log('creating a throwaway Sandbox item…')
  const publicToken = (
    await api.sandboxPublicTokenCreate({
      institution_id: INSTITUTION,
      // recurring_transactions is NOT requested here — Plaid rejects it in
      // initial_products outright. It becomes available on its own (plan F1).
      initial_products: INITIAL_PRODUCTS as never,
    })
  ).data.public_token
  const { access_token } = (await api.itemPublicTokenExchange({ public_token: publicToken })).data

  const sync = await poll('transactions/sync', async () => {
    const data = (await api.transactionsSync({ access_token })).data
    if (data.added.length === 0) throw { response: { data: { error_code: 'EMPTY' } } }
    return data
  })
  const accounts = (await api.accountsGet({ access_token })).data
  const recurring = await poll('transactions/recurring/get', async () =>
    (await api.transactionsRecurringGet({ access_token })).data,
  )
  const holdings = (await api.investmentsHoldingsGet({ access_token })).data
  const investmentTx = (
    await api.investmentsTransactionsGet({
      access_token,
      start_date: '2024-01-01',
      end_date: '2030-01-01',
      options: { count: 100 },
    })
  ).data
  const item = (await api.itemGet({ access_token })).data

  // SCRUBBED BEFORE IT IS EVER SERIALISED. Nothing unscrubbed reaches a file.
  const fixture = scrub({
    recorded_from: 'plaid sandbox',
    institution_id: INSTITUTION,
    accounts: accounts.accounts,
    transactions: sync.added,
    recurring_inflow: recurring.inflow_streams,
    recurring_outflow: recurring.outflow_streams,
    holdings: holdings.holdings,
    securities: holdings.securities,
    investment_transactions: investmentTx.investment_transactions,
    institution_name: item.item.institution_name,
  })

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`\nwrote ${OUT}`)
  console.log(
    `  accounts=${fixture.accounts.length} transactions=${fixture.transactions.length} ` +
      `recurring=${fixture.recurring_inflow.length + fixture.recurring_outflow.length} ` +
      `holdings=${fixture.holdings.length} securities=${fixture.securities.length} ` +
      `investment_transactions=${fixture.investment_transactions.length}`,
  )

  // Leave nothing behind in Plaid's world either.
  await api.itemRemove({ access_token }).catch(() => {})
  console.log('  sandbox item removed')
}

main().catch((error) => {
  console.error('recording failed:', error instanceof Error ? error.message : codeOf(error))
  process.exit(1)
})
