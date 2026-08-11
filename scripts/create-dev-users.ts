import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openPlatformDb } from '../lib/db/platform'
import { createAccount } from '../lib/auth/accounts'

/**
 * Create the step 1a checkpoint accounts in the platform database.
 *
 * INSERT ONLY. This script must never delete or regenerate the database it
 * targets: on the production droplet it runs as
 *   PLATFORM_DB=/home/deploy/stairwell/platform.db npx tsx scripts/create-dev-users.ts
 * against the live, already-populated file (see
 * docs/superpowers/plans/2026-08-10-step1b-infra-and-deploy.md). Wiping or
 * DELETEing anything here would destroy production accounts on a host that
 * has no synthetic-only guarantee. If the target already has accounts, this
 * script refuses to run rather than touch it.
 *
 * openPlatformDb() never mkdirSync's its target directory (only
 * regeneratePlatform(), a test-only helper this script must not call, does
 * that), so on a fresh clone this script creates platform/dev/ itself
 * before opening the file.
 */
function resolvePlatformDbPath(): string {
  return process.env.PLATFORM_DB
    ? resolve(process.env.PLATFORM_DB)
    : resolve(process.cwd(), 'platform', 'dev', 'synthetic.db')
}

async function main(): Promise<void> {
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) {
    console.error(
      'ADMIN_PASSWORD is not set. Refusing to create the admin account ' +
        'without an explicit password (CLAUDE.md > Data safety: no ' +
        'committed credentials). Set ADMIN_PASSWORD and re-run.',
    )
    process.exitCode = 1
    return
  }

  const path = resolvePlatformDbPath()
  mkdirSync(dirname(path), { recursive: true })

  const db = openPlatformDb(path)
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as {
      n: number
    }
    if (n > 0) {
      console.error(
        `Refusing to run: ${path} already has ${n} account(s). This ` +
          'script only INSERTs and never modifies or deletes an existing ' +
          "account, so it won't run again against a populated database. " +
          'Create additional accounts by hand if that is really what you want.',
      )
      process.exitCode = 1
      return
    }

    // devone/devtwo are loudly-fake dev fixtures (CLAUDE.md > Data safety);
    // the admin password comes from the environment, never the repo.
    await createAccount(db, { slug: 'devone', role: 'user', password: 'TEST-DEV-ONE' })
    await createAccount(db, { slug: 'devtwo', role: 'user', password: 'TEST-DEV-TWO' })
    await createAccount(db, { slug: 'nico', role: 'admin', password: adminPassword })

    console.log(`devone / devtwo / nico created in ${path}`)
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
