// lib/chat/announce.ts
//
// The builder speaking through the agent surface: a deploy landing, or a
// mid-build question only the friend can answer. File 02 §4 asks for both to
// arrive in chat, and chat is the log of record, so they are ordinary
// assistant transcript rows — written by an operator CLI, not by a model.
//
// prompt_sha is the sentinel 'operator' rather than a content hash, because
// this row was typed by a person and no prompt produced it. Every other row
// in the table can be traced to the exact prompt text behind it; this one
// says, permanently, that there was none. transcripts is append-only — the
// distinction has to be right at write time or not at all.
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript } from '@/lib/db/appendOnly'
import { conversationIdFor } from '@/lib/chat/conversation'
import { currentSpec } from '@/lib/db/specs'
import { readStoredSpec } from '@/lib/spec/stored'
import { findAccountBySlug } from '@/lib/auth/accounts'

export const OPERATOR_SHA = 'operator'

/**
 * Append one operator-authored assistant row to an account's transcript.
 *
 * A blank body throws instead of being written. `lib/chat/history.ts` drops
 * empty bodies for exactly this reason: the Messages API rejects empty text
 * content, so one such row would 400 every subsequent turn for that account —
 * forever, because transcripts is append-only and the row can never be
 * deleted. Refusing here is the only point where that can still be
 * prevented rather than merely worked around later.
 */
export function announce(
  db: PlatformDb,
  input: { accountId: number; body: string; at: number },
): void {
  if (input.body.trim() === '') {
    throw new Error(
      'announce: refusing to write a blank body — it would break every later turn for this account (see lib/chat/history.ts)',
    )
  }

  // Joins whatever conversation is already open (or starts a fresh one after
  // 30+ min of silence, same rule as every other message) rather than always
  // minting a new id — an announcement is part of the ongoing conversation,
  // not a stray thread of its own.
  const conversation = conversationIdFor(db, input.accountId, input.at)

  appendTranscript(db, {
    accountId: input.accountId,
    // There is no session for a row a human typed — OPERATOR_SHA fills both
    // slots that would otherwise carry session/prompt provenance, and it is
    // the sentinel value CLAUDE.md and the ledger point at.
    sessionId: OPERATOR_SHA,
    conversationId: conversation.id,
    promptSha: OPERATOR_SHA,
    role: 'assistant',
    body: input.body,
    at: input.at,
  })
}

export type AnnounceDeployResult =
  | { announced: true }
  | { announced: false; reason: 'no_confirmed_spec' | 'already_announced' }

/**
 * Whether `specId` already has a `deploy_announced` metric row.
 *
 * A plain scan-and-parse rather than a SQL `json_extract` filter: this is
 * the only reader of `deploy_announced` rows in the codebase, the metrics
 * table is tiny per account, and not depending on a SQLite build's JSON1
 * support keeps this correct regardless of how better-sqlite3-multiple-
 * ciphers was compiled.
 */
function alreadyAnnounced(db: PlatformDb, accountId: number, specId: number): boolean {
  const rows = db
    .prepare(`SELECT data FROM metrics WHERE account_id = ? AND event = 'deploy_announced'`)
    .all(accountId) as { data: string | null }[]
  return rows.some((row) => {
    if (!row.data) return false
    try {
      const parsed = JSON.parse(row.data) as { spec_id?: unknown }
      return parsed.spec_id === specId
    } catch {
      // A malformed data blob is not evidence of an announcement having
      // happened — treat it as absent rather than throwing, since this is a
      // read-path check, not the write that produced the row.
      return false
    }
  })
}

/**
 * Post a deploy announcement into an account's chat, once per confirmed spec
 * version.
 *
 * `deploy.sh` may run repeatedly against the same confirmed version — a
 * restart, a retry, a redeploy for an unrelated reason — and transcripts is
 * append-only, so a duplicate announcement would be permanent. The guard is
 * keyed on the CONFIRMED spec's id specifically (not "has this account ever
 * been announced to"), so a NEW confirmed version announces again: each
 * version is its own event.
 */
export function announceDeploy(
  db: PlatformDb,
  slug: string,
  now: () => number,
): AnnounceDeployResult {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  const spec = currentSpec(db, account.id)
  if (!spec) return { announced: false, reason: 'no_confirmed_spec' }

  if (alreadyAnnounced(db, account.id, spec.id)) {
    return { announced: false, reason: 'already_announced' }
  }

  // The renderer's own discriminator, reused rather than re-implemented: a
  // legacy row has no change_summary field at all, so the body falls back to
  // the title. Saying something generic beats saying nothing on the one
  // morning the promise ("your build landed") is being kept.
  const stored = readStoredSpec(spec.payload)
  const headline =
    stored.kind === 'version' ? stored.version.change_summary : stored.payload.title
  const body = `Your dashboard was just rebuilt: ${headline}`

  const at = now()
  // Both inserts commit together or not at all. Two independent INSERTs
  // here would leave one direction of failure open: transcript commits,
  // metric insert fails (disk full, a constraint, anything) — the
  // announcement is now permanently in the log, but the guard row
  // `alreadyAnnounced` checks does not exist, so the next run sees "not yet
  // announced" and posts a second, permanent duplicate into a table that
  // rejects DELETE. That is exactly the failure this idempotency check
  // exists to prevent, so it cannot be left open by the write that
  // implements the check. Wrapping both in one transaction closes it: a
  // failure on either insert rolls back both, so no half-announced state is
  // ever observable by a later run. A rollback of an uncommitted INSERT is
  // neither an UPDATE nor a DELETE against a committed row, so the
  // append-only triggers on `transcripts` and `metrics` are untouched.
  db.transaction(() => {
    announce(db, { accountId: account.id, body, at })
    appendMetric(db, {
      accountId: account.id,
      event: 'deploy_announced',
      at,
      data: { spec_id: spec.id, version: spec.version },
    })
  })()

  return { announced: true }
}
