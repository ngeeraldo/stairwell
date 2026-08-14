// tests/metrics/deviceClass.test.ts
import { describe, expect, it } from 'vitest'
import { deviceClassFrom } from '@/lib/metrics/deviceClass'

/**
 * onboarding-ux-spec.md: "the phone-vs-desktop usage split cannot be
 * reconstructed retroactively any more than the retention curve can." This is
 * the instrument, and these are the four things it has to get right.
 */
describe('deviceClassFrom', () => {
  it('trusts the cookie, which is the only source that knows the viewport', () => {
    // A Mac can be at a 400px window. The UA cannot tell; the cookie was
    // written from matchMedia and can.
    expect(deviceClassFrom({ cookie: 'phone', userAgent: 'Mozilla/5.0 (Macintosh)' })).toBe(
      'phone',
    )
  })

  it('ignores a cookie value that is not one of the three', () => {
    // The cookie is client-set, so it is untrusted input. An unknown value
    // must never reach metrics: the point of an enum in an append-only log is
    // that grouping by it keeps working forever, and one row saying 'laptop'
    // breaks that permanently.
    expect(deviceClassFrom({ cookie: 'laptop', userAgent: 'Mozilla/5.0 (Macintosh)' })).toBe(
      'desktop',
    )
    expect(deviceClassFrom({ cookie: '', userAgent: 'Mozilla/5.0 (iPhone)' })).toBe('phone')
  })

  it('falls back to the UA on the first request, before any script has run', () => {
    const ua = (s: string) => deviceClassFrom({ cookie: undefined, userAgent: s })
    expect(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('phone')
    expect(ua('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet')
    expect(ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe('phone')
    expect(ua('Mozilla/5.0 (Linux; Android 14; SM-X200) Safari/537.36')).toBe('tablet')
    expect(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop')
    expect(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop')
  })

  it('defaults to desktop when it knows nothing at all', () => {
    expect(deviceClassFrom({ cookie: undefined, userAgent: undefined })).toBe('desktop')
  })
})
