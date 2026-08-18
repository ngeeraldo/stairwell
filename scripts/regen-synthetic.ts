// scripts/regen-synthetic.ts
//
// Regenerate every users/<slug>/synthetic.db from that user's seed.py.
//
//   npm run synthetic            # shape + sample rows, from seed.py
//   npm run synthetic -- --empty # shape only, no rows — see regenerateAllEmpty
//
// users/*/synthetic.db is gitignored, so a fresh checkout — and every deploy
// — starts with none. CLAUDE.md says synthetic.db is regenerated at session
// start; this is that sentence as a command.
//
// This NEVER touches platform/dev/synthetic.db. That file holds accounts and
// sessions and is seeded by scripts/create-dev-users.ts. The separation is
// structural, not merely asserted: every path this script writes is built by
// joining `usersDir` (the argument, or the CLI default `<cwd>/users`) with a
// slug and `synthetic.db` — it never derives a path from `usersDir`'s parent
// or from any other root, so it cannot reach a sibling directory like
// `platform/dev`. tests/support/noCross.test.ts pins the same property for
// the SIBLING helpers in tests/support/synthetic.ts (regeneratePlatform /
// regenerateUser), not for this script — this file's own separation is
// covered by the "leaves a neighbouring platform database byte-identical"
// test in tests/scripts/regenSynthetic.test.ts.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { SLUG_PATTERN } from '@/lib/auth/slug'

/**
 * Slugs under `usersDir` that have a seed.py, sorted for stable output.
 *
 * Filtered by SLUG_PATTERN (lib/auth/slug.ts) — the same pattern
 * tests/users/conventions.test.ts uses for the same sweep, imported rather
 * than re-declared. The case is stronger here than there: that test only
 * fails loudly on a stray non-slug directory, whereas this script EXECUTES
 * whatever seed.py it finds and writes a database into it, on every deploy —
 * so a dot-dir, an editor artifact, or an accidental mkdir under users/ must
 * never be treated as an account.
 */
export function userSlugsWithSeeds(usersDir: string): string[] {
  if (!existsSync(usersDir)) return []
  return readdirSync(usersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => SLUG_PATTERN.test(name))
    .filter((name) => existsSync(join(usersDir, name, 'seed.py')))
    .sort()
}

/**
 * Run every generator. Returns the target paths written, in slug order.
 * Throws on the first failure, naming the slug — a deploy log that says
 * "regeneration failed" without saying whose is a log that sends the reader
 * to the wrong folder.
 */
export function regenerateAll(usersDir: string): string[] {
  const written: string[] = []
  for (const slug of userSlugsWithSeeds(usersDir)) {
    const target = join(usersDir, slug, 'synthetic.db')
    // The sidecars hold the same rows as the database itself; a stale one can
    // resurrect rows the new generator never wrote. `-journal`, not `-wal`
    // or `-shm`, is the one Python's sqlite3 module actually leaves behind:
    // it defaults to ROLLBACK JOURNAL mode, not WAL, so `-wal`/`-shm` cover a
    // mode this generator never uses while the sidecar it DOES produce went
    // unremoved.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${target}${suffix}`, { force: true })
    }
    try {
      // The sidecars above are removed BEFORE this runs, not after — so a
      // seed.py that fails here leaves this slug with no database at all
      // until the next successful regeneration, rather than leaving the
      // last-good one in place. The still-running process keeps serving
      // reads from its already-open handle on the deleted inode in the
      // meantime, so there is no visible outage until the next restart.
      execFileSync('python3', [join(usersDir, slug, 'seed.py'), target], {
        stdio: 'pipe',
      })
    } catch (error) {
      throw new Error(
        `users/${slug}/seed.py failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    written.push(target)
  }
  return written
}

/**
 * Migration files for one slug, in numeric order, resolved from `usersDir`.
 *
 * Deliberately NOT lib/db/migrationFiles.ts's `listMigrations`, despite
 * listing the same files: that one resolves through `usersRoot()`, and this
 * script's separation property (see the header) is precisely that every path
 * it writes is built by joining the `usersDir` it was handed. Importing a
 * helper that finds its own root would put a second, unrelated root into the
 * one script that deletes and rewrites databases in a loop.
 */
function migrationFiles(usersDir: string, slug: string): string[] {
  const dir = join(usersDir, slug, 'migrations')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    // Lexical is numeric here because the prefix is zero-padded to three
    // digits — the same guarantee lib/db/migrationFiles.ts's FILENAME buys.
    .sort()
    .map((name) => join(dir, name))
}

/**
 * Rebuild every users/<slug>/synthetic.db with its SHAPE and NO ROWS.
 *
 *   npm run synthetic -- --empty
 *
 * This is day one: the state every friend is actually in the morning their
 * dashboard ships, because there is no synthetic fallback standing in front of
 * their own empty database (CLAUDE.md > Dashboard folder conventions). A test
 * can only prove an empty dashboard does not THROW; whether it reads as
 * "waiting" or as "broken" is a question only a picture answers, and until
 * this existed there was no way to put that picture on a screen — `seed.py`
 * always fills the file.
 *
 * Built from the MIGRATIONS rather than by running seed.py and deleting rows,
 * for the same reason seed.py itself applies them: the migrations are the one
 * description of a dashboard's shape (2026-08-15 migrations design, D6), and
 * migrations-applied-with-nothing-written is exactly what lib/db/migrate.ts
 * leaves behind on a real database nobody has used yet. It also means every
 * dashboard gets this for free, now and in six months, with no per-folder
 * `--empty` handling for a seed author to forget.
 *
 * NOT what deploy/deploy.sh runs. A deploy regenerates with data, and this
 * mode is only ever reached by typing --empty.
 */
export function regenerateAllEmpty(usersDir: string): string[] {
  const written: string[] = []
  for (const slug of userSlugsWithSeeds(usersDir)) {
    const target = join(usersDir, slug, 'synthetic.db')
    // Same sidecar sweep as regenerateAll, and load-bearing for the same
    // reason: a stale journal can resurrect rows into a file whose entire
    // purpose is to have none.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${target}${suffix}`, { force: true })
    }
    const files = migrationFiles(usersDir, slug)
    const db = new Database(target)
    try {
      for (const path of files) db.exec(readFileSync(path, 'utf8'))
      // Stamped to match, exactly as seed.py does, so an empty synthetic
      // database reports the same version a migrated real one does rather
      // than looking like a database the runner still owes work to.
      if (files.length > 0) {
        db.pragma(`user_version = ${Number(basename(files[files.length - 1]!).slice(0, 3))}`)
      }
    } finally {
      db.close()
    }
    written.push(target)
  }
  return written
}

if (process.argv[1]?.endsWith('regen-synthetic.ts')) {
  const usersDir = process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
  const empty = process.argv.includes('--empty')
  const written = empty ? regenerateAllEmpty(usersDir) : regenerateAll(usersDir)
  if (written.length === 0) {
    console.log(`No user generators found under ${usersDir}.`)
  } else {
    for (const path of written) console.log(`Regenerated ${path}`)
    // Said out loud, every time. An empty synthetic database looks identical
    // to a broken generator from the outside, and the whole point of this mode
    // is to sit and LOOK at a dashboard showing nothing — which is the state
    // most likely to make someone forget why it is showing nothing.
    if (empty) {
      console.log('\nEMPTY: shape only, no rows — this is day one.')
      console.log('Run `npm run synthetic` to put the sample data back.')
    }
  }
}
