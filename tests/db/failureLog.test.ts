// tests/db/failureLog.test.ts
//
// A policy test, mirroring the metrics leak test in
// tests/routing/dashboardRegion.test.ts: it plants an obviously-fake account
// number in the error and asserts it reaches the log NOWHERE. The metrics
// column and stderr are different sinks with the same rule — CLAUDE.md's hard
// rule covers debug output as well as storage — and this is the one that is
// easy to relax by accident, because adding `error.message` to a log line
// looks like an improvement.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logDbFailure } from '@/lib/db/failureLog'

function capture(fn: () => void): string {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('logDbFailure', () => {
  it('carries the event, the slug, and the error NAME and CODE', () => {
    // Name and code are what let an operator tell a permissions failure from a
    // corrupt file — the whole reason this exists, since `kind` is a closed
    // two-value set and deliberately stays that way.
    const error = Object.assign(new Error('whatever'), { code: 'SQLITE_READONLY' })
    const out = capture(() => logDbFailure('dashboard_error', 'devtwo', error))

    expect(out).toContain('dashboard_error')
    expect(out).toContain('devtwo')
    expect(out).toContain('Error')
    expect(out).toContain('SQLITE_READONLY')
  })

  it('distinguishes the failures it exists to distinguish', () => {
    // Not a shape assertion: these are the actual codes the droplet will see,
    // and the point is that the log tells them apart at all.
    const cases = [
      ['SQLITE_READONLY', 'a permissions failure'],
      ['SQLITE_NOTADB', 'a corrupt file or a wrong key'],
      ['SQLITE_FULL', 'a full disk'],
      ['SQLITE_BUSY', 'a lock held too long'],
      ['SQLITE_ERROR', 'a missing table — the shape a frozen schema takes'],
    ] as const

    const seen = cases.map(([code]) =>
      capture(() =>
        logDbFailure('dashboard_write_error', 'devtwo', Object.assign(new Error('x'), { code })),
      ),
    )
    expect(new Set(seen).size).toBe(cases.length)
  })

  it('NEVER logs the error message, even when it carries a value', () => {
    // The catch this feeds also receives whatever a per-user dashboard
    // component threw, and that is the least-reviewed code in the repo — free
    // to put a row value in an Error it constructs. Measured against this
    // driver, SQLite's own messages do not interpolate bound parameters, so
    // logging them would have been safe; the cheap win is declined so the same
    // discipline holds at both sinks.
    const error = new Error('REAL ACCOUNT NUMBER 4111 5551 2222 TEST')
    const out = capture(() => logDbFailure('dashboard_error', 'devtwo', error))

    expect(out).not.toContain('4111')
    expect(out).not.toContain('REAL ACCOUNT NUMBER')
    expect(out).not.toContain('TEST')
  })

  it('names a WrongKeyError as itself', () => {
    class WrongKeyError extends Error {
      constructor() {
        super('nope')
        this.name = 'WrongKeyError'
      }
    }
    const out = capture(() => logDbFailure('dashboard_error', 'devtwo', new WrongKeyError()))
    expect(out).toContain('WrongKeyError')
  })

  it('does not throw on a non-Error throwable', () => {
    // `catch (error)` receives whatever was thrown, including a string, and a
    // logger that throws inside a catch block turns a degraded page into a 500.
    expect(() => capture(() => logDbFailure('dashboard_error', 'devtwo', 'a string'))).not.toThrow()
    expect(() => capture(() => logDbFailure('dashboard_error', 'devtwo', undefined))).not.toThrow()
    expect(() => capture(() => logDbFailure('dashboard_error', 'devtwo', null))).not.toThrow()
  })
})
