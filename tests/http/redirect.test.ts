// tests/http/redirect.test.ts
//
// lib/http/redirect.ts exists because of a live failure, not a preference: see
// its own docstring for the measured behaviour at https://app.stairwell.run,
// where every absolute redirect named localhost:3000 and broke the auth flow
// through Caddy while working fine on localhost.
import { describe, expect, it } from 'vitest'
import { relativeRedirect } from '@/lib/http/redirect'

describe('relativeRedirect', () => {
  it('emits a host-relative Location, never an absolute one', () => {
    const response = relativeRedirect('/login')
    const location = response.headers.get('location')
    expect(location).toBe('/login')
    expect(location).not.toMatch(/^[a-z]+:\/\//i)
  })

  it('defaults to 303, the right status for a POST-then-redirect', () => {
    // 303 makes the browser follow with GET. 307/308 preserve the method, which
    // would re-POST the form to the target — /login and /<slug> are GET pages.
    expect(relativeRedirect('/login').status).toBe(303)
  })

  it('honours an explicit status, which middleware needs for 307', () => {
    // middleware.ts replaced NextResponse.redirect, whose default is 307. That
    // default is deliberate there: the API branch above it relies on methods
    // being preserved so a cookie-less POST is not silently turned into a GET.
    expect(relativeRedirect('/login', 307).status).toBe(307)
  })

  it('carries cookies set on the returned response', () => {
    // The login route sets the session cookie on the redirect, and the logout
    // route deletes it. If NextResponse's cookie jar did not survive being
    // constructed this way, login would redirect correctly and never
    // authenticate anyone.
    const response = relativeRedirect('/nico')
    response.cookies.set('probe', 'value', { httpOnly: true })
    expect(response.cookies.get('probe')?.value).toBe('value')
    expect(response.headers.get('set-cookie')).toContain('probe=value')
  })

  it('rejects a protocol-relative path, which would redirect off-origin', () => {
    // '//evil.example' is a valid URL reference resolving to a DIFFERENT
    // ORIGIN, so accepting it would make every caller an open redirect. This is
    // the same hazard SLUG_PATTERN guards in lib/auth/accounts.ts, enforced
    // again at the point of use.
    expect(() => relativeRedirect('//evil.example')).toThrow(
      /protocol-relative/,
    )
  })

  it('rejects a path that is not host-relative at all', () => {
    expect(() => relativeRedirect('https://evil.example/login')).toThrow()
    expect(() => relativeRedirect('login')).toThrow()
  })
})
