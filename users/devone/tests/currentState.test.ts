// users/devone/tests/currentState.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCurrentState } from '@/lib/build/currentState'

// Hermetic against an ambient USERS_DIR, same hazard tests/build/notes.test.ts
// guards explicitly: several other test files in this suite set and `delete`
// process.env.USERS_DIR with no try/finally, so a throw between the two leaks
// it for the rest of that worker. Every call below omits the usersDir
// argument on purpose — this file exists to check the ACTUAL committed
// users/devone/current.md, so a leaked USERS_DIR pointing at some other
// worker's temp tree must not be allowed to redirect it there instead.
let ambientUsersDir: string | undefined
beforeEach(() => {
  ambientUsersDir = process.env.USERS_DIR
  delete process.env.USERS_DIR
})
afterEach(() => {
  if (ambientUsersDir === undefined) delete process.env.USERS_DIR
  else process.env.USERS_DIR = ambientUsersDir
})

describe('devone current.md', () => {
  it('parses', () => {
    const state = readCurrentState('devone')
    expect(state).not.toBeNull()
    expect(state!.slug).toBe('devone')
  })

  it('is version 0 — devone predates the spec loop and can never be announced', () => {
    expect(readCurrentState('devone')!.version).toBe(0)
  })

  it('carries no money amounts or merchant names', () => {
    // The same bound notes carry, checked rather than trusted: this file is
    // committed, and devone's dashboard is about spending. A worked example
    // that leaked a value would be copied.
    const body = readCurrentState('devone')!.body
    expect(body).not.toMatch(/\$\d/)
    expect(body).not.toMatch(/COFFEE PALACE/i)
  })
})
