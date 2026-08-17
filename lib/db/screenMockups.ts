// lib/db/screenMockups.ts
//
// Appends and reads, nothing else — matching lib/db/specs.ts and
// lib/db/appendOnly.ts. No composition here; that is Task 16's
// lib/spec/mockupCompose.ts.
import type { PlatformDb } from './platform'

export type ScreenFragment = { screenId: string; html: string }

/**
 * All of a version's fragments, or none: a half-written set would compose
 * into a document with a screen silently missing — and for
 * specs.mockup_html that document is the build contract. The transaction
 * wrapper is what makes a mid-batch failure (e.g. a duplicate screen_id
 * colliding with spec_screen_mockups_unique) roll back every row already
 * inserted in this call, not just skip the offending one.
 */
export function insertScreenMockups(
  db: PlatformDb,
  specId: number,
  fragments: ScreenFragment[],
  at: number,
): void {
  const stmt = db.prepare(
    'INSERT INTO spec_screen_mockups (spec_id, screen_id, html, at) VALUES (?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const f of fragments) stmt.run(specId, f.screenId, f.html, at)
  })()
}

export function readScreenMockups(db: PlatformDb, specId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT screen_id, html FROM spec_screen_mockups WHERE spec_id = ?')
    .all(specId) as { screen_id: string; html: string }[]
  return new Map(rows.map((r) => [r.screen_id, r.html]))
}
