// tests/auth/envelope.test.ts
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  newDataKey,
  unwrapDataKey,
  wrapDataKey,
  WrappedKeyError,
} from '@/lib/auth/envelope'

describe('envelope', () => {
  it('round-trips a data key through a wrap', () => {
    const kek = randomBytes(32)
    const data = newDataKey()
    expect(unwrapDataKey(kek, wrapDataKey(kek, data))).toEqual(data)
  })

  it('produces a different ciphertext every time, for the same inputs', () => {
    // A fresh IV per wrap. Without it, two accounts that chose the same
    // password would produce byte-identical rows in an UNENCRYPTED database —
    // which would tell anyone reading platform.db that two people share a
    // password.
    const kek = randomBytes(32)
    const data = newDataKey()
    expect(wrapDataKey(kek, data)).not.toEqual(wrapDataKey(kek, data))
  })

  it('refuses a wrong key rather than returning wrong bytes', () => {
    // GCM authenticates. Without the tag check this would hand back plausible
    // garbage, SQLCipher would report "file is not a database", and a friend
    // who mistyped their password would be told their data was corrupt.
    const wrapped = wrapDataKey(randomBytes(32), newDataKey())
    expect(() => unwrapDataKey(randomBytes(32), wrapped)).toThrow(WrappedKeyError)
  })

  it('refuses a tampered ciphertext', () => {
    const kek = randomBytes(32)
    const wrapped = wrapDataKey(kek, newDataKey())
    // `!` only satisfies noUncheckedIndexedAccess; wrapDataKey always returns
    // at least IV + tag, so the last byte exists.
    wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1]! ^ 0xff
    expect(() => unwrapDataKey(kek, wrapped)).toThrow(WrappedKeyError)
  })

  it('refuses a truncated buffer without reading past its end', () => {
    expect(() => unwrapDataKey(randomBytes(32), Buffer.alloc(4))).toThrow(WrappedKeyError)
    expect(() => unwrapDataKey(randomBytes(32), Buffer.alloc(0))).toThrow(WrappedKeyError)
  })

  it('makes a data key that is 32 bytes and never repeats', () => {
    expect(newDataKey()).toHaveLength(32)
    expect(newDataKey()).not.toEqual(newDataKey())
  })

  it('never puts key material or byte counts in the error message', () => {
    // The message reaches a log, and a log is not where key material goes
    // (CLAUDE.md > Data safety). It is also identical for a wrong key and a
    // malformed buffer, so it cannot be used to tell those apart.
    const kek = randomBytes(32)
    const messages = new Set<string>()
    for (const attempt of [
      () => unwrapDataKey(randomBytes(32), wrapDataKey(kek, newDataKey())),
      () => unwrapDataKey(kek, Buffer.alloc(4)),
    ]) {
      try {
        attempt()
        throw new Error('should have thrown')
      } catch (error) {
        messages.add((error as Error).message)
      }
    }
    expect([...messages]).toEqual(['wrapped key did not open with this key'])
  })
})
