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
// FINAL REVIEW, IMPORTANT 4. `--send` used to re-run draftAnnouncement even
// after a dry run had already produced and shown a sentence — a second,
// independent model sample, not the one Nico read. The ten seconds it takes
// to read a dry run is only a real gate if the sentence read is the sentence
// written; a re-draft makes it a gate on a DIFFERENT sentence. Two things
// close that:
//   --body-file <path>  Send exactly that file's bytes, verbatim, with NO
//                        model call — the way to actually send the sentence
//                        a dry run already showed: copy it to a file, then
//                        `--send --body-file <path>`.
//   no --body-file       `--send` still drafts fresh (unavoidable — there is
//                        no other source for a first sentence) but now PRINTS
//                        A WARNING that what is about to be written is a new
//                        sample and may not match any earlier dry run read.
// commitAnnouncement also re-checks its own idempotency guard INSIDE the
// write transaction now (lib/chat/announce.ts) — the read this file does
// against announceTarget happens before any drafting, so two concurrent
// --send runs could otherwise both see "not yet announced" and both commit.
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
//
// REFUSES TO RUN if PLATFORM_DB is unset, rather than falling back to
// platform/dev/synthetic.db. A non-interactive `ssh` loads no profile and no
// EnvironmentFile, so a forgotten $STAIRWELL prelude on the droplet is
// exactly the state a fallback would hit — and a fallback there would draft
// or send an announcement into a synthetic account instead of the friend's
// real chat, silently, while Nico believes it landed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { readTranscript } from '@/lib/db/appendOnly'
import { toMessages } from '@/lib/chat/history'
import { friendFacing, NotesMissingError, readBuildNotes, type BuildNotes } from '@/lib/build/notes'
import {
  AlreadyAnnouncedError,
  announceTarget,
  commitAnnouncement,
  plainBody,
  OPERATOR_SHA,
} from '@/lib/chat/announce'
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
    // --body-file named a path that could not be read as UTF-8 text — a typo,
    // a missing file, a directory. Final review, Important 4.
    | 'body_file_invalid'
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
 * Substrings that mean a --body-file holds a terminal transcript, not prose.
 *
 * A crude check on purpose. It cannot know what a friend's announcement should
 * say, so it only refuses text that could not plausibly BE one — and the cost
 * of a false positive is rewording a sentence, while the cost of a miss is a
 * permanent row in a transcript that rejects DELETE.
 *
 * Every entry is drawn from the paste that made this necessary: the runbook's
 * own step-9 command block, sent to a friend on 2026-08-18 because `pbpaste`
 * read a clipboard that still held it.
 *
 * This is the SECOND of two independent guards, and the weaker one. The first
 * is that stdout now carries only the body, so the documented flow never puts
 * a human hand between the draft and the send. This exists for the case where
 * someone assembles the file some other way.
 */
