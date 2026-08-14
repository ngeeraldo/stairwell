import type { PlatformDb } from '@/lib/db/platform'
import { getKey } from './keymap'
import { readSession } from './store'

export type AuthState = 'anonymous' | 'authenticated' | 'unlocked'

/**
 * Two-tier state (architecture spec section 2.3). The session persists across
 * a deploy; the key does not, so a restart leaves users authenticated but
 * locked and the chat surface keeps working.
 */
export function resolveState(
  db: PlatformDb,
  sessionId: string | undefined,
): AuthState {
  if (!sessionId) return 'anonymous'
  if (!readSession(db, sessionId)) return 'anonymous'
  return getKey(sessionId) ? 'unlocked' : 'authenticated'
}

const PUBLIC = new Set(['/login', '/forgot'])
const LOCKED_OK = new Set(['/unlock'])

/**
 * An invite link is reachable in EVERY state, not just anonymously.
 *
 * A logged-in Nico opening a friend's link to check it must see the page, not
 * be bounced to /unlock — and a friend who accepted, closed the tab, and came
 * back with a live session must land back on the same screen rather than
 * somewhere that cannot finish what they started. Nothing on the invite path
 * reads user data, so there is nothing for a lock to protect.
 *
 * `/invite/` with the trailing slash, so a future `/invitedguests` route would
 * not silently inherit this. Same care as isAdminPath below.
 */
function isInvitePath(pathname: string): boolean {
  return pathname.startsWith('/invite/')
}

/**
 * A path segment boundary, not a string prefix: '/admin' must match itself
 * or a '/admin/...' subpath, never a same-named slug like '/adminbob' — see
 * the routeFor tests for the regression this guards.
 */
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

/**
 * Paths that are never a user slug. `createAccount` validates slugs against
 * SLUG_PATTERN, so a real account can never be named one of these — this set
 * is about classifying the URL, not about trusting it.
 */
const RESERVED_SEGMENTS = new Set([
  'login',
  'unlock',
  'admin',
  'api',
  // Added with the onboarding flow. Without these, isUserSpacePath would
  // classify '/forgot' as a single-segment user space and let a locked
  // session through to it as though it were their own page — harmless today,
  // but the classification would be wrong, and lib/auth/slug.ts already
  // refuses to create accounts with these names.
  'invite',
  'forgot',
  'mockup',
])

/**
 * A single non-reserved segment: '/devone', not '/devone/settings' and not
 * '/admin'. Exactly one segment, because a locked session is allowed the
 * user-space page itself (which carries the chat surface) and nothing deeper.
 */
export function isUserSpacePath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  const [only] = segments
  return segments.length === 1 && only !== undefined && !RESERVED_SEGMENTS.has(only)
}

/** The path to redirect to, or null to allow the request through. */
export function routeFor(state: AuthState, pathname: string): string | null {
  // Before every other rule: an invite link renders in every state.
  if (isInvitePath(pathname)) return null

  if (state === 'anonymous') {
    return PUBLIC.has(pathname) ? null : '/login'
  }
  if (pathname === '/login') {
    return state === 'unlocked' ? '/' : '/unlock'
  }
  if (state === 'authenticated') {
    // architecture-overview.md line 59: a deploy leaves users logged in but
    // locked, and "the chat surface keeps working across the tweak loop,
    // and data panels ask for the password again". The user-space page
    // carries that chat surface, so the lock is enforced at the panel layer
    // inside the page rather than by bouncing the whole route.
    return LOCKED_OK.has(pathname) ||
      isAdminPath(pathname) ||
      isUserSpacePath(pathname)
      ? null
      : '/unlock'
  }
  return null
}

/** resolveState composed with routeFor — the whole decision in one call. */
export function redirectTargetFor(
  db: PlatformDb,
  sessionId: string | undefined,
  pathname: string,
): string | null {
  return routeFor(resolveState(db, sessionId), pathname)
}
