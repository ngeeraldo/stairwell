import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { login, unlock } from '@/lib/auth/flow'
import { resolveState } from '@/lib/session/resolve'
import * as password from '@/lib/auth/password'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-flow-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  await createAccount(db, { slug: 'nico', role: 'user', password: 'pw' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('login', () => {
  it('issues a session for correct credentials', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(sid).toBeTruthy()
    expect(resolveState(db, sid!)).toBe('authenticated')
  })

  it('returns null for a wrong password', async () => {
    expect(await login(db, 'nico', 'wrong')).toBeNull()
  })

  it('returns null for an unknown account', async () => {
    expect(await login(db, 'ghost', 'pw')).toBeNull()
  })

  it('leaves the session locked, not unlocked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(resolveState(db, sid!)).not.toBe('unlocked')
  })

  // Task 13G: /api/login has no cookie gate and both outcomes redirect to
  // the same /login?error=1, so wall-clock time was the only observable
  // difference between "unknown slug" and "known slug, wrong password" --
  // a slug-existence oracle. login() must do equivalent Argon2 work on both
  // branches. This is pinned behaviourally (deterministic) plus a robust,
  // floor-based timing check (see rationale on that test below).
  describe('closes the login timing oracle', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('runs a real verifyPassword call on an unknown slug, shaped like the known-account path', async () => {
      const spy = vi.spyOn(password, 'verifyPassword')

      await login(db, 'ghost', 'pw')
      expect(spy).toHaveBeenCalledTimes(1)
      const [unknownSlugArg] = spy.mock.calls[0]!

      spy.mockClear()
      await login(db, 'nico', 'wrong')
      expect(spy).toHaveBeenCalledTimes(1)
      const [knownSlugArg] = spy.mock.calls[0]!

      // Both calls must pass a real Argon2id-encoded verifier string (not
      // undefined, not skipped) -- the unknown-slug branch is doing the
      // same shape of work as the known-account branch, just against a
      // fixed dummy hash instead of the account's stored one.
      const argon2idShape = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$/
      expect(unknownSlugArg).toEqual(expect.stringMatching(argon2idShape))
      expect(knownSlugArg).toEqual(expect.stringMatching(argon2idShape))
    })

    // Wall-clock assertions are normally too flaky to pin security behaviour
    // (CI load, GC pauses). This one is a one-sided FLOOR, not a ratio or an
    // upper bound: contention can only push the measured time UP, never
    // down, so it cannot flake low. A real Argon2id verify at this
    // project's cost params (memoryCost 19456, timeCost 2) takes ~14-19ms
    // on dev hardware; a skipped or malformed dummy verify returns in well
    // under 1ms (measured: ~0.05-0.15ms). 2ms sits with an order of
    // magnitude of headroom on both sides of that gap, and 7 iterations
    // with a median guard against a single outlier sample.
    it('spends non-trivial wall-clock time on an unknown slug (robust floor, not a stopwatch race)', async () => {
      const N = 7
      const times: number[] = []
      for (let i = 0; i < N; i++) {
        const t0 = process.hrtime.bigint()
        await login(db, 'ghost', 'pw')
        times.push(Number(process.hrtime.bigint() - t0) / 1e6)
      }
      times.sort((a, b) => a - b)
      const median = times[Math.floor(N / 2)]
      expect(median).toBeGreaterThan(2)
    })
  })
})

describe('unlock', () => {
  it('moves an authenticated session to unlocked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(await unlock(db, sid!, 'pw')).toBe(true)
    expect(resolveState(db, sid!)).toBe('unlocked')
  })

  it('rejects a wrong password and stays locked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(await unlock(db, sid!, 'wrong')).toBe(false)
    expect(resolveState(db, sid!)).toBe('authenticated')
  })

  it('rejects an unknown session', async () => {
    expect(await unlock(db, 'nope', 'pw')).toBe(false)
  })
})
