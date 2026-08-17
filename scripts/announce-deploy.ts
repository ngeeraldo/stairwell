// scripts/announce-deploy.ts
//
// Turns one build's friend-facing notes into "your build landed", posted
// into one account's chat, once per confirmed spec version. Run BY NICO, by
// hand, right after a deploy that shipped that specific account's build.
//
// DRAFTS BY DEFAULT and only sends on --send: this writes into an
// append-only transcript a real person reads, and transcripts rejects
// DELETE, so a mistaken run has to be free to throw away rather than free to
// undo. --plain sends the fixed sentence instead of a drafted one and makes
// no model call — the deliberate valve for the moment drafting itself is
// unavailable (see deploy/required-env's ANTHROPIC_API_KEY note).
//
// THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico.
// That is consistent with CLAUDE.md: the platform database is not encrypted
// with any user key and holds the records Nico is promised access to at
// onboarding. It is NOT consistent with Claude running it locally against
// anything but the synthetic database. PLATFORM_DB is what selects the
// database — always explicit, never ambient (see lib/db/platform.ts) — so
// point it at a synthetic one. --send and --plain are the only flags this
// file takes, and neither touches which database opens.
//
// Deliberately NOT called from deploy/deploy.sh. deploy.sh deploys the whole
// service, not one user's dashboard — wiring this in would post "your
// dashboard is live" into every account's chat on every push, which is a
// permanent lie in an append-only transcript for every account that was not
// the reason for that particular deploy. This stays a one-line command Nico
// runs for the specific account whose build just shipped.
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { readTranscript } from '@/lib/db/appendOnly'
import { toMessages } from '@/lib/chat/history'
import { friendFacing, NotesMissingError, readBuildNotes, type BuildNotes } from '@/lib/build/notes'
import { announceTarget, commitAnnouncement, plainBody, OPERATOR_SHA } from '@/lib/chat/announce'
import { draftAnnouncement } from '@/lib/chat/draftAnnouncement'
import { anthropicClient, type ChatClient } from '@/lib/chat/client'

/** How much conversation the drafter sees, so it can omit what they know. */
const RECENT_TURNS = 12

export type AnnounceOutcome = {
  kind:
    | 'announced'
    | 'drafted'
    | 'already_announced'
    | 'no_confirmed_spec'
    | 'notes_missing'
    | 'notes_invalid'
    | 'draft_failed'
  message: string
  body?: string
  warnings: string[]
}

export type AnnounceDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  usersDir?: string
}

/**
 * The whole command, as a function, so every branch is testable without a
 * subprocess. The CLI below parses argv, calls resolveClient and this
 * function, and prints; every DECISION it makes (which client, which exit
 * code) is pulled out into its own small exported function below
 * (resolveClient, exitCodeFor) so the claim "the wrapper holds no logic" is
 * true of the code, not just of this comment.
 *
 * ORDER MATTERS. The target is resolved FIRST: an already-announced version
 * must not pay for a drafting call, and a missing notes file must refuse
 * before one too.
 */
