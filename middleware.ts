import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session/cookie'
import { relativeRedirect } from '@/lib/http/redirect'

/**
 * Thin adapter. The decision logic lives in lib/session/resolve.ts so it can
 * be tested without booting Next.js; middleware runs on the edge runtime and
 * cannot open SQLite, so the full state resolution happens in the route
 * handlers. Here we only bounce requests with no cookie at all.
 */
export function middleware(request: NextRequest) {
  const hasCookie = request.cookies.has(SESSION_COOKIE)
  const { pathname } = request.nextUrl

  if (!hasCookie && pathname !== '/login') {
    // An API caller with no session cookie gets a 401, not a redirect. A
    // redirect() here defaults to 307 (method-preserving) to /login, which
    // has no POST handler — the caller would see a 405 instead of the 401
    // that actually describes the problem. The matcher below already
    // excludes api/login, so every /api/* path reaching this branch is
    // genuinely unauthenticated.
    if (pathname.startsWith('/api/')) {
      return new NextResponse(null, { status: 401 })
    }
    // 307 preserves the method, matching NextResponse.redirect's default,
    // which this replaced. Relative because an absolute Location built from
    // request.url names the loopback origin behind a proxy — see
    // lib/http/redirect.ts.
    return relativeRedirect('/login', 307)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/login).*)'],
}
