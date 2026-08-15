// lib/db/migrate.ts
//
// The one thing in this repo that changes the shape of a friend's real
// database.
//
// It runs at the ONE moment their key exists: when they unlock. There is no
// deploy-time or startup-time alternative, and that is not an oversight — the
// key lives only in the in-process keymap for the length of a session and is
// never serialized, so nothing on the server can open a friend's database
// without them. The cost of zero server-side access is zero server-side
// migration, and this module is what buys it back.
//
// Design: docs/superpowers/specs/2026-08-15-user-db-migrations-design.md
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ManifestError, listMigrations, verifyManifest } from '@/lib/db/migrationFiles'
import { isDevData } from '@/lib/db/userData'
import {
  createEmptyEncryptedDbAt,
  encryptedUserDbPath,
  openEncryptedUserDb,
} from '@/lib/db/encryptedUserDb'

/**
 * A migration did not apply, so this session must be refused.
 *
 * Carries a NUMBER and a CODE and never the driver's message. Both of those
 * reach an ntfy alert, and a constraint violation's message can quote a
 * column's contents — CLAUDE.md is absolute that metrics and alerts carry no
 * user values. The message goes to the server log instead, via
 * lib/db/failureLog.ts, which draws exactly this line already.
 */
export class MigrationFailure extends Error {
  readonly migrationNumber: number
  readonly code: string

  constructor(migrationNumber: number, code: string) {
    super(`migration ${migrationNumber} failed (${code})`)
    this.name = 'MigrationFailure'
    this.migrationNumber = migrationNumber
    this.code = code
  }
}

/**
 * One lock per slug, held across a whole run.
 *
 * IN-PROCESS, which is sufficient only because the service is a single
 * process — the same assumption lib/session/keymap.ts already makes. If that
 * ever stops being true this stops being sufficient, and it fails by ALLOWING
 * two concurrent migrations of one database rather than by refusing. Named
 * here rather than left to be discovered.
 *
 * Two sessions for one friend cannot hold different keys (the key derives from
 * their password and salt), so a second caller returning early is always safe:
 * whatever the first is doing is what the second would have done.
 */
const running = new Set<string>()

/**
 * Where the migration-window copy lives.
 *
 * `.backup.db`, and the suffix is load-bearing. The guard hook denies any
 * `*.db` that is not `synthetic.db`, so this is denied with NO hook change,
 * and `.gitignore`'s `*.db` covers it for free. A `.bak` suffix would have
 * made the backup the one readable copy of the thing the hook exists to
 * protect — the worst possible place to save four characters.
 *
 * NOT A BACKUP SYSTEM. One deep, replaced after the next successful run, and
 * encrypted under the same key as the original — so a forgotten password still
 * destroys both. step-6a design section 8.1 is untouched by this, and no
 * user-facing copy may imply recovery exists.
 */
export function backupPathFor(slug: string): string {
  const path = encryptedUserDbPath(slug)
  return join(dirname(path), `${slug}.backup.db`)
}

export function migrateUserDb(slug: string, key: Buffer): void {
  // NOTHING TO DO IN DEV, and nothing it is allowed to do.
  //
  // `synthetic.db` is the user database outside production, and seed.py builds
  // it by running these same migrations and stamping `user_version` to match —
  // so it arrives current and this would be a no-op anyway. It also cannot run
  // against it: synthetic.db is a plain SQLite file and everything below opens
  // SQLCipher.
  //
  // The load-bearing half is what this PREVENTS. Without it, logging in
  // locally creates `users/<slug>/<slug>.db` on a laptop — a real-named
  // database outside the server, which is the one thing the guard hook's
  // filename partition assumes cannot happen. That is not hypothetical: two
  // test suites did exactly that before this existed.
  if (isDevData()) return

  if (running.has(slug)) return
  running.add(slug)
  try {
    runMigrations(slug, key)
  } finally {
    running.delete(slug)
  }
}

function runMigrations(slug: string, key: Buffer): void {
  // FIRST, and before the file is created: a manifest that does not match must
  // never bring a friend's database into being. Pinned by
  // tests/db/migrate.test.ts ("refuses before creating anything").
  try {
    verifyManifest(slug)
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new MigrationFailure(error.migrationNumber, 'MANIFEST_MISMATCH')
    }
    throw error
  }

  const path = encryptedUserDbPath(slug)
  const createdNow = !existsSync(path)
  if (createdNow) createEmptyEncryptedDbAt(slug, path, key)

  const migrations = listMigrations(slug)
  const target = migrations.at(-1)?.number ?? 0

  // Read the version on its OWN short-lived handle, then close it. The
  // overwhelmingly common path is "already current", and it costs one pragma
  // read on every unlock — so it must not hold anything open. Closing here
  // also leaves the file checkpointed for the copy Task 3 adds next.
  const probe = openEncryptedUserDb(slug, key, { readonly: true })
  let current: number
  try {
    current = probe.pragma('user_version', { simple: true }) as number
  } finally {
    probe.close()
  }
  if (current >= target) return

  // Only when there is something to lose. A database created moments ago in
  // this same run has no tables and no rows, and copying it would spend the
  // single backup slot on an empty file.
  //
  // Taken on a CLOSED handle — the probe above is already closed — because a
  // WAL database copied while open can miss committed pages that still live
  // in its `-wal` sidecar. Closing checkpoints them into the main file, which
  // is the same reason the atomic create closes before it links.
  if (!createdNow) copyFileSync(path, backupPathFor(slug))

  const db = openEncryptedUserDb(slug, key)
  try {
    for (const migration of migrations) {
      if (migration.number <= current) continue
      try {
        // The version moves inside the SAME transaction as the DDL it
        // describes, so a crash can never leave a database whose recorded
        // version and actual shape disagree. That is the whole reason
        // bookkeeping can be a single integer (D8) rather than a table.
        db.exec('BEGIN')
        db.exec(migration.sql)
        db.pragma(`user_version = ${migration.number}`)
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Already rolled back by the driver. Never let this mask the real
          // failure below.
        }
        throw new MigrationFailure(
          migration.number,
          (error as { code?: string }).code ?? (error as Error).name ?? 'UNKNOWN',
        )
      }
    }
  } finally {
    db.close()
  }
}