export async function runAnnounce(
  deps: AnnounceDeps,
  opts: { slug: string; send: boolean; plain: boolean },
): Promise<AnnounceOutcome> {
  const warnings: string[] = []
  const target = announceTarget(deps.db, opts.slug)
  if (!target.ok) {
    return {
      kind: target.reason,
      message:
        target.reason === 'already_announced'
          ? // No version number to name here — AnnounceTarget's false arm
            // does not carry one (see lib/chat/announce.ts). Reworded rather
            // than printing a literal placeholder, which reads at a terminal
            // as a forgotten template value.
            `the confirmed build for '${opts.slug}' was already announced — nothing to do`
          : `no confirmed spec for '${opts.slug}'`,
      warnings,
    }
  }

  let body: string
  let promptSha = OPERATOR_SHA

  if (opts.plain) {
    // The valve. No notes read, no model call: this exists for the moment the
    // API is down and the announcement still has to go out.
    body = plainBody(target.headline, target.first)
  } else {
    let notes: BuildNotes
    try {
      notes = readBuildNotes(opts.slug, target.version, deps.usersDir)
    } catch (error) {
      if (error instanceof NotesMissingError) {
        return { kind: 'notes_missing', message: error.message, warnings }
      }
      return {
        kind: 'notes_invalid',
        message: error instanceof Error ? error.message : String(error),
        warnings,
      }
    }

    // A ROUTING INSTRUCTION, NOT A DISCLOSURE (design §3.5). Nico is told, at
    // the one moment he is already looking, that a conversation is owed. It
    // never blocks: what landed should be announced, what did not land needs a
    // chat, and neither should hold up the other.
    if (notes.open.trim() !== '') {
      warnings.push(
        `notes v${target.version} has a non-empty "## Open" — take it back to ` +
          `${opts.slug}'s chat (scripts/ask-user.ts, or a new proposal). It is ` +
          `NOT in this announcement.`,
      )
    }

    try {
      const history = toMessages(readTranscript(deps.db, target.accountId))
      const recent = history.slice(-RECENT_TURNS)
      // D17 (unified-loop ledger). draftAnnouncement appends a role:'user'
      // message after whatever `recent` ends with. toMessages already folds
      // consecutive same-role TRANSCRIPT rows into one message, so `recent`
      // itself never has two turns of the same role back to back — but if the
      // very LAST turn is a user turn (the friend's latest message has no
      // reply yet — readTranscript makes no promise otherwise), appending
      // another user turn here reintroduces exactly the shape that fold
      // exists to prevent, just for a request built by this call rather than
      // for stored rows. Anthropic's own docs disagree on whether that is a
      // 400 or a silent merge, and the two are wildly asymmetric — a 400 here
      // would surface as a permanent, unexplained draft_failed. Drop the
      // trailing user turn rather than gamble on which reading is live.
      if (recent.length > 0 && recent[recent.length - 1]!.role === 'user') {
        recent.pop()
      }
      const draft = await draftAnnouncement(
        { client: deps.client },
        {
          notes: friendFacing(notes),
          changeSummary: target.headline,
          recent,
          signal: new AbortController().signal,
        },
      )
      body = draft.message
      promptSha = draft.promptSha
    } catch (error) {
      // REFUSE, never fall back. A quiet fallback would produce a normal-looking
      // announcement that never read the notes — the failure nobody notices.
      // --plain is the deliberate, named way to send the fixed sentence.
      return {
        kind: 'draft_failed',
        message:
          (error instanceof Error ? error.message : String(error)) +
          '\nRe-run when it is back, or use --plain to send the fixed sentence.',
        warnings,
      }
    }
  }

  if (!opts.send) {
    return {
      kind: 'drafted',
      message: `DRY RUN — nothing written. Re-run with --send to post it.`,
      body,
      warnings,
    }
  }

  commitAnnouncement(deps.db, target, { body, promptSha, at: deps.now() })
  return { kind: 'announced', message: `announced v${target.version} to '${opts.slug}'`, body, warnings }
}

/**
 * A client that must never be called, used when --plain is passed: no model
 * call is meant to happen, so constructing the real anthropicClient() would
 * defeat the valve's own purpose (it throws MissingCredentialError when
 * ANTHROPIC_API_KEY is unset — exactly the situation --plain exists for).
 * If runAnnounce's --plain branch ever changed to call the client by
 * mistake, this throws loudly instead of silently succeeding against a real
 * key that happened to be present.
 */
const NEVER_CALLED_CLIENT: ChatClient = {
  async stream() {
    throw new Error('--plain must never call the model client')
  },
  async propose() {
    throw new Error('--plain must never call the model client')
  },
}

/**
 * Which client runAnnounce gets, decided from one flag — pulled out of the
 * CLI wrapper so this decision is unit tested directly instead of only
 * through a subprocess.
 *
 * --plain never touches the model: constructing the real client would throw
 * MissingCredentialError when ANTHROPIC_API_KEY is unset — exactly the
 * situation --plain exists to route around (see deploy/required-env's
 * ANTHROPIC_API_KEY note). Throws synchronously when !plain and no
 * credential is set, same as anthropicClient() itself.
 */
export function resolveClient(plain: boolean): ChatClient {
  return plain ? NEVER_CALLED_CLIENT : anthropicClient()
}

/**
 * The exit code for one outcome. A refusal must not exit 0 — Nico is reading
 * a terminal after a deploy, and a green exit on "notes missing" is the one
 * that gets skimmed past. Pulled out of the CLI wrapper for the same reason
 * as resolveClient: a real decision, unit tested directly.
 */
export function exitCodeFor(kind: AnnounceOutcome['kind']): number {
  const refusal: AnnounceOutcome['kind'][] = [
    'notes_missing',
    'notes_invalid',
    'draft_failed',
    'no_confirmed_spec',
  ]
  return refusal.includes(kind) ? 1 : 0
}

if (process.argv[1]?.endsWith('announce-deploy.ts')) {
  const args = process.argv.slice(2)
  const slug = args.find((a) => !a.startsWith('--'))
  const send = args.includes('--send')
  const plain = args.includes('--plain')
  if (!slug) {
    console.error('usage: tsx scripts/announce-deploy.ts <slug> [--send] [--plain]')
    process.exit(2)
  }

  let client: ChatClient
  try {
    client = resolveClient(plain)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const db = openPlatformDb(process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db')
  try {
    const out = await runAnnounce({ db, client, now: Date.now }, { slug, send, plain })
    for (const w of out.warnings) console.error(`warning: ${w}`)
    if (out.body) console.log(`\n${out.body}\n`)
    console.log(out.message)
    const code = exitCodeFor(out.kind)
    if (code !== 0) process.exit(code)
  } finally {
    db.close()
  }
}
