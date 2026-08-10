// tests/auth/password.test.ts
import { describe, expect, it } from 'vitest'
import {
  deriveDbKey,
  hashPassword,
  newSalts,
  verifyPassword,
} from '@/lib/auth/password'

describe('password derivations', () => {
  it('verifies a correct password', async () => {
    const { saltAuth } = newSalts()
    const hash = await hashPassword('correct horse', saltAuth)
    expect(await verifyPassword(hash, 'correct horse')).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const { saltAuth } = newSalts()
    const hash = await hashPassword('correct horse', saltAuth)
    expect(await verifyPassword(hash, 'wrong horse')).toBe(false)
  })

  it('derives a 32-byte key', async () => {
    const { saltKey } = newSalts()
    const key = await deriveDbKey('correct horse', saltKey)
    expect(key).toHaveLength(32)
  })

  it('derives the same key for the same password and salt', async () => {
    const { saltKey } = newSalts()
    const a = await deriveDbKey('correct horse', saltKey)
    const b = await deriveDbKey('correct horse', saltKey)
    expect(a.equals(b)).toBe(true)
  })

  it('uses different salts, so the key is not recoverable from the hash', async () => {
    const { saltAuth, saltKey } = newSalts()
    expect(saltAuth.equals(saltKey)).toBe(false)

    const hash = await hashPassword('correct horse', saltAuth)
    const key = await deriveDbKey('correct horse', saltKey)

    // The stored verifier must not contain the key material in any form.
    expect(hash).not.toContain(key.toString('hex'))
    expect(hash).not.toContain(key.toString('base64'))
  })

  it('gives different salts on every call', () => {
    const a = newSalts()
    const b = newSalts()
    expect(a.saltAuth.equals(b.saltAuth)).toBe(false)
    expect(a.saltKey.equals(b.saltKey)).toBe(false)
  })
})
