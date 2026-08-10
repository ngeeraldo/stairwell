import { hash, hashRaw, verify } from '@node-rs/argon2'
import type { Algorithm } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'

/**
 * One password, two derivations, two salts.
 *
 * auth_hash verifies the login and is stored. db_key unlocks the user's
 * SQLCipher database and is NEVER stored — it exists only in the in-process
 * TTL map (CLAUDE.md > Data safety). The salts differ so that the stored
 * verifier gets an attacker no closer to the key.
 */

// `Algorithm` is an ambient `const enum` in @node-rs/argon2's typings, and
// this project has `isolatedModules: true` (tsconfig.json), so it cannot be
// referenced as a value (TS2748). Pin the numeric value directly — Argon2id
// is enum value 2 — via a type-only import plus a cast, so the algorithm
// stays explicitly, verifiably Argon2id rather than falling back silently
// to the library default.
const ARGON2ID = 2 as Algorithm

const OPTS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
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
  return hashRaw(password, { ...OPTS, salt: saltKey, outputLen: 32 })
}
