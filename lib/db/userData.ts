// lib/db/userData.ts
//
// The ONE place that answers "which database does this slug use".
//
// There is no real-vs-synthetic fallback. Production always serves the
// friend's own encrypted database, even when it holds zero rows — an empty
// dashboard is a normal state, not an error, and every dashboard is required
// to render one. Dev always serves synthetic.db, for READS AND WRITES, so an
// entry widget can be tested end to end: reads from one database and writes to
// another would make typing a weight save somewhere the screen never looks.
//
// THE GATE IS `NODE_ENV` AND NOTHING ELSE. A variable that could switch
// production onto synthetic data would rebuild the exact failure
// deploy/required-env describes for PLATFORM_DB — loudly-fake data served in
// production with every health check green. Inert in production by
// construction rather than by configuration, and red-tested: deleting the gate
// must turn tests/db/userData.test.ts red.
//
// The invariant that makes this safe: REAL DATABASES EXIST ONLY ON THE SERVER.
// Dev never has a real-named file, so the guard hook's filename partition —
// synthetic.db is the only database anything local may open — stays intact.
import Database from 'better-sqlite3-multiple-ciphers'
import { openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { userDbPath, type UserDb } from '@/lib/db/userDb'

export function isDevData(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * The handle a dashboard render gets. READ-ONLY in both worlds.
 *
 * A dashboard component never holds a writable handle; routes do the writing.
 * That rule predates this design and is unweakened by it — but it now has to
 * be asserted on the dev path too, which is new. Before, dev's synthetic open
 * was read-only by construction, because nothing ever wrote to it.
 */
export function openUserDataForRead(slug: string, key: Buffer): UserDb {
  if (isDevData()) {
    return new Database(userDbPath(slug), { readonly: true, fileMustExist: true })
  }
  return openEncryptedUserDb(slug, key, { readonly: true })
}

/**
 * The handle a platform ROUTE gets in order to write.
 *
 * Only routes reach this — the four ordered auth checks live in them, and a
 * dashboard component that imported this would be a change to CLAUDE.md's
 * read-only rule rather than a refactor.
 */
export function openUserDataForWrite(slug: string, key: Buffer): UserDb {
  if (isDevData()) {
    return new Database(userDbPath(slug), { fileMustExist: true })
  }
  return openEncryptedUserDb(slug, key)
}
