import { NextResponse, type NextRequest } from 'next/server'

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

// A bare host, optionally with a port. Deliberately rejects anything containing
// '/', '@', whitespace or a scheme, so a malformed header cannot be spliced into
// the origin below and change where the redirect points.
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i

/**
 * The middleware counterpart of `relativeRedirect`, which CANNOT be used in
 * middleware.
 *
 * Next's middleware runtime parses the `Location` header as a URL, so a relative
 * value throws before the response ever leaves the process. Observed on the
 * droplet and reproduced locally against `next start`:
 *
 *   TypeError: Invalid URL ... code: 'ERR_INVALID_URL', input: '/login'
 *
 * and the request 500s. Route handlers have no such constraint — a relative
 * Location works there and is preferred, because it needs no host at all. This
 * asymmetry is not obvious and is the reason these are two functions rather than
 * one: the unit test for `middleware()` passes either way, because the throw
 * happens in Next's adapter after our function returns.
 *
 * So middleware needs an absolute URL, which means it needs a host, and
 * `request.nextUrl` supplies the loopback one (that is the whole bug). The host
 * therefore comes from the proxy headers.
 *
 * WHY TRUSTING THOSE HEADERS IS SAFE HERE, and what would break it:
 * `deploy/Caddyfile` declares a single site block for `app.stairwell.run`, and
 * Caddy matches sites by Host header — a request bearing any other Host does not
 * match and never reaches this app. `ufw` allows only 22/80/443, and Next binds
 * 127.0.0.1, so Caddy is the only path in. The Host is therefore already
 * validated before we see it.
 *
 * If a second site block, a wildcard host, or a direct route to port 3000 is
 * ever added, that guarantee is gone and this should switch to an explicit
 * allowlisted origin from configuration.
 */
export function middlewareRedirect(
  request: NextRequest,
  path: string,
  status = 307,
): NextResponse {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(
      `middlewareRedirect: path must be host-relative and not protocol-relative, got '${path}'`,
    )
  }

  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto')

  // Fall back to the request's own origin rather than throwing: a 500 on the
  // unauthenticated entry path is worse than a redirect to the internal origin,
  // and HOST_PATTERN only rejects values Caddy would never produce.
  if (!host || !HOST_PATTERN.test(host)) {
    return NextResponse.redirect(new URL(path, request.nextUrl.origin), status)
  }

  const scheme = proto === 'http' || proto === 'https' ? proto : 'https'
  return NextResponse.redirect(new URL(path, `${scheme}://${host}`), status)
}
