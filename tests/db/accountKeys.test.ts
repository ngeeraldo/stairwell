// tests/db/accountKeys.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { putWrappedKey, readWrappedKey } from '@/lib/db/accountKeys'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-acctkeys-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function account(slug: string): Promise<number> {
  return createAccount(db, { slug, role: 'user', password: 'TEST-NOT-A-REAL-PASSWORD' })
}

describe('account_keys', () => {
  it('stores and reads back the exact bytes', async () => {
    const id = await account('friendone')
    const wrapped = Buffer.from('wrapped-bytes-not-a-real-key')
    putWrappedKey(db, id, wrapped, 1000)
    expect(readWrappedKey(db, id)).toEqual(wrapped)
  })

  it('returns undefined for an account with no row — the legacy arm', async () => {
    // devone, devtwo and nico are this. The arm is permanent (onboarding
    // ledger D2) and undefined is how every caller learns it applies.
    const id = await account('legacyone')
    expect(readWrappedKey(db, id)).toBeUndefined()
  })

  it('replaces rather than throwing on a second write', async () => {
    // A password change — not built here, but the entire reason the
    // indirection exists — is this call with a new KEK and the same data key.
    // account_id is the PRIMARY KEY, so without the upsert it would throw.
    const id = await account('friendtwo')
    putWrappedKey(db, id, Buffer.from('first'), 1000)
    putWrappedKey(db, id, Buffer.from('second'), 2000)
    expect(readWrappedKey(db, id)).toEqual(Buffer.from('second'))
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM account_keys WHERE account_id = ?')
      .get(id) as { n: number }
    expect(n).toBe(1)
  })

  it('keeps accounts separate', async () => {
    const one = await account('friendone')
    const two = await account('friendtwo')
    putWrappedKey(db, one, Buffer.from('one'), 1000)
    expect(readWrappedKey(db, two)).toBeUndefined()
  })

  it('goes away with its account, so a deletion leaves no orphan key', async () => {
    // Deletion is `rm` for the encrypted file (architecture-overview.md
    // section 2). The wrapped key must not outlive the account it opens.
    const id = await account('friendone')
    putWrappedKey(db, id, Buffer.from('bytes'), 1000)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    expect(readWrappedKey(db, id)).toBeUndefined()
  })
})
