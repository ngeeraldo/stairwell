import type { PlatformDb } from '@/lib/db/platform'
import { checkPassword, findAccountBySlug } from './accounts'
import { deriveDbKey, verifyPassword } from './password'
import { putKey } from '@/lib/session/keymap'
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

/** Derive the SQLCipher key and put it in the in-memory map. */
export async function unlock(
  db: PlatformDb,
  sessionId: string,
  password: string,
): Promise<boolean> {
  const session = readSession(db, sessionId)
  if (!session) return false
  const account = db
    .prepare('SELECT auth_hash, salt_key FROM accounts WHERE id = ?')
    .get(session.account_id) as
    | { auth_hash: string; salt_key: Buffer }
    | undefined
  if (!account) return false
  if (!(await verifyPassword(account.auth_hash, password))) return false
  putKey(sessionId, await deriveDbKey(password, account.salt_key))
  return true
}
