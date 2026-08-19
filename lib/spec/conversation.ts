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
 * The transcript rows belonging to one spec version.
 *
 * `prev.at < at <= spec.at`. Exclusive at the bottom so a row written in the
 * same millisecond as the previous spec belongs to that spec's slice and not
 * to two of them; inclusive at the top because the rows that produced a spec
 * include the one the agent wrote just before calling the tool.
 *
 * A first version has no predecessor and takes everything up to its own
 * timestamp.
 *
 * `specs` is passed in rather than re-read: readSpecs derives `version` from
 * ROW POSITION, and a second derivation could disagree with the first
 * (lib/db/specs.ts).
 */
export function conversationRows(
  rows: TranscriptRow[],
  spec: SpecRecord,
  specs: SpecRecord[],
): TranscriptRow[] {
  const previous = specs.find((s) => s.version === spec.version - 1)
  const after = previous?.at ?? Number.NEGATIVE_INFINITY
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
    '     Gitignored: this is a raw transcript, not a designed artifact.\n' +
    '     Do not hand-edit: the next pull overwrites this file. -->\n'

  if (rows.length === 0) {
    return `${header}\n_No conversation rows fall between the previous spec and this one._\n`
  }

  const body = rows
    .map((r) => `## ${r.role} — ${new Date(r.at).toISOString()}\n\n${r.body}`)
    .join('\n\n')

  return `${header}\n${body}\n`
}
