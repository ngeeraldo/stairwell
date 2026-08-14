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

export type Conversation = { id: string; rows: TranscriptRow[] }

/**
 * One account's transcript, grouped into conversations.
 *
 * Newest conversation first (the admin pane wants the current one at the top);
 * rows inside a conversation oldest-first, because that is reading order.
 */
export function readConversations(
  db: PlatformDb,
  accountId: number,
): Conversation[] {
  const groups = new Map<string, TranscriptRow[]>()
  for (const row of readTranscript(db, accountId)) {
    const existing = groups.get(row.conversation_id)
    if (existing) existing.push(row)
    else groups.set(row.conversation_id, [row])
  }
  return [...groups.entries()]
    .map(([id, rows]) => ({ id, rows }))
    .sort((a, b) => {
      // Every group is seeded with at least one row in the loop above, so
      // rows[0] always exists; the `!` only satisfies
      // noUncheckedIndexedAccess, it doesn't add a new runtime guarantee.
      return b.rows[0]!.at - a.rows[0]!.at
    })
}

/**
 * Whether this account already has a row for `event`.
 *
 * THE SECOND METRICS ROW IN THIS CODEBASE THAT IS SYSTEM STATE RATHER THAN
 * TELEMETRY (onboarding ledger D8). `deploy_announced` was the first
 * (unified-loop D16); `first_session_start` is this one — the shell asks
 * whether it has already fired before firing it.
 *
 * Accepted for the same reasons: `metrics` rejects UPDATE and DELETE at the
 * database, so the row cannot be edited or removed through the application.
 * THE HAZARD IS A HUMAN ONE. Someone pruning metrics as disposable telemetry
 * would make a months-old account report a first session again, and there is
 * no way to tell afterwards which rows were real. CLAUDE.md's sacred-data
 * section names both events for exactly that reason.
 */
/**
 * When this account last did anything, or `undefined` if they never have.
 *
 * The admin index sorts by it, so Nico opens the portal and sees who has been
 * using the thing rather than an alphabetical list — which is the whole point
 * of a monitoring surface during a pilot.
 *
 * MAX over both append-only tables: transcripts alone would miss a friend who
 * opened their dashboard every morning and never typed anything, and metrics
 * alone would miss nothing today but would the moment an event stops being
 * written for some interaction. Neither table is read for CONTENT here — only
 * for the timestamp — so this stays inside what the onboarding promise covers.
 *
 * `undefined`, never 0. A friend who has done nothing has no last activity,
 * and rendering that as a 1970 date would be a small lie in the one place
 * Nico looks to decide whether to worry about someone.
 */
export function lastActivityAt(
  db: PlatformDb,
  accountId: number,
): number | undefined {
  const row = db
    .prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT at FROM transcripts WHERE account_id = ?
         UNION ALL
         SELECT at FROM metrics WHERE account_id = ?
       )`,
    )
    .get(accountId, accountId) as { at: number | null }
  return row.at ?? undefined
}

export function hasMetric(
  db: PlatformDb,
  accountId: number,
  event: string,
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM metrics WHERE account_id = ? AND event = ? LIMIT 1')
      .get(accountId, event) !== undefined
  )
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
