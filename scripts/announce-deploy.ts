// scripts/announce-deploy.ts
//
// Posts "your build landed" into one account's chat, once per confirmed spec
// version. Run BY NICO, by hand, right after a deploy that shipped that
// specific account's build.
//
// THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico.
// That is consistent with CLAUDE.md: the platform database is not encrypted
// with any user key and holds the records Nico is promised access to at
// onboarding. It is NOT consistent with Claude running it locally against
// anything but the synthetic database. This file takes no flag of its own —
// PLATFORM_DB is what selects the database, always explicit, never
// ambient (see lib/db/platform.ts) — so point it at a synthetic one.
//
// Deliberately NOT called from deploy/deploy.sh. deploy.sh deploys the whole
// service, not one user's dashboard — wiring this in would post "your
// dashboard is live" into every account's chat on every push, which is a
// permanent lie in an append-only transcript for every account that was not
// the reason for that particular deploy. This stays a one-line command Nico
// runs for the specific account whose build just shipped.
import { openPlatformDb } from '@/lib/db/platform'
import { announceDeploy } from '@/lib/chat/announce'

if (process.argv[1]?.endsWith('announce-deploy.ts')) {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: tsx scripts/announce-deploy.ts <slug>')
    process.exit(2)
  }
  const db = openPlatformDb(
    process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db',
  )
  try {
    const result = announceDeploy(db, slug, Date.now)
    if (result.announced) {
      console.log(`announced to '${slug}'`)
    } else {
      console.log(`did not announce to '${slug}': ${result.reason}`)
    }
  } finally {
    db.close()
  }
}
