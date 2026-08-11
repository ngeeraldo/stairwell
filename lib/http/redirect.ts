import { NextResponse } from 'next/server'

/**
 * A redirect whose `Location` is host-relative.
 *
 * WHY THIS EXISTS, and why `NextResponse.redirect(new URL(path, request.url))`
 * must not come back:
 *
 * `request.url` is the server's own view of the request. Behind a reverse proxy
 * that is the loopback address Next is bound to, NOT the host the browser
 * asked for. Measured live at https://app.stairwell.run (Caddy terminating TLS,
 * proxying to 127.0.0.1:3000):
 *
 *   GET /                    -> location: https://localhost:3000/login
 *   POST /api/login (bad pw) -> location: https://localhost:3000/login?error=1
 *   GET /devone (no cookie)  -> location: https://localhost:3000/login
 *
 * Every redirect in the auth flow pointed at a host that does not exist for the
 * browser, so login, unlock and logout were all unusable through the proxy —
 * while working perfectly on localhost, where the internal origin happens to be
 * the external one. Only a proxy separates the two, which is why no local test
 * and no `next build` caught it.
 *
 * Supplying the Host header does not fix it: verified against the origin on the
 * droplet, an explicit `Host: app.stairwell.run` still produced `localhost:3000`.
 * Next honours `X-Forwarded-Proto` for the scheme but does not take the host
 * from `Host` or `X-Forwarded-Host`. There is no absolute form that is correct
 * here, and deriving one from a forwarded header would mean trusting a
 * client-settable value on the auth path.
 *
 * A relative Location (RFC 7231 section 7.1.2) is resolved by the client against
 * the request URI, so it is right behind any proxy, or none, with nothing to
 * configure and nothing to trust.
 *
 * One definition on purpose, mirroring lib/session/cookie.ts: six copies of a
 * security-relevant pattern is six chances for one of them to drift back.
 *
 * Edge-safe: imports `next/server` only, and nothing that reaches `node:`. It is
 * on middleware.ts's import allowlist in tests/session/cookie.test.ts, and
 * scanned for `node:` imports there too.
 */
export function relativeRedirect(path: string, status = 303): NextResponse {
  if (!path.startsWith('/') || path.startsWith('//')) {
    // A Location starting '//' is protocol-relative and resolves to a DIFFERENT
    // ORIGIN, which would turn every caller into an open redirect. Slugs are
    // already constrained by SLUG_PATTERN in lib/auth/accounts.ts, so this is
    // defence in depth for future callers rather than a live hole.
    throw new Error(
      `relativeRedirect: path must be host-relative and not protocol-relative, got '${path}'`,
    )
  }
  return new NextResponse(null, { status, headers: { location: path } })
}
