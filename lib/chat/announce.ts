// lib/chat/announce.ts
//
// The builder speaking through the agent surface: a deploy landing, or a
// mid-build question only the friend can answer. File 02 §4 asks for both to
// arrive in chat, and chat is the log of record, so they are ordinary
// assistant transcript rows — written by an operator CLI, not by a model.
//
// session_id is unconditionally the sentinel 'operator': there is never a
// real session behind a row this module writes, drafted or not. prompt_sha
// is conditional — the same sentinel when no prompt produced the row (an
// operator typing a question by hand, or announceDeploy's --plain path),
// but the real drafting prompt's content hash when one did (a DRAFTED
// announcement). Every other row in the table can be traced to the exact
// prompt text behind it; a row with prompt_sha = OPERATOR_SHA says,
// permanently, that there was none. transcripts is append-only — the
// distinction has to be right at write time or not at all.
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript } from '@/lib/db/appendOnly'
import { conversationIdFor } from '@/lib/chat/conversation'
import { currentSpec, hasConfirmedSpecBelow } from '@/lib/db/specs'
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
  input: { accountId: number; body: string; at: number; promptSha?: string },
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
    // session_id is unconditionally the sentinel — there is never a real
    // session behind a row this module writes, and it is the sentinel value
    // CLAUDE.md and the ledger point at.
    sessionId: OPERATOR_SHA,
    conversationId: conversation.id,
    // prompt_sha is conditional, unlike session_id above: OPERATOR_SHA means
    // "no prompt produced this row" (an operator typing it by hand, or the
    // --plain path). A DRAFTED announcement did have a prompt behind it, so
    // it names that prompt's hash instead — the sentinel keeps meaning what
    // it says.
    promptSha: input.promptSha ?? OPERATOR_SHA,
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

/** What an announcement would be about, or why there is nothing to say. */
export type AnnounceTarget =
  | {
      ok: true
      accountId: number
      specId: number
      version: number
      /** The confirmed version's change_summary, or a legacy row's title. */
      headline: string
      /** Whether this is the account's first dashboard (ledger D9). */
      first: boolean
    }
  | { ok: false; reason: 'no_confirmed_spec' | 'already_announced' }

/**
 * Decide, without writing anything and without spending a model call.
 *
 * Split out from announceDeploy so scripts/announce-deploy.ts can answer
 * "is there anything to announce?" BEFORE paying to draft a sentence — and so
 * its dry run can print a draft while writing neither the transcript row nor
 * the deploy_announced metric that would make the real send a no-op.
 */
export function announceTarget(db: PlatformDb, slug: string): AnnounceTarget {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  const spec = currentSpec(db, account.id)
  if (!spec) return { ok: false, reason: 'no_confirmed_spec' }
  if (alreadyAnnounced(db, account.id, spec.id)) {
    return { ok: false, reason: 'already_announced' }
  }

  // The renderer's own discriminator, reused rather than re-implemented: a
  // legacy row has no change_summary field at all, so headline falls back to
  // the title. Saying something generic beats saying nothing on the one
  // morning the promise ("your build landed") is being kept.
  const stored = readStoredSpec(spec.payload)
  const headline =
    stored.kind === 'version' ? stored.version.change_summary : stored.payload.title

  return {
    ok: true,
    accountId: account.id,
    specId: spec.id,
    version: spec.version,
    headline,
    first: !hasConfirmedSpecBelow(db, account.id, spec.version),
  }
}

/**
 * The two fixed sentences, unchanged and still fixed chrome.
 *
 * "Rebuilt" is false on the one morning it matters most: a first build had
 * nothing to rebuild. Bounded by hasConfirmedSpecBelow, the same question and
 * the same helper the delivery promise on the card uses (ledger D9), so the
 * sentence that promised the build and the sentence announcing it cannot
 * disagree about which one this was.
 */
export function plainBody(headline: string, first: boolean): string {
  return first
    ? `Your dashboard is live: ${headline}`
    : `Your dashboard was just rebuilt: ${headline}`
}

/**
 * The success arm of AnnounceTarget, narrowed for callers that write.
 *
 * A target is a thing `announceTarget` DECIDED, not a record a caller may
 * assemble by hand. Typing `commitAnnouncement`'s first parameter as this
 * (rather than a bespoke `{ accountId, specId, version }` literal) means the
 * compiler, not a convention, is what stops a caller hand-constructing a
 * `specId`/`version` that never went through `announceTarget`'s
 * `alreadyAnnounced` check — which is exactly the check whose bypass would
 * post a permanent duplicate into an append-only transcript.
 */
export type ConfirmedTarget = Extract<AnnounceTarget, { ok: true }>

/**
 * Write the announcement and its guard row, together or not at all.
 *
 * The transaction is the whole idempotency guarantee: two independent INSERTs
 * would leave the failure open where the transcript commits and the metric
 * does not, so the next run sees "not yet announced" and posts a second,
 * permanent duplicate into a table that rejects DELETE.
 */
export function commitAnnouncement(
  db: PlatformDb,
  target: ConfirmedTarget,
  write: {
    body: string
    /** announce-v1.md's hash, or OPERATOR_SHA for the --plain path. */
    promptSha: string
    at: number
  },
): void {
  db.transaction(() => {
    announce(db, {
      accountId: target.accountId,
      body: write.body,
      at: write.at,
      promptSha: write.promptSha,
    })
    appendMetric(db, {
      accountId: target.accountId,
      event: 'deploy_announced',
      at: write.at,
      data: { spec_id: target.specId, version: target.version },
    })
  })()
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
 *
 * The fixed-sentence path, unchanged in behaviour and still the --plain
 * valve. Now expressed in terms of the two functions above rather than
 * duplicating them, so there is one place that decides and one place that
 * writes.
 */
export function announceDeploy(
  db: PlatformDb,
  slug: string,
  now: () => number,
): AnnounceDeployResult {
  const target = announceTarget(db, slug)
  if (!target.ok) return { announced: false, reason: target.reason }

  commitAnnouncement(db, target, {
    body: plainBody(target.headline, target.first),
    promptSha: OPERATOR_SHA,
    at: now(),
  })
  return { announced: true }
}
