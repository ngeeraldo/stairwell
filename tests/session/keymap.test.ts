// tests/session/keymap.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  dropKey,
  getKey,
  putKey,
  sweep,
} from '@/lib/session/keymap'

const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  dropKey('s1')
  vi.useRealTimers()
})

describe('key map lifetime', () => {
  it('returns a key that was just put', () => {
    putKey('s1', KEY)
    expect(getKey('s1')).toEqual(KEY)
  })

  it('expires after the idle TTL', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS + 1)
    expect(getKey('s1')).toBeUndefined()
  })

  it('refreshes the idle timer on access', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS - 1000)
    expect(getKey('s1')).toEqual(KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS - 1000)
    expect(getKey('s1')).toEqual(KEY)
  })

  it('expires at the absolute ceiling even when constantly refreshed', () => {
    putKey('s1', KEY)
    // Touch it every hour. Idle TTL never elapses, but the ceiling still wins.
    for (let elapsed = 0; elapsed < ABSOLUTE_TTL_MS; elapsed += 3_600_000) {
      vi.advanceTimersByTime(3_600_000)
      getKey('s1')
    }
    vi.advanceTimersByTime(1000)
    expect(getKey('s1')).toBeUndefined()
  })

  it('cannot survive from one morning to the next', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(24 * 3_600_000)
    expect(getKey('s1')).toBeUndefined()
  })

  it('drops immediately on logout', () => {
    putKey('s1', KEY)
    dropKey('s1')
    expect(getKey('s1')).toBeUndefined()
  })

  it('restarts the ceiling on re-unlock', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(1000)
    putKey('s1', KEY)
    // A re-unlock is a fresh unlock: the ceiling restarts. Re-entering the
    // password is the thing that earns a new 12 hours, which is exactly the
    // property getKey's refresh must NOT have.
    //
    // DEVIATION FROM BRIEF (documented in task-9-report.md): the brief's
    // original body was a single `vi.advanceTimersByTime(ABSOLUTE_TTL_MS -
    // 2000)` with no intervening getKey call. That starves the 4h idle TTL
    // over a ~12h wait and fails against the verbatim module regardless of
    // ceiling logic. This loop reaches the exact same final instant (2000ms
    // before the new ceiling) via hourly touches, mirroring the idiom the
    // brief itself uses one test above ("expires at the absolute ceiling
    // even when constantly refreshed"), so idle expiry cannot mask the
    // ceiling-restart property under test.
    const target = ABSOLUTE_TTL_MS - 2000
    let elapsed = 0
    while (elapsed < target) {
      const step = Math.min(3_600_000, target - elapsed)
      vi.advanceTimersByTime(step)
      elapsed += step
      getKey('s1')
    }
    expect(getKey('s1')).toEqual(KEY)
  })
})

describe('sweep()', () => {
  afterEach(() => {
    dropKey('sweep-expired')
    dropKey('sweep-live')
  })

  it('removes an expired entry from the map itself, not just on next access', () => {
    // getKey already deletes-on-access when an entry has expired, so
    // asserting getKey('sweep-expired') is undefined after sweep() would
    // pass even if sweep() were a no-op — getKey's own lazy check would
    // produce that result regardless. To observe sweep()'s own mutation
    // without a new export, roll the fake clock BACKWARDS after calling
    // sweep(): if sweep() actually deleted the Map entry, the id is gone
    // no matter what the clock reads. If sweep() left a stale entry behind,
    // winding the clock back to before that entry's original timestamps
    // makes it read as alive again and getKey would incorrectly resurrect
    // it. Only a real deletion survives that rollback.
    putKey('sweep-expired', KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS + 1) // sweep-expired is now idle-expired
    putKey('sweep-live', KEY) // put fresh at this later "now" — stays alive

    sweep()

    // Wind the clock back to a point before sweep-expired's original
    // lastSeenAt/unlockedAt (both 0). A leftover stale entry would look
    // freshly alive again from this earlier vantage point.
    vi.setSystemTime(1)
    expect(getKey('sweep-expired')).toBeUndefined()
    expect(getKey('sweep-live')).toEqual(KEY)
  })
})

describe('key material never leaves memory', () => {
  it('has no console output, JSON serialization, or filesystem write anywhere in lib/session', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk('lib/session')
    const offending =
      /console\.|JSON\.stringify|writeFileSync|writeFile\(|createWriteStream|appendFileSync|appendFile\(|from ['"](?:node:)?fs['"]/
    for (const f of files) {
      expect(
        readFileSync(f, 'utf8'),
        `${f} may log, serialize, or persist key material`,
      ).not.toMatch(offending)
    }
  })
})
