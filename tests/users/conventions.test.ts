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
import type { DashboardScreen } from '@/lib/dashboard/contract'
import { declaredObjects } from '@/tests/support/declaredObjects'
import { verifyManifest } from '@/lib/db/migrationFiles'
import { readBuildNotes } from '@/lib/build/notes'

/**
 * Governs a screen id — NOT lib/auth/slug.ts's SLUG_PATTERN, despite both
 * living one import away. `DashboardScreen`'s id/title/order mirror
 * lib/spec/schema.ts's `Screen` exactly (lib/dashboard/contract.ts says so),
 * and a screen id is spec-authored: it comes from the same model output as
 * `divorce_lawyer_fund`-shaped panel and value ids (CLAUDE.md, Dashboard
 * folder conventions — "Metrics never carry user values"),
 * which use underscores. SLUG_PATTERN (`^[a-z0-9-]{1,32}$`) allows hyphens
 * and forbids underscores — the opposite of a spec id's actual shape — so it
 * would reject a perfectly valid spec-derived screen id on the day one
 * contains an underscore. Both id shapes ARE safe as a `?screen=<id>` query
 * value and a `#screen-<id>` DOM id, so the deciding fact is provenance
 * (spec-authored, not account-authored), not URL/DOM safety.
 *
 * Mirrors the unexported `ID` constant in lib/spec/fields.ts
 * (`/^[a-z0-9]+(_[a-z0-9]+)*$/`) rather than importing it: this task's brief
 * scopes changes to this file and tests/dashboard/registry.test.ts only, and
 * `ID` is deliberately not part of that module's public surface. Kept in
 * sync by inspection, same as the shape check below is a duplicate of
 * fields.ts's own throw, not a delegation to it.
 */
const SCREEN_ID_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/

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
const REQUIRED = ['migrations', 'seed.py', 'queries.ts', 'dashboard.tsx', 'tests']

const isBuilt = (slug: string) =>
  REQUIRED.every((entry) => existsSync(join(USERS, slug, entry)))

/**
 * A dashboard.tsx module has to actually be IMPORTED to check what its
 * `screens` export holds at runtime — a type check already proves the export
 * exists and shapes each entry as `{ id, title, order }` (task 23 made it
 * required), but not that the array is non-empty, that its ids are unique,
 * or that its `order`s are integers, all of which the type system cannot see.
 * This file did not import any .tsx module before this sweep;
 * tests/dashboard/contract.test.ts already proves a dynamic `import()` of a
 * dashboard module works inside this suite (it does exactly this through
 * `dashboardLoaderFor`), so the same dynamic import, run directly against the
 * slug rather than through the registry, is used here too — this sweep must
 * cover a complete-but-not-yet-registered folder (dashboard.tsx exists the
 * moment a folder is `complete`, regardless of whether it has a migrations
 * shape yet — see the `whenComplete` gate below), which the registry loader
 * cannot reach at all.
 *
 * Cached per slug: several `whenComplete` checks below each need the same
 * import, and re-importing per assertion would run the module's top-level
 * code (and pay the transform cost) once per check for no reason.
 */
