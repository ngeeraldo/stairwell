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
// operator typing a question by hand, or scripts/announce-deploy.ts's
// --plain path), but the real drafting prompt's content hash when one did (a
// DRAFTED announcement). Every other row in the table can be traced to the
// exact prompt text behind it; a row with prompt_sha = OPERATOR_SHA says,
// permanently, that there was none. transcripts is append-only — the
// distinction has to be right at write time or not at all.
import { existsSync } from 'node:fs'
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript } from '@/lib/db/appendOnly'
import { conversationIdFor } from '@/lib/chat/conversation'
import { readSpecs, hasConfirmedSpecBelow } from '@/lib/db/specs'
import { notesPath } from '@/lib/build/notes'
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
  | { ok: false; reason: 'no_build_notes' | 'already_announced' }

/**
 * Decide, without writing anything and without spending a model call.
 *
 * So scripts/announce-deploy.ts's runAnnounce can answer "is there anything
 * to announce?" BEFORE paying to draft a sentence — and so its dry run can
 * print a draft while writing neither the transcript row nor the
 * deploy_announced metric that would make the real send a no-op.
 *
 * `usersDir` threads through to notesPath so a test can point it at a temp
 * tree; omitted, it defaults to lib/build/notes.ts's own production default.
 */
export function announceTarget(db: PlatformDb, slug: string, usersDir?: string): AnnounceTarget {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  // notes/v<n>.md exists only for a version that was actually built and
  // committed — a spec being authored (or even confirmed) proves someone
  // asked for it, never that it was built. So the notes file, not `specs`
  // itself, is what decides what can honestly be announced: walk versions
  // newest first and take the first one a notes file exists for on disk,
  // never parsing it here (a parse failure is runAnnounce's to report, with
  // its own message).
  const spec = readSpecs(db, account.id).find((s) =>
    existsSync(notesPath(slug, s.version, usersDir)),
  )
  if (!spec) return { ok: false, reason: 'no_build_notes' }
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
 * (rather than a bespoke `{ accountId, specId, version }` literal) does NOT
 * stop a caller hand-constructing one — TypeScript is structurally typed
 * with no branding, so a matching object literal still satisfies
 * `ConfirmedTarget` and would type-check. What it actually buys: the
 * narrowed type makes fabricating one by accident harder (there is no
 * `{ accountId, specId, version }` literal lying around to copy), and at
 * every real call site the value comes from `if (!target.ok) return ...`
 * control-flow narrowing on `announceTarget`'s own result — so in practice
 * a `ConfirmedTarget` reaching `commitAnnouncement` did go through the
 * `alreadyAnnounced` check, even though nothing in the type system enforces
 * that.
 */
export type ConfirmedTarget = Extract<AnnounceTarget, { ok: true }>

/**
 * Thrown by commitAnnouncement's own re-check, below — never by
 * announceTarget's read, which returns `{ ok: false, reason:
 * 'already_announced' }` instead of throwing. Two different shapes for the
 * same fact because they answer two different questions: announceTarget asks
 * "is there anything to do" before a caller has spent anything; this asks "is
 * it still true right now, inside the transaction that is about to commit."
 */
export class AlreadyAnnouncedError extends Error {
  constructor(specId: number) {
    super(`spec ${specId} was already announced`)
    this.name = 'AlreadyAnnouncedError'
  }
}

/**
 * Write the announcement and its guard row, together or not at all.
 *
 * The transaction is the whole idempotency guarantee: two independent INSERTs
 * would leave the failure open where the transcript commits and the metric
 * does not, so the next run sees "not yet announced" and posts a second,
 * permanent duplicate into a table that rejects DELETE.
 *
 * FINAL REVIEW, IMPORTANT 4: `alreadyAnnounced` is re-checked HERE, inside the
 * transaction, not just by the caller's earlier `announceTarget` read. Two
 * concurrent `--send` runs for the same account both read "not yet announced"
 * before either has written anything — announceTarget's own check cannot see
 * the other run's in-flight commit — and without a re-check at the point of
 * writing, both would post a real transcript row and a real deploy_announced
 * metric, permanently, into two append-only tables. The re-check and the
 * writes are one transaction (better-sqlite3's db.transaction is exclusive
 * for its whole body against another write transaction on the same
 * connection/database file), so the second run's re-check sees the first
 * run's commit and refuses instead of duplicating it.
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
    if (alreadyAnnounced(db, target.accountId, target.specId)) {
      throw new AlreadyAnnouncedError(target.specId)
    }
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

