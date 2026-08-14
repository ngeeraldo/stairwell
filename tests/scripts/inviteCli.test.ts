// tests/scripts/inviteCli.test.ts
//
// The two operator CLIs, run as real subprocesses against a temp
// PLATFORM_DB — same idiom as tests/scripts/createDevUsers.test.ts, and for
// the same reason: what matters is the behaviour of the command Nico actually
// types on the droplet, not of the function it happens to call.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { consumeInvite, readInvite } from '@/lib/invite/tokens'

const REPO = resolve(__dirname, '..', '..')
const CREATE = join(REPO, 'scripts', 'create-invite.ts')
const REVOKE = join(REPO, 'scripts', 'revoke-invite.ts')

let root: string
let target: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-invite-cli-'))
  target = join(root, 'platform.db')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function run(script: string, args: string[], env: Record<string, string> = {}) {
  try {
    return {
      status: 0,
      output: execFileSync('npx', ['tsx', script, ...args], {
        cwd: REPO,
        env: { ...process.env, PLATFORM_DB: target, ...env },
        stdio: 'pipe',
        encoding: 'utf8',
      }),
    }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

describe('scripts/create-invite.ts', () => {
  it('prints exactly one line: a link that works', () => {
    const { status, output } = run(CREATE, ['friendone'], {
      INVITE_ORIGIN: 'https://example.test',
    })

    expect(status).toBe(0)
    const lines = output.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^https:\/\/example\.test\/invite\/[A-Za-z0-9_-]+$/)

    // The link is not merely well-shaped — the token in it opens the invite.
    const token = lines[0]!.split('/').pop()!
    const db = openPlatformDb(target)
    try {
      expect(readInvite(db, token)).toMatchObject({ kind: 'valid', slug: 'friendone' })
    } finally {
      db.close()
    }
  })

  it('leaves the token nowhere in the database', () => {
    // onboarding ledger D11, asserted end to end rather than at the function
    // boundary: what matters is that the FILE ON THE DROPLET does not hold a
    // credential, whatever the code in between does.
    const { output } = run(CREATE, ['friendone'], { INVITE_ORIGIN: 'https://example.test' })
    const token = output.trim().split('/').pop()!

    const db = openPlatformDb(target)
    try {
      const rows = db.prepare('SELECT * FROM invites').all()
      expect(JSON.stringify(rows)).not.toContain(token)
    } finally {
      db.close()
    }
  })

  it('defaults its origin to production, so a droplet run needs no variable', () => {
    const { output } = run(CREATE, ['friendone'])
    expect(output.trim()).toMatch(/^https:\/\/app\.stairwell\.run\/invite\//)
  })

  it('fails with a sentence, not a stack, on a reserved slug', () => {
    const { status, output } = run(CREATE, ['admin'])
    expect(status).not.toBe(0)
    expect(output).toContain('reserved for a route')
    expect(output).not.toContain('at Object.')
  })

  it('refuses a second invite for the same slug', () => {
    expect(run(CREATE, ['friendone']).status).toBe(0)
    expect(run(CREATE, ['friendone']).status).not.toBe(0)
  })

  it('refuses a slug an account already has', async () => {
    const db = openPlatformDb(target)
    try {
      await createAccount(db, { slug: 'devtwo', role: 'user', password: 'TEST-NOT-REAL' })
    } finally {
      db.close()
    }
    const { status, output } = run(CREATE, ['devtwo'])
    expect(status).not.toBe(0)
    expect(output).toContain('already has it')
  })

  it('says how to call it when called with nothing', () => {
    const { status, output } = run(CREATE, [])
    expect(status).not.toBe(0)
    expect(output).toContain('usage:')
  })
})

describe('scripts/revoke-invite.ts', () => {
  it('revokes an unused invite, which then reads as invalid', () => {
    const { output } = run(CREATE, ['friendone'], { INVITE_ORIGIN: 'https://example.test' })
    const token = output.trim().split('/').pop()!

    const revoked = run(REVOKE, ['friendone'])
    expect(revoked.status).toBe(0)
    expect(revoked.output).toContain('revoked friendone')

    const db = openPlatformDb(target)
    try {
      expect(readInvite(db, token)).toEqual({ kind: 'invalid' })
    } finally {
      db.close()
    }
  })

  it('exits non-zero when there was nothing to revoke', () => {
    // "Nothing happened" is not success when the operator believed they were
    // closing a hole.
    const { status, output } = run(REVOKE, ['nobody'])
    expect(status).not.toBe(0)
    expect(output).toContain('nothing to revoke')
  })

  it('will not revoke an invite that was already used', async () => {
    const { output } = run(CREATE, ['friendone'], { INVITE_ORIGIN: 'https://example.test' })
    const token = output.trim().split('/').pop()!

    const db = openPlatformDb(target)
    try {
      const id = await createAccount(db, {
        slug: 'friendone',
        role: 'user',
        password: 'TEST-NOT-REAL',
      })
      consumeInvite(db, { token, accountId: id, at: Date.now() })
    } finally {
      db.close()
    }

    const { status, output: revokeOutput } = run(REVOKE, ['friendone'])
    expect(status).not.toBe(0)
    expect(revokeOutput).toContain('nothing to revoke')
  })
})