const screensCache = new Map<string, Promise<DashboardScreen[]>>()
function loadScreens(slug: string): Promise<DashboardScreen[]> {
  let cached = screensCache.get(slug)
  if (!cached) {
    // @vite-ignore — this path is fully dynamic (a variable slug, no file
    // extension), so vite:dynamic-import-vars cannot glob it for code-split
    // analysis and would otherwise only warn. vite-node (vitest's runtime)
    // resolves it directly, the same way it resolves the real dashboard
    // import inside dashboardLoaderFor for tests/dashboard/contract.test.ts.
    cached = import(/* @vite-ignore */ `@/users/${slug}/dashboard`).then(
      (mod) => (mod as { screens: DashboardScreen[] }).screens,
    )
    screensCache.set(slug, cached)
  }
  return cached
}

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
     *   pulled     — spec.md / mockup.html only. Allowed: not started yet.
     *   scaffolded — all five entries, but migrations/ holds no .sql. Allowed:
     *                ./scripts/new-dashboard.sh just ran and nobody has
     *                designed a shape yet.
     *   built      — all five entries AND a shape. Swept in full.
     *   partial    — some of the five. A defect, and the one this now names.
     *
     * Skipping the built-only checks is what makes the middle states pass, so
     * "is either fully built or not started" carries the weight for a pulled
     * folder, and the run-if-built assertion below stops the whole sweep from
     * going quiet if every folder were ever pulled-only.
     *
     * WHY "scaffolded" IS ITS OWN STATE. The scaffold used to ship a finance
     * table — a `transactions` shape copied from devone — purely so a fresh
     * folder would satisfy the built-only checks below, which demand that
     * seed.py produce every object the migrations declare. That is the right
     * demand of a finished dashboard and the wrong demand of one nobody has
     * designed: it made every new dashboard start life pretending to be about
     * spending, whatever the friend had actually asked for. The shape is gone
     * and this state replaces it, so the checks stay strict where they mean
     * something instead of being satisfied by a placeholder.
     */
    const found = REQUIRED.filter((entry) => existsSync(join(dir, entry)))
    const complete = found.length === REQUIRED.length
    const hasShape =
      complete &&
      readdirSync(join(dir, 'migrations')).some((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    const built = complete && hasShape
    const whenBuilt = built ? it : it.skip

    it('is either fully built or not started — never half a dashboard', () => {
      const missing = REQUIRED.filter((entry) => !found.includes(entry))
      // Named rather than counted, so the failure says which files to write.
      // `complete`, not `built`: a scaffolded folder has every entry and no
      // shape yet, which is a legitimate state rather than a half-written one.
      expect(complete || found.length === 0, `missing: ${missing.join(', ')}`).toBe(true)
    })

    // A scaffolded folder still has to be wired up — its dashboard must render
    // and its seed must run. What it does NOT have to do is declare a shape.
    const whenComplete = complete ? it : it.skip

    whenComplete('has a migrations/README.md if it has no migrations yet', () => {
      // The empty state is deliberate, and a directory that is empty by
      // accident looks identical to one that is empty on purpose. The README
      // is what tells them apart, and it is where the rules for writing 001
      // live.
      if (hasShape) return
      expect(existsSync(join(dir, 'migrations', 'README.md'))).toBe(true)
    })

    whenComplete('has a notes/ directory', () => {
      // Required on every complete folder, including scaffolded ones — the
      // directory is the convention, and it must exist before the first build
      // finishes so there is somewhere obvious to write v1.md.
      expect(existsSync(join(dir, 'notes'))).toBe(true)
    })

    whenComplete('has nothing in notes/ but README.md and v<n>.md files', () => {
      // Shape, NOT presence. This sweep cannot know which versions were built —
      // that lives in the platform database, not in this folder — so demanding
      // "at least one note" would be a false failure on devone (hand-written,
      // never had a spec) and on every folder built before this convention.
      // Presence is enforced where the version number is actually known:
      // scripts/announce-deploy.ts.
      const strays = readdirSync(join(dir, 'notes')).filter(
        (f) => f !== 'README.md' && !/^v\d+\.md$/.test(f),
      )
      expect(strays, `unexpected files in notes/: ${strays.join(', ')}`).toHaveLength(0)
    })

    whenComplete('every note in notes/ parses', () => {
      // VACUOUS until the first real v<n>.md lands — no folder in this repo
      // has one yet (final review, Minor 11), so this loop body has never
      // actually run and this test's green means only "no v<n>.md files
      // exist to fail on", not "readBuildNotes was exercised against a real
      // one". Do not read this test passing as verification of
      // readBuildNotes itself — that lives in tests/build/notes.test.ts.
      for (const f of readdirSync(join(dir, 'notes')).filter((f) => /^v\d+\.md$/.test(f))) {
        const version = Number(/^v(\d+)\.md$/.exec(f)![1])
        expect(() => readBuildNotes(slug, version, USERS)).not.toThrow()
      }
    })

    whenBuilt('has a manifest covering every migration it declares', () => {
      // Without one the runner refuses every session for this slug — the
      // friend cannot log in at all. A folder that declares a shape must
      // therefore declare its checksums too.
      expect(existsSync(join(dir, 'migrations', 'manifest.json'))).toBe(true)
      expect(() => verifyManifest(slug)).not.toThrow()
    })

    whenComplete('has at least one test of its own', () => {
      const tests = readdirSync(join(dir, 'tests')).filter((f) =>
        f.endsWith('.test.ts'),
      )
      expect(tests.length).toBeGreaterThan(0)
    })

    whenBuilt(
      'seed.py runs clean and produces every object the migrations declare',
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
          // Built by applying the chain directly, rather than by scanning the
          // SQL for CREATE statements.
          //
          // Scanning would false-fail on the sanctioned rebuild recipe (D4):
          // `CREATE TABLE x_new; ...; DROP TABLE x; ALTER TABLE x_new RENAME
          // TO x` textually declares `x_new`, which correctly does not exist
          // afterwards. Applying the migrations reproduces the real end state,
          // renames and drops included.
          //
          // It also asserts something stronger than the old check did: that
          // seed.py builds its database FROM the migrations, rather than
          // declaring shapes of its own that happen to look similar.
          const migrationsDir = join(dir, 'migrations')
          const reference = new Database(':memory:')
          try {
            for (const file of readdirSync(migrationsDir)
              .filter((f) => f.endsWith('.sql'))
              .sort()) {
              reference.exec(readFileSync(join(migrationsDir, file), 'utf8'))
            }
            const declared = (
              reference
                .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
                .all() as { name: string }[]
            )
              .map((r) => r.name)
              .filter((name) => !name.startsWith('sqlite_'))

            expect(declared.length).toBeGreaterThan(0)
            for (const name of declared) expect(present.has(name)).toBe(true)
          } finally {
            reference.close()
          }
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

    // The four properties `screens: DashboardScreen[]` cannot express as a
    // type, run over every COMPLETE folder — not `whenBuilt`. `screens`
    // comes from dashboard.tsx, one of the five REQUIRED entries that make a
    // folder `complete`; `whenBuilt` additionally requires `hasShape` (a real
    // .sql migration file), which is about the DATA shape and has no
    // relationship to a dashboard's screens. Gating on `whenBuilt` skipped
    // these checks on run4, which has migrations but no numbered .sql file
    // yet — and run4 is the one folder in the repo whose screens export
    // (`walk_now`) actually distinguishes SCREEN_ID_PATTERN from
    // SLUG_PATTERN; every other folder uses `morning`, which passes both.
    // Fix round 1, finding 1: gating on whenBuilt made the sweep exercise
    // zero cases where the id-pattern choice mattered.
    //
    // Safe on a freshly scaffolded folder: platform/templates ships
    // `screens: [{ id: 'morning', title: 'Morning', order: 1 }]`, which
    // trivially satisfies all four checks. No separate vacuity guard is
    // needed either — the file's existing "sweeps at least one BUILT
    // dashboard" guard already proves at least one COMPLETE folder exists
    // (built implies complete).

    whenComplete('screens is non-empty', async () => {
      const screens = await loadScreens(slug)
      // Empty is legal to the type system and fatal at render: activeScreen
      // throws on it (lib/dashboard/contract.ts), turning the page into
      // dashboard_error instead of showing anything. Better a red test here.
      expect(screens.length).toBeGreaterThan(0)
    })

    whenComplete('every screen id matches the spec id shape', async () => {
      const screens = await loadScreens(slug)
      for (const screen of screens) {
        expect(
          SCREEN_ID_PATTERN.test(screen.id),
          `screen id "${screen.id}" is not a valid spec-shaped id (lowercase letters, digits, single underscores)`,
        ).toBe(true)
      }
    })

    whenComplete('every screen order is an integer', async () => {
      const screens = await loadScreens(slug)
      for (const screen of screens) {
        expect(
          Number.isInteger(screen.order),
          `screen "${screen.id}" has a non-integer order: ${JSON.stringify(screen.order)}`,
        ).toBe(true)
      }
    })

    whenComplete('screen ids are unique within the folder', async () => {
      const screens = await loadScreens(slug)
      const ids = screens.map((s) => s.id)
      expect(
        new Set(ids).size,
        `duplicate screen id among: ${ids.join(', ')} — ?screen= would be ambiguous`,
      ).toBe(ids.length)
    })
  })
})
