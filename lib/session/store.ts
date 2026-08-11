import { randomBytes } from 'node:crypto'
import type { PlatformDb } from '@/lib/db/platform'
import { dropKey } from './keymap'
import { COOKIE_OPTIONS, SESSION_COOKIE, SESSION_TTL_MS } from './cookie'

// Re-exported from lib/session/cookie.ts (the edge-safe module) so every
// existing import site (`from '@/lib/session/store'`) keeps working
// unchanged. middleware.ts imports SESSION_COOKIE from './cookie' directly
// instead, so it never has to load this file's `node:crypto` import.
export { COOKIE_OPTIONS, SESSION_COOKIE, SESSION_TTL_MS }

export type Session = {
  id: string
  account_id: number
  created_at: number
  expires_at: number
}

/**
 * The session row carries identity and nothing else. The derived key lives in
 * lib/session/keymap.ts and is never written here — see CLAUDE.md > Data
 * safety.
 */
export function createSession(db: PlatformDb, accountId: number): string {
  const id = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare(
    'INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(id, accountId, now, now + SESSION_TTL_MS)
  return id
}

export function readSession(
  db: PlatformDb,
  sessionId: string,
): Session | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Session
    | undefined
  if (!row) return undefined
  if (row.expires_at <= Date.now()) {
    dropKey(sessionId)
    return undefined
  }
  return row
}

export function destroySession(db: PlatformDb, sessionId: string): void {
  dropKey(sessionId)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}
