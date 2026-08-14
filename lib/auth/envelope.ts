// lib/auth/envelope.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The password no longer IS the database key; it unwraps one.
 *
 * Before this, `deriveDbKey(password, salt_key)` was handed straight to
 * SQLCipher, which meant the password could never change without re-encrypting
 * the whole file. Now that derivation produces a key-encrypting key (KEK), and
 * the 32 bytes SQLCipher actually sees are random, generated once at
 * registration, and stored wrapped in `account_keys` (onboarding ledger D2).
 *
 * AES-256-GCM from node:crypto — no dependency, and AUTHENTICATED, which
 * matters more than it looks. An unauthenticated mode would hand back
 * plausible-looking bytes for a wrong password; SQLCipher would then report
 * "file is not a database", and a friend who mistyped their password would be
 * told their data was corrupt. lib/db/encryptedUserDb.ts has a whole class
 * (WrongKeyError) devoted to drawing that distinction one layer down, where it
 * is hard. Here it is free.
 *
 * Layout: [12-byte IV][16-byte tag][ciphertext]. Fixed-width prefixes, so
 * parsing is slicing and there is no length field to get wrong.
 *
 * NEITHER KEY IS EVER LOGGED, and no error below carries bytes or lengths.
 * CLAUDE.md > Data safety: keys are never serialized, persisted, or logged —
 * the wrapped key is the single exception, and it is wrapped.
 */

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class WrappedKeyError extends Error {
  constructor() {
    // No account id, no byte counts, nothing that varies with the input: this
    // message reaches a log, and a log is not where key material goes. It is
    // also deliberately identical for a wrong key and a malformed buffer —
    // see unwrapDataKey.
    super('wrapped key did not open with this key')
    this.name = 'WrappedKeyError'
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function wrapDataKey(kek: Buffer, dataKey: Buffer): Buffer {
  // A fresh IV per wrap. Without it, two accounts that chose the same password
  // would produce byte-identical rows in an unencrypted database — which would
  // tell anyone reading platform.db that two people share a password.
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const body = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function unwrapDataKey(kek: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length <= IV_BYTES + TAG_BYTES) throw new WrappedKeyError()
  const iv = wrapped.subarray(0, IV_BYTES)
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = wrapped.subarray(IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // A failed tag check is the only interesting outcome, and it is
    // deliberately NOT distinguished from a malformed buffer: both mean "this
    // password does not open this account", and telling them apart tells a
    // caller nothing it can act on while telling an attacker something.
    throw new WrappedKeyError()
  }
}
