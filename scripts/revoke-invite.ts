/**
 * Revoke an unused invite.
 *
 *   npx tsx scripts/revoke-invite.ts <slug>
 *
 * On the droplet:
 *   PLATFORM_DB=/home/deploy/stairwell/platform.db \
 *     npx tsx scripts/revoke-invite.ts friendone
 *
 * onboarding-ux-spec.md > Invite minting: "No automatic expiry. Manual revoke
 * command instead. N=3 friends; expiry timers are over-engineering." This is
 * that command, and it is the whole of what replaces expiry.
 *
 * By SLUG, not by token, because the token is the thing Nico does not have —
 * it was never stored (lib/invite/tokens.ts). The slug is what he typed.
 *
 * It refuses to revoke an invite that was already USED, and that refusal is
 * the useful part: revoking it would be a lie, since the account exists and
 * the row is the record of how it came to. Deleting an account is a different
 * operation and is not this one.
 */
import { resolve } from 'node:path'
import { openPlatformDb } from '../lib/db/platform'
import { revokeInvite } from '../lib/invite/tokens'

function resolvePlatformDbPath(): string {
  return process.env.PLATFORM_DB
    ? resolve(process.env.PLATFORM_DB)
    : resolve(process.cwd(), 'platform', 'dev', 'synthetic.db')
}

function main(): void {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: npx tsx scripts/revoke-invite.ts <slug>')
    process.exitCode = 1
    return
  }

  const db = openPlatformDb(resolvePlatformDbPath())
  try {
    if (revokeInvite(db, { slug, at: Date.now() })) {
      console.log(`revoked ${slug}`)
      return
    }
    // Non-zero, because "nothing happened" is not success when the operator
    // believed they were closing a hole. The two reasons it can happen —
    // no such invite, or one that was already used — are deliberately not
    // distinguished here for the same reason the dead-link page does not
    // distinguish them: the next step is identical either way.
    console.error(
      `nothing to revoke for '${slug}': no unused invite with that slug ` +
        '(it may never have existed, or it may already have been used)',
    )
    process.exitCode = 1
  } finally {
    db.close()
  }
}

main()
