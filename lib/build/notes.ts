// lib/build/notes.ts
//
// One build's notes, parsed. Written by the builder on the version branch and
// committed with the build; added, never edited, because the announcer speaks
// from this file and an edit would change what an already-sent, permanently
// stored announcement was based on.
//
// THE SECTION SPLIT IS THE POINT. Two sections reach the friend and two do
// not, and that boundary is enforced here — by a parser — rather than by a
// line in a prompt. lib/spec/banner.ts (unified-loop D19) sets the precedent:
// a guarantee the model cannot forget beats a rule it is asked to remember.
//
// Every failure throws. transcripts rejects DELETE, so a half-parsed notes
// file that produced a partial announcement would be permanent —
// lib/chat/opening.ts refuses for exactly the same reason.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class BuildNotesError extends Error {
  constructor(message: string) {
    super(`build notes: ${message}`)
    this.name = 'BuildNotesError'
  }
}

/** In file order. A file must carry all four, and nothing else. */
export const SECTION_HEADINGS = [
  'What shipped',
  'Built differently',
  'Open',
  'Notes for the next build',
] as const

export type BuildNotes = {
  slug: string
  version: number
  built_at: string
  /** Friend-facing. Never empty. */
  what_shipped: string
  /** Friend-facing. Empty is normal — most builds have no adjustment. */
  built_differently: string
  /** BUILDER-ONLY. A routing instruction, not a disclosure (design §3.5). */
  open: string
  /** BUILDER-ONLY. */
  next_build: string
}

/** Exactly what the drafting call is allowed to see. */
export type FriendFacingNotes = {
  what_shipped: string
  built_differently: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function frontmatter(text: string): Map<string, string> {
  const match = FRONTMATTER.exec(text)
  if (!match) throw new BuildNotesError('no --- frontmatter block at the top of the file')
  const out = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) throw new BuildNotesError(`frontmatter line is not "key: value": ${line}`)
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return out
}

/**
 * Sections, split on level-2 headings.
 *
 * An UNKNOWN heading throws rather than being ignored. A typo — "## Opne" —
 * would otherwise leave the real section absent and read as empty, which for
 * `## Open` means an unbuilt item silently never routes back to the chat.
 */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = body.split(/^## +(.+?) *$/m)
  // parts[0] is whatever preceded the first heading — ignored on purpose, so
  // a file may carry a title or a note above the sections.
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim()
    if (!(SECTION_HEADINGS as readonly string[]).includes(heading)) {
      throw new BuildNotesError(
        `unknown section "## ${heading}" — expected one of: ${SECTION_HEADINGS.join(', ')}`,
      )
    }
    if (out.has(heading)) throw new BuildNotesError(`duplicate section "## ${heading}"`)
    out.set(heading, (parts[i + 1] ?? '').trim())
  }
  for (const heading of SECTION_HEADINGS) {
    if (!out.has(heading)) throw new BuildNotesError(`missing section "## ${heading}"`)
  }
  return out
}

export function parseBuildNotes(text: string): BuildNotes {
  const front = frontmatter(text)

  const slug = front.get('slug')
  if (!slug) throw new BuildNotesError('frontmatter is missing slug')

  const rawVersion = front.get('version')
  const version = Number(rawVersion)
  if (!rawVersion || !Number.isInteger(version) || version < 1) {
    throw new BuildNotesError(`frontmatter version "${rawVersion ?? ''}" is not a positive integer`)
  }

  const builtAt = front.get('built_at')
  if (!builtAt || !DATE.test(builtAt)) {
    throw new BuildNotesError(`frontmatter built_at "${builtAt ?? ''}" is not YYYY-MM-DD`)
  }

  const body = text.replace(FRONTMATTER, '')
  const found = sections(body)

  const whatShipped = found.get('What shipped')!
  // The one section that may not be empty: it is the substance of the
  // announcement, and a drafting call handed nothing would invent something.
  if (whatShipped === '') throw new BuildNotesError('"## What shipped" is empty')

  return {
    slug,
    version,
    built_at: builtAt,
    what_shipped: whatShipped,
    built_differently: found.get('Built differently')!,
    open: found.get('Open')!,
    next_build: found.get('Notes for the next build')!,
  }
}

/**
 * The ONLY thing handed to the drafting call.
 *
 * Built by naming two fields, never by deleting two from the whole object: a
 * future section added to BuildNotes must be opted IN here, not remembered
 * out. `## Open` and `## Notes for the next build` can therefore never reach
 * a friend, whatever a prompt says.
 */
export function friendFacing(notes: BuildNotes): FriendFacingNotes {
  return { what_shipped: notes.what_shipped, built_differently: notes.built_differently }
}

/**
 * Absent notes are their OWN error class, not a BuildNotesError.
 *
 * scripts/announce-deploy.ts distinguishes them: a missing file means "write
 * the notes, then run this again", a malformed one means "fix the file". The
 * two need different sentences at the moment Nico is standing at a terminal
 * after a deploy.
 */
export class NotesMissingError extends Error {
  constructor(public readonly path: string) {
    super(`build notes: no file at ${path} — write it before announcing`)
    this.name = 'NotesMissingError'
  }
}

/**
 * USERS_DIR, matching the rest of the repo — it exists so tests can point at a
 * temp tree, and its default IS the correct production value, which is why
 * deploy/required-env deliberately does not list it.
 *
 * This duplicates the one-line fallback lib/db/userDb.ts already exports
 * rather than importing it. That file pulls in
 * better-sqlite3-multiple-ciphers (a native SQLite binding) at module top, and
 * this module is pure text parsing — importing from userDb.ts would drag that
 * native binding into every downstream consumer of lib/build/notes.ts,
 * including an operator CLI that has no business opening a database. A
 * duplicated one-liner is much cheaper than that coupling.
 */
function usersRoot(override?: string): string {
  return override ?? process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
}

export function notesPath(slug: string, version: number, usersDir?: string): string {
  return join(usersRoot(usersDir), slug, 'notes', `v${version}.md`)
}

/**
 * Read the notes for one built version.
 *
 * The frontmatter is checked AGAINST the path it was found at. A notes file is
 * the most copy-pasteable artifact in the build — the previous version's file
 * with two words changed — and a stale `version:` would make the announcement
 * describe the wrong build, permanently.
 */
export function readBuildNotes(slug: string, version: number, usersDir?: string): BuildNotes {
  const path = notesPath(slug, version, usersDir)
  if (!existsSync(path)) throw new NotesMissingError(path)

  const notes = parseBuildNotes(readFileSync(path, 'utf8'))
  if (notes.slug !== slug || notes.version !== version) {
    throw new BuildNotesError(
      `frontmatter says ${notes.slug} v${notes.version} but the file is ${path}`,
    )
  }
  return notes
}
