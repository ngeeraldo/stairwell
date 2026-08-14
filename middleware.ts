import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session/cookie'
import { middlewareRedirect } from '@/lib/http/redirect'

/**
 * Thin adapter. The decision logic lives in lib/session/resolve.ts so it can
 * be tested without booting Next.js; middleware runs on the edge runtime and
 * cannot open SQLite, so the full state resolution happens in the route
 * handlers. Here we only bounce requests with no cookie at all.
 */
/**
 * Paths a person with NO SESSION must be able to reach.
 *
 * /login has always been one. /invite/<token> and /forgot arrived with the
 * onboarding flow, and both are meaningless to anyone who already has a
 * session: an invite creates the account a session already proves, and the
 * forgot page is read by someone who cannot get one. Bouncing either to
 * /login would make a friend's very first link look broken.
 *
 * A PREFIX for invite, an exact match for the other two — and the prefix is
 * `/invite/` with its trailing slash on purpose, so `/invitations` is still
 * bounced. Same segment-boundary care as isAdminPath in lib/session/resolve.ts,
 * and for the same reason: `startsWith('/invite')` would open a door nobody
 * meant to open.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/forgot' ||
    pathname.startsWith('/invite/')
  )
}

export function middleware(request: NextRequest) {
  const hasCookie = request.cookies.has(SESSION_COOKIE)
  const { pathname } = request.nextUrl

  if (!hasCookie && !isPublicPath(pathname)) {
    // An API caller with no session cookie gets a 401, not a redirect. A
    // redirect() here defaults to 307 (method-preserving) to /login, which
    // has no POST handler — the caller would see a 405 instead of the 401
    // that actually describes the problem. The matcher below already
    // excludes api/login, so every /api/* path reaching this branch is
    // genuinely unauthenticated.
    if (pathname.startsWith('/api/')) {
      return new NextResponse(null, { status: 401 })
    }
    // 307 preserves the method, matching NextResponse.redirect's default.
    //
    // Absolute, built from the proxy headers — NOT relative. Middleware is the
    // one layer where a relative Location cannot work: Next's middleware runtime
    // parses the header as a URL and throws ERR_INVALID_URL, 500ing the request.
    // Route handlers are the opposite and use relativeRedirect. See
    // lib/http/redirect.ts for the measurement and for why trusting the host
    // header is safe behind this Caddyfile.
    return middlewareRedirect(request, '/login', 307)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/login).*)'],
}
