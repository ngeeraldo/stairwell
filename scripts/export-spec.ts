// scripts/export-spec.ts
//
// Prints one account's current spec (the newest one — nothing confirms any
// more) as JSON on stdout, together with the CONVERSATION that produced it:
// `{ spec_md, conversation_md }`. A change-only spec says what changed, not
// what the friend meant, so the transcript slice behind it travels with it
// (lib/spec/conversation.ts). Runs ON THE DROPLET, invoked by
// scripts/pull-spec.sh over ssh.
//
// That makes the JSON on stdout potentially LARGE — a whole conversation, not
// a page of markdown — which is why pull-spec.sh pipes it into
// write-spec-pair.ts on stdin rather than passing it as an argv argument.
//
// THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico.
// That is consistent with CLAUDE.md: the platform database is not encrypted
// with any user key and holds the records Nico is promised access to at
// onboarding. It is NOT consistent with Claude running it locally against
// anything but the synthetic database. This file takes no flag of its own —
// PLATFORM_DB is what selects the database, always explicit, never
// ambient (see lib/db/platform.ts) — so point it at a synthetic one.
// scripts/pull-spec.sh devtwo --local is the only form of this pull an
// agent runs; that script's --local is what passes a synthetic PLATFORM_DB
// through to this file.
//
// REFUSES TO RUN if PLATFORM_DB is unset, rather than falling back to
// platform/dev/synthetic.db. A non-interactive `ssh` loads no profile and no
// EnvironmentFile, so a forgotten $STAIRWELL prelude on the droplet is
// exactly the state a fallback would hit — and a fallback there would write
// synthetic data into a friend's users/<slug>/spec.md as if it were their
// real spec, silently, with no error telling Nico it happened.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { readTranscript } from '@/lib/db/appendOnly'
import { currentSpec, readSpecs } from '@/lib/db/specs'
import { readStoredSpec } from '@/lib/spec/stored'
import { conversationRows, renderConversationMarkdown } from '@/lib/spec/conversation'
import { notesPath } from '@/lib/build/notes'
import { renderChangeMarkdown, renderLegacyMarkdown, renderSpecMarkdown } from '@/lib/spec/render'

/**
 * `usersDir` threads through to notesPath, exactly as it does on
 * lib/chat/announce.ts's announceTarget, so a test can point the
 * "was this version built?" lookup at a temp tree; omitted, it defaults to
 * lib/build/notes.ts's own production default. The CLI entry point below
 * never passes it — on the droplet the real `users/` tree is the answer.
 */
export function exportSpec(
  db: PlatformDb,
  slug: string,
  usersDir?: string,
): { spec_md: string; conversation_md: string } {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  const spec = currentSpec(db, account.id)
  // Nothing confirms any more — the newest spec IS the build contract
  // (lib/db/specs.ts's currentSpec) — so this only fires for an account with
  // no spec at all.
  if (!spec) throw new Error(`no spec for '${slug}'`)

  // readStoredSpec throws SpecShapeError on a corrupt stored payload. Let it
  // propagate: exportSpec must build the output string or return nothing at
  // all, never a spec_md from a half-parsed payload. A throw here means the
  // caller (the CLI entry point below, then pull-spec.sh) never sees a result
  // to write at all.
  //
  // The renderer is chosen by the row's ACTUAL shape, never by which one is
  // current: a pre-unification row exports through the frozen renderer
  // forever, because spec.md is a build contract and re-pulling one must not
  // produce a diff nobody asked for.
  // confirmed_at can genuinely be null now — currentSpec no longer requires
  // a confirmation — so fall back to the spec's own timestamp. (This used to
  // cite lib/spec/author.ts's currentVersionBlock as the place the same
  // fallback already lived; that function is gone, and nothing else pairs
  // confirmed_at with a fallback any more, so this line is the only site.)
  // Without it, `new Date(null)` renders as 1970-01-01 in spec.md — exactly
  // the silent-garbage-date failure this project guards against elsewhere.
  const meta = { slug, version: spec.version, confirmedAt: spec.confirmed_at ?? spec.at }
  const stored = readStoredSpec(spec.payload)
  const spec_md =
    stored.kind === 'change'
      ? renderChangeMarkdown(stored.change, meta)
      : stored.kind === 'version'
        ? renderSpecMarkdown(stored.version, meta)
        : renderLegacyMarkdown(stored.payload, meta)

  // The conversation since the last BUILT version, not the whole history and
  // not merely since the previous spec ROW: the builder needs what the friend
  // meant across everything this spec's change is written against. See
  // lib/spec/conversation.ts for why the two must reach back to the same
  // place.
  //
  // `notes/v<n>.md` existing on disk is what "built" means — the same marker
  // lib/chat/announce.ts's announceTarget keys off, for the reason its comment
  // gives: a spec existing proves someone asked for it, never that it was
  // built. Resolving it HERE keeps conversationRows pure; readSpecs returns
  // newest first, so the first match below is the highest built version, and
  // `< spec.version` keeps the spec being exported from being its own
  // boundary. No match means nothing has been built yet — a first build —
  // and the slice takes everything up to spec.at.
  //
  // readSpecs is re-read rather than re-derived — currentSpec already walks
  // it, so this is one extra read of a small table on an operator CLI, and it
  // keeps the version derivation (row position, never stored) in one place.
  const specs = readSpecs(db, account.id)
  const builtBase = specs.find(
    (s) => s.version < spec.version && existsSync(notesPath(slug, s.version, usersDir)),
  )
  const conversation_md = renderConversationMarkdown(
    conversationRows(readTranscript(db, account.id), spec, builtBase),
    { slug, version: spec.version },
  )

  return { spec_md, conversation_md }
}

/**
 * No fallback — see the header comment. `??` only catches null/undefined, so
 * an explicit empty string (`PLATFORM_DB=` with nothing after it) is checked
 * for by hand or it would resolve to the cwd.
 */
function resolvePlatformDbPath(): string {
  if (!process.env.PLATFORM_DB) {
    console.error(
      'Refusing to run: PLATFORM_DB is not set.\n\n' +
        'This script never falls back to a synthetic database — a fallback ' +
        "on the droplet would write synthetic data into a friend's " +
        "users/<slug>/spec.md as if it were their real spec, " +
        'silently. Set it explicitly, e.g.:\n\n' +
        '  PLATFORM_DB=platform/dev/synthetic.db npx tsx scripts/export-spec.ts <slug>',
    )
    process.exit(1)
  }
  return resolve(process.env.PLATFORM_DB)
}

if (process.argv[1]?.endsWith('export-spec.ts')) {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: tsx scripts/export-spec.ts <slug>')
    process.exit(2)
  }
  const db = openPlatformDb(resolvePlatformDbPath())
  try {
    // Nothing is written to stdout unless exportSpec returns successfully —
    // an uncaught throw here prints to stderr and exits non-zero, and
    // pull-spec.sh's `set -e` stops before it ever reaches the write step.
    process.stdout.write(JSON.stringify(exportSpec(db, slug)))
  } finally {
    db.close()
  }
}
