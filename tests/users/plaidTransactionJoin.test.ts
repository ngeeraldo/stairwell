// tests/users/plaidTransactionJoin.test.ts
//
// A READ OF plaid_transactions ALWAYS REACHES THROUGH plaid_accounts.
//
// This was a line in docs/dashboard-build-rules.md §9.6, and a line is what
// this plan has now watched fail twice — §9.5 listed the bank controls as
// optional parts and a dashboard shipped without half of them; this rule was
// written down and users/plaidtest was already violating it when someone
// happened to look. So it is a sweep.
//
// ── WHAT GOES WRONG WITHOUT IT ──────────────────────────────────────────────
//
// Nothing deletes the transactions of an account a bank stops sharing, on
// purpose (2026-08-22 ruling): the account picker opens with nothing ticked,
// so a friend adding one account is indistinguishable from a friend removing
// every other, and deleting on that basis destroyed history nobody could
// restore. The account's row leaves plaid_accounts on the next refresh; its
// transactions stay.
//
// So the join is the ONLY thing keeping a removed account off the screen. A
// panel reading plaid_transactions alone keeps counting an account the friend
// removed, forever, with nothing there to explain it.
//
// It also, measured against real Plaid, covers a case nobody designed for: an
// account that is unticked and later re-added comes back with a NEW account_id
// and NEW transaction_ids, so its history is stored twice. The join hides the
// stranded copy — without it, a panel silently double-counts every one of
// those transactions.
//
// ── HOW IT DECIDES ──────────────────────────────────────────────────────────
//
// Per SQL STATEMENT, not per file. A file-level check would pass any queries.ts
// that happens to read plaid_accounts somewhere else in it — which plaidtest's
// did, while the transaction query beside it joined nothing.
//
// The join target only has to END IN `accounts`, so a friend's own view over
// plaid_accounts counts: users/run11 reads through `spending_accounts`, which
// is that view plus this friend's own scope, and is exactly the shape §9.2
// asks a builder to write.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const USERS_DIR = resolve(__dirname, '..', '..', 'users')

/** One SQL statement, and where a human would go to look at it. */
type Statement = { where: string; sql: string }

/**
 * Every SQL statement in a user folder that mentions plaid_transactions.
 *
 * TypeScript holds its SQL in backtick template literals and a migration holds
 * it as statements separated by semicolons; both are read, because run11 does
 * its scoping in a migration's view and plaidtest does it in queries.ts.
 */
function statementsFor(slug: string): Statement[] {
  const found: Statement[] = []

  const queries = resolve(USERS_DIR, slug, 'queries.ts')
  if (existsSync(queries)) {
    const source = readFileSync(queries, 'utf8')
    for (const literal of source.match(/`[^`]*`/g) ?? []) {
      if (literal.includes('plaid_transactions')) {
        found.push({ where: `users/${slug}/queries.ts`, sql: literal })
      }
    }
  }

  const migrations = resolve(USERS_DIR, slug, 'migrations')
  if (existsSync(migrations)) {
    for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql'))) {
      const source = readFileSync(resolve(migrations, file), 'utf8')
      for (const statement of source.split(';')) {
        // The envelope's own CREATE TABLE names the table without reading it.
        if (statement.includes('plaid_transactions') && /\bFROM\s+plaid_transactions\b/i.test(statement)) {
          found.push({ where: `users/${slug}/migrations/${file}`, sql: statement })
        }
      }
    }
  }

  return found
}

const financeFolders = () =>
  readdirSync(USERS_DIR).filter((slug) => {
    const migrations = resolve(USERS_DIR, slug, 'migrations')
    return existsSync(migrations) && readdirSync(migrations).some((f) => f.includes('_module_plaid'))
  })

describe('every read of plaid_transactions reaches through the accounts table', () => {
  it('has a finance folder to sweep, or this proves nothing', () => {
    expect(financeFolders().length).toBeGreaterThan(0)
  })

  it.each(financeFolders())('users/%s', (slug) => {
    const statements = statementsFor(slug)
    // A finance folder that reads no transactions at all is possible — a
    // balances-only dashboard — so an empty list is not a failure.
    for (const statement of statements) {
      // Anything ending in `accounts`: plaid_accounts itself, or a friend's
      // own view over it.
      const joined = /\b\w*accounts\b/i.test(statement.sql)
      expect({
        where: statement.where,
        sql: statement.sql.replace(/\s+/g, ' ').slice(0, 90),
        joinsAccounts: joined,
      }).toEqual({
        where: statement.where,
        sql: statement.sql.replace(/\s+/g, ' ').slice(0, 90),
        joinsAccounts: true,
      })
    }
  })
})
