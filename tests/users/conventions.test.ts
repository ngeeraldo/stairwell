// tests/users/conventions.test.ts
//
// One sweep over every users/<slug>/ folder, so a dashboard added in six
// months is covered on the day it lands rather than when someone remembers to
// write a test for it.
//
// The high-value assertion is the schema one: CLAUDE.md's anti-drift rule says
// schema.sql + seed.py + tests/ move in the same commit, and Gate A enforces
// that they were STAGED together. Nothing before this proved they AGREE.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterAll, describe, expect, it } from 'vitest'
import { SLUG_PATTERN } from '@/lib/auth/slug'
import { declaredObjects } from '@/tests/support/declaredObjects'

/**
 * Every test in this file spawns python3 once per user folder. vitest's
 * 5-second default is not a budget for that on the droplet, which spawns
 * subprocesses far slower than the laptop and runs this suite as a deploy
 * gate — a false timeout there aborts a deploy over nothing. Per-file, never a
 * global testTimeout: the other ~500 tests should finish in milliseconds and
 * raising the ceiling everywhere would hide a real hang. Precedent and full
 * reasoning: tests/scripts/pullSpec.test.ts.
 */
const SUBPROCESS_TIMEOUT_MS = 60_000

const USERS = resolve(__dirname, '..', '..', 'users')

// users/ holds one directory per account, and an account slug can never be
// dot-prefixed or contain a slash (lib/auth/slug.ts). Anything else under
// users/ — a dot-dir, an editor artifact, an accidental mkdir — is not a
// user folder, and demanding schema.sql of it would be a false failure.
const slugs = existsSync(USERS)
  ? readdirSync(USERS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => SLUG_PATTERN.test(name))
      .sort()
  : []

/** The five entries a BUILT dashboard has. See the state note below. */
const REQUIRED = ['schema.sql', 'seed.py', 'queries.ts', 'dashboard.tsx', 'tests']

const isBuilt = (slug: string) =>
  REQUIRED.every((entry) => existsSync(join(USERS, slug, entry)))

const temps: string[] = []
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

describe('users/ folder conventions', () => {
  // Without this the it.each below is vacuous on an empty users/ tree: zero
  // cases, zero failures, a green suite that checked nothing. devone exists,
  // so this is a real assertion, not a formality.
  it('finds at least one user folder to check', () => {
    expect(slugs.length).toBeGreaterThan(0)
  })

  // The companion to the skip below. A folder that has been pulled but not
  // built skips the four checks that do the real work, which is correct for
  // that folder and dangerous for the sweep: a tree where every folder were
  // pulled-only would report all-green having executed none of them.
  it('sweeps at least one BUILT dashboard, not only pulled-but-unbuilt folders', () => {
    expect(slugs.filter(isBuilt)).not.toHaveLength(0)
  })

  describe.each(slugs)('users/%s', (slug) => {
    const dir = join(USERS, slug)

    /**
     * A user folder has three legitimate states, and only one of them is a
     * defect. This distinction was missing until the first real pull created
     * the middle one: `./scripts/pull-spec.sh devtwo` writes spec.md and
     * mockup.html into a folder that does not exist yet, so between pulling a
     * confirmed spec and building the dashboard from it the folder legitimately
     * holds the build contract and nothing else. The sweep used to fail all
     * eight of its checks there — on the documented workflow, at the exact
     * moment it is followed.
     *
     *   pulled  — spec.md / mockup.html only. Allowed: not started yet.
     *   built   — all five required entries. Swept in full.
     *   partial — some of the five. A defect, and the one this now names.
     *
     * Skipping the built-only checks is what makes the middle state pass, so
     * "is either fully built or not started" carries the weight for a pulled
     * folder, and the run-if-built assertion below stops the whole sweep from
     * going quiet if every folder were ever pulled-only.
     */
    const found = REQUIRED.filter((entry) => existsSync(join(dir, entry)))
    const built = found.length === REQUIRED.length
    const whenBuilt = built ? it : it.skip

    it('is either fully built or not started — never half a dashboard', () => {
      const missing = REQUIRED.filter((entry) => !found.includes(entry))
      // Named rather than counted, so the failure says which files to write.
      expect(built || found.length === 0, `missing: ${missing.join(', ')}`).toBe(true)
    })

    whenBuilt('has at least one test of its own', () => {
      const tests = readdirSync(join(dir, 'tests')).filter((f) =>
        f.endsWith('.test.ts'),
      )
      expect(tests.length).toBeGreaterThan(0)
    })

    whenBuilt(
      'seed.py runs clean and produces every object schema.sql declares',
      () => {
        const out = mkdtempSync(join(tmpdir(), `stairwell-conv-${slug}-`))
        temps.push(out)
        const target = join(out, 'synthetic.db')

        execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })

        const db = new Database(target, { readonly: true, fileMustExist: true })
        try {
          const present = new Set(
            (
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
                )
                .all() as { name: string }[]
            ).map((r) => r.name),
          )
          const declared = declaredObjects(readFileSync(join(dir, 'schema.sql'), 'utf8'))
          expect(declared.length).toBeGreaterThan(0)
          for (const name of declared) expect(present.has(name)).toBe(true)
        } finally {
          db.close()
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    )

    whenBuilt(
      'generates loudly-fake, non-empty data',
      () => {
        const out = mkdtempSync(join(tmpdir(), `stairwell-loud-${slug}-`))
        temps.push(out)
        const target = join(out, 'synthetic.db')
        execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })

        const db = new Database(target, { readonly: true, fileMustExist: true })
        try {
          const tables = (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
              )
              .all() as { name: string }[]
          ).map((r) => r.name)

          let rows = 0
          let loud = false
          for (const table of tables) {
            const all = db.prepare(`SELECT * FROM "${table}"`).all() as Record<
              string,
              unknown
            >[]
            rows += all.length
            // Check VALUES only, never the serialised row: a column literally
            // named e.g. "test_flag" would satisfy a JSON.stringify(all) scan
            // while every row held realistic, non-fake data.
            for (const row of all) {
              if (Object.values(row).some((v) => String(v).includes('TEST'))) {
                loud = true
              }
            }
          }
          expect(rows).toBeGreaterThan(0)
          expect(loud).toBe(true)
        } finally {
          db.close()
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    )
  })
})