const SHELL_MARKERS = ['ssh ', 'scp ', 'npx tsx', '$DROPLET', '$STAIRWELL', '$FRIEND']

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
  opts: { slug: string; send: boolean; plain: boolean; bodyFile?: string },
): Promise<AnnounceOutcome> {
  const warnings: string[] = []

  // --plain and --body-file are two different ways to skip drafting — a
  // fixed sentence versus Nico's own reviewed bytes. Neither implies the
  // other, and accepting both silently would mean one of them is ignored
  // without saying so.
  if (opts.plain && opts.bodyFile) {
    return {
      kind: 'draft_failed',
      message: '--plain and --body-file both skip drafting in different ways — pass exactly one.',
      warnings,
    }
  }

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

  if (opts.bodyFile) {
    // Verbatim, no model call — Nico's own reviewed bytes, read fresh off
    // disk on every invocation rather than cached, so this always sends
    // exactly what is on disk right now. promptSha stays OPERATOR_SHA: no
    // prompt produced this text, same reasoning as --plain below.
    try {
      body = readFileSync(opts.bodyFile, 'utf8')
    } catch (error) {
      return {
        kind: 'body_file_invalid',
        message: `could not read --body-file '${opts.bodyFile}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        warnings,
      }
    }
    const shellish = SHELL_MARKERS.find((marker) => body.includes(marker))
    if (shellish !== undefined) {
      return {
        kind: 'body_file_invalid',
        message:
          `--body-file '${opts.bodyFile}' contains ${JSON.stringify(shellish)}, ` +
          'which reads as a shell command rather than a message to a friend. ' +
          'Nothing was sent. Re-draft and pipe it through `tee` — ' +
          'docs/runbook.md step 9.',
        warnings,
      }
    }
  } else if (opts.plain) {
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

      // Final review, Important 4. On a dry run this warning would be noise
      // — nothing is being written, and the whole POINT of a dry run is to
      // read this exact sentence before deciding. On --send there is no
      // earlier reviewed text to compare against: this call just drew a
      // fresh, independent sample, so if Nico is picturing an earlier dry
      // run's wording, what is about to be written permanently may not
      // match it.
      if (opts.send) {
        warnings.push(
          '--send just drafted a FRESH sentence — a new model sample, not necessarily the one from an earlier dry run. ' +
            'To send exactly reviewed text, save it to a file and re-run with --body-file <path>.',
        )
      }
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

  try {
    commitAnnouncement(deps.db, target, { body, promptSha, at: deps.now() })
  } catch (error) {
    // The transaction's own re-check (lib/chat/announce.ts, final review
    // Important 4) — a concurrent --send for the same account won the race
    // and committed first. Report it the same way announceTarget's earlier,
    // pre-drafting check would have, not as a crash: nothing failed, there is
    // just nothing left to do.
    if (error instanceof AlreadyAnnouncedError) {
      return {
        kind: 'already_announced',
        message: `the confirmed build for '${opts.slug}' was already announced — nothing to do`,
        warnings,
      }
    }
    throw error
  }
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
    throw new Error('--plain/--body-file must never call the model client')
  },
  async propose() {
    throw new Error('--plain/--body-file must never call the model client')
  },
}

/**
 * Which client runAnnounce gets, decided from the two flags that skip
 * drafting — pulled out of the CLI wrapper so this decision is unit tested
 * directly instead of only through a subprocess.
 *
 * --plain never touches the model: constructing the real client would throw
 * MissingCredentialError when ANTHROPIC_API_KEY is unset — exactly the
 * situation --plain exists to route around (see deploy/required-env's
 * ANTHROPIC_API_KEY note). --body-file (final review, Important 4) is the
 * same situation from the opposite direction — Nico's own reviewed text,
 * verbatim, no model call — so it gets the same stub for the same reason:
 * requiring a credential neither path will ever use would be its own bug.
 * Throws synchronously when neither is set and no credential is present,
 * same as anthropicClient() itself.
 */
export function resolveClient(plain: boolean, bodyFile?: string): ChatClient {
  return plain || bodyFile ? NEVER_CALLED_CLIENT : anthropicClient()
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
    'body_file_invalid',
  ]
  return refusal.includes(kind) ? 1 : 0
}

/**
 * No fallback — see the header comment. `??` only catches null/undefined, so
 * an explicit empty string (`PLATFORM_DB=` with nothing after it) is checked
 * for by hand or it would resolve to the cwd.
 */
export function resolvePlatformDbPath(): string {
  if (!process.env.PLATFORM_DB) {
    console.error(
      'Refusing to run: PLATFORM_DB is not set.\n\n' +
        'This script never falls back to a synthetic database — a fallback ' +
        'on the droplet would draft or send an announcement into a ' +
        "synthetic account instead of the friend's real chat, silently. " +
        'Set it explicitly, e.g.:\n\n' +
        '  PLATFORM_DB=platform/dev/synthetic.db npx tsx scripts/announce-deploy.ts <slug>',
    )
    process.exit(1)
  }
  return resolve(process.env.PLATFORM_DB)
}

if (process.argv[1]?.endsWith('announce-deploy.ts')) {
  // Wrapped in an async IIFE rather than a bare top-level `await`. This repo
  // has no `"type": "module"` in package.json, so `npx tsx` transpiles a
  // plain .ts entry point to CommonJS, and CommonJS cannot contain top-level
  // await — esbuild refuses at transform time, before a single line of this
  // file runs. Found while proving the PLATFORM_DB refusal below actually
  // works end to end: it did not, because the process never started.
  // `void ... .catch(...)` is what stands in for the crash a bare top-level
  // await would have surfaced as an unhandled rejection instead.
  void (async () => {
    const args = process.argv.slice(2)
    // --body-file takes a value, so its argument (and the flag itself) must be
    // excluded before scanning for the positional slug — otherwise the path
    // would be mistaken for the slug.
    const bodyFileIndex = args.indexOf('--body-file')
    const bodyFile = bodyFileIndex === -1 ? undefined : args[bodyFileIndex + 1]
    if (bodyFileIndex !== -1 && bodyFile === undefined) {
      console.error('--body-file requires a path argument')
      process.exit(2)
    }
    const slug = args.find(
      (a, i) => !a.startsWith('--') && (bodyFileIndex === -1 || i !== bodyFileIndex + 1),
    )
    const send = args.includes('--send')
    const plain = args.includes('--plain')
    if (!slug) {
      console.error(
        'usage: tsx scripts/announce-deploy.ts <slug> [--send] [--plain] [--body-file <path>]',
      )
      process.exit(2)
    }

    let client: ChatClient
    try {
      client = resolveClient(plain, bodyFile)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    const db = openPlatformDb(resolvePlatformDbPath())
    try {
      const out = await runAnnounce({ db, client, now: Date.now }, { slug, send, plain, bodyFile })
      for (const w of out.warnings) console.error(`warning: ${w}`)
      // STDOUT CARRIES THE BODY AND NOTHING ELSE. Everything else — warnings
      // above, the status line below — goes to stderr, so that
      //
      //   ssh ... announce-deploy.ts <slug> | tee /tmp/announce-<slug>.txt
      //
      // produces a file holding exactly the sentence, ready to hand straight
      // back to --body-file. docs/runbook.md step 9 depends on this split.
      //
      // It used to print the status line here too, which is why that step told
      // you to route the draft through the CLIPBOARD instead. That cost a real
      // friend a real message: on 2026-08-18 the clipboard still held the
      // runbook's own command block, `pbpaste` wrote three shell commands into
      // the file, and --body-file posted them verbatim into an append-only
      // transcript that rejects DELETE. The clipboard was ambient state
      // standing between reading a sentence and sending it; this removes the
      // reason it was ever there.
      if (out.body) console.log(out.body)
      console.error(out.message)
      const code = exitCodeFor(out.kind)
      if (code !== 0) process.exit(code)
    } finally {
      db.close()
    }
  })().catch((error) => {
    // A throw that escapes runAnnounce entirely (e.g. announceTarget's "no
    // account with slug") — every EXPECTED refusal already returns an
    // AnnounceOutcome and is handled above via exitCodeFor. Printed as a
    // message, not swallowed as a silent process exit 1 the way an unhandled
    // rejection otherwise would.
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
