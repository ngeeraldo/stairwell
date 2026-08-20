// tests/time/minuteOfDay.test.ts
//
// The companion to dayKey.test.ts. dayKey answers "which day"; this answers
// "how far into it", and users/run11 is built entirely out of the second
// question — every check it runs is a comparison of minutes since local
// midnight.
import { describe, expect, it } from 'vitest'
import { MINUTES_PER_DAY, localMinuteOfDay } from '@/lib/time/minuteOfDay'

// 2026-08-20T14:30:00Z. Houston is UTC−5 in August (CDT), so this is 09:30
// local — the same westward shift that made devtwo's evening tap land on the
// wrong day.
const AFTERNOON = Date.parse('2026-08-20T14:30:00Z')

describe('localMinuteOfDay', () => {
  it('is the friend’s wall clock, not the droplet’s', () => {
    expect(localMinuteOfDay(AFTERNOON, 'UTC')).toBe(14 * 60 + 30)
    expect(localMinuteOfDay(AFTERNOON, 'America/Chicago')).toBe(9 * 60 + 30)
    expect(localMinuteOfDay(AFTERNOON, 'Asia/Kolkata')).toBe(20 * 60)
  })

  it('returns 0 at local midnight, never 1440', () => {
    // The reason the formatter is pinned to hourCycle 'h23': `hour12: false`
    // is specified to render midnight as '24' in some locales, which would
    // make midnight 1440 minutes past midnight and put every window check one
    // whole day out.
    expect(localMinuteOfDay(Date.parse('2026-08-20T00:00:00Z'), 'UTC')).toBe(0)
    expect(localMinuteOfDay(Date.parse('2026-08-20T05:00:00Z'), 'America/Chicago')).toBe(0)
  })

  it('stays inside the day, at both ends', () => {
    const end = localMinuteOfDay(Date.parse('2026-08-20T23:59:00Z'), 'UTC')
    expect(end).toBe(MINUTES_PER_DAY - 1)
    expect(end).toBeLessThan(MINUTES_PER_DAY)
  })

  it('degrades an unusable zone to UTC rather than throwing', () => {
    // Same contract as dayKey, for the same reason: the zone arrives from an
    // untrusted `stairwell_tz` cookie on a path that writes a row. A friend's
    // refresh must not be able to fail because something rewrote a cookie.
    expect(localMinuteOfDay(AFTERNOON, 'Not/AZone')).toBe(14 * 60 + 30)
    expect(localMinuteOfDay(AFTERNOON, undefined)).toBe(14 * 60 + 30)
    expect(localMinuteOfDay(AFTERNOON, '')).toBe(14 * 60 + 30)
  })

  it('handles a half-hour offset, which hour-only arithmetic would round away', () => {
    // 09:30Z is 15:15 in Kathmandu (UTC+5:45). A helper that only carried
    // hours would report 15:00 and lose the quarter hour.
    expect(localMinuteOfDay(Date.parse('2026-08-20T09:30:00Z'), 'Asia/Kathmandu')).toBe(
      15 * 60 + 15,
    )
  })

  it('follows a DST transition rather than a fixed offset', () => {
    // 2026-11-01 is the US fall-back date. 14:30Z is 08:30 CST (UTC−6), where
    // the August instant at the same clock time was 09:30 CDT (UTC−5).
    expect(localMinuteOfDay(Date.parse('2026-11-01T14:30:00Z'), 'America/Chicago')).toBe(
      8 * 60 + 30,
    )
  })
})
