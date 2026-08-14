/**
 * Mint a single-use invite link.
 *
 *   npx tsx scripts/create-invite.ts <slug>
 *
 * On the droplet:
 *   PLATFORM_DB=/home/deploy/stairwell/platform.db \
 *     npx tsx scripts/create-invite.ts friendone
 *
 * Prints ONE line: the URL to text or email. Nothing else goes to stdout, so
 * the output can be piped or copied without editing.
 *
 * THE TOKEN IS NEVER WRITTEN DOWN ANYWHERE ELSE — not in the database (only
 * its SHA-256), not in a log line here. If the message is lost, revoke and
 * mint again; there is nothing to look up. That is the same shape as the
 * password rule the whole product is built on, applied to the link.
 *
 * INSERT ONLY, like scripts/create-dev-users.ts: this runs against the live
 * platform database on a host with no synthetic-only guarantee, so it must
 * never delete or regenerate anything.
 */
import { resolve } from 'node:path'
import { openPlatformDb } from '../lib/db/platform'
import { mintInvite } from '../lib/invite/tokens'

/**
 * Not in deploy/required-env, and deliberately: the default IS the correct
 * production value, so its absence cannot produce a wrong link on the droplet.
 * Listing it would block every deploy over a variable that should normally be
 * unset — the same reasoning that file already applies to USERS_DIR.
 */
const ORIGIN = process.env.INVITE_ORIGIN ?? 'https://app.stairwell.run'

function resolvePlatformDbPath(): string {
  return process.env.PLATFORM_DB
    ? resolve(process.env.PLATFORM_DB)
    : resolve(process.cwd(), 'platform', 'dev', 'synthetic.db')
}

function main(): void {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: npx tsx scripts/create-invite.ts <slug>')
    process.exitCode = 1
    return
  }

  const db = openPlatformDb(resolvePlatformDbPath())
  try {
    console.log(`${ORIGIN}/invite/${mintInvite(db, { slug, at: Date.now() })}`)
  } catch (error) {
    // The message, not the stack: every throw mintInvite produces is a
    // sentence aimed at the person who just typed the command.
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  } finally {
    db.close()
  }
}

main()
