// tests/ui/writeActionStore.test.ts
//
// The grouping rule, tested directly rather than through a component: two
// controls sharing a route must not both be pressable, and two controls on
// DIFFERENT routes must not affect each other (design §3.3).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWriteActionStore,
  beginWrite,
  endWrite,
  isWriteInFlight,
  subscribeToWrites,
} from '@/lib/ui/writeActionStore'

afterEach(() => {
  __resetWriteActionStore()
})

describe('writeActionStore', () => {
  it('reports nothing in flight before any write starts', () => {
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(false)
  })

  it('marks one action in flight and clears it again', () => {
    beginWrite('/api/users/run9/pee')
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(true)
    endWrite('/api/users/run9/pee')
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(false)
  })

  it('KEYS ON THE ACTION URL: a different route is untouched', () => {
    // The whole point of the ruling. A friend with a habit panel and a weight
    // panel must not have weight lock while a habit tap is in flight.
    beginWrite('/api/users/run9/pee')
    expect(isWriteInFlight('/api/users/run9/weight')).toBe(false)
  })

  it('notifies subscribers on begin and on end', () => {
    const listener = vi.fn()
    subscribeToWrites(listener)
    beginWrite('/api/users/run9/pee')
    expect(listener).toHaveBeenCalledTimes(1)
    endWrite('/api/users/run9/pee')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToWrites(listener)
    unsubscribe()
    beginWrite('/api/users/run9/pee')
    expect(listener).not.toHaveBeenCalled()
  })
})
