// tests/db/migrationFiles.test.ts
//
// Discovery and manifest verification, which is the half of the migration
// system that runs BEFORE anything is unlocked: no key, no database, just
// files on disk. That is what lets a bad manifest refuse a session without
// ever bringing a database into being.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestError, listMigrations, verifyManifest } from '@/lib/db/migrationFiles'

let root: string
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function writeMigration(slug: string, file: string, sql: string) {
  mkdirSync(join(root, slug, 'migrations'), { recursive: true })
  writeFileSync(join(root, slug, 'migrations', file), sql)
}

function writeManifest(slug: string, entries: { number: number; sha256: string }[]) {
  mkdirSync(join(root, slug, 'migrations'), { recursive: true })
  writeFileSync(
    join(root, slug, 'migrations', 'manifest.json'),
    JSON.stringify({ migrations: entries }, null, 2),
  )
}

/** Rebuild manifest.json from whatever .sql files are on disk. */
function manifestFromDisk(slug: string) {
  const dir = join(root, slug, 'migrations')
  writeManifest(
    slug,
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({
        number: Number(f.slice(0, 3)),
        sha256: sha(readFileSync(join(dir, f), 'utf8')),
      })),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-mig-'))
  process.env.USERS_DIR = root
})

afterEach(() => {
  delete process.env.USERS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('listMigrations', () => {
  it('returns numeric order, not lexical', () => {
    // The bug this pins: readdirSync gives lexical order, in which "010"
    // sorts before "002". Applying ten before two is applying a change to a
    // shape that does not exist yet.
    writeMigration('sam', '010_ten.sql', 'SELECT 10;')
    writeMigration('sam', '002_two.sql', 'SELECT 2;')
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    expect(listMigrations('sam').map((m) => m.number)).toEqual([1, 2, 10])
  })

  it('is empty for a folder with no migrations directory', () => {
    mkdirSync(join(root, 'sam'), { recursive: true })
    expect(listMigrations('sam')).toEqual([])
  })

  it('ignores manifest.json and any non-.sql file', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    manifestFromDisk('sam')
    writeFileSync(join(root, 'sam', 'migrations', 'notes.md'), 'hi')
    expect(listMigrations('sam').map((m) => m.number)).toEqual([1])
  })

  it('throws on a duplicate number rather than picking one', () => {
    // Two files claiming 002 means the numbering was reused, and applying
    // either one silently applies half a change.
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeMigration('sam', '001_other.sql', 'SELECT 2;')
    expect(() => listMigrations('sam')).toThrow(/duplicate/i)
  })

  it('carries the sql and its checksum, so nothing re-reads the file later', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    const migrations = listMigrations('sam')
    expect(migrations).toHaveLength(1)
    expect(migrations[0]?.sql).toBe('SELECT 1;')
    expect(migrations[0]?.sha256).toBe(sha('SELECT 1;'))
  })

  it('refuses a slug that is not a slug', () => {
    expect(() => listMigrations('../escape')).toThrow(/invalid slug/i)
  })
})

describe('verifyManifest', () => {
  it('passes when every file matches its recorded checksum', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    manifestFromDisk('sam')
    expect(() => verifyManifest('sam')).not.toThrow()
  })

  it('throws when an applied migration was edited — D2', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    manifestFromDisk('sam')
    writeFileSync(join(root, 'sam', 'migrations', '001_one.sql'), 'SELECT 1 EDITED;')
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('names the migration number it refused on', () => {
    // The number is what reaches the ntfy alert. A refusal that cannot say
    // which migration broke fails goal 2: knowing why, quickly.
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeMigration('sam', '002_two.sql', 'SELECT 2;')
    manifestFromDisk('sam')
    writeFileSync(join(root, 'sam', 'migrations', '002_two.sql'), 'EDITED;')
    try {
      verifyManifest('sam')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError)
      expect((e as ManifestError).migrationNumber).toBe(2)
    }
  })

  it('throws when a file exists with no manifest entry', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeManifest('sam', [])
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('throws when the manifest lists a file that is gone', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    writeManifest('sam', [
      { number: 1, sha256: sha('SELECT 1;') },
      { number: 2, sha256: sha('SELECT 2;') },
    ])
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('throws when migrations exist but the manifest does not', () => {
    writeMigration('sam', '001_one.sql', 'SELECT 1;')
    expect(() => verifyManifest('sam')).toThrow(ManifestError)
  })

  it('is a no-op when there are no migrations and no manifest', () => {
    // A friend whose dashboard has not been built yet. Not a failure —
    // they get a database and nothing applied.
    mkdirSync(join(root, 'sam'), { recursive: true })
    expect(() => verifyManifest('sam')).not.toThrow()
  })
})
