import type { PlatformDb } from '@/lib/db/platform'
import { readSession } from '@/lib/session/store'

type Row = { slug: string; role: 'user' | 'admin' }

function accountFor(
  db: PlatformDb,
  sessionId: string | undefined,
): Row | undefined {
  if (!sessionId) return undefined
  const session = readSession(db, sessionId)
  if (!session) return undefined
  return db
    .prepare('SELECT slug, role FROM accounts WHERE id = ?')
    .get(session.account_id) as Row | undefined
}

/**
 * A user space belongs to exactly one account. Admin is not an override:
 * the admin portal is read-only over transcripts and specs, not a back door
 * into someone's dashboard.
 *
 * Callers must render 404, never 403 — a 403 confirms the space exists.
 */
export function canSeeUserSpace(
  db: PlatformDb,
  sessionId: string | undefined,
  slug: string,
): boolean {
  const account = accountFor(db, sessionId)
  return account !== undefined && account.slug === slug
}

export function isAdmin(
  db: PlatformDb,
  sessionId: string | undefined,
): boolean {
  return accountFor(db, sessionId)?.role === 'admin'
}
