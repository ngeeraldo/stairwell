import type { PlatformDb } from '@/lib/db/platform'
import { checkPassword, findAccountBySlug } from './accounts'
import { deriveDbKey, verifyPassword } from './password'
import { putKey } from '@/lib/session/keymap'
import { createSession, readSession } from '@/lib/session/store'

/**
 * Login authenticates and issues a session. It deliberately does NOT unlock:
 * the two-tier model means the key is derived at /unlock, so a deploy leaves
 * users logged in but locked.
 */
export async function login(
  db: PlatformDb,
  slug: string,
  password: string,
): Promise<string | null> {
  const account = findAccountBySlug(db, slug)
  if (!account) return null
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
