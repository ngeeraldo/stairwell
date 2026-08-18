// tests/chat/heartbeat.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_LINE, HEARTBEAT_MS, startHeartbeat } from '@/lib/chat/heartbeat'

afterEach(() => {
  vi.useRealTimers()
})

describe('startHeartbeat', () => {
  it('beats on the interval until it is stopped', () => {
    vi.useFakeTimers()
    const beat = vi.fn()
    const stop = startHeartbeat({ beat, stopped: () => false, intervalMs: 1000 })

    vi.advanceTimersByTime(3000)
    expect(beat).toHaveBeenCalledTimes(3)

    stop()
    vi.advanceTimersByTime(10_000)
    expect(beat).toHaveBeenCalledTimes(3)
  })

  it('does not beat once stopped() reports the client is gone', () => {
    // The whole point of the guard: enqueueing onto a controller whose client
    // has disconnected throws, and this fires on a timer with no caller to
    // catch it.
    vi.useFakeTimers()
    const beat = vi.fn()
    let gone = false
    startHeartbeat({ beat, stopped: () => gone, intervalMs: 1000 })

    vi.advanceTimersByTime(2000)
    expect(beat).toHaveBeenCalledTimes(2)

    gone = true
    vi.advanceTimersByTime(5000)
    expect(beat).toHaveBeenCalledTimes(2)
  })

  it('swallows a throwing beat rather than raising on the timer', () => {
    // A throw inside a setInterval callback has no caller to catch it: it
    // becomes an unhandled exception and takes the process down. There is no
    // request to fail here — the request is already over.
    vi.useFakeTimers()
    const beat = vi.fn(() => {
      throw new Error('controller is closed')
    })
    startHeartbeat({ beat, stopped: () => false, intervalMs: 1000 })

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
    expect(beat).toHaveBeenCalledTimes(2)
  })

  it('is safe to stop more than once', () => {
    vi.useFakeTimers()
    const beat = vi.fn()
    const stop = startHeartbeat({ beat, stopped: () => false, intervalMs: 1000 })
    stop()
    expect(() => stop()).not.toThrow()
    vi.advanceTimersByTime(5000)
    expect(beat).not.toHaveBeenCalled()
  })

  it('beats well inside the shortest silent window that has been torn down', () => {
    // Not a style assertion. The shortest observed gap between the last byte
    // sent and a client-side teardown was 8.0s (unified-loop ledger D13's
    // table of authoring durations). An interval at or above that would leave
    // the exact window this exists to close.
    expect(HEARTBEAT_MS).toBeLessThan(8_000)
  })

  it('carries no field the panel acts on', () => {
    // app/[user]/ChatPanel.tsx's applyLine dispatches on t/stage/authoring/
    // proposal/proposal_error and returns state untouched for anything else.
    // If a heartbeat ever gained one of those keys it would drive the UI.
    expect(Object.keys(HEARTBEAT_LINE)).toEqual(['hb'])
  })
})
