import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SLUG_PATTERN } from '@/lib/auth/slug'

export type UserDb = Database.Database

/**
 * What the page found when it went looking for a user's data.
 *
 * There is no 'real' member yet. Step 6 introduces users/<slug>/<slug>.db,
 * SQLCipher-encrypted and keyed from the in-process keymap; a resolver that
 * selected "real" on mere file existence would open an encrypted file with no
 * key the day that lands. Step 6 owns that branch and must add its OWN
 * opener — see the note on caching below.
 */
export type DashboardData =
  | { source: 'synthetic'; db: UserDb }
  | { source: 'none'; db: undefined }

/**
 * Open handles, keyed by resolved PATH (not by slug — tests point USERS_DIR at
 * a temp tree, and a slug-keyed cache would serve one test's handle to the
 * next). The file only changes at deploy, which restarts the process, so a
 * process-wide read-only handle is correct here.
 *
 * This will be WRONG in step 6, where the handle is keyed to a session's
 * derived key and must not outlive it. Step 6 does not extend this function.
 */
const handles = new Map<string, UserDb>()

/** Where user folders live. USERS_DIR exists for tests; the default is right. */
export function usersRoot(): string {
  return process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
}

/**
 * The synthetic database path for a slug. Throws on anything that is not a
 * slug, before any filesystem call — this is the single place a URL-derived
 * string becomes a path.
 */
export function userDbPath(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug '${slug}': refusing to build a filesystem path from it`,
    )
  }
  return join(usersRoot(), slug, 'synthetic.db')
}

export function openUserDb(slug: string): DashboardData {
  const path = userDbPath(slug)

  const cached = handles.get(path)
  if (cached) return { source: 'synthetic', db: cached }

  // A MISS is never cached: a database generated mid-session (npm run
  // synthetic, or a freshly scaffolded dashboard) must be picked up on the
  // next request rather than after a restart.
  if (!existsSync(path)) return { source: 'none', db: undefined }

  const db = new Database(path, { readonly: true, fileMustExist: true })
  handles.set(path, db)
  return { source: 'synthetic', db }
}

/** Release every handle. For tests, and for anything that swaps the tree. */
export function closeUserDbs(): void {
  for (const db of handles.values()) db.close()
  handles.clear()
}
