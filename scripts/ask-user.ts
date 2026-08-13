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
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { announce } from '@/lib/chat/announce'

export function askUser(db: PlatformDb, slug: string, question: string): void {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)
  announce(db, { accountId: account.id, body: question, at: Date.now() })
}

if (process.argv[1]?.endsWith('ask-user.ts')) {
  const slug = process.argv[2]
  const question = process.argv[3]
  if (!slug || !question) {
    console.error('usage: tsx scripts/ask-user.ts <slug> "<question>"')
    process.exit(2)
  }
  const db = openPlatformDb(
    process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db',
  )
  try {
    askUser(db, slug, question)
    console.log(`posted to '${slug}'`)
  } finally {
    db.close()
  }
}
