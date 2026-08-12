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

const PUBLIC = new Set(['/login'])
const LOCKED_OK = new Set(['/unlock'])

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
const RESERVED_SEGMENTS = new Set(['login', 'unlock', 'admin', 'api'])

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
