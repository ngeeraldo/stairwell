import { openPlatformDb } from '@/lib/db/platform'

/**
 * Generate the synthetic platform database at an explicit path.
 *
 * Loud fake values only (CLAUDE.md > Data safety): anything rendered from
 * this data must read as obviously fake at a glance.
 */
export function seedPlatform(targetPath: string): void {
  const db = openPlatformDb(targetPath)
  try {
    db.prepare('DELETE FROM sessions').run()
    // account_keys rows go with them: the table is ON DELETE CASCADE and
    // foreign_keys is ON (lib/db/platform.ts), so this needs no companion
    // DELETE and would silently stop needing one if that ever changed.
    db.prepare('DELETE FROM accounts').run()
    // Accounts are seeded by the account helper in production. Here the rows
    // exist only so a dev session has something to log in as; the hashes are
    // placeholders replaced by Task 8's helper when dev users are created.
    //
    // Deliberately NO account_keys row. That makes this account a LEGACY one
    // (onboarding ledger D2), which is exactly what devone, devtwo and nico
    // are — a seed that quietly enveloped it would stop the dev database
    // resembling the production one on the one axis where they differ.
    db.prepare(
      `INSERT INTO accounts (slug, role, auth_hash, salt_auth, salt_key, created_at)
       VALUES ('devuser-test', 'user', 'PLACEHOLDER-TEST', x'00', x'00', 0)`,
    ).run()
  } finally {
    db.close()
  }
}
