// lib/auth/refuseSession.ts
//
// The ONE exit for a refused session.
//
// One function, one copy block, one alert. Per-case refusal handling is what
// produces a path nobody has read in six months, discovered by a friend at
// seven in the morning. Today only a failed migration reaches here; whatever
// arrives next comes through the same door.
//
// Design: docs/superpowers/specs/2026-08-15-user-db-migrations-design.md §5.1
import { MigrationFailure } from '@/lib/db/migrate'

/**
 * What the operator's phone is told.
 *
 * A slug, an integer and a driver code — three values, none of which a friend
 * ever typed. CLAUDE.md: metrics and alerts carry no user values, and a SQLite
 * error MESSAGE can quote the row that broke.
 */
export type RefusalAlert = {
  slug: string
  migrationNumber: number
  code: string
}

export type RefuseDeps = {
  dropKey: (sessionId: string) => void
  log: (event: string, slug: string, error: unknown) => void
  alert: (payload: RefusalAlert) => Promise<void>
}

/**
 * Refuse a session: drop the key, record why, tell Nico.
 *
 * NEVER THROWS. Every caller is a route about to return a redirect, and a
 * throw here would replace an honest error page with Next's default one —
 * taking the chat panel and the log-out button with it, which is the surface a
 * friend needs in order to report that this happened.
 */
export async function refuseSession(
  deps: RefuseDeps,
  input: { sessionId: string; slug: string; error: unknown },
): Promise<void> {
  // FIRST, and before anything that can fail. A friend holding a live key to a
  // half-migrated database is the thing this whole path exists to prevent; a
  // missing push notification is an inconvenience. Pinned by a test that
  // asserts the ORDER, not merely that both happened.
  deps.dropKey(input.sessionId)

  const failure = input.error instanceof MigrationFailure ? input.error : undefined

  try {
    // The full error, message and all, goes HERE — to the server log, which is
    // where "why" is allowed to live in detail. lib/db/failureLog.ts draws the
    // same line for the same reason.
    deps.log('migration_failed', input.slug, input.error)
  } catch {
    // A broken logger must not turn a refused session into a 500.
  }

  try {
    await deps.alert({
      slug: input.slug,
      // 0 and UNKNOWN rather than a guess. An error that is not a
      // MigrationFailure has no number, and inventing one would put a
      // confident, wrong migration number on the operator's phone.
      migrationNumber: failure?.migrationNumber ?? 0,
      code: failure?.code ?? 'UNKNOWN',
    })
  } catch {
    // Already logged above. An alerter that cannot reach ntfy.sh must not turn
    // a refused session into an unhandled rejection.
  }
}
