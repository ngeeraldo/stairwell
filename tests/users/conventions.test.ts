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
import { readCurrentState } from '@/lib/build/currentState'

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

/**
 * A value that is a number, or a bare calendar day/instant — nothing else.
 *
 * Deliberately narrow. Anything this does NOT match counts as free text below,
 * so a pattern that grew to cover "sort of structured" values would quietly
 * stop requiring the marker from the columns that most need it.
 */
const STRUCTURAL_VALUE =
  /^(-?\d+(\.\d+)?|\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?)$/

/**
 * Whether a seeded value is somewhere a real person's data could hide.
 *
 * The check below enforces CLAUDE.md > Data safety's loudly-fake rule by
 * looking for the literal marker `TEST`. That works for a merchant name and is
 * impossible for a bathroom count: a value that is a number, or a day key,
 * cannot carry the word and still be the thing it is. devtwo already hit this
 * and paid the marker with a sentinel row whose `day` its own migration
 * documents as invalid — a proxy being satisfied, not a rule being met.
 *
 * The rule the marker actually serves is CLAUDE.md > Testing's: "a fixture is
 * never recorded from a real person's data". `seed.py` is committed SOURCE, so
 * it sits outside every other guard here — .gitignore, the guard hook and Gate
 * F all govern DATABASES, and none of them would notice a real person's
 * merchant list pasted into a generator and committed forever. This check is
 * the only thing that would.
 *
 * That threat needs somewhere to hide, and only free text has room. An integer
 * is not traceable to anyone, and '2026-08-18' is a fact about the calendar
 * rather than about a person. So the marker is required of a seed that
 * produces free text, and not of one that produces only numbers and days.
 *
 * This is narrower than "every synthetic value is loudly fake", which is what
 * CLAUDE.md says and what no version of this check has ever enforced: devone's
 * own categories ('eating out', 'groceries') carry no marker and never have.
 * One marked value per seed is the bar, unchanged — the only thing that moved
 * is whether a seed with nowhere to put one is asked for it anyway.
 */
export function isFreeText(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !STRUCTURAL_VALUE.test(value)
}

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

// Pinned directly, because the loud-fake sweep below now DECIDES whether to
// demand a marker at all based on this predicate. Getting it wrong in the
// permissive direction is silent: a seed full of real merchant names read as
// "structural" would skip the check entirely and the sweep would stay green.
describe('isFreeText — where a real person’s data could hide', () => {
  it('treats names and descriptions as free text', () => {
    for (const value of ['COFFEE PALACE TEST', 'eating out', 'Sam', 'a', '2026-08-18 SAMPLE TEST']) {
      expect(isFreeText(value)).toBe(true)
    }
  })

  it('treats numbers and day keys as structural', () => {
    // Numbers whether stored as INTEGER or as TEXT: SQLite is dynamically
    // typed, so a seed may hand back either for the same column.
    for (const value of [0, 7, -1, 1.5, '7', '-1', '1755561600000']) {
      expect(isFreeText(value)).toBe(false)
    }
    for (const value of ['2026-08-18', '2026-08-18T14:30:00Z', '2026-08-18 14:30']) {
      expect(isFreeText(value)).toBe(false)
    }
  })

  it('treats null, empty and non-strings as nothing to mark', () => {
    for (const value of [null, undefined, '', Buffer.from([1, 2, 3])]) {
      expect(isFreeText(value)).toBe(false)
    }
  })
})

