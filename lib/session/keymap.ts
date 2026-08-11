/**
 * Derived SQLCipher keys, in process memory only.
 *
 * CLAUDE.md > Data safety: never serialized, persisted, logged, or written to
 * the sessions table. This module is the only place a key is held, and the
 * map dies with the process — which is why a deploy leaves users logged in
 * but locked (architecture spec section 2.3).
 *
 * The absolute ceiling exists because step 6 makes login the trigger for
 * Plaid sync. A key surviving overnight would turn "morning open -> sync"
 * into "morning open -> stale data".
 *
 * getKey returns the stored Buffer BY REFERENCE. dropKey(), sweep(), and
 * getKey's own expiry branch zero that buffer in place before the entry
 * becomes unreachable, so "removed" means wiped from process memory, not
 * just unlinked from the Map. putKey()'s overwrite path (re-unlock reusing
 * a session id) does NOT zero the buffer it replaces — out of scope here,
 * flagged as a residual item.
 *
 * Callers must not mutate a returned buffer and must not retain their own
 * reference past the call that needed it — a retained reference keeps key
 * material live in memory even after dropKey()/sweep() wipes and removes
 * this module's copy.
 *
 * sweep() is scheduled at process startup by instrumentation.ts on a
 * SWEEP_INTERVAL_MS timer so an idle process does not retain keys past
 * IDLE_TTL_MS by more than one sweep interval — see the design spec,
 * "expiry is enforced on access and by a sweep interval".
 */

export const IDLE_TTL_MS = 4 * 60 * 60 * 1000
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * How often the process-startup scheduler (instrumentation.ts) calls
 * sweep(). Well under IDLE_TTL_MS so a closed-browser session's key does
 * not sit resident for anywhere near the full idle window.
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000

type Entry = { key: Buffer; lastSeenAt: number; unlockedAt: number }

const keys = new Map<string, Entry>()

function alive(e: Entry, now: number): boolean {
  return (
    now - e.lastSeenAt <= IDLE_TTL_MS && now - e.unlockedAt <= ABSOLUTE_TTL_MS
  )
}

/**
 * Zero a key buffer in place before it becomes unreachable, so "dropped"
 * means wiped from process memory, not just unlinked from the Map. Every
 * removal path (dropKey, sweep, getKey's expiry branch) must go through
 * this rather than a bare keys.delete().
 */
function wipe(entry: Entry): void {
  entry.key.fill(0)
}

export function putKey(sessionId: string, key: Buffer): void {
  const now = Date.now()
  keys.set(sessionId, { key, lastSeenAt: now, unlockedAt: now })
}

export function getKey(sessionId: string): Buffer | undefined {
  const now = Date.now()
  const entry = keys.get(sessionId)
  if (!entry) return undefined
  if (!alive(entry, now)) {
    wipe(entry)
    keys.delete(sessionId)
    return undefined
  }
  entry.lastSeenAt = now
  return entry.key
}

export function dropKey(sessionId: string): void {
  const entry = keys.get(sessionId)
  if (entry) wipe(entry)
  keys.delete(sessionId)
}

/** Drop expired entries so an idle process does not retain keys. */
export function sweep(): void {
  const now = Date.now()
  for (const [id, entry] of keys) {
    if (!alive(entry, now)) {
      wipe(entry)
      keys.delete(id)
    }
  }
}
