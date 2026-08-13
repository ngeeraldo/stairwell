/**
 * One stderr line for a per-user database failure, so an operator can tell
 * WHICH failure it was.
 *
 * WHY THIS EXISTS: `dashboard_error` and `dashboard_write_error` carry a closed
 * `kind`/`panel` and nothing else, because `metrics` is append-only and
 * unencrypted and a raw `.message` written there is a permanent fragment of the
 * friend's own data in the one place this design promises never holds it. That
 * is the right call for the table and it leaves an operator with `kind:'error'`
 * and no way to tell a permissions failure from a corrupt file. The step-6a
 * ledger recorded the fix as `console.error` at the catch site — stderr, which
 * on the droplet is journald: transient, rotated, and NOT the sacred
 * append-only record. This is that.
 *
 * WHAT IS LOGGED, and why it stops where it does: the error's `name` and
 * `code`, never its `message`. Those two discriminate every case this exists
 * for — `SQLITE_READONLY`/`SQLITE_CANTOPEN`/`EACCES` for permissions,
 * `SQLITE_NOTADB` for a corrupt file or wrong key, `SQLITE_FULL` for a full
 * disk, `SQLITE_BUSY` for a lock, `SQLITE_ERROR` for a missing table (the
 * shape a frozen schema takes once 6b changes one), and `WrongKeyError` by
 * name.
 *
 * The `message` is left out deliberately. Measured against this driver, its
 * messages do not interpolate bound parameters — a duplicate primary key
 * reports `UNIQUE constraint failed: walks.day`, not the day — so the driver's
 * own text would have been safe. But this catch also receives whatever a
 * per-user dashboard component threw, which is the least-reviewed code in the
 * repo and free to put a row value in an Error it constructs. `CLAUDE.md`'s
 * hard rule covers debug output as well as storage, so the same discipline
 * applies at both sinks and the cheap win is declined.
 */
export function logDbFailure(event: string, slug: string, error: unknown): void {
  const e = error as { name?: unknown; code?: unknown } | null | undefined
  const name = typeof e?.name === 'string' ? e.name : 'unknown'
  const code = typeof e?.code === 'string' ? e.code : 'none'
  console.error(`[${event}] slug=${slug} error=${name} code=${code}`)
}
