import type { PlatformDb } from './platform'

export type TranscriptRow = {
  id: number
  account_id: number
  session_id: string
  conversation_id: string
  prompt_sha: string
  role: string
  body: string
  at: number
}

/**
 * transcripts and metrics are append-only (CLAUDE.md > Sacred data). This
 * module exposes appends and reads and nothing else. The database enforces
 * the same rule with triggers, so a mistake here fails loudly rather than
 * silently rewriting history.
 */
export function appendTranscript(
  db: PlatformDb,
  row: {
    accountId: number
    sessionId: string
    conversationId: string
    promptSha: string
    role: string
    body: string
    at: number
  },
): void {
  db.prepare(
    `INSERT INTO transcripts
     (account_id, session_id, conversation_id, prompt_sha, role, body, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.accountId,
    row.sessionId,
    row.conversationId,
    row.promptSha,
    row.role,
    row.body,
    row.at,
  )
}

export function readTranscript(
  db: PlatformDb,
  accountId: number,
): TranscriptRow[] {
  return db
    .prepare('SELECT * FROM transcripts WHERE account_id = ? ORDER BY at, id')
    .all(accountId) as TranscriptRow[]
}

/** The newest row for one account, or undefined if they have never written. */
export function lastTranscriptRow(
  db: PlatformDb,
  accountId: number,
): TranscriptRow | undefined {
  return db
    .prepare(
      'SELECT * FROM transcripts WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT 1',
    )
    .get(accountId) as TranscriptRow | undefined
}

export function appendMetric(
  db: PlatformDb,
  row: {
    accountId: number | null
    event: string
    data?: unknown
    at: number
  },
): void {
  db.prepare(
    'INSERT INTO metrics (account_id, event, data, at) VALUES (?, ?, ?, ?)',
  ).run(
    row.accountId,
    row.event,
    row.data === undefined ? null : JSON.stringify(row.data),
    row.at,
  )
}
