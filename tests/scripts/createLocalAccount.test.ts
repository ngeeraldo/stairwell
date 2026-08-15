// tests/scripts/createLocalAccount.test.ts
//
// The load-bearing test in this file is "creates NO real-named user
// database". Everything else is ordinary CLI behaviour.
//
// Background: `npm start` sets NODE_ENV=production, and NODE_ENV is the one
// switch lib/db/userData.ts uses to pick a world. Registering through the
// browser under `npm start` — which is what docs/runbook.md step 7 used to
// say — therefore created users/<slug>/<slug>.db on a laptop, the one thing
// CLAUDE.md > Data safety says cannot exist. This script is step 7's
// replacement, so the assertion that it creates no such file is the whole
// reason it exists rather than a nice-to-have.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openPlatformDb } from '@/lib/db/platform'
import { PASSWORD_MIN_LENGTH } from '@/lib/copy/onboarding'

const REPO = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'create-local-account.ts')
const PASSWORD = 'TEST-LOCAL-PASSWORD'

let root: string
let usersDir: string
let target: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-local-account-'))
  usersDir = join(root, 'users')
  target = join(root, 'platform.db')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Run the script as a real subprocess.
 *
 * USERS_DIR points at a temp tree so that IF this script ever started creating
 * a user database, it would land here where the test can see it — and not in
 * the repo, where the guard hook would then deny every later read of it.
 */
function runScript(
  args: string[],
  env: Record<string, string | undefined> = {},
): { status: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, PLATFORM_DB: target, USERS_DIR: usersDir, ...env },
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

describe('scripts/create-local-account.ts', () => {
  it('creates the account', () => {
    const { status } = runScript(['sam', PASSWORD])

    expect(status).toBe(0)
    const db = openPlatformDb(target)
    try {
      const rows = db.prepare('SELECT slug, role FROM accounts').all() as {
        slug: string
        role: string
      }[]
      expect(rows).toEqual([{ slug: 'sam', role: 'user' }])
    } finally {
      db.close()
    }
  })

  it('gives it an account_keys row, like a friend registered from an invite', () => {
    // Not cosmetic. An account with no wrapped key derives its database key
    // DIRECTLY, which is the legacy shape devone/devtwo/nico keep forever and
    // that nothing new should be born into (CLAUDE.md, onboarding ledger D2).
    // A local account in the wrong shape would exercise the wrong code path
    // every time it logged in.
    const { status } = runScript(['sam', PASSWORD])

    expect(status).toBe(0)
    const db = openPlatformDb(target)
    try {
      const row = db
        .prepare(
          `SELECT k.account_id IS NOT NULL AS enveloped
             FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id
            WHERE a.slug = 'sam'`,
        )
        .get() as { enveloped: number }
      expect(row.enveloped).toBe(1)
    } finally {
      db.close()
    }
  })

  it('creates NO real-named user database', () => {
    // THE REASON THIS SCRIPT EXISTS. If someone ever adds a migrateUserDb call
    // here — the obvious-looking way to make the account "complete" — this
    // turns red, and the message above says why it must not.
    const { status } = runScript(['sam', PASSWORD])

    expect(status).toBe(0)
    expect(existsSync(join(usersDir, 'sam', 'sam.db'))).toBe(false)
    // Nothing at all, not merely nothing with that one name: a differently
    // named encrypted file on a laptop is the same violation.
    expect(existsSync(usersDir) ? readdirSync(usersDir) : []).toEqual([])
  })

  it('refuses to run in production', () => {
    // The droplet, or a terminal that inherited `npm start`'s environment. In
    // production an account is created by accepting an invite and by nothing
    // else.
    const { status, output } = runScript(['sam', PASSWORD], {
      NODE_ENV: 'production',
    })

    expect(status).not.toBe(0)
    expect(output).toContain('NODE_ENV is production')
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a password shorter than the real flow accepts', () => {
    const short = 'x'.repeat(PASSWORD_MIN_LENGTH - 1)
    const { status, output } = runScript(['sam', short])

    expect(status).not.toBe(0)
    expect(output).toContain(String(PASSWORD_MIN_LENGTH))
  })

  it('refuses a slug that already has an account, without touching it', () => {
    expect(runScript(['sam', PASSWORD]).status).toBe(0)

    const { status, output } = runScript(['sam', 'A-DIFFERENT-PASSWORD'])

    expect(status).not.toBe(0)
    expect(output).toContain('already has an account')

    const db = openPlatformDb(target)
    try {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as {
        n: number
      }
      expect(n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('prints usage when called with no arguments', () => {
    const { status, output } = runScript([])

    expect(status).not.toBe(0)
    expect(output).toContain('usage:')
  })
})
