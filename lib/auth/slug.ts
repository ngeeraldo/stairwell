/**
 * What a slug may be — one definition, imported by everything that judges one.
 *
 * `lib/auth/accounts.ts` uses it to decide what may be CREATED;
 * `lib/db/userDb.ts` uses it to decide what may become a FILESYSTEM PATH.
 * Two copies would be two things that can drift, and the drift would be a
 * path traversal on one side of it.
 *
 * The pattern is also what stands between account creation and an open
 * redirect: `app/api/unlock/route.ts` builds a path from `account.slug`, and
 * a slug allowed to start with '/' (e.g. "/evil.com") would resolve to
 * "//evil.com" — a post-authentication redirect off the trusted origin. A
 * slug that can never contain '/' closes that off at the source, for every
 * caller, rather than re-sanitizing at each place a slug gets interpolated
 * into a path.
 */
export const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/

/**
 * Route segments a slug must not collide with. admin/login/unlock/invite/
 * forgot are real top-level routes (app/admin, app/(auth)/login,
 * app/(auth)/unlock, app/(auth)/invite, app/(auth)/forgot); api and _next are
 * reserved by the app/framework; favicon.ico is a static asset route.
 * `mockup` was a real route too (app/mockup) until the mockup-loop removal
 * deleted it — see that entry below for why it stays reserved anyway.
 *
 * lib/invite/tokens.ts checks this at MINT time as well, so a reserved slug is
 * rejected when the link is created rather than when it is used.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'login',
  'unlock',
  'api',
  '_next',
  'favicon.ico',
  // Added with the onboarding flow: /invite/<token> and /forgot are real
  // top-level routes, and a slug that collided with one would shadow it for
  // that user forever.
  'invite',
  'forgot',
  // /mockup/<version> was a real top-level route until the mockup-loop
  // removal deleted app/mockup and app/admin/mockup. Left reserved rather
  // than freed: nothing is served there any more, but nothing needs the name
  // back either, and freeing it would just be one more thing a future mockup
  // route would have to re-reserve.
  'mockup',
])
