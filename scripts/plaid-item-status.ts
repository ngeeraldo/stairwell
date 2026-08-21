/**
 * What state is a connected Sandbox bank actually in?
 *
 *   npx tsx --env-file=.env scripts/plaid-item-status.ts <slug>
 *
 * The counterpart to scripts/plaid-break-item.ts. Breaking an item and
 * repairing it are both invisible from the outside — the dashboard renders
 * identically either way — so without this there is no way to tell whether a
 * re-auth actually worked.
 *
 * Same two bounds as plaid-break-item.ts, and for the same reasons: sandbox
 * only, and it opens users/<slug>/synthetic.db and nothing else.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { getItem, plaidApiFromEnv } from '../lib/plaid/client'

const codeOf = (error: unknown): string =>
  (error as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
  'non-plaid-error'

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: npx tsx --env-file=.env scripts/plaid-item-status.ts <slug>')
    process.exit(1)
  }
  if (process.env.PLAID_ENV !== 'sandbox') {
    console.error(`refusing to run with PLAID_ENV=${process.env.PLAID_ENV ?? '(unset)'}`)
    process.exit(1)
  }

  const path = resolve(__dirname, '..', 'users', slug, 'synthetic.db')
  if (!existsSync(path)) {
    console.error(`no synthetic database at users/${slug}/synthetic.db`)
    process.exit(1)
  }

  const db = new Database(path, { readonly: true })
  let stored: { access_token: string; item_id: string; connected_at: number } | undefined
  try {
    stored = db
      .prepare('SELECT access_token, item_id, connected_at FROM plaid_items ORDER BY connected_at LIMIT 1')
      .get() as typeof stored
  } finally {
    db.close()
  }

  if (!stored) {
    console.log(`${slug}: NOT CONNECTED (no plaid_items row)`)
    return
  }

  console.log(`stored item_id : ${stored.item_id}`)
  console.log(`stored token   : ${stored.access_token.slice(0, 20)}…`)
  console.log(`connected at   : ${new Date(stored.connected_at).toISOString()}`)

  try {
    const live = await getItem(plaidApiFromEnv(), stored.access_token)
    console.log(`live item_id   : ${live.itemId}`)
    console.log(`error_code     : ${live.errorCode ?? 'null  <-- HEALTHY'}`)
    console.log(`products       : ${live.availableProducts.length}`)
    if (live.itemId !== stored.item_id) {
      // Worth saying out loud: update mode repairs an item IN PLACE, so a
      // changed id means a whole new connection was made instead.
      console.log('\nNOTE: the item id CHANGED — this was a new connection, not a repair.')
    }
  } catch (error) {
    console.log(`error_code     : ${codeOf(error)}  <-- the stored token no longer works`)
  }
}

main().catch((error) => {
  console.error('failed:', codeOf(error))
  process.exit(1)
})
