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

// A FACTORY, not a shared constant. dropKey/sweep/getKey's expiry branch
// zero a key buffer in place before releasing it (fix round 2 below), so a
// buffer object reused across tests or across two different session ids
// would let one entry's wipe silently corrupt another entry's still-live
// key material, or make a later test's `toEqual` comparison pass against
// an already-zeroed buffer for the wrong reason. Every putKey() call below
// gets its own buffer from this factory; comparisons construct their own
// independent copy with the same fill byte, so value equality is checked
// without ever sharing an object identity with the stored entry.
function key(fill: number): Buffer {
  return Buffer.alloc(32, fill)
}

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
    putKey('s1', key(7))
    expect(getKey('s1')).toEqual(key(7))
  })

  it('expires after the idle TTL', () => {
    putKey('s1', key(7))
    vi.advanceTimersByTime(IDLE_TTL_MS + 1)
    expect(getKey('s1')).toBeUndefined()
  })

  it('refreshes the idle timer on access', () => {
    putKey('s1', key(7))
    vi.advanceTimersByTime(IDLE_TTL_MS - 1000)
    expect(getKey('s1')).toEqual(key(7))
    vi.advanceTimersByTime(IDLE_TTL_MS - 1000)
    expect(getKey('s1')).toEqual(key(7))
  })

  it('expires at the absolute ceiling even when constantly refreshed', () => {
    putKey('s1', key(7))
    // Touch it every hour. Idle TTL never elapses, but the ceiling still wins.
    for (let elapsed = 0; elapsed < ABSOLUTE_TTL_MS; elapsed += 3_600_000) {
      vi.advanceTimersByTime(3_600_000)
      getKey('s1')
    }
    vi.advanceTimersByTime(1000)
    expect(getKey('s1')).toBeUndefined()
  })

  it('cannot survive from one morning to the next', () => {
    putKey('s1', key(7))
    vi.advanceTimersByTime(24 * 3_600_000)
    expect(getKey('s1')).toBeUndefined()
  })

  it('drops immediately on logout', () => {
    putKey('s1', key(7))
    dropKey('s1')
    expect(getKey('s1')).toBeUndefined()
  })

  it('restarts the ceiling on re-unlock', () => {
    putKey('s1', key(7))
    vi.advanceTimersByTime(3_600_000)
    getKey('s1')
    putKey('s1', key(9))
    // A re-unlock is a fresh unlock: the ceiling restarts, AND the entry
    // must become the buffer just handed to putKey, not whatever was
    // stored before. Re-entering the password is the thing that earns a
    // new 12 hours and a fresh key, which is exactly the property
    // getKey's refresh must NOT have (see "refreshes the idle timer" and
    // "expires at the absolute ceiling" above).
    //
    // DEVIATION FROM BRIEF (documented in task-9-report.md, Fix round 1):
    // the brief's original body put the SAME KEY twice, 1000ms apart, then
    // jumped straight to `ABSOLUTE_TTL_MS - 2000` with no intervening
    // getKey call. That version is red against the verbatim module (idle
    // starvation — fixed in the initial submission) AND, even once fixed,
    // passes identically whether or not putKey restarts the ceiling: a
    // 1000ms gap against a 2000ms margin, on a 12h scale, means the final
    // checkpoint sits below the *original* (non-restarted) ceiling too. A
    // putKey that silently never restarts the ceiling would have shipped
    // green. Widening the gap to 1h and asserting a second, distinct
    // buffer makes this test pull double duty: it goes red if the ceiling
    // doesn't restart (proved in task-9-report.md's Fix round 1 mutant
    // proof) and red if putKey doesn't overwrite the stored key on
    // re-unlock.
    const target = ABSOLUTE_TTL_MS - 2000
    let elapsed = 0
    while (elapsed < target) {
      const step = Math.min(3_600_000, target - elapsed)
      vi.advanceTimersByTime(step)
      elapsed += step
      getKey('s1')
    }
    expect(getKey('s1')).toEqual(key(9))
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
    //
    // FRAGILE ON PURPOSE, FLAGGED HERE: this trick depends on alive()
    // treating a NEGATIVE elapsed (now before lastSeenAt/unlockedAt) as
    // "alive" — i.e. on the module doing no clamping or monotonic-clock
    // guard against a clock that moves backwards. If a later task hardens
    // alive() against backwards clock steps (a real hardening item,
    // currently out of scope — see task-9-report.md), the rollback below
    // stops being able to resurrect a stale entry, and THIS TEST WOULD
    // KEEP PASSING FOR A SILENTLY WRONG REASON: sweep-expired would stay
    // undefined regardless of whether sweep() itself deleted it, because
    // the hardened alive() would independently reject the stale entry at
    // the rolled-back time too. Whoever adds that hardening MUST redesign
    // this test in the same commit, or re-verify it's still diagnostic.
    //
    // STATUS as of the buffer-zeroing fix (final fix wave, item 4): this
    // trick's precondition — alive() treats negative elapsed as alive — is
    // untouched by that fix; zeroing a buffer on removal changes nothing
    // about how alive() computes elapsed. This test remains valid as-is.
    // The zeroing fix is instead covered by its own, non-fragile test
    // below ("zeroes an expired entry's buffer..."), which observes
    // sweep()'s mutation directly via the buffer object rather than via
    // this clock-rewind side channel.
    putKey('sweep-expired', key(7))
    vi.advanceTimersByTime(IDLE_TTL_MS + 1) // sweep-expired is now idle-expired
    putKey('sweep-live', key(7)) // put fresh at this later "now" — stays alive

    sweep()

    // Wind the clock back to a point before sweep-expired's original
    // lastSeenAt/unlockedAt (both 0). A leftover stale entry would look
    // freshly alive again from this earlier vantage point.
    vi.setSystemTime(1)
    expect(getKey('sweep-expired')).toBeUndefined()
    expect(getKey('sweep-live')).toEqual(key(7))
  })

  it('zeroes an expired entry\'s buffer without touching a live entry\'s buffer', () => {
    // Distinct buffer objects with distinguishable fill bytes for the
    // expired vs. the live entry — this is the case the clock-rewind test
    // above cannot see: if sweep() ever zeroed the wrong entry (or zeroed
    // by iterating a shared reference), a same-fill-byte setup would hide
    // it. Keep our own references to the exact buffers passed to putKey;
    // getKey() would itself delete-and-wipe an expired entry on access, so
    // reading through getKey after sweep() would not isolate sweep()'s own
    // effect from getKey's lazy path. Reading the retained buffer directly
    // avoids that.
    const expiredBuf = key(7)
    putKey('sweep-expired', expiredBuf)
    vi.advanceTimersByTime(IDLE_TTL_MS + 1)
    const liveBuf = key(9)
    putKey('sweep-live', liveBuf)

    sweep()

    expect(expiredBuf.every((b) => b === 0)).toBe(true)
    expect(liveBuf.every((b) => b === 9)).toBe(true)
  })
})

describe('key material is wiped, not just unlinked, on removal', () => {
  afterEach(() => {
    dropKey('wipe-drop')
    dropKey('wipe-expire')
  })

  it('dropKey zeroes the buffer in place', () => {
    const buf = key(7)
    putKey('wipe-drop', buf)
    dropKey('wipe-drop')
    expect(buf.every((b) => b === 0)).toBe(true)
  })

  it("getKey's own expiry branch zeroes the buffer, not only sweep()", () => {
    const buf = key(7)
    putKey('wipe-expire', buf)
    vi.advanceTimersByTime(IDLE_TTL_MS + 1)
    expect(getKey('wipe-expire')).toBeUndefined()
    expect(buf.every((b) => b === 0)).toBe(true)
  })

  it('a live key is untouched — zeroing only happens on removal', () => {
    const buf = key(7)
    putKey('wipe-drop', buf)
    expect(getKey('wipe-drop')).toEqual(key(7))
    expect(buf.every((b) => b === 7)).toBe(true)
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
    // An empty walk (e.g. a moved/renamed directory) would make the loop
    // below assert nothing and pass silently. Guard against that.
    expect(files.length).toBeGreaterThan(0)
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
