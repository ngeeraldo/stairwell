// tests/session/store.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { checkPassword, createAccount, findAccountBySlug } from '@/lib/auth/accounts'
import {
  COOKIE_OPTIONS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  destroySession,
  readSession,
} from '@/lib/session/store'
import { getKey, putKey } from '@/lib/session/keymap'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-sess-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('accounts', () => {
  it('stores a verifier and two distinct salts', async () => {
    await createAccount(db, { slug: 'nico', role: 'admin', password: 'pw' })
    const account = findAccountBySlug(db, 'nico')
    expect(account).toBeDefined()
    expect(account!.salt_auth.equals(account!.salt_key)).toBe(false)
  })

  it('never stores the password', async () => {
    await createAccount(db, { slug: 'nico', role: 'user', password: 'hunter2' })
    const row = JSON.stringify(findAccountBySlug(db, 'nico'))
    expect(row).not.toContain('hunter2')
  })

  it('checkPassword verifies a correct password', async () => {
    await createAccount(db, { slug: 'nico', role: 'user', password: 'hunter2' })
    const account = findAccountBySlug(db, 'nico')!
    expect(await checkPassword(account, 'hunter2')).toBe(true)
  })

  it('checkPassword rejects a wrong password', async () => {
    await createAccount(db, { slug: 'nico', role: 'user', password: 'hunter2' })
    const account = findAccountBySlug(db, 'nico')!
    expect(await checkPassword(account, 'wrong-password')).toBe(false)
  })
})

describe('sessions', () => {
  it('round-trips a session', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    expect(readSession(db, sid)?.account_id).toBe(id)
  })

  it('returns undefined for an expired session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    vi.setSystemTime(SESSION_TTL_MS + 1)
    expect(readSession(db, sid)).toBeUndefined()
  })

  it('drops the key when the session expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 9))
    // Do NOT advance the clock by SESSION_TTL_MS (30 days) to reach expiry:
    // that also blows past the keymap's own internal TTLs (4h idle / 12h
    // absolute, lib/session/keymap.ts), so getKey(sid) would already be
    // undefined from the keymap's OWN expiry regardless of whether
    // readSession drops it — non-diagnostic by construction, since
    // ABSOLUTE_TTL_MS << SESSION_TTL_MS. Force the session row itself past
    // its expiry directly instead, with the clock left at t=0 so the
    // keymap entry stays alive under its own rules. This isolates exactly
    // the behavior under test: whether readSession's expiry branch drops
    // the key.
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(-1, sid)
    expect(readSession(db, sid)).toBeUndefined()
    expect(getKey(sid)).toBeUndefined()
  })

  it('never writes key material into the sessions table', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    const key = Buffer.alloc(32, 9)
    putKey(sid, key)
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<
      string,
      unknown
    >[]
    const row = JSON.stringify(rows)
    expect(row).not.toContain(key.toString('hex'))
    expect(row).not.toContain('key')

    // JSON.stringify renders a Buffer/Uint8Array as {"type":"Buffer","data":[...]}
    // with no hex or base64 substring anywhere, so the two assertions above
    // would sail past a key stored as a BLOB column. Check the actual row
    // values directly, in every representation the key could plausibly take.
    const keyHex = key.toString('hex')
    const keyBase64 = key.toString('base64')
    // Buffer's own toJSON() renders as {"type":"Buffer","data":[9,9,...]} —
    // a decimal-byte-sequence representation with no hex/base64 substring,
    // so a key serialized this way into a TEXT column would escape every
    // check above it.
    const keyJson = JSON.stringify(key)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      for (const value of Object.values(r)) {
        if (value instanceof Uint8Array) {
          expect(Buffer.from(value).equals(key)).toBe(false)
        } else if (typeof value === 'string') {
          expect(value).not.toBe(keyHex)
          expect(value).not.toBe(keyBase64)
          expect(value).not.toContain(keyHex)
          expect(value).not.toContain(keyBase64)
          expect(value).not.toBe(keyJson)
          expect(value).not.toContain(keyJson)
        }
      }
    }
  })

  it('drops the key when the session is destroyed', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 9))
    destroySession(db, sid)
    expect(getKey(sid)).toBeUndefined()
    expect(readSession(db, sid)).toBeUndefined()
  })

  it('issues unpredictable session ids', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const ids = new Set(
      Array.from({ length: 50 }, () => createSession(db, id)),
    )
    expect(ids.size).toBe(50)
    for (const sid of ids) expect(sid.length).toBeGreaterThanOrEqual(32)
  })

  it('sets security-critical cookie flags', () => {
    expect(COOKIE_OPTIONS.httpOnly).toBe(true)
    expect(COOKIE_OPTIONS.secure).toBe(true)
    expect(COOKIE_OPTIONS.sameSite).toBe('lax')
    expect(COOKIE_OPTIONS.path).toBe('/')
    expect(COOKIE_OPTIONS.maxAge).toBe(SESSION_TTL_MS / 1000)
  })

  it('pins the session TTL to 30 days', () => {
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('pins the session cookie name', () => {
    expect(SESSION_COOKIE).toBe('stairwell_session')
  })

  it('treats a session at exactly the TTL boundary as already expired', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    vi.setSystemTime(SESSION_TTL_MS)
    expect(readSession(db, sid)).toBeUndefined()
  })

  it('throws on a duplicate slug', async () => {
    await createAccount(db, { slug: 'dupe', role: 'user', password: 'pw' })
    await expect(
      createAccount(db, { slug: 'dupe', role: 'user', password: 'pw2' }),
    ).rejects.toThrow()
  })
})
