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
 * getKey returns the stored Buffer BY REFERENCE, and nothing here zeroes
 * it. Callers must not mutate it and must not retain their own reference
 * past the call that needed it — a retained reference keeps key material
 * live in memory even after dropKey()/sweep() removes it from this map.
 */

export const IDLE_TTL_MS = 4 * 60 * 60 * 1000
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000

type Entry = { key: Buffer; lastSeenAt: number; unlockedAt: number }

const keys = new Map<string, Entry>()

function alive(e: Entry, now: number): boolean {
  return (
    now - e.lastSeenAt <= IDLE_TTL_MS && now - e.unlockedAt <= ABSOLUTE_TTL_MS
  )
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
    keys.delete(sessionId)
    return undefined
  }
  entry.lastSeenAt = now
  return entry.key
}

export function dropKey(sessionId: string): void {
  keys.delete(sessionId)
}

/** Drop expired entries so an idle process does not retain keys. */
export function sweep(): void {
  const now = Date.now()
  for (const [id, entry] of keys) {
    if (!alive(entry, now)) keys.delete(id)
  }
}
