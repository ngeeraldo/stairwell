// lib/db/migrationFiles.ts
//
// Which migrations exist for a friend, and whether they are the ones that were
// reviewed.
//
// Pure filesystem and crypto: this module opens no database and needs no key,
// which is exactly what lets it run BEFORE anything is unlocked. A manifest
// that does not match refuses the session without a friend's database ever
// being brought into being — see lib/db/migrate.ts, which calls verifyManifest
// before it creates anything.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SLUG_PATTERN } from '@/lib/auth/slug'
import { usersRoot } from '@/lib/db/userDb'

export type Migration = {
  number: number
  name: string
  path: string
  sql: string
  sha256: string
}

/**
 * A migration file is not the one the manifest recorded.
 *
 * Carries the NUMBER rather than any text. This propagates to an ntfy alert,
 * and CLAUDE.md is absolute that metrics and alerts carry no user values — a
 * migration's SQL can quote column names a friend chose, and its failure
 * message can quote their data.
 */
export class ManifestError extends Error {
  readonly migrationNumber: number

  constructor(migrationNumber: number, detail: string) {
    super(`migration ${migrationNumber}: ${detail}`)
    this.name = 'ManifestError'
    this.migrationNumber = migrationNumber
  }
}

function migrationsDir(slug: string): string {
  // Same guard encryptedUserDbPath applies, and for the same reason: a slug
  // reaches this from a URL segment, and join() would happily walk out of
  // users/ given the chance.
  if (!SLUG_PATTERN.test(slug)) throw new Error(`invalid slug '${slug}'`)
  return join(usersRoot(), slug, 'migrations')
}

/**
 * `001_initial.sql`. Three digits so lexical and numeric order agree up to
 * 999, an underscore-separated lowercase name so a directory listing reads as
 * a changelog.
 */
const FILENAME = /^(\d{3})_[a-z0-9_]+\.sql$/

export function listMigrations(slug: string): Migration[] {
  const dir = migrationsDir(slug)
  if (!existsSync(dir)) return []

  const found = new Map<number, Migration>()
  for (const name of readdirSync(dir)) {
    const match = FILENAME.exec(name)
    if (!match) continue

    const number = Number(match[1])
    if (found.has(number)) {
      // Never pick one. Two files claiming 002 means a number was reused,
      // and applying either silently applies half of an intended change.
      throw new Error(`users/${slug}/migrations: duplicate number ${number}`)
    }

    const path = join(dir, name)
    const sql = readFileSync(path, 'utf8')
    found.set(number, {
      number,
      name,
      path,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    })
  }

  // Numeric, not lexical: readdirSync would order "010" before "002", which
  // applies a change to a shape that does not exist yet.
  return [...found.values()].sort((a, b) => a.number - b.number)
}

type ManifestEntry = { number: number; sha256: string }

/**
 * Refuse unless every migration on disk is byte-identical to what the manifest
 * recorded, in both directions.
 *
 * This is the whole of D2's enforcement. `PRAGMA user_version` holds a number
 * and nothing else, so a friend's database cannot remember which bytes it
 * applied — the guarantee this buys is "no applied migration IN THE REPO has
 * changed", which is weaker than a per-database record and is stated as such
 * in the design's §3.2.
 */
export function verifyManifest(slug: string): void {
  const migrations = listMigrations(slug)
  const manifestPath = join(migrationsDir(slug), 'manifest.json')
  const hasManifest = existsSync(manifestPath)

  // A friend whose dashboard has not been built yet: no migrations, no
  // manifest, nothing to verify. Not a failure — they still get a database.
  if (migrations.length === 0 && !hasManifest) return

  if (!hasManifest) {
    throw new ManifestError(migrations[0]?.number ?? 0, 'manifest.json missing')
  }

  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    migrations: ManifestEntry[]
  }
  const recorded = new Map(parsed.migrations.map((entry) => [entry.number, entry.sha256]))

  for (const migration of migrations) {
    const expected = recorded.get(migration.number)
    if (expected === undefined) {
      throw new ManifestError(migration.number, 'file has no manifest entry')
    }
    if (expected !== migration.sha256) {
      throw new ManifestError(migration.number, 'file does not match manifest checksum')
    }
    recorded.delete(migration.number)
  }

  // Both directions. A manifest entry with no file means a migration was
  // deleted after being applied somewhere, which leaves every database at a
  // version whose definition is gone.
  for (const number of recorded.keys()) {
    throw new ManifestError(number, 'manifest entry has no file')
  }
}