describe('SCREEN_ID_PATTERN is not SLUG_PATTERN', () => {
  // Held here explicitly since users/run4/ was deleted. Its screens export
  // used `walk_now`, and it was the only folder in the repo where the two
  // patterns disagreed — the sweep below runs over live folders, so with
  // every remaining folder on `morning` (which passes both) it can no longer
  // tell them apart. A deleted fixture must not take a real assertion with
  // it: this states directly what the sweep used to prove incidentally.
  it('accepts an underscore in a screen id, which a slug may not carry', () => {
    expect(SCREEN_ID_PATTERN.test('walk_now')).toBe(true)
    expect(SLUG_PATTERN.test('walk_now')).toBe(false)
  })

  it('still rejects what neither pattern allows', () => {
    expect(SCREEN_ID_PATTERN.test('Walk Now')).toBe(false)
    expect(SCREEN_ID_PATTERN.test('')).toBe(false)
    expect(SCREEN_ID_PATTERN.test('_leading')).toBe(false)
  })
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
     * the middle one: `./scripts/pull-spec.sh devtwo` writes spec.md into a
     * folder that does not exist yet, so between pulling a version and
     * building the dashboard from it the folder legitimately holds the build
     * contract and nothing else. The sweep used to fail all eight of its
     * checks there — on the documented workflow, at the exact moment it is
     * followed. (pull-spec.sh wrote mockup.html alongside spec.md until the
     * mockup-loop removal — nothing composes or serves mockup HTML any more —
     * and then spec.md alone until change-only specs, plan
     * 2026-08-19-change-only-specs. It writes a PAIR again now: spec.md and
     * conversation.md, the transcript slice behind that spec version. Only
     * spec.md is tracked; conversation.md is gitignored, so it is invisible to
     * a fresh clone but genuinely present in a pulled folder on the laptop.)
     *
     *   pulled     — spec.md, plus a gitignored conversation.md beside it and
     *                nothing else. Allowed: not started yet.
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

    whenBuilt('has a current.md that parses', () => {
      // PRESENCE, unlike notes/ — and the difference is that this sweep CAN
      // know. Which v<n>.md files should exist depends on which versions were
      // built, which lives in the platform database; current.md is exactly one
      // file per built dashboard, and a built dashboard the agent cannot see
      // is the whole defect this artifact exists to fix.
      const state = readCurrentState(slug, USERS)
      expect(state, `${slug} is built but has no current.md`).not.toBeNull()
      expect(state!.slug).toBe(slug)
    })

    whenBuilt('current.md names the newest version that was built', () => {
      // THE STALENESS GATE, and it needs no database — notes/v<n>.md exists
      // on disk for exactly the versions that were built, so the newest note
      // is what current.md must describe.
      //
      // This matters because nothing else catches it: `*.md` is exempt from
      // Gate B (.githooks/pre-commit:152), so a build that edits dashboard.tsx
      // and forgets to rewrite current.md commits green. Without this check
      // the file rots into a description of some earlier version, which is the
      // exact failure the artifact exists to prevent, just slower.
      const versions = readdirSync(join(dir, 'notes'))
        .map((f) => /^v(\d+)\.md$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
      const state = readCurrentState(slug, USERS)
      // GUARDED, not `!`. docs/runbook-ai.md §2.8 tells the builder to expect
      // current.md to be absent between §2.2 (shape landed, so `built` is
      // already true) and §3.2 (current.md written) — the previous test
      // already reports that gap by name. An unguarded `!` here would instead
      // throw a null-deref TypeError, which drops this test's own message and
      // leaves whoever is reading red output no way to tell "current.md is
      // missing, as expected mid-build" from "the runner itself broke".
      expect(state, `${slug} is built but has no current.md`).not.toBeNull()
      // No notes at all means the folder predates the spec loop — devone and
      // devtwo, hand-written, never had a version. Version 0 says so.
      const expected = versions.length === 0 ? 0 : Math.max(...versions)
      expect(
        state!.version,
        versions.length === 0
          ? `${slug}/current.md says version ${state!.version}, but notes/ has no v<n>.md files at all`
          : `${slug}/current.md says version ${state!.version}, newest note is v${expected}`,
      ).toBe(expected)
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
      'generates non-empty data, loudly fake wherever it has free text',
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
          let freeText = 0
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
              for (const value of Object.values(row)) {
                if (!isFreeText(value)) continue
                freeText += 1
                // The marker is looked for in free text only. A structural
                // value cannot contain it, so this is the same assertion the
                // check has always made — stated over the values that can
                // actually carry it.
                if (value.includes('TEST')) loud = true
              }
            }
          }
          expect(rows).toBeGreaterThan(0)
          // A seed that produces only numbers and day keys has nowhere to put
          // the marker, and nothing for a real person's data to hide in.
          // See isFreeText.
          if (freeText > 0) expect(loud).toBe(true)
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
    // relationship to a dashboard's screens.
    //
    // The folder this ruling was made for — run4, complete but with no
    // numbered .sql, and the only one whose screen id (`walk_now`) told
    // SCREEN_ID_PATTERN and SLUG_PATTERN apart — was deleted on 2026-08-18.
    // The ruling stands on its own reasoning above. The id-pattern coverage
    // moved to the SCREEN_ID_PATTERN describe at the top of this
    // file, which states it directly rather than depending on a fixture
    // happening to exist. NO FOLDER IS
    // CURRENTLY IN THE `scaffolded` STATE, so that branch is live but
    // unexercised — a known gap, accepted rather than papered over with a
    // permanent fake dashboard under users/.

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
