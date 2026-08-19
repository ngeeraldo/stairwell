// users/devone/tests/currentState.test.ts
import { describe, expect, it } from 'vitest'
import { readCurrentState } from '@/lib/build/currentState'

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
