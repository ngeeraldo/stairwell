import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { login, unlock } from '@/lib/auth/flow'
import { resolveState } from '@/lib/session/resolve'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-flow-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  await createAccount(db, { slug: 'nico', role: 'user', password: 'pw' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('login', () => {
  it('issues a session for correct credentials', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(sid).toBeTruthy()
    expect(resolveState(db, sid!)).toBe('authenticated')
  })

  it('returns null for a wrong password', async () => {
    expect(await login(db, 'nico', 'wrong')).toBeNull()
  })

  it('returns null for an unknown account', async () => {
    expect(await login(db, 'ghost', 'pw')).toBeNull()
  })

  it('leaves the session locked, not unlocked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(resolveState(db, sid!)).not.toBe('unlocked')
  })
})

describe('unlock', () => {
  it('moves an authenticated session to unlocked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(await unlock(db, sid!, 'pw')).toBe(true)
    expect(resolveState(db, sid!)).toBe('unlocked')
  })

  it('rejects a wrong password and stays locked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(await unlock(db, sid!, 'wrong')).toBe(false)
    expect(resolveState(db, sid!)).toBe('authenticated')
  })

  it('rejects an unknown session', async () => {
    expect(await unlock(db, 'nope', 'pw')).toBe(false)
  })
})
