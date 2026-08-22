/**
 * Can a friend add a SECOND account at a bank they have already connected?
 *
 *   npx tsx --env-file=.env scripts/plaid-account-select-probe.ts
 *
 * A throwaway probe, in the shape of scripts/plaid-probe.ts and for the same
 * reason: the multi-source plan's per-account story rests on Plaid's Link
 * update mode with account selection, and this repository's rule is that a
 * design is written from real output rather than from recollection about
 * someone else's API (2026-08-20 plan, Gate 1).
 *
 * It answers three questions and nothing else:
 *
 *   1. Does /item/get return institution_name?  (plan D3 — free, or not free)
 *   2. Does /link/token/create accept update.account_selection_enabled?
 *   3. Does an item report which accounts it currently shares?
 *
 * PRINTS FIELD NAMES, COUNTS AND SANDBOX-FABRICATED INSTITUTION NAMES ONLY.
 * No access token, no account id, no balance — this output is meant to be safe
 * to paste into a chat or a plan.
 */
import { PlaidApi } from 'plaid'
import { createSandboxItem, getItem, plaidApiFromEnv } from '../lib/plaid/client'

const SANDBOX_INSTITUTION = 'ins_109508'

async function main(): Promise<void> {
  if (process.env.PLAID_ENV !== 'sandbox') {
    console.error(`refusing to run with PLAID_ENV=${process.env.PLAID_ENV ?? '(unset)'}`)
    process.exit(1)
  }

  const api: PlaidApi = plaidApiFromEnv()

  console.log('— creating a sandbox item —')
  const { accessToken } = await createSandboxItem(api, {
    institutionId: SANDBOX_INSTITUTION,
    products: ['transactions'],
  })
  console.log('  item created')

  console.log('\n— Q1: does /item/get carry institution_name? —')
  const item = await getItem(api, accessToken)
  console.log('  getItem() returns keys:', Object.keys(item).sort().join(', '))
  const raw = await api.itemGet({ access_token: accessToken })
  const itemKeys = Object.keys(raw.data.item ?? {}).sort()
  console.log('  raw item keys:', itemKeys.join(', '))
  console.log('  institution_name present:', itemKeys.includes('institution_name'))
  console.log('  institution_name value:', (raw.data.item as unknown as Record<string, unknown>).institution_name)

  console.log('\n— Q2: update mode with account_selection_enabled —')
  try {
    const token = await api.linkTokenCreate({
      user: { client_user_id: 'probe' },
      client_name: 'Stairwell probe',
      country_codes: ['US'] as never,
      language: 'en',
      access_token: accessToken,
      update: { account_selection_enabled: true } as never,
    })
    console.log('  ACCEPTED. response keys:', Object.keys(token.data).sort().join(', '))
    console.log('  link_token minted:', typeof token.data.link_token === 'string')
  } catch (error) {
    const data = (error as { response?: { data?: Record<string, unknown> } })?.response?.data
    console.log('  REJECTED.')
    console.log('  error_code:', data?.error_code)
    console.log('  error_type:', data?.error_type)
    console.log('  message:', data?.error_message)
  }

  console.log('\n— Q2b: plain update mode (the repair flow we already ship) —')
  try {
    const token = await api.linkTokenCreate({
      user: { client_user_id: 'probe' },
      client_name: 'Stairwell probe',
      country_codes: ['US'] as never,
      language: 'en',
      access_token: accessToken,
    })
    console.log('  ACCEPTED. link_token minted:', typeof token.data.link_token === 'string')
  } catch (error) {
    const data = (error as { response?: { data?: Record<string, unknown> } })?.response?.data
    console.log('  REJECTED. error_code:', data?.error_code, '/', data?.error_message)
  }

  console.log('\n— Q3: what does the item currently share? —')
  const accounts = await api.accountsGet({ access_token: accessToken })
  console.log('  accounts returned:', accounts.data.accounts.length)
  console.log('  account keys:', Object.keys(accounts.data.accounts[0] ?? {}).sort().join(', '))
  console.log(
    '  item block keys:',
    Object.keys(accounts.data.item ?? {}).sort().join(', '),
  )

  console.log('\n— cleaning up —')
  await api.itemRemove({ access_token: accessToken })
  console.log('  item removed')
}

main().catch((error) => {
  console.error('probe failed:', error instanceof Error ? error.message : 'unknown')
  process.exit(1)
})
