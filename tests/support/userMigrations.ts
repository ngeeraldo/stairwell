// tests/support/userMigrations.ts
//
// Build a user's shape in a test.
//
// Before migrations, a test that needed a friend's tables read
// `users/<slug>/schema.sql` and exec'd it. That file is gone: migrations own
// the shape (2026-08-15 migrations design, D6), and the shape is now the sum
// of `users/<slug>/migrations/*.sql` applied in order.
//
// This is the ONE place tests get that from. It deliberately does not import
// lib/db/migrate.ts: the runner opens encrypted databases, takes locks and
// writes backups, none of which a query test wants, and a test helper that
// reached for it would make every fixture depend on the thing under test.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'

type ExecutesSql = { exec(sql: string): unknown }

/** Absolute path to a user folder's migrations directory. */
export function migrationsDirFor(slug: string): string {
  return resolve(__dirname, '..', '..', 'users', slug, 'migrations')
}

/** Every migration for `slug`, in numeric order. */
export function migrationFilesFor(slug: string): string[] {
  const dir = migrationsDirFor(slug)
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => join(dir, f))
}

/**
 * The whole chain as one string.
 *
 * For tests that want to inspect or write the SQL rather than run it. Applying
 * it in one exec is equivalent to applying the files in order — the runner
 * wraps each migration in its own transaction, but nothing here depends on
 * that boundary.
 */
export function migrationSqlFor(slug: string): string {
  return migrationFilesFor(slug)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
}

/** Apply a user's migrations to an open database handle. */
export function applyUserMigrations(db: ExecutesSql, slug: string): void {
  for (const path of migrationFilesFor(slug)) db.exec(readFileSync(path, 'utf8'))
}

/**
 * An in-memory database holding a user's shape and NO rows.
 *
 * The fixture for the obligation every dashboard now carries: with no
 * synthetic fallback, a friend's first session renders their own database, and
 * it is empty. That is an ordinary state, not an error — see the 2026-08-15
 * migrations design, §9.
 *
 * Returned read-only, because that is what a dashboard is handed. A dashboard
 * that only renders when it can write would pass a laxer fixture and fail in
 * production.
 */
export function emptyDbFromMigrations(slug: string): Database.Database {
  const db = new Database(':memory:')
  applyUserMigrations(db, slug)
  return db
}
