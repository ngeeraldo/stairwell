// lib/spec/conversation.ts
//
// The conversation that produced one spec version, as a file the builder
// reads beside spec.md. The spec says what to build; the conversation says
// what they meant.
//
// GITIGNORED, and that is a data-safety line rather than housekeeping — see
// .gitignore and CLAUDE.md. spec.md is a designed artifact describing a
// dashboard; this is everything a friend said, including whatever they said
// around the dashboard. It is a working input pulled fresh when needed. The
// record of record stays `transcripts` on the droplet, append-only.
import type { TranscriptRow } from '@/lib/db/appendOnly'
import type { SpecRecord } from '@/lib/db/specs'

/**
 * The transcript rows behind one spec version.
 *
 * `builtBase.at < at <= spec.at`. Exclusive at the bottom so a row written in
 * the same millisecond as the boundary spec belongs to that spec's slice and
 * not to two of them; inclusive at the top because the rows that produced a
 * spec include the one the agent wrote just before calling the tool.
 *
 * `builtBase` IS THE LAST BUILT VERSION, not the row one version below.
 * A spec is a change written against `users/<slug>/current.md`, and
 * `current.md` describes what was last BUILT — so the conversation beside it
 * has to reach back to the same place the spec's own base does. With nothing
 * to confirm, a friend can author two specs before either is built (design
 * §7): v3 asks for a weekly average, v4 also drops a panel, the builder
 * builds v4 and v3 is superseded, never getting a `notes/v<n>.md`. Slicing at
 * v3 would hand the builder a `spec.md` covering v2 -> v4 beside a
 * `conversation.md` covering only v3 -> v4, and design §5.0.1 dropped the
 * spec's `background` field on the explicit promise that the residue about
 * the PERSON survives as raw transcript here. Half of it would be in neither
 * file, with nothing on disk saying so.
 *
 * `undefined` means NOTHING HAS BEEN BUILT YET — a first build — and takes
 * everything up to `spec.at`, which is already what a first spec does.
 *
 * PURE AND FILESYSTEM-FREE ON PURPOSE. "Was this version built?" is answered
 * by `notes/v<n>.md` existing on disk (`lib/chat/announce.ts`'s
 * `announceTarget` uses the same marker, and its comment says why: a spec
 * existing proves someone asked for it, never that it was built). That lookup
 * belongs to the caller — `scripts/export-spec.ts` — so the slice itself stays
 * directly testable with plain data.
 *
 * The boundary is passed in rather than re-derived here for the same reason it
 * used to take the whole list: readSpecs derives `version` from ROW POSITION,
 * and a second derivation could disagree with the first (lib/db/specs.ts).
 */
export function conversationRows(
  rows: TranscriptRow[],
  spec: SpecRecord,
  builtBase: SpecRecord | undefined,
): TranscriptRow[] {
  const after = builtBase?.at ?? Number.NEGATIVE_INFINITY
  return rows
    .filter((r) => r.at > after && r.at <= spec.at)
    .sort((a, b) => a.at - b.at || a.id - b.id)
}

/**
 * The slice as markdown.
 *
 * NOTHING IS ESCAPED OR REFLOWED. lib/spec/render.ts neutralises line-leading
 * markdown structure because spec.md is a designed document that a person
 * reads as rendered output. This is a transcript: it is read as a source, by a
 * builder, and altering what someone said to tidy a layout is not a trade this
 * file gets to make. It is never rendered to a friend and never served by the
 * app.
 */
export function renderConversationMarkdown(
  rows: TranscriptRow[],
  meta: { slug: string; version: number },
): string {
  const header =
    `# ${meta.slug} — the conversation behind spec v${meta.version}\n\n` +
    '<!-- Generated from the transcript by scripts/pull-spec.sh.\n' +
    '     Everything said since the last BUILT version, up to this spec —\n' +
    '     the same base current.md describes, not the previous spec row.\n' +
    '     Gitignored: this is a raw transcript, not a designed artifact.\n' +
    '     Do not hand-edit: the next pull overwrites this file. -->\n'

  if (rows.length === 0) {
    return `${header}\n_No conversation rows fall between the last built version and this spec._\n`
  }

  const body = rows
    .map((r) => `## ${r.role} — ${new Date(r.at).toISOString()}\n\n${r.body}`)
    .join('\n\n')

  return `${header}\n${body}\n`
}
