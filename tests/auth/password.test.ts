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

    // The stored verifier's own digest must not equal the key.
    const digest = Buffer.from(hash.slice(hash.lastIndexOf('$') + 1), 'base64')
    expect(digest.equals(key)).toBe(false)
    // The salt actually changes the derived key.
    expect((await deriveDbKey('correct horse', saltAuth)).equals(key)).toBe(false)
  })

  it('matches a known answer for a fixed password and salt', async () => {
    // Pins algorithm, version, memoryCost, timeCost, parallelism, and
    // outputLen simultaneously: if any library default ever shifts, this
    // fails loudly instead of silently rekeying every user's database.
    // The password is loudly fake and the salt/key here are not secrets.
    const fixedSalt = Buffer.alloc(16, 0x42)
    const key = await deriveDbKey('correct horse', fixedSalt)
    expect(key.toString('hex')).toBe(
      'f947e6e7f8cec5018aaa98bdd372821c55f55dd7c4001c60e604677b1dc8c19a',
    )
  })

  it('gives different salts on every call', () => {
    const a = newSalts()
    const b = newSalts()
    expect(a.saltAuth.equals(b.saltAuth)).toBe(false)
    expect(a.saltKey.equals(b.saltKey)).toBe(false)
  })
})
