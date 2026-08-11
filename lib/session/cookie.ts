// lib/session/cookie.ts
//
// Edge-safe session cookie config. middleware.ts runs on the Edge Runtime
// and cannot bundle Node.js builtins, so the parts of session config it
// needs (just the cookie name) live here, in a module with zero `node:`
// imports. lib/session/store.ts re-exports these so every existing import
// site keeps working unchanged.
//
// This split exists because lib/session/store.ts imports `node:crypto`
// (for createSession's randomBytes), and middleware.ts used to import
// SESSION_COOKIE from store.ts directly — pulling `node:crypto` into the
// Edge Runtime bundle and breaking `next build` outright. See
// tests/session/cookie.test.ts for the regression test pinning this file's
// edge-safety, and for the check that middleware.ts's own import list
// stays edge-safe.
export const SESSION_COOKIE = 'stairwell_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS / 1000,
} as const
