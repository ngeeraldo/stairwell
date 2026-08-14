// lib/invite/tokens.ts
import { createHash, randomBytes } from 'node:crypto'
import type { PlatformDb } from '@/lib/db/platform'
import { RESERVED_SLUGS, SLUG_PATTERN } from '@/lib/auth/slug'

/**
 * A single-use invite, bound to a slug Nico assigned.
 *
 * onboarding-ux-spec.md > Invite minting: no self-chosen usernames, no
 * automatic expiry, a manual revoke instead. N=3 friends, so expiry timers are
 * over-engineering and a revoke command is not.
 */

export type InviteState =
  | { kind: 'valid'; id: number; slug: string }
  /**
   * ONE invalid arm, deliberately, and the type is the enforcement.
   *
   * The spec: "No distinction shown between 'used' and 'unknown' — same
   * message for both (leaks nothing, and the fix is identical: text Nico)." A
   * type that CANNOT EXPRESS the distinction is a stronger guarantee than a
   * renderer that remembers not to render it, because the renderer is the part
   * that gets rewritten.
   */
  | { kind: 'invalid' }

/** 32 bytes, base64url — URL-safe with no escaping, ~43 characters. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenSha(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Reserve a slug and return the token that claims it.
 *
 * The slug is validated HERE, at mint time, against the same two rules
 * `createAccount` applies — because this reserves the name that call will
 * later create. So Nico finds out he typed a route name while he is minting
 * the link, rather than while his friend is standing in a kitchen trying to
 * use it.
 *
 * The TOKEN IS NEVER STORED, only its SHA-256 (onboarding ledger D11).
 * platform.db is unencrypted by design and invites deliberately never expire,
 * so a live token sitting in it would be a permanent bearer credential to
 * create an account. It exists only in the URL Nico sends; a lost link is
 * re-minted, not recovered.
 */
export function mintInvite(db: PlatformDb, input: { slug: string; at: number }): string {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      `invalid slug '${input.slug}': must match ${SLUG_PATTERN.source} ` +
        '(lowercase letters, digits, and hyphens only, 1-32 characters)',
    )
  }
  if (RESERVED_SLUGS.has(input.slug)) {
    throw new Error(`invalid slug '${input.slug}': reserved for a route`)
  }
  if (db.prepare('SELECT 1 FROM accounts WHERE slug = ?').get(input.slug)) {
    throw new Error(`invalid slug '${input.slug}': an account already has it`)
  }

  const token = newToken()
  db.prepare('INSERT INTO invites (token_sha, slug, created_at) VALUES (?, ?, ?)').run(
    tokenSha(token),
    input.slug,
    input.at,
  )
  return token
}

/**
 * What this token is, as far as anyone is allowed to know.
 *
 * The used/revoked/unknown distinction is collapsed in the SQL, not in the
 * caller: three states go in and two come out, so there is nowhere downstream
 * for the difference to leak from.
 */
export function readInvite(db: PlatformDb, token: string): InviteState {
  const row = db
    .prepare(
      `SELECT id, slug FROM invites
       WHERE token_sha = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .get(tokenSha(token)) as { id: number; slug: string } | undefined
  return row ? { kind: 'valid', id: row.id, slug: row.slug } : { kind: 'invalid' }
}

/**
 * Mark an invite used, atomically. True if THIS call was the one that used it.
 *
 * The `used_at IS NULL AND revoked_at IS NULL` guard lives in the UPDATE's own
 * WHERE clause, NOT in a read before it. A read-then-write would let two
 * simultaneous submissions of the same form both see an unused invite and both
 * go on to create an account — and `accounts.slug` is UNIQUE, so the loser
 * would 500 AFTER consuming a token that can never be reissued. Here the loser
 * gets `changes === 0` and is told, honestly, that the link is no longer
 * valid.
 */
export function consumeInvite(
  db: PlatformDb,
  input: { token: string; accountId: number; at: number },
): boolean {
  const info = db
    .prepare(
      `UPDATE invites SET used_at = ?, account_id = ?
       WHERE token_sha = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(input.at, input.accountId, tokenSha(input.token))
  return info.changes === 1
}

/**
 * Revoke an unused invite. True if there was one to revoke.
 *
 * `AND used_at IS NULL` because revoking a USED invite would be a lie: the
 * account exists, and the row is the record of how it came to. Deleting the
 * account is a different operation (`rm` plus a DELETE), not this one.
 */
export function revokeInvite(
  db: PlatformDb,
  input: { slug: string; at: number },
): boolean {
  const info = db
    .prepare('UPDATE invites SET revoked_at = ? WHERE slug = ? AND used_at IS NULL')
    .run(input.at, input.slug)
  return info.changes === 1
}
