/**
 * Break a connected Sandbox bank on purpose, so the re-auth path can be tested.
 *
 *   npx tsx --env-file=.env scripts/plaid-break-item.ts <slug>
 *
 * ── WHY THIS HAS TO EXIST ───────────────────────────────────────────────────
 *
 * ITEM_LOGIN_REQUIRED is the one PlaidCallError with a friend-facing meaning:
 * their bank connection has expired and only they can repair it, by logging in
 * again through Plaid Link in UPDATE MODE. Every other failure is ours.
 *
 * That path is unreachable by hand. Disconnecting does not produce it — that
 * DELETES the item, so the next connect is a fresh one with an institution
 * picker, which is correct and is a different flow. You need an item that still
 * exists and no longer works, and the only way to get one on demand is
 * /sandbox/item/reset_login.
 *
 * Without this, the re-auth flow ships having been proven by unit tests and a
 * server-side probe, and gets its first real exercise on the morning a friend's
 * bank actually expires.
 *
 * ── TWO HARD BOUNDS ─────────────────────────────────────────────────────────
 *
 * 1. SANDBOX ONLY. /sandbox/item/reset_login does not exist in production, and
 *    this refuses to run outside PLAID_ENV=sandbox rather than relying on that.
 *    Breaking a real person's bank connection to test a code path is not a
 *    thing this repo should be able to do by accident.
 *
 * 2. synthetic.db ONLY. It reads the access token from users/<slug>/synthetic.db
 *    — a plain, loudly-fake, gitignored file. It never opens an encrypted
 *    database, has no key, and could not open one if it tried. That is the same
 *    filename partition the guard hook enforces
 *    (.claude/hooks/deny-sensitive-files.sh).
 *
 * After running this, press "Reconnect your bank" on the dashboard: Plaid
 * should reopen the same institution with NO picker.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { plaidApiFromEnv } from '../lib/plaid/client'

const codeOf = (error: unknown): string =>
  (error as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
  'non-plaid-error'

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: npx tsx --env-file=.env scripts/plaid-break-item.ts <slug>')
    process.exit(1)
  }

  // Bound 1. Not a warning — a refusal.
  if (process.env.PLAID_ENV !== 'sandbox') {
    console.error(`refusing to run with PLAID_ENV=${process.env.PLAID_ENV ?? '(unset)'}`)
    console.error('this breaks a bank connection on purpose and is sandbox-only')
    process.exit(1)
  }

  // Bound 2. The filename IS the partition: synthetic.db is the only database
  // anything local may open.
  const path = resolve(__dirname, '..', 'users', slug, 'synthetic.db')
  if (!existsSync(path)) {
    console.error(`no synthetic database at users/${slug}/synthetic.db`)
    process.exit(1)
  }

  const db = new Database(path, { readonly: true })
  let token: string | undefined
  try {
    const row = db
      .prepare('SELECT access_token FROM plaid_items ORDER BY connected_at LIMIT 1')
      .get() as { access_token?: string } | undefined
    token = row?.access_token
  } finally {
    db.close()
  }

  if (!token) {
    console.error(`${slug} has no connected bank — connect one first, then run this`)
    process.exit(1)
  }

  try {
    // The token is never printed. Its prefix is enough to confirm which
    // environment it belongs to and reaches no bank on its own.
    console.log(`breaking ${slug}'s item (${token.slice(0, 14)}…)`)
    await plaidApiFromEnv().sandboxItemResetLogin({ access_token: token })
  } catch (error) {
    // A CODE, never the raw error object: an SDK error carries our
    // PLAID-SECRET in its request headers. That is not hypothetical — it
    // leaked into a transcript once, from a throwaway script with a bare
    // handler.
    console.error('reset_login failed:', codeOf(error))
    process.exit(1)
  }

  console.log('\ndone. The item still exists and no longer works.')
  console.log('Now press "Reconnect your bank" — Plaid should reopen the same')
  console.log('institution with NO picker. That is update mode.')
}

main().catch((error) => {
  console.error('failed:', codeOf(error))
  process.exit(1)
})
