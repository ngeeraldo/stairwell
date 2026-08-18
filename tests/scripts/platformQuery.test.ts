// tests/scripts/platformQuery.test.ts
//
// scripts/platform-query.ts replaces `sqlite3 platform.db '...'` in
// docs/runbook.md, which does not run on the droplet (no sqlite3 binary
// there). Two things matter most about its replacement: it must never read
// or write anything but the database it is explicitly pointed at (no
// synthetic fallback, genuinely read-only), and the command Nico actually
// types over ssh must behave the way the doc says it does — so this file
// tests both the exported functions AND the real subprocess, the same split
// tests/scripts/exportSpec.test.ts and tests/scripts/inviteCli.test.ts use
// for their own scripts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { putWrappedKey } from '@/lib/db/accountKeys'
import { mintInvite } from '@/lib/invite/tokens'
import { formatRows, runQuery } from '@/scripts/platform-query'

const REPO = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'platform-query.ts')

let dir: string
let target: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-platform-query-'))
  target = join(dir, 'platform.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a small, loudly-fake platform database and hand back its path.
 *
 * 'devtwo' is registered through the same two inserts a real invite
 * acceptance makes (account + wrapped account_keys row, CLAUDE.md > Two
 * databases per user), so the "enveloped=1" the runbook's prose promises is
 * actually true of this fixture, not just of the query's shape.
 *
 * A SECOND slug of each kind ('decoyfriend' / 'devone', both revoked/
 * unenveloped, the opposite of the first) is seeded too, so a test asserting
 * `--param` filtered to 'friendtest' or 'devtwo' is proving exclusion of a
 * real other row — not merely that the query happened to return one row
 * because only one existed.
 */
async function seed(): Promise<string> {
  const db = openPlatformDb(target)
  try {
    mintInvite(db, { slug: 'friendtest', at: 1_000 })
    mintInvite(db, { slug: 'decoyfriend', at: 1_000 })
    const accountId = await createAccount(db, {
      slug: 'devtwo',
      role: 'user',
      password: 'TEST-NOT-REAL',
    })
    putWrappedKey(db, accountId, Buffer.from('TEST-WRAPPED-KEY'), 1_000)
    await createAccount(db, {
      slug: 'devone',
      role: 'user',
      password: 'TEST-NOT-REAL-EITHER',
    })
  } finally {
    db.close()
  }
  return target
}

/** Run the script as a real subprocess, the way Nico types it over ssh. */
function runScript(
  args: string[],
  env: Record<string, string | undefined> = {},
): { status: number; output: string } {
  const cleanEnv = { ...process.env }
  delete cleanEnv.PLATFORM_DB
  try {
    const output = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      cwd: REPO,
      env: { ...cleanEnv, ...env },
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

describe('runQuery / formatRows (unit)', () => {
  let db: PlatformDb

  afterEach(() => {
    db?.close()
  })

  it('returns rows from a SELECT against a temp database', async () => {
    await seed()
    db = new Database(target, { readonly: true, fileMustExist: true })
    const rows = runQuery(
      db,
      'SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites ORDER BY slug',
    )
    // Both seeded invites, unfiltered.
    expect(rows).toEqual([
      { slug: 'decoyfriend', used: 0, revoked: 0 },
      { slug: 'friendtest', used: 0, revoked: 0 },
    ])
  })

  it('binds a `?` placeholder to a --param value, filtering to one row', async () => {
    await seed()
    db = new Database(target, { readonly: true, fileMustExist: true })
    const rows = runQuery(
      db,
      'SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites WHERE slug = ?',
      ['friendtest'],
    )
    // 'decoyfriend' from the same seed proves this is a real filter, not a
    // coincidence of only one row existing.
    expect(rows).toEqual([{ slug: 'friendtest', used: 0, revoked: 0 }])
  })

  it('is genuinely read-only: an INSERT throws rather than succeeding', async () => {
    await seed()
    db = new Database(target, { readonly: true, fileMustExist: true })
    expect(() =>
      runQuery(db, "INSERT INTO invites (slug, token_sha, created_at) VALUES ('x', 'y', 0)"),
    ).toThrow(/readonly/i)

    // The attempted write really did not land — checked from a fresh,
    // separate WRITABLE handle, not trusted from the throw alone.
    const verify = openPlatformDb(target)
    try {
      const row = verify.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }
      expect(row.n).toBe(2) // the two invites seeded above, unchanged
    } finally {
      verify.close()
    }
  })

  it('formats rows as key=value, one row per block', () => {
    expect(formatRows([{ slug: 'a', used: 1 }, { slug: 'b', used: 0 }])).toBe(
      'slug=a\nused=1\n\nslug=b\nused=0',
    )
  })

  it('formats zero rows explicitly rather than printing nothing', () => {
    expect(formatRows([])).toBe('(0 rows)')
  })
})

describe('scripts/platform-query.ts (subprocess)', () => {
  it('prints usage and exits non-zero with no SQL argument', () => {
    const { status, output } = runScript([], { PLATFORM_DB: target })
    expect(status).not.toBe(0)
    expect(output).toContain('usage:')
  })

  it('refuses to run when PLATFORM_DB is not set', () => {
    const { status, output } = runScript(['SELECT 1'])
    expect(status).not.toBe(0)
    expect(output).toContain('PLATFORM_DB is not set')
  })

  it('never falls back to synthetic.db even when PLATFORM_DB is empty string', () => {
    const { status, output } = runScript(['SELECT 1'], { PLATFORM_DB: '' })
    expect(status).not.toBe(0)
    expect(output).toContain('PLATFORM_DB is not set')
  })

  it('runs the exact query the runbook uses to verify an invite landed, filtered to one slug', async () => {
    await seed()
    const { status, output } = runScript(
      [
        'SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites WHERE slug = ?;',
        '--param',
        'friendtest',
      ],
      { PLATFORM_DB: target },
    )
    expect(status).toBe(0)
    // Exactly one row — 'decoyfriend' from the same seed is excluded, proving
    // the filter, not just the query shape.
    expect(output.trim()).toBe('slug=friendtest\nused=0\nrevoked=0')
  })

  it('runs the exact query the runbook uses to verify an account is enveloped, filtered to one slug', async () => {
    await seed()
    const { status, output } = runScript(
      [
        'SELECT a.slug, k.account_id IS NOT NULL AS enveloped FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id WHERE a.slug = ?;',
        '--param',
        'devtwo',
      ],
      { PLATFORM_DB: target },
    )
    expect(status).toBe(0)
    // 'devone' (unenveloped) from the same seed is excluded by the filter.
    expect(output.trim()).toBe('slug=devtwo\nenveloped=1')
  })

  it('the $FRIEND slot in the runbook is safe to splice unquoted into the ssh command', async () => {
    // Simulates exactly what docs/runbook.md sends: the SQL in single quotes,
    // `--param $FRIEND` unquoted after it, all inside one double-quoted
    // string a local shell would hand to `ssh`. Run through `bash -c` here
    // instead of an actual ssh round trip, which is untestable by design
    // (CLAUDE.md > Testing).
    await seed()
    const friend = 'devtwo'
    const remoteCommand =
      `PLATFORM_DB='${target}' npx tsx ${SCRIPT} ` +
      `'SELECT a.slug, k.account_id IS NOT NULL AS enveloped FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id WHERE a.slug = ?;' --param ${friend}`
    const output = execFileSync('bash', ['-c', remoteCommand], { encoding: 'utf8' })
    expect(output.trim()).toBe('slug=devtwo\nenveloped=1')
  })

  it('reads the SQL from a file with --file, for a query with an apostrophe', async () => {
    await seed()
    const sqlFile = join(dir, 'query.sql')
    writeFileSync(sqlFile, "SELECT slug FROM accounts WHERE slug = 'devtwo'")
    const { status, output } = runScript(['--file', sqlFile], { PLATFORM_DB: target })
    expect(status).toBe(0)
    expect(output.trim()).toBe('slug=devtwo')
  })

  it('rejects a write attempted from the CLI', async () => {
    await seed()
    const { status, output } = runScript(
      ["INSERT INTO invites (slug, token_sha, created_at) VALUES ('x', 'y', 0)"],
      { PLATFORM_DB: target },
    )
    expect(status).not.toBe(0)
    expect(output.toLowerCase()).toContain('readonly')
  })
})
