import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { SLUG_PATTERN } from '@/lib/auth/slug'
import { usersRoot } from '@/lib/db/userDb'

export type EncryptedUserDb = Database.Database

/**
 * A wrong key and a corrupt file are the SAME driver error — SqliteError with
 * code SQLITE_NOTADB, message "file is not a database". The opener knows
 * whether the file existed before it touched it, so it is the only layer that
 * can tell those apart, and it says which rather than passing the ambiguity up.
 */
export class WrongKeyError extends Error {
  constructor(slug: string) {
    super(
      `users/${slug}/${slug}.db exists but did not open with this session's key`,
    )
    this.name = 'WrongKeyError'
  }
}

/**
 * The cipher, pinned rather than inherited.
 *
 * The driver's current default is chacha20 (sqleet). If a future release
 * changed that default, every file written before the change would stop
 * opening — and the error would be "file is not a database", which reads as
 * corruption rather than as a configuration change. Naming it here means the
 * files stay readable across driver upgrades, and the pinning itself is
 * asserted by a test.
 */
const CIPHER = 'chacha20'

export function encryptedUserDbPath(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug '${slug}': refusing to build a filesystem path from it`,
    )
  }
  return join(usersRoot(), slug, `${slug}.db`)
}

/** True when this user has real data. Cheap: no key needed, no open. */
export function encryptedUserDbExists(slug: string): boolean {
  return existsSync(encryptedUserDbPath(slug))
}

/**
 * Open (or create) a user's encrypted database with `key`.
 *
 * The key is applied with db.key(Buffer), never a `key=` pragma: a pragma
 * would turn 32 bytes of key material into a SQL string on its way through
 * the driver. The buffer belongs to lib/session/keymap.ts, which zeroes it in
 * place on expiry — this function uses it and keeps no reference.
 *
 * Creating and opening are the same call because the file is created lazily on
 * first write (design spec section 3): a user with no logged data has no real
 * database, and their dashboard reads the synthetic one under a banner.
 */
export function openEncryptedUserDb(slug: string, key: Buffer): EncryptedUserDb {
  const path = encryptedUserDbPath(slug)
  const existedBefore = existsSync(path)

  const db = new Database(path)
  try {
    // Cipher and key are both applied before any statement touches the file
    // (WAL and foreign_keys, then schema.sql). This order is deliberate —
    // not because a specific failure from reordering was observed here:
    // reversing cipher and key was tested directly against this driver and
    // it still produced a correctly encrypted file.
    db.pragma(`cipher='${CIPHER}'`)
    db.key(key)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // The first statement that actually touches the file is where a wrong key
    // surfaces, so the schema exec doubles as the key check.
    db.exec(readFileSync(join(usersRoot(), slug, 'schema.sql'), 'utf8'))
  } catch (error) {
    db.close()
    if (!existedBefore) {
      // `new Database(path)` creates the file immediately, and the WAL /
      // foreign_keys pragmas write real bytes before schema.sql is even
      // read — so a failed open on a brand-new file leaves an encrypted
      // but table-less stub behind. Left in place, that stub makes
      // existedBefore true on the NEXT call for this slug, so a later
      // failure (for any reason) would be misreported as a wrong key. A
      // failed create must leave nothing behind.
      try {
        unlinkSync(path)
      } catch {
        // Do not let a failed cleanup mask the original error below.
      }
    }
    const notADb =
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'SQLITE_NOTADB'
    // Only a file that already existed can be a KEY mismatch. A brand-new file
    // that fails to open is something else entirely and must not be relabelled.
    if (notADb && existedBefore) throw new WrongKeyError(slug)
    throw error
  }
  return db
}
