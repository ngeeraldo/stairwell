// tests/invite/tokens.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import {
  consumeInvite,
  mintInvite,
  readInvite,
  revokeInvite,
  tokenSha,
} from '@/lib/invite/tokens'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-invites-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A real account id, because `invites.account_id` is a REAL foreign key and
 * SQLite checks it immediately.
 *
 * That constraint is load-bearing rather than incidental, and it decided the
 * ordering inside lib/invite/register.ts: the account must EXIST before its
 * invite can be marked used, so the transaction there runs createAccount
 * first and rolls back when consumeInvite returns false. A fixture that passed
 * a fake id would have hidden that until the registration route was written.
 */
async function realAccount(slug: string): Promise<number> {
  return createAccount(db, { slug, role: 'user', password: 'TEST-NOT-A-REAL-PASSWORD' })
}

describe('minting', () => {
  it('returns a token that reads back as valid, carrying its slug', () => {
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    expect(readInvite(db, token)).toMatchObject({ kind: 'valid', slug: 'friendone' })
  })

  it('does not store the token — only its hash', () => {
    // onboarding ledger D11. platform.db is unencrypted and invites never
    // expire, so a stored token would be a permanent bearer credential to
    // create an account. Asserted against the WHOLE ROW rather than the one
    // column, so a future column that happened to carry it would fail here.
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    const row = db.prepare('SELECT * FROM invites').get() as Record<string, unknown>
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row.token_sha).toBe(tokenSha(token))
    expect(String(row.token_sha)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a reserved slug at MINT time, not at use time', () => {
    // The whole reason this check lives here: Nico finds out he typed a route
    // name in the ten seconds he spends minting, not while his friend is
    // standing in a kitchen trying to use the link.
    for (const slug of ['admin', 'login', 'invite', 'forgot', 'mockup', 'api']) {
      expect(() => mintInvite(db, { slug, at: 1000 })).toThrow(/reserved for a route/)
    }
  })

  it('rejects a slug that could never be an account', () => {
    for (const slug of ['Friend One', 'friend_one', '', 'a'.repeat(33), '../etc']) {
      expect(() => mintInvite(db, { slug, at: 1000 })).toThrow(/invalid slug/)
    }
  })

  it('rejects a slug an account already holds', async () => {
    await createAccount(db, { slug: 'devtwo', role: 'user', password: 'TEST-NOT-REAL' })
    expect(() => mintInvite(db, { slug: 'devtwo', at: 1000 })).toThrow(/already has it/)
  })

  it('rejects a second invite for the same slug', () => {
    mintInvite(db, { slug: 'friendone', at: 1000 })
    expect(() => mintInvite(db, { slug: 'friendone', at: 2000 })).toThrow()
  })
})

describe('reading', () => {
  it('reads an unknown token as invalid', () => {
    expect(readInvite(db, 'not-a-token-that-was-ever-minted')).toEqual({ kind: 'invalid' })
  })

  it('reads a revoked invite as invalid', () => {
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    revokeInvite(db, { slug: 'friendone', at: 2000 })
    expect(readInvite(db, token)).toEqual({ kind: 'invalid' })
  })

  it('reads a used invite as invalid', async () => {
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    consumeInvite(db, { token, accountId: await realAccount('friendone'), at: 2000 })
    expect(readInvite(db, token)).toEqual({ kind: 'invalid' })
  })

  it('reports used, revoked and unknown IDENTICALLY, to the byte', async () => {
    // The spec: "No distinction shown between 'used' and 'unknown' — same
    // message for both (leaks nothing, and the fix is identical: text Nico)."
    // Asserted on the VALUE rather than on the rendered page, because the type
    // is where the guarantee lives — a renderer can be rewritten, and the
    // thing that must not leak is upstream of it.
    const used = mintInvite(db, { slug: 'usedone', at: 1000 })
    consumeInvite(db, { token: used, accountId: await realAccount('usedone'), at: 1001 })
    const revoked = mintInvite(db, { slug: 'revokedone', at: 1000 })
    revokeInvite(db, { slug: 'revokedone', at: 1001 })

    const results = [readInvite(db, used), readInvite(db, revoked), readInvite(db, 'nope')]
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1)
  })
})

describe('consuming', () => {
  it('consumes exactly once, even when two requests race', async () => {
    // THE SPEC'S NAMED RED-TEST: "used token cannot re-register gets a test
    // that goes red when the guard is deleted."
    //
    // The guard being tested is the `used_at IS NULL` in the UPDATE's own
    // WHERE clause. A read-then-write would let both callers see an unused
    // invite; accounts.slug is UNIQUE, so the loser would 500 AFTER consuming
    // a token that can never be reissued.
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    const winner = await realAccount('friendone')
    const loser = await realAccount('someoneelse')

    const first = consumeInvite(db, { token, accountId: winner, at: 2000 })
    const second = consumeInvite(db, { token, accountId: loser, at: 3000 })

    expect([first, second]).toEqual([true, false])
    // The winner's id, not the loser's: a losing UPDATE must not overwrite
    // the record of who actually claimed the link.
    expect(db.prepare('SELECT used_at, account_id FROM invites').get()).toMatchObject({
      used_at: 2000,
      account_id: winner,
    })
  })

  it('refuses to consume a revoked invite', async () => {
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    revokeInvite(db, { slug: 'friendone', at: 1500 })
    const id = await realAccount('friendone')
    expect(consumeInvite(db, { token, accountId: id, at: 2000 })).toBe(false)
  })

  it('refuses to consume an unknown token', async () => {
    expect(
      consumeInvite(db, { token: 'nope', accountId: await realAccount('friendone'), at: 2000 }),
    ).toBe(false)
  })
})

describe('revoking', () => {
  it('reports whether there was anything to revoke', () => {
    mintInvite(db, { slug: 'friendone', at: 1000 })
    expect(revokeInvite(db, { slug: 'friendone', at: 2000 })).toBe(true)
    expect(revokeInvite(db, { slug: 'nobody', at: 2000 })).toBe(false)
  })

  it('will not revoke an invite that was already used', async () => {
    // Revoking a used invite would be a lie: the account exists, and this row
    // is the record of how it came to.
    const token = mintInvite(db, { slug: 'friendone', at: 1000 })
    consumeInvite(db, { token, accountId: await realAccount('friendone'), at: 1500 })
    expect(revokeInvite(db, { slug: 'friendone', at: 2000 })).toBe(false)
    expect(
      (db.prepare('SELECT revoked_at FROM invites').get() as { revoked_at: number | null })
        .revoked_at,
    ).toBeNull()
  })
})
