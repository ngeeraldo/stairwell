// tests/invite/register.test.ts
//
// S2's submit — the single most consequential operation in the product. It
// creates the account, the key that opens the friend's data forever, and the
// file that key opens, and it spends a link that can never be reissued.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { deriveDbKey } from '@/lib/auth/password'
import { readWrappedKey } from '@/lib/db/accountKeys'
import {
  encryptedUserDbHasTables,
  encryptedUserDbPath,
  openEncryptedUserDb,
  WrongKeyError,
} from '@/lib/db/encryptedUserDb'
import { getKey } from '@/lib/session/keymap'
import { mintInvite, readInvite } from '@/lib/invite/tokens'
import { registerFromInvite } from '@/lib/invite/register'

const PASSWORD = 'a short sentence works'

let dir: string
let usersDir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-register-'))
  usersDir = join(dir, 'users')
  process.env.USERS_DIR = usersDir
  db = openPlatformDb(join(dir, 'platform.db'))
})

afterEach(() => {
  db.close()
  delete process.env.USERS_DIR
  // Restore any permission the disk-failure test took away, or rmSync cannot
  // clean up after itself.
  try {
    chmodSync(usersDir, 0o755)
  } catch {
    // Never created, which is fine.
  }
  rmSync(dir, { recursive: true, force: true })
})

function mint(slug = 'friendone'): string {
  return mintInvite(db, { slug, at: 1000 })
}

describe('a successful registration', () => {
  it('creates the account, the wrapped key, the session, and the file', async () => {
    const token = mint()
    const result = await registerFromInvite(db, { token, password: PASSWORD, at: 2000 })

    expect(result).toMatchObject({ ok: true, slug: 'friendone' })
    const account = findAccountBySlug(db, 'friendone')
    expect(account).toBeDefined()
    expect(readWrappedKey(db, account!.id)).toBeDefined()
    expect(readInvite(db, token)).toEqual({ kind: 'invalid' })
    expect(existsSync(encryptedUserDbPath('friendone'))).toBe(true)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    ).toBe(1)
  })

  it('gives the session the DATA key, which opens the file — and the derived key does not', async () => {
    // Both halves matter. The first proves the key in the map is usable at
    // all; the second proves the envelope is genuinely in the path rather than
    // being a wrapper around the same bytes (onboarding ledger D2).
    const token = mint()
    const result = await registerFromInvite(db, { token, password: PASSWORD, at: 2000 })
    if (!result.ok) throw new Error('expected success')

    const key = getKey(result.sessionId)!
    expect(key).toBeDefined()
    openEncryptedUserDb('friendone', key, { readonly: true }).close()

    const account = findAccountBySlug(db, 'friendone')!
    const derived = await deriveDbKey(PASSWORD, account.salt_key)
    expect(key).not.toEqual(derived)
    expect(() => openEncryptedUserDb('friendone', derived, { readonly: true })).toThrow(
      WrongKeyError,
    )
  })

  it('leaves the database EMPTY, so the dashboard still reads synthetic', async () => {
    // The state every invited friend is in for days. If this were non-empty
    // the render path would take the real branch and find no tables — see
    // onboarding ledger D3.
    const token = mint()
    const result = await registerFromInvite(db, { token, password: PASSWORD, at: 2000 })
    if (!result.ok) throw new Error('expected success')

    expect(encryptedUserDbHasTables('friendone', getKey(result.sessionId)!)).toBe(false)
  })

  it('logs the friend straight in, so they never type the password twice', async () => {
    const token = mint()
    const result = await registerFromInvite(db, { token, password: PASSWORD, at: 2000 })
    if (!result.ok) throw new Error('expected success')

    const session = db
      .prepare('SELECT account_id FROM sessions WHERE id = ?')
      .get(result.sessionId) as { account_id: number }
    expect(session.account_id).toBe(findAccountBySlug(db, 'friendone')!.id)
  })
})

describe('a spent link', () => {
  it('creates NOTHING the second time', async () => {
    // THE SPEC'S NAMED RED-TEST: "used token cannot re-register."
    //
    // The `used_at` assertion is not decoration. A drill showed that removing
    // consumeInvite entirely leaves the OUTCOME of this test unchanged —
    // accounts.slug is UNIQUE, so the second attempt fails on the constraint
    // and is reported as a spent link anyway. That redundancy is welcome, but
    // it means the outcome alone does not pin the guard the spec names. The
    // consumption itself has to be asserted, or this test would pass against
    // a build with no invite consumption at all.
    const token = mint()
    await registerFromInvite(db, { token, password: PASSWORD, at: 2000 })

    expect(
      (db.prepare('SELECT used_at FROM invites').get() as { used_at: number | null }).used_at,
    ).toBe(2000)

    const before = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
    const second = await registerFromInvite(db, { token, password: 'a different sentence', at: 3000 })

    expect(second).toEqual({ ok: false, reason: 'invalid_token' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual(before)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    ).toBe(1)
  })

  it('creates nothing for a token that never existed', async () => {
    const result = await registerFromInvite(db, {
      token: 'never-minted',
      password: PASSWORD,
      at: 2000,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
    ).toBe(0)
  })
})

describe('a password that is too short', () => {
  it('is rejected server-side, whatever the form allowed', async () => {
    const token = mint()
    const result = await registerFromInvite(db, { token, password: 'nine char', at: 2000 })

    expect(result).toEqual({ ok: false, reason: 'too_short' })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
    ).toBe(0)
    expect(readInvite(db, token)).toMatchObject({ kind: 'valid' })
    expect(existsSync(encryptedUserDbPath('friendone'))).toBe(false)
  })

  it('accepts exactly ten characters', async () => {
    const token = mint()
    expect(
      await registerFromInvite(db, { token, password: '0123456789', at: 2000 }),
    ).toMatchObject({ ok: true })
  })
})

describe('when the file cannot be created', () => {
  it('does NOT consume the token, so the friend can retry', async () => {
    // The spec, in as many words: "All-or-nothing: if DB creation fails, token
    // is NOT consumed; show retry."
    //
    // Induced by making the users root unwritable, which is a real way this
    // fails on a droplet — a permissions mistake or a full disk. The ordering
    // this pins is the whole of ledger D13: the file is built BEFORE any row,
    // so a failure here has touched nothing.
    const token = mint()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(usersDir, { recursive: true })
    chmodSync(usersDir, 0o500)

    const result = await registerFromInvite(db, { token, password: PASSWORD, at: 2000 })

    expect(result).toEqual({ ok: false, reason: 'server' })
    expect(readInvite(db, token)).toMatchObject({ kind: 'valid' })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
    ).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    ).toBe(0)
  })
})

describe('metrics', () => {
  it('are the caller’s job, not this function’s', () => {
    // Stated as a test so the absence reads as a decision. registerFromInvite
    // is called from a route that already knows the device class and has the
    // request headers; threading `next/headers` into a library function to
    // emit two rows would make it unusable from a script or a test.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM metrics').get() as { n: number }).n,
    ).toBe(0)
  })
})
