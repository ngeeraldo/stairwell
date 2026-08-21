/**
 * Which Sandbox institutions are OAuth, and would our Link token show them?
 *
 *   npx tsx --env-file=.env scripts/plaid-oauth-probe.ts
 *
 * Answers one question before any OAuth code gets written: is this testable at
 * all? Our link token asks for `transactions` + `investments`, and Plaid Link
 * only lists institutions supporting EVERY requested product — so an OAuth
 * bank that lacks one of them is invisible in the picker, and "I couldn't find
 * one" would be our own filter rather than a missing feature.
 *
 * Prints names and capability flags. An institution name is public
 * information about a company, not about a person.
 */
import { plaidApiFromEnv } from '../lib/plaid/client'

const codeOf = (e: unknown): string =>
  (e as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
  'non-plaid-error'

const WANTED = ['transactions', 'investments']

async function main(): Promise<void> {
  if (process.env.PLAID_ENV !== 'sandbox') {
    console.error('sandbox only')
    process.exit(1)
  }
  const api = plaidApiFromEnv()

  const { data } = await api.institutionsGet({
    count: 500,
    offset: 0,
    country_codes: ['US'] as never,
    options: { include_optional_metadata: false },
  })

  const rows = (data.institutions as any[]).map((i) => ({
    id: i.institution_id,
    name: i.name,
    oauth: Boolean(i.oauth),
    products: (i.products ?? []) as string[],
  }))

  const oauth = rows.filter((r) => r.oauth)
  console.log(`total institutions: ${rows.length}`)
  console.log(`OAuth institutions: ${oauth.length}\n`)

  for (const r of oauth) {
    const missing = WANTED.filter((p) => !r.products.includes(p))
    const verdict = missing.length === 0 ? '✅ WOULD APPEAR' : `❌ hidden (no ${missing.join(', ')})`
    console.log(`${verdict}  ${r.id}  ${r.name}`)
  }

  console.log('\n--- what a transactions-only token would show ---')
  for (const r of oauth) {
    if (r.products.includes('transactions')) console.log(`  ${r.id}  ${r.name}`)
  }
}

main().catch((e) => {
  console.error('failed:', codeOf(e))
  process.exit(1)
})
