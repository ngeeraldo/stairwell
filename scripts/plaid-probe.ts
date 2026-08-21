/**
 * Ask Plaid Sandbox what it actually returns, one enabled PRODUCT at a time.
 *
 *   npx tsx --env-file=.env scripts/plaid-probe.ts
 *
 * PHASE 1 OF docs/superpowers/plans/2026-08-20-plaid-connection.md. Its whole
 * deliverable is knowledge: the envelope in Phase 2 is designed from real
 * output rather than from anyone's recollection of Plaid's documentation, and
 * Gate 1 is a person reading this. It writes to no database and nothing it
 * does survives — the Sandbox item is throwaway.
 *
 * ── ORGANISED BY PRODUCT, DELIBERATELY ──────────────────────────────────────
 *
 * PRODUCT_BLOCKS below mirrors the products enabled on the Plaid dashboard,
 * one block per product, using the dashboard's own labels. That is the point:
 * enabling a sixth product means ADDING A BLOCK, not remembering which calls
 * it brought with it. A block whose calls all fail is the honest signal that a
 * product is not actually enabled, whatever the dashboard says.
 *
 * CORE_BLOCK holds the calls that belong to no product — the item lifecycle
 * every connection needs regardless of what data it carries.
 *
 * ── IT PRINTS NAMES AND COUNTS, NEVER VALUES ────────────────────────────────
 *
 * Every line is a key name, a type name, a count, or a product identifier from
 * our own Plaid account. No merchant, no amount, no balance, no account mask,
 * no token, ever reaches stdout — which is what makes the output safe to paste
 * into a chat, a commit message, or a plan document. Sandbox data is
 * fabricated by Plaid and belongs to nobody, so this is stricter than it
 * strictly needs to be, on purpose: this script's shape is what a later one
 * against production would be copied from.
 *
 * ── IT CALLS THE SDK DIRECTLY, UNLIKE THE APP ───────────────────────────────
 *
 * lib/plaid/client.ts is "the only file that knows Plaid exists" for the
 * RUNNING APP. A probe is not the app: wrapping calls we have not yet decided
 * to make would be speculative surface in the one file that must stay small.
 * A call earns a wrapper in lib/plaid/client.ts when a route needs it.
 */
import type { PlaidApi } from 'plaid'
import { plaidApiFromEnv, PlaidCallError, classifyError } from '../lib/plaid/client'

/**
 * ── ROUTES DELIBERATELY NOT CALLED, AND WHY ─────────────────────────────────
 *
 * The claim this file makes is "every route we could need, for every product
 * enabled on the account". That claim is only worth something if the
 * exclusions are written down, so here they are:
 *
 *   /transactions/get          Superseded by /transactions/sync. The whole
 *                              refresh design is cursor-based; calling the
 *                              date-ranged legacy endpoint would be building
 *                              the thing we chose against.
 *   /transactions/enrich       A SEPARATE product, not enabled.
 *   /investments/auth/get      `investments_auth` is a separate product; it
 *                              appears in available_products, not billed.
 *   /institutions/search       Plaid Link does institution search itself, on
 *                              the friend's device. We never run one.
 *   /link/token/get            Reads back a link token we already hold.
 *   /item/webhook/update       There are no webhooks: a friend's data key
 *                              exists only while they are unlocked, so a
 *                              webhook could never write to their database.
 *   /sandbox/item/fire_webhook Same reason.
 *
 * Everything else reachable with Balance, Investments, Transactions,
 * Recurring Transactions and Transactions Refresh is called below.
 */

/** First Platypus Bank — the Sandbox institution carrying both data products. */
const INSTITUTION = 'ins_109508'
const INITIAL_PRODUCTS = ['transactions', 'investments']

/** How many times to re-ask before calling the first sync empty. */
const SYNC_ATTEMPTS = 8
const SYNC_WAIT_MS = 2_000

type Ctx = { api: PlaidApi; accessToken: string; itemId: string }

type Call = {
  /** Plaid's own endpoint path, so this reads against their docs. */
  endpoint: string
  why: string
  run: (ctx: Ctx) => Promise<unknown>
  /** What to print. Counts and key names only. */
  report?: (result: any) => void
}

type ProductBlock = {
  /** The label as it appears on the Plaid dashboard. */
  product: string
  calls: Call[]
}

/**
 * Render a value's SHAPE: key names and type names, never contents.
 *
 * An array becomes its length plus the shape of element 0 — every element of a
 * Plaid array is the same kind of thing, so the first describes all of them
 * and printing more would be printing data.
 */
