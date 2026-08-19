// users/devtwo/tests/currentState.test.ts
import { describe, expect, it } from 'vitest'
import { readCurrentState } from '@/lib/build/currentState'

describe('devtwo current.md', () => {
  it('parses', () => {
    const state = readCurrentState('devtwo')
    expect(state).not.toBeNull()
    expect(state!.slug).toBe('devtwo')
  })

  it('is version 0 — devtwo predates the spec loop and can never be announced', () => {
    expect(readCurrentState('devtwo')!.version).toBe(0)
  })

  it('carries no logged days', () => {
    // devtwo's data IS days. A date in this file would be one of its rows,
    // and this file is committed — the same bound notes/ carries.
    const body = readCurrentState('devtwo')!.body
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('records that a day cannot be un-marked', () => {
    // The refusal is the load-bearing part of this artifact: without it the
    // agent proposes an undo control that was deliberately never built.
    expect(readCurrentState('devtwo')!.body).toMatch(/Un-marking a day/)
  })
})
