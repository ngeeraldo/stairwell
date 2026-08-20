// tests/http/redirect.test.ts
//
// lib/http/redirect.ts exists because of a live failure, not a preference: see
// its own docstring for the measured behaviour at https://app.stairwell.run,
// where every absolute redirect named localhost:3000 and broke the auth flow
// through Caddy while working fine on localhost.
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { middlewareRedirect, relativeRedirect, writeAnswer } from '@/lib/http/redirect'

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
    // the same hazard SLUG_PATTERN guards in lib/auth/slug.ts, enforced
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

describe('writeAnswer', () => {
  it('answers a fetch-initiated write (the header set) with 204 and no Location', () => {
    const request = new Request('http://x', {
      method: 'POST',
      headers: { 'X-Stairwell-Write': '1' },
    })
    const response = writeAnswer(request, '/run9')
    expect(response.status).toBe(204)
    expect(response.headers.get('location')).toBeNull()
  })

  it('answers a native form post (no header) with the 303 relativeRedirect gives', () => {
    // The whole no-JS path rides on this branch: a browser posting a real
    // <form> can never set X-Stairwell-Write, so it always lands here.
    const request = new Request('http://x', { method: 'POST' })
    const response = writeAnswer(request, '/run9')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/run9')
  })

  it('treats any value other than the exact string "1" as a native post', () => {
    const request = new Request('http://x', {
      method: 'POST',
      headers: { 'X-Stairwell-Write': 'true' },
    })
    const response = writeAnswer(request, '/run9')
    expect(response.status).toBe(303)
  })
})

// These two functions look redundant and are not. Middleware is the one layer
// where a relative Location cannot work: Next's middleware runtime parses the
// header as a URL and throws ERR_INVALID_URL, 500ing the request. Observed on the
// droplet and reproduced locally against `next start` before this was written.
//
// NOTE the coverage limit honestly: nothing here reproduces that throw, because
// it happens inside Next's adapter AFTER middleware() returns. These tests pin
// the property that avoids it — the Location is absolute — not the throw itself.
// Only a request against a real built server exercises that, which is why the
// bug reached the droplet in the first place.
function proxiedRequest(
  path: string,
  headers: Record<string, string>,
): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`, { headers })
}

describe('middlewareRedirect', () => {
  it('builds an ABSOLUTE Location from the proxy headers, not from the loopback origin', () => {
    const response = middlewareRedirect(
      proxiedRequest('/nico', {
        host: 'app.stairwell.run',
        'x-forwarded-host': 'app.stairwell.run',
        'x-forwarded-proto': 'https',
      }),
      '/login',
    )
    // The exact failure this replaced: https://localhost:3000/login
    expect(response.headers.get('location')).toBe(
      'https://app.stairwell.run/login',
    )
  })

  it('defaults to 307, preserving the method as NextResponse.redirect did', () => {
    const response = middlewareRedirect(
      proxiedRequest('/nico', { host: 'app.stairwell.run' }),
      '/login',
    )
    expect(response.status).toBe(307)
  })

  it('falls back to the plain Host header when x-forwarded-host is absent', () => {
    const response = middlewareRedirect(
      proxiedRequest('/nico', { host: 'app.stairwell.run' }),
      '/login',
    )
    expect(response.headers.get('location')).toBe(
      'https://app.stairwell.run/login',
    )
  })

  it('honours x-forwarded-proto so a plain-HTTP deployment is not forced to https', () => {
    const response = middlewareRedirect(
      proxiedRequest('/nico', {
        host: 'app.stairwell.run',
        'x-forwarded-proto': 'http',
      }),
      '/login',
    )
    expect(response.headers.get('location')).toBe(
      'http://app.stairwell.run/login',
    )
  })

  it('ignores a malformed host rather than splicing it into the origin', () => {
    // A Host of 'evil.example/@x' must not produce a Location whose authority is
    // evil.example. Falling back to the request origin keeps the response a
    // valid redirect (a 500 on the unauthenticated entry path would be worse)
    // while refusing to honour the injected value.
    const response = middlewareRedirect(
      proxiedRequest('/nico', { host: 'evil.example/@x' }),
      '/login',
    )
    const location = response.headers.get('location')!
    // Assert the property, not the exact fallback host: Next normalises
    // 127.0.0.1 to localhost in nextUrl.origin, so pinning the literal would be
    // pinning an implementation detail of Next rather than the security property.
    expect(new URL(location).host).not.toContain('evil.example')
    expect(new URL(location).pathname).toBe('/login')
    expect(location).toMatch(/^https?:\/\//)
  })

  it('rejects a protocol-relative path here too', () => {
    expect(() =>
      middlewareRedirect(
        proxiedRequest('/nico', { host: 'app.stairwell.run' }),
        '//evil.example',
      ),
    ).toThrow(/protocol-relative/)
  })
})
