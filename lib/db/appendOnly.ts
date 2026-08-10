import type { PlatformDb } from './platform'

export type TranscriptRow = {
  id: number
  account_id: number
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
  row: { accountId: number; role: string; body: string; at: number },
): void {
  db.prepare(
    'INSERT INTO transcripts (account_id, role, body, at) VALUES (?, ?, ?, ?)',
  ).run(row.accountId, row.role, row.body, row.at)
}

export function readTranscript(
  db: PlatformDb,
  accountId: number,
): TranscriptRow[] {
  return db
    .prepare('SELECT * FROM transcripts WHERE account_id = ? ORDER BY at')
    .all(accountId) as TranscriptRow[]
}

export function appendMetric(
  db: PlatformDb,
  row: { accountId: number | null; event: string; at: number },
): void {
  db.prepare(
    'INSERT INTO metrics (account_id, event, at) VALUES (?, ?, ?)',
  ).run(row.accountId, row.event, row.at)
}
