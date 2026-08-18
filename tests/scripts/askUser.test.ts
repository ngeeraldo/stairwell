// tests/scripts/askUser.test.ts
//
// No test file for scripts/ask-user.ts existed before this one — the
// unified-loop ledger already flagged that as a residual risk ("writes to an
// append-only transcript with zero tests"). Written now alongside the fix
// for the PLATFORM_DB fallback: ask-user.ts used to fall back to
// platform/dev/synthetic.db when PLATFORM_DB was unset, which on the
// droplet would post a question into a synthetic account instead of the
// friend's real chat — silently, while Nico believed it was asked. It now
// refuses instead; these tests cover both the function and the real CLI
// subprocess, the split tests/scripts/exportSpec.test.ts and
// tests/scripts/inviteCli.test.ts use for their own scripts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { readTranscript } from '@/lib/db/appendOnly'
import { askUser } from '@/scripts/ask-user'

const REPO = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'ask-user.ts')

let dir: string
let db: PlatformDb
let accountId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-ask-user-'))
  db = openPlatformDb(join(dir, 'platform.db'))
  accountId = await createAccount(db, {
    slug: 'clitest',
    role: 'user',
    password: 'TEST-ASK-USER',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('askUser (function)', () => {
  it('posts the question into the account transcript', () => {
    askUser(db, 'clitest', 'Streak reset on a missed day, or just pause? TEST')
    const rows = readTranscript(db, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toBe('Streak reset on a missed day, or just pause? TEST')
  })

  it('refuses an unknown slug, naming it', () => {
    expect(() => askUser(db, 'ghost', 'Anything? TEST')).toThrow(/no account with slug 'ghost'/)
  })
})

/**
 * The CLI wrapper, as a real subprocess — the command Nico actually types
 * over ssh at runbook step 4.
 */
describe('scripts/ask-user.ts (CLI)', () => {
  function run(
    args: string[],
    env: Record<string, string | undefined> = {},
  ): { status: number; output: string } {
    // Child env built from a CLONE of process.env — the real process.env is
    // never touched, so nothing here can leak PLATFORM_DB into another test
    // file sharing this worker.
    const childEnv = { ...process.env, ...env }
    if (!('PLATFORM_DB' in env)) delete childEnv.PLATFORM_DB
    try {
      const output = execFileSync('npx', ['tsx', SCRIPT, ...args], {
        cwd: REPO,
        env: childEnv,
        stdio: 'pipe',
        encoding: 'utf8',
      })
      return { status: 0, output }
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string }
      return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
    }
  }

  it('prints usage and exits non-zero with no arguments', () => {
    const { status, output } = run([], { PLATFORM_DB: join(dir, 'platform.db') })
    expect(status).not.toBe(0)
    expect(output).toContain('usage:')
  })

  it('refuses to run when PLATFORM_DB is not set', () => {
    const { status, output } = run(['clitest', 'A question? TEST'])
    expect(status).not.toBe(0)
    expect(output).toContain('PLATFORM_DB is not set')
  })

  it('refuses even when PLATFORM_DB is an explicit empty string', () => {
    const { status, output } = run(['clitest', 'A question? TEST'], { PLATFORM_DB: '' })
    expect(status).not.toBe(0)
    expect(output).toContain('PLATFORM_DB is not set')
  })

  it('posts the question and reports it, once PLATFORM_DB is set', () => {
    const target = join(dir, 'platform.db')
    const { status, output } = run(['clitest', 'A real question? TEST'], { PLATFORM_DB: target })
    expect(status).toBe(0)
    expect(output.trim()).toBe("posted to 'clitest'")

    const rows = readTranscript(db, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toBe('A real question? TEST')
  })
})
