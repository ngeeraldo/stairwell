// tests/time/dayKey.test.ts
//
// Moved here with the function itself, unchanged in what it asserts. It used
// to live in tests/routing/walkRoute.test.ts, where it needed a dynamic import
// helper to avoid evaluating a route module during vi.mock's hoisting pass.
// lib/time/dayKey.ts imports nothing at all, so a plain static import is
// correct now — and the assertions below are the same ones, at the same
// offsets, with the same honest statement about what UTC can and cannot pin.
import { describe, expect, it } from 'vitest'
import { dayKey } from '@/lib/time/dayKey'

describe('dayKey', () => {
  it('yields the LOCAL calendar day, and diverges from ISO/UTC off-UTC', () => {
    // Two fixed local instants, chosen to straddle midnight from each side:
    // a late evening (23:30) and an early morning (00:30) on the same
    // nominal local date. dayKey must report that same local date for both,
    // regardless of the host's timezone.
    const evening = new Date(2026, 7, 12, 23, 30, 0).getTime() // Aug is month 7 (0-based)
    const morning = new Date(2026, 7, 12, 0, 30, 0).getTime()
    expect(dayKey(evening)).toBe('2026-08-12')
    expect(dayKey(morning)).toBe('2026-08-12')

    // Pinning that dayKey is NOT `new Date(at).toISOString().slice(0, 10)`:
    // a late-evening local instant rolls onto the NEXT UTC day when local
    // time is BEHIND UTC (getTimezoneOffset() > 0, e.g. the Americas); an
    // early-morning local instant rolls onto the PREVIOUS UTC day when
    // local time is AHEAD of UTC (getTimezoneOffset() < 0, e.g.
    // Asia/Tokyo). Exactly one of the two diverges for any real non-UTC
    // timezone, which is why the branch is picked from the host's own
    // offset rather than hardcoded. At UTC itself (offset === 0) neither
    // instant can diverge — the two equality checks above are the only
    // assertions this test can make in that environment, and this branch
    // asserts nothing further. This is stated plainly rather than silently
    // passing: the divergence check below is only discriminating off-UTC.
    const offsetMinutes = new Date().getTimezoneOffset()
    if (offsetMinutes > 0) {
      expect(dayKey(evening)).not.toBe(new Date(evening).toISOString().slice(0, 10))
    } else if (offsetMinutes < 0) {
      expect(dayKey(morning)).not.toBe(new Date(morning).toISOString().slice(0, 10))
    }
  })
})
