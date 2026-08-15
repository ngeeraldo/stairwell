// tests/auth/refuseSession.test.ts
//
// The one exit for a refused session. Its job is small and its ORDER matters:
// the key must be gone before anything that can fail gets a chance to fail.
import { describe, expect, it, vi } from 'vitest'
import { MigrationFailure } from '@/lib/db/migrate'
import { refuseSession, type RefusalAlert } from '@/lib/auth/refuseSession'

function deps() {
  return {
    dropKey: vi.fn((_sessionId: string) => {}),
    log: vi.fn((_event: string, _slug: string, _error: unknown) => {}),
    // Typed with its parameter so the payload assertions below can read
    // mock.calls[0][0] — an untyped vi.fn() makes that a zero-length tuple and
    // the "never leaks the message" test would not compile.
    alert: vi.fn(async (_payload: RefusalAlert) => {}),
  }
}

const failure = (n: number, code: string) => new MigrationFailure(n, code)

describe('refuseSession', () => {
  it('drops the key, so a refused session cannot read anything', async () => {
    const d = deps()
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: failure(2, 'SQLITE_ERROR') })
    expect(d.dropKey).toHaveBeenCalledWith('s1')
  })

  it('drops the key BEFORE alerting, so a hanging alert cannot leave one live', async () => {
    // Order, not just occurrence. A friend holding a key to a half-migrated
    // database is the failure this path exists to prevent; a missing push
    // notification is not.
    const order: string[] = []
    const d = {
      dropKey: vi.fn(() => {
        order.push('dropKey')
      }),
      log: vi.fn(() => {
        order.push('log')
      }),
      alert: vi.fn(async () => {
        order.push('alert')
      }),
    }
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: failure(2, 'X') })
    expect(order[0]).toBe('dropKey')
  })

  it('alerts with slug, migration number and code', async () => {
    const d = deps()
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: failure(2, 'SQLITE_ERROR') })
    expect(d.alert).toHaveBeenCalledWith({
      slug: 'sam',
      migrationNumber: 2,
      code: 'SQLITE_ERROR',
    })
  })

  it('NEVER puts the error message in the alert payload', async () => {
    // A constraint violation quotes the offending value. CLAUDE.md: metrics
    // and alerts carry a slug and nothing a friend typed.
    const d = deps()
    const error = failure(2, 'SQLITE_CONSTRAINT')
    error.message = 'UNIQUE constraint failed: weigh_ins.day = 2026-08-15, lb = 200.4'
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error })

    const payload = JSON.stringify(d.alert.mock.calls[0]?.[0])
    expect(payload).not.toMatch(/200\.4/)
    expect(payload).not.toMatch(/UNIQUE/)
  })

  it('sends the whole error to the log, which is where "why" lives', async () => {
    const d = deps()
    const error = failure(2, 'SQLITE_ERROR')
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error })
    expect(d.log).toHaveBeenCalledWith('migration_failed', 'sam', error)
  })

  it('still drops the key when the alert throws', async () => {
    const d = deps()
    d.alert = vi.fn(async () => {
      throw new Error('ntfy unreachable')
    })
    await expect(
      refuseSession(d, { sessionId: 's1', slug: 'sam', error: failure(1, 'X') }),
    ).resolves.toBeUndefined()
    expect(d.dropKey).toHaveBeenCalledWith('s1')
  })

  it('still drops the key when the LOG throws', async () => {
    const d = deps()
    d.log = vi.fn(() => {
      throw new Error('stderr closed')
    })
    await expect(
      refuseSession(d, { sessionId: 's1', slug: 'sam', error: failure(1, 'X') }),
    ).resolves.toBeUndefined()
    expect(d.dropKey).toHaveBeenCalledWith('s1')
  })

  it('handles an error that is not a MigrationFailure without inventing a number', async () => {
    const d = deps()
    await refuseSession(d, { sessionId: 's1', slug: 'sam', error: new Error('boom') })
    expect(d.alert).toHaveBeenCalledWith({ slug: 'sam', migrationNumber: 0, code: 'UNKNOWN' })
  })
})
