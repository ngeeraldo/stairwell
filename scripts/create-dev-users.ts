import { regeneratePlatform } from '../tests/support/synthetic'
import { openPlatformDb } from '../lib/db/platform'
import { createAccount } from '../lib/auth/accounts'

/**
 * Create the step 1a checkpoint accounts in the synthetic dev database.
 * Passwords are loudly fake, in keeping with CLAUDE.md > Data safety.
 *
 * regeneratePlatform() creates platform/dev/ (mkdirSync) and the database
 * file itself before we open it, so this script — not `npm run dev` — must
 * be the first thing that touches platform/dev/synthetic.db in a fresh
 * clone. getDb() only opens the file; it never creates the directory.
 */
async function main(): Promise<void> {
  const path = regeneratePlatform()
  const db = openPlatformDb(path)
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM accounts').run()

  await createAccount(db, { slug: 'devone', role: 'user', password: 'TEST-DEV-ONE' })
  await createAccount(db, { slug: 'devtwo', role: 'user', password: 'TEST-DEV-TWO' })
  await createAccount(db, { slug: 'nico', role: 'admin', password: 'TEST-ADMIN' })

  console.log('devone / devtwo / nico created in platform/dev/synthetic.db')
  db.close()
}

main()
