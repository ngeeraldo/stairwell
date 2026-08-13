// lib/db/specs.ts
import type { PlatformDb } from './platform'

/**
 * One proposal, with its derived version and confirmation state.
 *
 * `payload` is the raw JSON string as stored. Callers parse it with
 * parseLegacySpecPayload (lib/spec/legacy.ts) — this module does appends and
 * reads and nothing else, matching lib/db/appendOnly.ts.
 */
export type SpecRecord = {
  id: number
  account_id: number
  conversation_id: string
  prompt_sha: string
  payload: string
  mockup_html: string
  at: number
  /** The FIRST confirmation's timestamp, or null if never confirmed. */
  confirmed_at: number | null
  /** Position in the account's proposal list, oldest = 1. Derived, never stored. */
  version: number
}

export function insertSpec(
  db: PlatformDb,
  row: {
    accountId: number
    conversationId: string
    promptSha: string
    payload: unknown
    mockupHtml: string
    at: number
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO specs
       (account_id, conversation_id, prompt_sha, payload, mockup_html, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.accountId,
      row.conversationId,
      row.promptSha,
      JSON.stringify(row.payload),
      row.mockupHtml,
      row.at,
    )
  return Number(info.lastInsertRowid)
}

/**
 * One account's proposals, newest first.
 *
 * confirmed_at comes from a scalar subquery taking MIN(at), not a LEFT JOIN:
 * a JOIN would duplicate a spec row for every confirmation, and the
 * concurrent-confirm race (design spec section 12) can produce two. MIN is
 * also the honest value — the first confirmation is when the friend decided.
 *
 * `version` is derived from position so it can neither drift nor race.
 */
export function readSpecs(db: PlatformDb, accountId: number): SpecRecord[] {
  const rows = db
    .prepare(
      `SELECT s.*,
              (SELECT MIN(c.at) FROM spec_confirmations c WHERE c.spec_id = s.id)
                AS confirmed_at
       FROM specs s
       WHERE s.account_id = ?
       ORDER BY s.at DESC, s.id DESC`,
    )
    .all(accountId) as Omit<SpecRecord, 'version'>[]

  // Newest first, so the first row is the highest version.
  return rows.map((row, index) => ({ ...row, version: rows.length - index }))
}

/**
 * The proposal at a given version number. Version is derived from position
 * (see readSpecs), so this walks the same derivation rather than adding a
 * WHERE clause that could disagree with it.
 */
export function specByVersion(
  db: PlatformDb,
  accountId: number,
  version: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId).find((s) => s.version === version)
}

export function newestSpec(
  db: PlatformDb,
  accountId: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId)[0]
}

/** The newest proposal that has a confirmation. The build contract. */
export function currentSpec(
  db: PlatformDb,
  accountId: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId).find((s) => s.confirmed_at !== null)
}

export function hasConfirmedSpec(db: PlatformDb, accountId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM spec_confirmations c
       JOIN specs s ON s.id = c.spec_id
       WHERE c.account_id = ? AND s.account_id = ?
       LIMIT 1`,
    )
    .get(accountId, accountId)
  return row !== undefined
}

export function confirmSpec(
  db: PlatformDb,
  row: { specId: number; accountId: number; at: number },
): void {
  // Look up the spec to validate it belongs to the provided account. Without this
  // check, readSpecs and hasConfirmedSpec would disagree forever on a mismatched
  // (specId, accountId) pair: readSpecs ignores confirmation.account_id and joins
  // only on spec_id, while hasConfirmedSpec requires both account_ids to match.
  // Since spec_confirmations is append-only, a bad row cannot be deleted later.
  const spec = db
    .prepare('SELECT account_id FROM specs WHERE id = ?')
    .get(row.specId) as { account_id: number } | undefined
  if (!spec || spec.account_id !== row.accountId) {
    throw new Error(
      `Cannot confirm spec ${row.specId}: does not belong to account ${row.accountId}`,
    )
  }

  db.prepare(
    'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
  ).run(row.specId, row.accountId, row.at)
}
