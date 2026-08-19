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

/**
 * The newest proposal. The build contract.
 *
 * It used to be "the newest proposal that has a confirmation" — the friend
 * pressing Build this is what promoted a proposal to the thing Nico built.
 * Nothing confirms any more, so the newest spec IS the contract, and
 * `readSpecs` already returns newest-first.
 *
 * `confirmed_at` stays on SpecRecord and stays populated for rows that have a
 * historical confirmation. spec_confirmations is append-only and keeps every
 * row it holds; this function simply no longer asks about them.
 */
export function currentSpec(
  db: PlatformDb,
  accountId: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId)[0]
}

/** Whether this account has any spec at all. */
export function hasSpec(db: PlatformDb, accountId: number): boolean {
  const row = db
    .prepare('SELECT 1 FROM specs WHERE account_id = ? LIMIT 1')
    .get(accountId)
  return row !== undefined
}

/**
 * Every confirmation this account has made, oldest first.
 *
 * A confirmation is a transcript event (onboarding ledger D5a) and this is the
 * record of it — already permanent, already timestamped, already append-only.
 * The panel and the admin pane merge these into conversation order rather than
 * writing anything new.
 *
 * Walks readSpecs rather than joining and deriving a version number in SQL,
 * for the same reason specByVersion does: `version` comes from POSITION, and a
 * second derivation could disagree with the first.
 *
 * MIN(at) per spec, matching readSpecs' own confirmed_at: the concurrent-
 * confirm race can produce two rows, and the first one is when the friend
 * actually decided.
 */
export function readConfirmations(
  db: PlatformDb,
  accountId: number,
): { version: number; at: number }[] {
  return readSpecs(db, accountId)
    .filter((s) => s.confirmed_at !== null)
    .map((s) => ({ version: s.version, at: s.confirmed_at! }))
    .sort((a, b) => a.at - b.at)
}
