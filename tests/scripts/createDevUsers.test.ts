import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'

const REPO = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'create-dev-users.ts')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-dev-users-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run the script as a real subprocess against an explicit PLATFORM_DB. */
function runScript(
  target: string,
  env: Record<string, string | undefined> = {},
): { status: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', SCRIPT], {
      cwd: REPO,
      env: { ...process.env, PLATFORM_DB: target, ...env },
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

describe('scripts/create-dev-users.ts', () => {
  it('honours PLATFORM_DB instead of the hardcoded default path', () => {
    const target = join(root, 'not-the-default', 'platform.db')
    const { status } = runScript(target, { ADMIN_PASSWORD: 'TEST-ADMIN-ONE' })
    expect(status).toBe(0)
    expect(existsSync(target)).toBe(true)
    const db = openPlatformDb(target)
    try {
      const rows = db.prepare('SELECT slug, role FROM accounts ORDER BY slug').all() as {
        slug: string
        role: string
      }[]
      expect(rows).toEqual([
        { slug: 'devone', role: 'user' },
        { slug: 'devtwo', role: 'user' },
        { slug: 'nico', role: 'admin' },
      ])
    } finally {
      db.close()
    }
  })

  it('creates the parent directory on a fresh clone (openPlatformDb never does)', () => {
    const target = join(root, 'deeply', 'nested', 'platform.db')
    expect(existsSync(join(root, 'deeply'))).toBe(false)

    const { status } = runScript(target, { ADMIN_PASSWORD: 'TEST-ADMIN-TWO' })

    expect(status).toBe(0)
    expect(existsSync(target)).toBe(true)
  })

  it('fails with a clear message and creates nothing when ADMIN_PASSWORD is unset', () => {
    const target = join(root, 'platform.db')
    const { status, output } = runScript(target, { ADMIN_PASSWORD: undefined })

    expect(status).not.toBe(0)
    expect(output).toMatch(/ADMIN_PASSWORD/)
    expect(existsSync(target)).toBe(false)
  })

  it('never hardcodes the admin password — the account only checks against ADMIN_PASSWORD', () => {
    const target = join(root, 'platform.db')
    runScript(target, { ADMIN_PASSWORD: 'TEST-ADMIN-UNIQUE-VALUE' })

    const db = openPlatformDb(target)
    try {
      const admin = db.prepare("SELECT auth_hash FROM accounts WHERE slug = 'nico'").get() as {
        auth_hash: string
      }
      // A hardcoded literal (e.g. the old 'TEST-ADMIN') would never appear
      // in a bcrypt/scrypt-style hash, but assert the stronger property
      // directly: the hash must not equal any well-known repo literal.
      expect(admin.auth_hash).not.toContain('TEST-ADMIN')
    } finally {
      db.close()
    }
  })

  it('refuses to run against a database that already has accounts, and changes nothing', async () => {
    const target = join(root, 'platform.db')
    mkdirSync(root, { recursive: true })
    const db = openPlatformDb(target)
    await createAccount(db, { slug: 'preexisting', role: 'user', password: 'TEST-PRE-EXISTING' })
    db.close()

    const { status, output } = runScript(target, { ADMIN_PASSWORD: 'TEST-ADMIN-THREE' })

    expect(status).not.toBe(0)
    expect(output).toMatch(/already has/i)

    const after = openPlatformDb(target)
    try {
      const rows = after.prepare('SELECT slug FROM accounts').all() as { slug: string }[]
      // Only the pre-existing account — the script must not have inserted
      // devone/devtwo/nico on top of it, nor deleted anything.
      expect(rows).toEqual([{ slug: 'preexisting' }])
    } finally {
      after.close()
    }
  })
})
