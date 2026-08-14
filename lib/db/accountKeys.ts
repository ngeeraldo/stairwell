// lib/db/accountKeys.ts
import type { PlatformDb } from './platform'

/**
 * The wrapped data key for an account, or `undefined`.
 *
 * ABSENCE OF A ROW IS THE LEGACY ARM, permanently — see platform/schema.sql
 * and onboarding ledger D2. devone, devtwo and nico predate envelope
 * encryption and have no row, so their SQLCipher key is still
 * argon2(password, salt_key), which is what keeps devtwo's existing real
 * database on the droplet openable.
 *
 * Never backfill. A legacy account's wrapped key cannot be computed without
 * their password, and fabricating one would lock a real person out of real
 * data with no recovery path.
 */
export function readWrappedKey(db: PlatformDb, accountId: number): Buffer | undefined {
  const row = db
    .prepare('SELECT wrapped_key FROM account_keys WHERE account_id = ?')
    .get(accountId) as { wrapped_key: Buffer } | undefined
  return row?.wrapped_key
}

/**
 * Store (or replace) an account's wrapped data key.
 *
 * The upsert is not defensive tidiness: a password change — not built here,
 * but the entire reason the indirection exists — is exactly this call with a
 * new KEK and the same data key, and nothing else. `account_keys` is
 * deliberately NOT append-only for that reason.
 */
export function putWrappedKey(
  db: PlatformDb,
  accountId: number,
  wrapped: Buffer,
  at: number,
): void {
  db.prepare(
    `INSERT INTO account_keys (account_id, wrapped_key, created_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET wrapped_key = excluded.wrapped_key`,
  ).run(accountId, wrapped, at)
}
