// scripts/regen-synthetic.ts
//
// Regenerate every users/<slug>/synthetic.db from that user's seed.py.
//
//   npm run synthetic
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
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

if (process.argv[1]?.endsWith('regen-synthetic.ts')) {
  const usersDir = process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
  const written = regenerateAll(usersDir)
  if (written.length === 0) {
    console.log(`No user generators found under ${usersDir}.`)
  } else {
    for (const path of written) console.log(`Regenerated ${path}`)
  }
}
