import type { PlatformDb } from '@/lib/db/platform'
import { checkPassword, findAccountBySlug } from './accounts'
import { deriveDbKey, verifyPassword } from './password'
import { unwrapDataKey } from './envelope'
import { readWrappedKey } from '@/lib/db/accountKeys'
import { putKey } from '@/lib/session/keymap'
import { migrateUserDb } from '@/lib/db/migrate'
import { refuseDeps, refuseSession } from '@/lib/auth/refuseSession'
import { createSession, readSession } from '@/lib/session/store'

// A real Argon2id hash (same OPTS as lib/auth/password.ts: algorithm 2,
// memoryCost 19456, timeCost 2, parallelism 1, outputLen 32) of a loudly
// fake password, generated once and hardcoded here. Its only job is to give
// `verifyPassword` real Argon2 work to do on the unknown-slug branch below,
// so that branch costs the same as a real verify and an attacker cannot use
// wall-clock time to learn whether a slug exists (Task 13G). Its return
// value is discarded; only its cost matters.
//
// To regenerate (both values are loudly fake, not secrets, and the salt is
// fixed only so this constant is reproducible/auditable):
//   hashPassword('DUMMY-NOT-A-REAL-PASSWORD-oracle-fix-13G', Buffer.alloc(16, 0x99))
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$mZmZmZmZmZmZmZmZmZmZmQ$g5OANDJjXnwpUD9m4VxfTuBU//J2PhaxCX3zEteqjn8'

/**
 * Login authenticates and issues a session. It deliberately does not derive
 * the key itself — that stays the caller's job, so this function has no reason
 * to touch key material.
 *
 * Note this is narrower than "logging in leaves you locked", which is what
 * this comment used to say. app/api/login/route.ts DOES derive the key right
 * after calling this, because it already has the password and asking for it
 * twice in one login was a pointless prompt. The two-tier model is unaffected:
 * the key lives only in the in-process map (4h idle, 12h ceiling), so a
 * restart still leaves users authenticated but locked, and `unlock` below is
 * still the single-prompt path back in.
 *
 * The unknown-slug branch runs a dummy Argon2 verify before returning, so
 * that path costs the same as a real failed verify. Without it, a miss on
 * findAccountBySlug returns in microseconds while a real account costs a
 * full Argon2id verify (~14-19ms on dev hardware) — a ~1000x timing gap an
 * unauthenticated caller of /api/login can use to learn which slugs exist,
 * defeating the 404-never-403 blindness Task 13 built for `/[user]/…`.
 */
export async function login(
  db: PlatformDb,
  slug: string,
  password: string,
): Promise<string | null> {
  const account = findAccountBySlug(db, slug)
  if (!account) {
    await verifyPassword(DUMMY_HASH, password)
    return null
  }
  if (!(await checkPassword(account, password))) return null
  return createSession(db, account.id)
}

/**
 * The 32 bytes that open this account's SQLCipher database.
 *
 * TWO ARMS, PERMANENTLY (onboarding ledger D2). An account with a row in
 * `account_keys` gets the unwrapped random data key; one without gets the
 * derived key itself, which is what devone's, devtwo's and nico's databases
 * were actually written under.
 *
 * There is no third arm and no backfill. A legacy account's wrapped key cannot
 * be computed without their password, and fabricating one would lock a real
 * person out of real data with no recovery path — which is the same
 * irreversibility the whole product is built around, pointed at the wrong
 * target.
 *
 * ONE function, called from both places that reach putKey (unlock() below and
 * app/api/login/route.ts). Two copies of this branch would be two things that
 * can drift, and the drift would be a lockout.
 */
export async function databaseKeyFor(
  db: PlatformDb,
  account: { id: number; salt_key: Buffer },
  password: string,
): Promise<Buffer> {
  const derived = await deriveDbKey(password, account.salt_key)
  const wrapped = readWrappedKey(db, account.id)
  return wrapped ? unwrapDataKey(derived, wrapped) : derived
}

/** Resolve the database key and put it in the in-memory map. */
export async function unlock(
  db: PlatformDb,
  sessionId: string,
  password: string,
): Promise<boolean> {
  const session = readSession(db, sessionId)
  if (!session) return false
  const account = db
    // slug and role too: unlock runs migrations now, which needs to know
    // WHOSE database, and must skip an admin who has no user space at all.
    .prepare('SELECT auth_hash, salt_key, slug, role FROM accounts WHERE id = ?')
    .get(session.account_id) as
    | { auth_hash: string; salt_key: Buffer; slug: string; role: 'user' | 'admin' }
    | undefined
  if (!account) return false
  if (!(await verifyPassword(account.auth_hash, password))) return false

  let key: Buffer
  try {
    key = await databaseKeyFor(
      db,
      { id: session.account_id, salt_key: account.salt_key },
      password,
    )
  } catch {
    // The password was already verified against auth_hash above, so a
    // WrappedKeyError here does NOT mean a wrong password — it means a corrupt
    // account_keys row, which should be impossible.
    //
    // No metrics row, deliberately. The failure is already visible as a failed
    // unlock, and a new event kind for a state that cannot occur is noise in
    // an append-only log that can never be cleaned up.
    return false
  }

  // The second of the three places the runner fires, and the one that matters
  // after a deploy: restarting the service empties the in-process keymap, so
  // every friend comes back through here. That is why no write path needs a
  // defensive migrate — a deploy cannot leave an unlocked session pointing at
  // a database whose shape predates it.
  try {
    if (account.role !== 'admin') migrateUserDb(account.slug, key)
  } catch (error) {
    await refuseSession(refuseDeps(session.account_id), {
      sessionId,
      slug: account.slug,
      error,
    })
    return false
  }

  putKey(sessionId, key)
  return true
}
