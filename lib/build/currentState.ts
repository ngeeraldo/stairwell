// lib/build/currentState.ts
//
// What a dashboard IS right now, as the builder describes it after building.
//
// OVERWRITTEN EVERY BUILD, and that is the whole difference from
// lib/build/notes.ts, which this file is otherwise modelled on. A note is
// pinned because scripts/announce-deploy.ts already spoke from it, so editing
// one rewrites the basis of a message a friend holds permanently. Nothing
// permanent points at a current-state description — and it MUST be replaced
// rather than appended to, because a changelog replayed forward is the
// "derive current state from history" failure this artifact exists to remove.
//
// The body is handed through UNSPLIT. This parser proves the five headings
// are present and spelled right, then stops: a body parser is a second thing
// that drifts from what the builder actually writes (design D8).

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class CurrentStateError extends Error {
  constructor(message: string) {
    super(`current state: ${message}`)
    this.name = 'CurrentStateError'
  }
}

/** In file order. A file must carry all five, and nothing else. */
export const SECTION_HEADINGS = [
  'What this is for',
  'Screens',
  'Panels',
  'What can be entered',
  'Deliberately not included',
] as const

export type CurrentState = {
  slug: string
  /**
   * The spec version this describes, or 0 for a dashboard that predates the
   * spec loop (devone, devtwo — hand-written, never had a spec). Those
   * dashboards have no notes/v<n>.md files and no `specs` rows either, so
   * scripts/announce-deploy.ts's target resolution (`announceTarget` in
   * lib/chat/announce.ts) returns `no_build_notes` for either slug before an
   * announce target ever resolves — the version comparison below never runs
   * for them at all. A `version: 0` file is a second, independent backstop:
   * a version being announced is always >= 1, so if either account ever
   * gained a real spec+notes pair, a stale 0 here would still be caught by
   * that comparison rather than by the absence of notes.
   */
  version: number
  /** Everything after the frontmatter, verbatim. */
  body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

function frontmatter(text: string): Map<string, string> {
  const match = FRONTMATTER.exec(text)
  if (!match) throw new CurrentStateError('no --- frontmatter block at the top of the file')
  const out = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) throw new CurrentStateError(`frontmatter line is not "key: value": ${line}`)
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return out
}

/**
 * Headings, checked and then discarded.
 *
 * An UNKNOWN heading throws rather than being ignored, for the same reason
 * lib/build/notes.ts does it: a typo leaves the real section absent and
 * reading as empty. Here that matters most for "## Deliberately not
 * included", which is the only carrier of a refusal — an empty one is how the
 * agent re-proposes something the friend already turned down.
 */
function checkSections(body: string): void {
  const seen = new Set<string>()
  const parts = body.split(/^## +(.+?) *$/m)
  // parts[0] is whatever preceded the first heading — ignored on purpose.
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim()
    if (!(SECTION_HEADINGS as readonly string[]).includes(heading)) {
      throw new CurrentStateError(
        `unknown section "## ${heading}" — expected one of: ${SECTION_HEADINGS.join(', ')}`,
      )
    }
    if (seen.has(heading)) throw new CurrentStateError(`duplicate section "## ${heading}"`)
    seen.add(heading)
  }
  for (const heading of SECTION_HEADINGS) {
    if (!seen.has(heading)) throw new CurrentStateError(`missing section "## ${heading}"`)
  }
}

export function parseCurrentState(text: string): CurrentState {
  const front = frontmatter(text)

  const slug = front.get('slug')
  if (!slug) throw new CurrentStateError('frontmatter is missing slug')

  const rawVersion = front.get('version')
  const version = Number(rawVersion)
  if (rawVersion === undefined || !Number.isInteger(version) || version < 0) {
    throw new CurrentStateError(
      `frontmatter version "${rawVersion ?? ''}" is not a non-negative integer`,
    )
  }

  const body = text.replace(FRONTMATTER, '')
  checkSections(body)

  return { slug, version, body: body.trim() }
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
 * native binding into every downstream consumer of lib/build/currentState.ts,
 * including an operator CLI that has no business opening a database. A
 * duplicated one-liner is much cheaper than that coupling.
 */
function usersRoot(override?: string): string {
  return override ?? process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
}

export function currentStatePath(slug: string, usersDir?: string): string {
  return join(usersRoot(usersDir), slug, 'current.md')
}

/**
 * ABSENT RETURNS NULL, unlike readBuildNotes, which throws NotesMissingError.
 *
 * The two absences mean different things. A missing note blocks an
 * announcement, which is a thing Nico is standing at a terminal waiting for.
 * A missing current.md is the ordinary state of an account whose dashboard
 * has not been built — and this is read on the chat path, where throwing
 * would take away the conversation of the friend who is furthest from having
 * a dashboard.
 *
 * A file that EXISTS and does not parse still throws: that is a builder
 * error, and degrading it to null would feed the agent nothing while the
 * folder looks complete.
 */
export function readCurrentState(slug: string, usersDir?: string): CurrentState | null {
  const path = currentStatePath(slug, usersDir)
  if (!existsSync(path)) return null
  return parseCurrentState(readFileSync(path, 'utf8'))
}
