import { hash, verify, Algorithm } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'

/**
 * One password, two derivations, two salts.
 *
 * auth_hash verifies the login and is stored. db_key unlocks the user's
 * SQLCipher database and is NEVER stored — it exists only in the in-process
 * TTL map (CLAUDE.md > Data safety). The salts differ so that the stored
 * verifier gets an attacker no closer to the key.
 */

const OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export function newSalts(): { saltAuth: Buffer; saltKey: Buffer } {
  return { saltAuth: randomBytes(16), saltKey: randomBytes(16) }
}

export async function hashPassword(
  password: string,
  saltAuth: Buffer,
): Promise<string> {
  return hash(password, { ...OPTS, salt: saltAuth })
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password)
  } catch {
    return false
  }
}

export async function deriveDbKey(
  password: string,
  saltKey: Buffer,
): Promise<Buffer> {
  const encoded = await hash(password, { ...OPTS, salt: saltKey })
  // The encoded form is `$argon2id$...$<salt>$<hash>`; take the raw digest.
  const digest = encoded.slice(encoded.lastIndexOf('$') + 1)
  return Buffer.from(digest, 'base64').subarray(0, 32)
}