function shape(value: unknown, indent = '  '): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array (0 items)'
    return `array (${value.length} items), each:\n${shape(value[0], indent + '  ')}`
  }
  if (typeof value !== 'object') return typeof value
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return 'object (no keys)'
  return entries.map(([k, v]) => `${indent}${k}: ${shape(v, indent + '  ')}`).join('\n')
}

function keysOnly(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(typeof value)
  return Object.keys(value as Record<string, unknown>).join(', ')
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE — no product owns these. Every connection needs them.
// ─────────────────────────────────────────────────────────────────────────────

const CORE_BLOCK: ProductBlock = {
  product: 'Core (item lifecycle — not a product)',
  calls: [
    {
      endpoint: '/link/token/create',
      why: 'Phase 3 cannot start without it. Mints the token Plaid Link opens with.',
      run: ({ api }) =>
        api
          .linkTokenCreate({
            user: { client_user_id: 'probe-user' },
            client_name: 'Stairwell',
            products: ['transactions'] as never,
            country_codes: ['US'] as never,
            language: 'en',
          })
          .then((r) => r.data),
      report: (d) =>
        console.log(
          `    link_token: ${String(d.link_token).length} chars; expiration present: ${Boolean(d.expiration)}`,
        ),
    },
    {
      endpoint: '/item/get',
      why: 'The authoritative answer to which products this account actually has, and the re-auth signal.',
      run: ({ api, accessToken }) =>
        api.itemGet({ access_token: accessToken }).then((r) => r.data),
      report: (d) => {
        // OUR account configuration, not a friend's data. Safe to print, and
        // it is the whole reason this call is in the probe.
        console.log(`    available_products: ${(d.item?.available_products ?? []).join(', ')}`)
        console.log(`    billed_products:    ${(d.item?.billed_products ?? []).join(', ')}`)
        console.log(`    consented_products: ${(d.item?.consented_products ?? []).join(', ')}`)
        console.log(`    item.error:         ${d.item?.error ? d.item.error.error_code : 'null'}`)
        console.log(`    item keys:          ${keysOnly(d.item)}`)
      },
    },
    {
      endpoint: '/accounts/get',
      why: 'The account list every dashboard needs, available with any product.',
      run: ({ api, accessToken }) =>
        api.accountsGet({ access_token: accessToken }).then((r) => r.data),
      report: (d) => {
        console.log(`    accounts: ${d.accounts.length}`)
        console.log(`    SHAPE OF ONE ACCOUNT:\n${shape(d.accounts[0])}`)
      },
    },
    {
      endpoint: '/institutions/get_by_id',
      why: 'Institution name and logo, if a panel wants to say which bank.',
      run: ({ api }) =>
        api
          .institutionsGetById({
            institution_id: INSTITUTION,
            country_codes: ['US'] as never,
          })
          .then((r) => r.data),
      report: (d) => console.log(`    institution keys: ${keysOnly(d.institution)}`),
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// ENABLED PRODUCTS — one block each, labelled as the Plaid dashboard labels them.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_BLOCKS: ProductBlock[] = [
  {
    product: 'Balance',
    calls: [
      {
        endpoint: '/accounts/balance/get',
        why: 'Forces a live balance read at the bank. /accounts/get may serve a cached one.',
        run: ({ api, accessToken }) =>
          api.accountsBalanceGet({ access_token: accessToken }).then((r) => r.data),
        report: (d) => {
          console.log(`    accounts: ${d.accounts.length}`)
          console.log(`    SHAPE OF ONE BALANCE:\n${shape(d.accounts[0]?.balances)}`)
        },
      },
    ],
  },
  {
    product: 'Transactions',
    calls: [
      {
        endpoint: '/transactions/sync',
        why: 'The cursor stream. THE call the whole refresh design is built on.',
        run: async ({ api, accessToken }) => {
          // Polled, because the backfill is asynchronous on Plaid's side and
          // the first call routinely returns nothing. How long that takes is
          // one of Gate 1's questions.
          for (let attempt = 1; attempt <= SYNC_ATTEMPTS; attempt++) {
            const d = (await api.transactionsSync({ access_token: accessToken })).data
            if (d.added.length > 0) {
              console.log(`    (data on attempt ${attempt})`)
              return d
            }
            await new Promise((r) => setTimeout(r, SYNC_WAIT_MS))
          }
          throw new PlaidCallError('unparseable')
        },
        report: (d) => {
          console.log(
            `    added=${d.added.length} modified=${d.modified.length} removed=${d.removed.length} has_more=${d.has_more}`,
          )
          console.log(`    cursor: ${String(d.next_cursor).length} chars`)
          console.log(`    SHAPE OF ONE TRANSACTION:\n${shape(d.added[0])}`)
        },
      },
    ],
  },
  {
    product: 'Recurring Transactions (ADD ON)',
    calls: [
      {
        endpoint: '/transactions/recurring/get',
        why: 'agent-v9.md PROMISES friends "subscriptions and paychecks detected automatically". Never verified until now.',
        run: ({ api, accessToken }) =>
          api.transactionsRecurringGet({ access_token: accessToken }).then((r) => r.data),
        report: (d) => {
          console.log(
            `    inflow_streams=${d.inflow_streams?.length ?? 0} outflow_streams=${d.outflow_streams?.length ?? 0}`,
          )
          const stream = d.outflow_streams?.[0] ?? d.inflow_streams?.[0]
          console.log(`    SHAPE OF ONE STREAM:\n${shape(stream)}`)
        },
      },
    ],
  },
  {
    product: 'Transactions Refresh (ADD ON)',
    calls: [
      {
        endpoint: '/transactions/refresh',
        why: 'On-demand extraction at the BANK. Without it, a friend pressing Refresh only re-reads what Plaid already had.',
        run: ({ api, accessToken }) =>
          api.transactionsRefresh({ access_token: accessToken }).then((r) => r.data),
        report: (d) => console.log(`    response keys: ${keysOnly(d)}`),
      },
    ],
  },
  {
    product: 'Investments',
    calls: [
      {
        endpoint: '/investments/holdings/get',
        why: 'Positions as a snapshot. No cursor — replace, never merge.',
        run: ({ api, accessToken }) =>
          api.investmentsHoldingsGet({ access_token: accessToken }).then((r) => r.data),
        report: (d) => {
          console.log(
            `    accounts=${d.accounts.length} holdings=${d.holdings.length} securities=${d.securities.length}`,
          )
          console.log(`    SHAPE OF ONE HOLDING:\n${shape(d.holdings[0])}`)
          console.log(`    SHAPE OF ONE SECURITY:\n${shape(d.securities[0])}`)
        },
      },
      {
        endpoint: '/investments/transactions/get',
        why: 'Buys and sells — a different call from holdings, and date-ranged rather than cursored.',
        run: ({ api, accessToken }) =>
          api
            .investmentsTransactionsGet({
              access_token: accessToken,
              start_date: isoDaysAgo(730),
              end_date: isoDaysAgo(0),
            })
            .then((r) => r.data),
        report: (d) => {
          console.log(
            `    investment_transactions=${d.investment_transactions?.length ?? 0} total=${d.total_investment_transactions ?? 0}`,
          )
          console.log(`    SHAPE OF ONE INVESTMENT TRANSACTION:\n${shape(d.investment_transactions?.[0])}`)
        },
      },
      {
        endpoint: '/investments/refresh',
        why: 'The Investments equivalent of /transactions/refresh, if the Refresh button should cover holdings too.',
        run: ({ api, accessToken }) =>
          api.investmentsRefresh({ access_token: accessToken }).then((r) => r.data),
        report: (d) => console.log(`    response keys: ${keysOnly(d)}`),
      },
    ],
  },
]

/**
 * Runs LAST and breaks the item on purpose.
 *
 * ITEM_LOGIN_REQUIRED is the one PlaidErrorCode with a friend-facing meaning,
 * and it is the failure the design currently has nowhere to surface. Proving
 * it can be produced and detected on demand is what makes that a build task
 * rather than a thing discovered when a real friend's bank expires.
 */
const TEARDOWN_BLOCK: ProductBlock = {
  product: 'Item lifecycle end (Sandbox only — breaks, repairs, then removes the item)',
  calls: [
    {
      endpoint: '/sandbox/item/reset_login',
      why: 'Forces the item into ITEM_LOGIN_REQUIRED.',
      run: ({ api, accessToken }) =>
        api.sandboxItemResetLogin({ access_token: accessToken }).then((r) => r.data),
      report: (d) => console.log(`    reset_login: ${keysOnly(d)}`),
    },
    {
      endpoint: '/transactions/sync (after reset)',
      why: 'Does our own classifyError() map the broken item to item_login_required?',
      run: async ({ api, accessToken }) => {
        try {
          await api.transactionsSync({ access_token: accessToken })
          return { mapped: 'NO ERROR RAISED — unexpected' }
        } catch (error) {
          return { mapped: classifyError(error) }
        }
      },
      report: (d) => console.log(`    classifyError() said: ${d.mapped}`),
    },
    {
      endpoint: '/link/token/create (UPDATE MODE)',
      why: 'The REPAIR for a broken item. Detecting one without being able to fix it is a dead end for a real friend.',
      run: ({ api, accessToken }) =>
        api
          .linkTokenCreate({
            user: { client_user_id: 'probe-user' },
            client_name: 'Stairwell',
            country_codes: ['US'] as never,
            language: 'en',
            // Supplying access_token IS update mode. `products` must be
            // omitted here — Plaid rejects the pair.
            access_token: accessToken,
          })
          .then((r) => r.data),
      report: (d) =>
        console.log(`    update-mode link_token: ${String(d.link_token).length} chars`),
    },
    {
      endpoint: '/item/remove',
      why: 'Disconnecting a bank. A product whose promise is "you control your data" owes a friend an unlink that actually unlinks.',
      run: ({ api, accessToken }) =>
        api.itemRemove({ access_token: accessToken }).then((r) => r.data),
      report: (d) => console.log(`    response keys: ${keysOnly(d)}`),
    },
    {
      endpoint: '/item/get (after remove)',
      why: 'Proves the removal was real rather than a 200 that changed nothing.',
      run: async ({ api, accessToken }) => {
        try {
          await api.itemGet({ access_token: accessToken })
          return { gone: false, code: 'STILL READABLE — unexpected' }
        } catch (error) {
          return {
            gone: true,
            code: (error as any)?.response?.data?.error_code ?? classifyError(error),
          }
        }
      },
      report: (d) => console.log(`    item readable after remove: ${!d.gone} (${d.code})`),
    },
  ],
}

async function runBlock(block: ProductBlock, ctx: Ctx): Promise<void> {
  console.log(`\n${'═'.repeat(74)}\n▌ ${block.product}\n${'═'.repeat(74)}`)
  for (const call of block.calls) {
    console.log(`\n  ${call.endpoint}`)
    console.log(`    why: ${call.why}`)
    const started = Date.now()
    try {
      const result = await call.run(ctx)
      console.log(`    ✅ ok in ${Date.now() - started}ms`)
      call.report?.(result)
    } catch (error) {
      const code = error instanceof PlaidCallError ? error.code : classifyError(error)
      const plaidCode = (error as any)?.response?.data?.error_code
      console.log(`    ❌ FAILED in ${Date.now() - started}ms — our code=${code}`)
      // Plaid's error_code is a TAXONOMY VALUE, not prose and not a friend's
      // data. It is the difference between "product not enabled" and "not
      // ready yet", which is exactly what this probe exists to tell apart.
      if (plaidCode) console.log(`       plaid error_code=${plaidCode}`)
    }
  }
}

async function main(): Promise<void> {
  const api = plaidApiFromEnv()
  console.log(`PLAID_ENV=${process.env.PLAID_ENV}   institution=${INSTITUTION}`)
  console.log(`initial_products: ${INITIAL_PRODUCTS.join(', ')}`)

  console.log(`\n${'═'.repeat(74)}\n▌ Setup — create a Sandbox item (no Link, no browser)\n${'═'.repeat(74)}`)
  const started = Date.now()
  const publicToken = (
    await api.sandboxPublicTokenCreate({
      institution_id: INSTITUTION,
      initial_products: INITIAL_PRODUCTS as never,
    })
  ).data.public_token
  const exchanged = (await api.itemPublicTokenExchange({ public_token: publicToken })).data
  console.log(`  ✅ item created and exchanged in ${Date.now() - started}ms`)
  console.log(`  access token: ${exchanged.access_token.length} chars, prefix "${exchanged.access_token.slice(0, 14)}…"`)

  const ctx: Ctx = {
    api,
    accessToken: exchanged.access_token,
    itemId: exchanged.item_id,
  }

  await runBlock(CORE_BLOCK, ctx)
  for (const block of PRODUCT_BLOCKS) await runBlock(block, ctx)
  await runBlock(TEARDOWN_BLOCK, ctx)

  console.log(`\n${'═'.repeat(74)}`)
  console.log('Done. Nothing was written to any database; the Sandbox item is throwaway.')
}

main().catch((error) => {
  console.error('probe failed:', error instanceof Error ? error.message : 'unknown')
  process.exit(1)
})
