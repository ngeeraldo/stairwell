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
 *
 * THE API ROUTES THE INVITE PAGE POSTS TO ARE ON THIS LIST TOO, and leaving
 * them off is what broke the flow in production on its first real walk:
 * pressing "Sounds good →" returned a bare HTTP 401 on a blank page. A page
 * being public is not worth anything if the route its form submits to is not,
 * and BOTH steps were affected — accept and register — so the friend could not
 * have got past that screen by any route.
 *
 * They belong here rather than in the matcher below for a reason that outlives
 * this bug: the matcher is applied by Next, not by this file, so a path
 * excluded there cannot be tested by the suite that tests this function. That
 * is precisely why /api/login has no test and these two now do.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/forgot' ||
    // The tab icon. app/icon.svg is a Next file convention, so every page —
    // /login included — carries <link rel="icon" href="/icon.svg?…">, and the
    // browser fetches it with whatever session the visitor has, which on the
    // login page is none. Without this it followed a 307 and got HTML where an
    // image belonged. It sits HERE and not in the matcher's exclusion list
    // beside favicon.ico for the reason this file's header gives: a path
    // excluded by the matcher cannot be tested by the suite.
    pathname === '/icon.svg' ||
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/api/invite/')
  )
}

export function middleware(request: NextRequest) {
  const hasCookie = request.cookies.has(SESSION_COOKIE)
  const { pathname } = request.nextUrl

  if (!hasCookie && !isPublicPath(pathname)) {
    // An API caller with no session cookie gets a 401, not a redirect. A
    // redirect() here defaults to 307 (method-preserving) to /login, which
    // has no POST handler — the caller would see a 405 instead of the 401
    // that actually describes the problem.
    //
    // This branch is reached only by an /api/ path that is neither excluded by
    // the matcher nor listed in isPublicPath. It used to say that the matcher's
    // api/login exclusion was enough to guarantee that, which was true when it
    // was written and became false the moment the onboarding flow added two API
    // routes a person with no account must reach. Anything unauthenticated by
    // DESIGN goes on the isPublicPath list; reaching here still means genuinely
    // unauthenticated, but it is that list that makes it so.
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
