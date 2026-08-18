// scripts/ask-user.ts
//
// Posts a question into one account's chat, for the mid-build case where a
// feasibility or design decision only the friend can make. Run BY NICO, by
// hand, when a build hits exactly that kind of blocker — the chat stays the
// log of record even for a question that originated outside it.
//
// THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico.
// That is consistent with CLAUDE.md: the platform database is not encrypted
// with any user key and holds the records Nico is promised access to at
// onboarding. It is NOT consistent with Claude running it locally against
// anything but the synthetic database. This file takes no flag of its own —
// PLATFORM_DB is what selects the database, always explicit, never
// ambient (see lib/db/platform.ts) — so point it at a synthetic one.
//
// Deliberately NOT called from deploy/deploy.sh, for the same reason
// scripts/announce-deploy.ts is not: this is a one-off, account-specific
// message, not something every deploy should trigger for every account.
//
// REFUSES TO RUN if PLATFORM_DB is unset, rather than falling back to
// platform/dev/synthetic.db. A non-interactive `ssh` loads no profile and no
// EnvironmentFile, so a forgotten $STAIRWELL prelude on the droplet is
// exactly the state a fallback would hit — and a fallback there would post
// the question into a synthetic account instead of the friend's real chat,
// silently, while Nico believes it was asked.
import { resolve } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { announce } from '@/lib/chat/announce'

export function askUser(db: PlatformDb, slug: string, question: string): void {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)
  announce(db, { accountId: account.id, body: question, at: Date.now() })
}

/**
 * No fallback — see the header comment. `??` only catches null/undefined, so
 * an explicit empty string (`PLATFORM_DB=` with nothing after it) is checked
 * for by hand or it would resolve to the cwd.
 */
function resolvePlatformDbPath(): string {
  if (!process.env.PLATFORM_DB) {
    console.error(
      'Refusing to run: PLATFORM_DB is not set.\n\n' +
        'This script never falls back to a synthetic database — a fallback ' +
        'on the droplet would post the question into a synthetic account ' +
        "instead of the friend's real chat, silently. Set it explicitly, " +
        'e.g.:\n\n' +
        '  PLATFORM_DB=platform/dev/synthetic.db npx tsx scripts/ask-user.ts <slug> "<question>"',
    )
    process.exit(1)
  }
  return resolve(process.env.PLATFORM_DB)
}

if (process.argv[1]?.endsWith('ask-user.ts')) {
  const slug = process.argv[2]
  const question = process.argv[3]
  if (!slug || !question) {
    console.error('usage: tsx scripts/ask-user.ts <slug> "<question>"')
    process.exit(2)
  }
  const db = openPlatformDb(resolvePlatformDbPath())
  try {
    askUser(db, slug, question)
    console.log(`posted to '${slug}'`)
  } finally {
    db.close()
  }
}
