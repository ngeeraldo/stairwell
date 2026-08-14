// tests/time/dayKey.test.ts
//
// REWRITTEN when the day became the friend's rather than the server's.
//
// The previous version asserted that dayKey returned the HOST's local calendar
// day, and it was faithful to what the function then did. That behaviour is the
// bug: the host is the droplet, the droplet is UTC, and a friend tapping at
// 21:03 in New York had it stored as tomorrow.
//
// Worth recording about the old test rather than just deleting it: it said in
// its own comment that at UTC "neither instant can diverge — the two equality
// checks above are the only assertions this test can make in that
// environment." The droplet is UTC. So on the machine that mattered, the test
// guarding this function was close to vacuous, and every assertion below is
// deliberately independent of whatever zone the test host happens to be in.
import { describe, expect, it } from 'vitest'
import { dayKey, isValidTimeZone } from '@/lib/time/dayKey'

/** The instant devtwo's real tap was recorded at, which started all of this. */
const THE_TAP = Date.parse('2026-08-14T01:03:39.093Z')

describe('dayKey', () => {
  it('reports the day the FRIEND is living, not the one the server is having', () => {
    // 01:03Z on the 14th is 21:03 on the 13th in New York. The friend tapped
    // on the 13th; the droplet stored the 14th. This is the whole bug, in one
    // assertion, against the real instant it happened at.
    expect(dayKey(THE_TAP, 'America/New_York')).toBe('2026-08-13')
    expect(dayKey(THE_TAP, 'UTC')).toBe('2026-08-14')
  })

  it('works east of Greenwich too, where the error runs the other way', () => {
    const lateEvening = Date.parse('2026-08-13T22:30:00Z')
    expect(dayKey(lateEvening, 'Asia/Tokyo')).toBe('2026-08-14')
    expect(dayKey(lateEvening, 'UTC')).toBe('2026-08-13')
  })

  it('is the ZONE it was given, never the process the code runs in', () => {
    // The assertion the old implementation could not make at all, and the one
    // that stays discriminating whatever machine runs it: two zones, one
    // instant, two different days. A function that ignored its argument and
    // read the host clock would return the same string twice.
    expect(dayKey(THE_TAP, 'Asia/Tokyo')).not.toBe(dayKey(THE_TAP, 'America/New_York'))
  })

  it('does not let a daylight-saving transition move the day', () => {
    // 02:30 EST on the US spring-forward morning — the hour that does not
    // exist locally is 02:00–03:00, and this instant is either side of it
    // depending on how you count. It is the 8th of March either way.
    expect(dayKey(Date.parse('2026-03-08T06:30:00Z'), 'America/New_York')).toBe('2026-03-08')
    expect(dayKey(Date.parse('2026-03-08T08:30:00Z'), 'America/New_York')).toBe('2026-03-08')
  })

  it('pads to a sortable YYYY-MM-DD, because the day IS a primary key', () => {
    // walks.day is a TEXT primary key and every range query compares it as a
    // string. A single-digit month would sort wrong and never match.
    expect(dayKey(Date.parse('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05')
    expect(dayKey(Date.parse('2026-12-31T12:00:00Z'), 'UTC')).toBe('2026-12-31')
  })

  it('falls back to UTC rather than throwing on a bad zone', () => {
    // The zone arrives in a cookie, which is untrusted input, and it is read
    // on the path that records a tap. A throw here would mean a friend's tap
    // failing because something rewrote a cookie — so an unusable zone
    // degrades to UTC exactly as an unusable device_class degrades to
    // 'desktop'.
    expect(dayKey(THE_TAP, 'Not/AZone')).toBe('2026-08-14')
    expect(dayKey(THE_TAP, '')).toBe('2026-08-14')
    expect(dayKey(THE_TAP, undefined)).toBe('2026-08-14')
    expect(dayKey(THE_TAP, 'UTC; DROP TABLE walks')).toBe('2026-08-14')
  })
})

describe('isValidTimeZone', () => {
  it('accepts real IANA names and rejects everything else', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
  })
})
