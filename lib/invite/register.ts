// lib/invite/register.ts
import { insertAccount } from '@/lib/auth/accounts'
import { newDataKey, wrapDataKey } from '@/lib/auth/envelope'
import { deriveDbKey, hashPassword, newSalts } from '@/lib/auth/password'
import { putWrappedKey } from '@/lib/db/accountKeys'
import { migrateUserDb } from '@/lib/db/migrate'
import type { PlatformDb } from '@/lib/db/platform'
import { putKey } from '@/lib/session/keymap'
import { createSession } from '@/lib/session/store'
import { consumeInvite, readInvite } from './tokens'
import { PASSWORD_MIN_LENGTH } from '@/lib/copy/onboarding'

export type RegisterResult =
  | { ok: true; slug: string; sessionId: string }
  | { ok: false; reason: 'invalid_token' | 'too_short' | 'server' }

/**
 * Thrown to roll the transaction back when the invite was claimed by someone
 * else between the read and the write. Never escapes this module.
 */
class InviteLostError extends Error {}

/**
 * Everything S2's submit does, in the order that keeps its promise.
 *
 * onboarding-ux-spec.md: "Token consumption and DB creation are atomic; a
 * consumed token with no DB is an invalid state." A SQLite transaction cannot
 * roll back a filesystem `link()`, so this is held by ORDER rather than by a
 * transaction (onboarding ledger D13):
 *
 *   1. Every async step FIRST — two Argon2 passes, a random data key, a wrap.
 *      They have to be first anyway: better-sqlite3 transactions cannot
 *      contain `await`, which is why lib/auth/accounts.ts has a synchronous
 *      insertAccount at all.
 *
 *   2. THE DATABASE FILE, before any row exists. It is the only step that can
 *      fail for reasons outside SQLite — a full disk, a read-only mount, a
 *      permissions mistake — and a failure here has touched nothing at all:
 *      no account, no consumed token. The friend sees "try once more" and
 *      their link still works, which is exactly what the spec asks for.
 *
 *   3. ONE TRANSACTION, all pure inserts: account, wrapped key, invite
 *      consumption, session. `consumeInvite` returning false means someone
 *      else claimed the link in between, and throwing is what un-creates the
 *      account we just made.
 *
 *      The account is created BEFORE the invite is consumed, and that ordering
 *      is forced: `invites.account_id` is a real foreign key, checked
 *      immediately. It costs nothing — a rollback undoes both.
 *
 *   4. The data key into the in-process keymap, never into a row
 *      (CLAUDE.md > Data safety).
 *
 * If step 3 fails, the leftover is an empty encrypted database in a folder no
 * account points at: inert, unreadable by anyone including us, and reused by
 * the next attempt for that slug because `link()` keeps whichever file already
 * exists.
 */
export async function registerFromInvite(
  db: PlatformDb,
  input: { token: string; password: string; at: number },
): Promise<RegisterResult> {
  // Server-side, and first. The client disables the button on the same rule,
  // but a disabled attribute is a courtesy and this is the gate.
  if (input.password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: 'too_short' }
  }

  // Read before doing ~30ms of Argon2, so a dead link costs nothing. The
  // authoritative check is still consumeInvite's own WHERE clause below —
  // this one is an optimisation and is allowed to be stale.
  const invite = readInvite(db, input.token)
  if (invite.kind === 'invalid') return { ok: false, reason: 'invalid_token' }
  const { slug } = invite

  const { saltAuth, saltKey } = newSalts()
  const authHash = await hashPassword(input.password, saltAuth)
  // The password-derived value is now a KEY-ENCRYPTING key: what opens the
  // database is `dataKey`, which is random and never derived from anything
  // (onboarding ledger D2).
  const kek = await deriveDbKey(input.password, saltKey)
  const dataKey = newDataKey()
  const wrapped = wrapDataKey(kek, dataKey)

  try {
    // The third and last place the runner fires. It creates the database AND
    // applies whatever migrations exist, which for a brand-new friend is
    // usually none at all — their folder is scaffolded days later, when Nico
    // builds a dashboard from their spec.
    //
    // onboarding-ux-spec.md S2 still holds, by a different mechanism than
    // before: the file exists the moment the password does, because this call
    // is what creates it. A consumed token with no database remains an invalid
    // state.
    migrateUserDb(slug, dataKey)
  } catch {
    // Nothing has been written to the platform database yet, so the invite is
    // still unused and the friend can simply try again.
    //
    // No refuseSession here, deliberately: there is no session to refuse yet
    // and no account to alert about. The friend sees the invite page's own
    // server error, which is retryable — and unlike a migration failure at
    // login, this one genuinely is, because nothing was consumed.
    return { ok: false, reason: 'server' }
  }

  let sessionId: string
  try {
    sessionId = db.transaction(() => {
      const accountId = insertAccount(db, {
        slug,
        role: 'user',
        authHash,
        saltAuth,
        saltKey,
        createdAt: input.at,
      })
      putWrappedKey(db, accountId, wrapped, input.at)
      if (!consumeInvite(db, { token: input.token, accountId, at: input.at })) {
        throw new InviteLostError()
      }
      return createSession(db, accountId)
    })()
  } catch (error) {
    if (error instanceof InviteLostError) return { ok: false, reason: 'invalid_token' }
    // A UNIQUE violation on accounts.slug lands here too, and means the same
    // thing from the friend's point of view: this link no longer leads
    // anywhere they can use. Anything genuinely unexpected is reported as a
    // server error rather than as a spent link, because those need different
    // things from them ("try again" vs "text Nico").
    if (isUniqueViolation(error)) return { ok: false, reason: 'invalid_token' }
    return { ok: false, reason: 'server' }
  }

  putKey(sessionId, dataKey)
  return { ok: true, slug, sessionId }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  )
}
