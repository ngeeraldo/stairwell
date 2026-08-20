// scripts/create-local-account.ts
//
//   npx tsx scripts/create-local-account.ts <slug> <password>
//
// Creates ONE local account so you can log in as a friend's slug while
// building their dashboard. Local only, synthetic platform database only, and
// it never brings a real-named user database into being.
//
// ─── why this exists at all ───
//
// The runbook's step 7 used to say: run `npm run build && npm start`, mint an
// invite, and register through the browser. That works, and it also creates
// `users/<slug>/<slug>.db` on the laptop — a real-named, SQLCipher-encrypted
// database outside the server, which CLAUDE.md > Data safety says cannot
// exist. Not a bug in the app: `npm start` sets NODE_ENV=production, and
// NODE_ENV is the ONE switch lib/db/userData.ts uses to decide which world it
// is in. `lib/db/migrate.ts` returns early outside production precisely to
// stop this — but `npm start` is production, so the guard was off exactly
// where the runbook pointed.
//
// The registration flow needs production mode only because of a dev-compiler
// artifact on cold routes (docs/local-dev.md), which is a reason to avoid the
// BROWSER, not a reason to create a real database. So this script does what
// registration does to the platform database and nothing it does to the
// filesystem.
//
// ─── what it deliberately does NOT do ───
//
// It does not call `migrateUserDb`. That is the only thing that creates
// `users/<slug>/<slug>.db`, and on a laptop the answer is always "don't".
// Under `npm run dev` the friend's dashboard reads `users/<slug>/synthetic.db`
// for reads AND writes, which is the whole point of having no fallback
// (lib/db/userData.ts) — the entry widget is testable end to end against a
// database you are allowed to open.
//
// It does not consume an invite, because there is no invite: this is not a
// rehearsal of onboarding. Rehearsing onboarding uses a throwaway slug and the
// real browser flow — docs/local-dev.md.
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { findAccountBySlug, insertAccount } from '../lib/auth/accounts'
import { newDataKey, wrapDataKey } from '../lib/auth/envelope'
import { deriveDbKey, hashPassword, newSalts } from '../lib/auth/password'
import { putWrappedKey } from '../lib/db/accountKeys'
import { openPlatformDb } from '../lib/db/platform'
import { isDevData } from '../lib/db/userData'
import { PASSWORD_MIN_LENGTH } from '../lib/copy/onboarding'

/** Same resolution every script in docs/local-dev.md uses. */
function resolvePlatformDbPath(): string {
  return process.env.PLATFORM_DB
    ? resolve(process.env.PLATFORM_DB)
    : resolve(process.cwd(), 'platform', 'dev', 'synthetic.db')
}

async function main(): Promise<void> {
  // FIRST, before anything reads an argument or opens a file.
  //
  // Two different disasters share this one guard. Run on the droplet, this
  // would mint an account with no invite behind it, straight into the live
  // platform database. Run locally under `npm start`'s environment, every
  // later login as that slug would take the production branch of
  // lib/db/userData.ts and create the very file this script exists to avoid.
  //
  // Keyed on isDevData() rather than on a name of its own, so it can never
  // disagree with the switch the app itself uses.
  if (!isDevData()) {
    console.error(
      'Refusing to run: NODE_ENV is production.\n\n' +
        'This script is a LOCAL dev convenience. In production an account is ' +
        'created by a friend accepting an invite, and nothing else may create ' +
        'one — see docs/runbook-human.md step 2.\n\n' +
        'If you are on your laptop, you have probably inherited NODE_ENV from ' +
        'a `npm start` shell. Open a new terminal and re-run.',
    )
    process.exitCode = 1
    return
  }

  const [slug, password] = process.argv.slice(2)
  if (!slug || !password) {
    console.error(
      'usage: npx tsx scripts/create-local-account.ts <slug> <password>\n\n' +
        'Creates a local account so you can log in as <slug> at ' +
        'http://localhost:3000/login while building their dashboard.\n' +
        'The password is local and disposable; it has nothing to do with the ' +
        'one the real friend sets on the droplet.',
    )
    process.exitCode = 1
    return
  }

  // The same rule the real flow enforces (lib/invite/register.ts). A local
  // account that could take a 4-character password would be a local account
  // that does not exercise what a friend goes through.
  if (password.length < PASSWORD_MIN_LENGTH) {
    console.error(
      `Refusing to run: password must be at least ${PASSWORD_MIN_LENGTH} ` +
        'characters, the same minimum lib/invite/register.ts enforces on a ' +
        'friend.',
    )
    process.exitCode = 1
    return
  }

  const path = resolvePlatformDbPath()
  mkdirSync(dirname(path), { recursive: true })

  // Every await BEFORE the transaction opens: better-sqlite3 transactions
  // cannot contain one. Same constraint, same ordering, and for the same
  // reason as lib/invite/register.ts — see lib/auth/accounts.ts.
  const { saltAuth, saltKey } = newSalts()
  const authHash = await hashPassword(password, saltAuth)
  const kek = await deriveDbKey(password, saltKey)
  const dataKey = newDataKey()
  const wrapped = wrapDataKey(kek, dataKey)

  const db = openPlatformDb(path)
  try {
    if (findAccountBySlug(db, slug)) {
      console.error(
        `Refusing to run: '${slug}' already has an account in ${path}.\n\n` +
          'This script only INSERTs. To start that slug over locally, reset ' +
          'the whole synthetic platform database — docs/local-dev.md > Reset.',
      )
      process.exitCode = 1
      return
    }

    // An `account_keys` row, so a local account has the SAME shape a friend
    // registered through an invite has: a random data key, wrapped under a
    // key-encrypting key derived from the password. Without it this would
    // build a legacy-shaped account that derives its database key directly —
    // the shape CLAUDE.md says devone/devtwo/nico keep forever and that
    // nothing new should ever be born into.
    db.transaction(() => {
      const accountId = insertAccount(db, {
        slug,
        role: 'user',
        authHash,
        saltAuth,
        saltKey,
        createdAt: Date.now(),
      })
      putWrappedKey(db, accountId, wrapped, Date.now())
    })()
  } finally {
    db.close()
  }

  console.log(
    `${slug} created in ${path}\n` +
      `Log in at http://localhost:3000/login under \`npm run dev\`.\n` +
      `No user database was created — /${slug} reads users/${slug}/synthetic.db.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
