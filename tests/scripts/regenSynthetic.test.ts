// tests/scripts/regenSynthetic.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { regenerateAll, userSlugsWithSeeds } from '@/scripts/regen-synthetic'

// Wraps the real readdirSync so one test (below) can override a single call
// with vi.mocked(readdirSync).mockReturnValueOnce(...). Every other call —
// in every other test in this file, and inside regen-synthetic.ts itself —
// falls through to the real implementation unchanged.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

/** See tests/scripts/pullSpec.test.ts — the droplet spawns processes slowly. */
const SUBPROCESS_TIMEOUT_MS = 60_000

let root: string

/** A minimal, valid user folder: schema.sql + a seed.py that executes it. */
function makeUser(slug: string, extraSql = '', usersDir: string = root) {
  const dir = join(usersDir, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'schema.sql'),
    `CREATE TABLE IF NOT EXISTS spend (merchant TEXT NOT NULL);${extraSql}`,
  )
  writeFileSync(
    join(dir, 'seed.py'),
    [
      'import os, sqlite3, sys',
      'here = os.path.dirname(os.path.abspath(__file__))',
      'schema = open(os.path.join(here, "schema.sql"), encoding="utf-8").read()',
      'db = sqlite3.connect(sys.argv[1])',
      'db.executescript(schema)',
      'db.execute("DELETE FROM spend")',
      `db.execute("INSERT INTO spend VALUES ('${slug.toUpperCase()} PALACE TEST')")`,
      'db.commit()',
      'db.close()',
      '',
    ].join('\n'),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-regen-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('userSlugsWithSeeds', () => {
  it('lists folders that have a seed.py, in sorted order', () => {
    // Creation order alone does not exercise the .sort() call: on APFS
    // (macOS), readdirSync already returns directory entries in
    // alphabetical order regardless of creation order, so
    // makeUser('devtwo'); makeUser('devone') passed even with .sort()
    // deleted — verified by removing it and re-running this suite, all 7
    // tests stayed green. The override below forces readdirSync's one call
    // inside userSlugsWithSeeds to return the names out of order, which no
    // filesystem's natural enumeration order can spoof.
    makeUser('devtwo')
    makeUser('devone')
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'devtwo', isDirectory: () => true },
      { name: 'devone', isDirectory: () => true },
    ] as unknown as ReturnType<typeof readdirSync>)
    expect(userSlugsWithSeeds(root)).toEqual(['devone', 'devtwo'])
  })

  it('skips a folder with no seed.py', () => {
    makeUser('devone')
    mkdirSync(join(root, 'devtwo'), { recursive: true })
    expect(userSlugsWithSeeds(root)).toEqual(['devone'])
  })

  it('returns an empty list when the users directory does not exist', () => {
    expect(userSlugsWithSeeds(join(root, 'nope'))).toEqual([])
  })

  it('skips a directory with a valid seed.py but a non-slug name', () => {
    // This function's result gets EXECUTED — not just checked for existence,
    // the way tests/users/conventions.test.ts's sweep does — so a dot-dir,
    // an editor artifact, or an accidental mkdir under users/ must never be
    // treated as an account, even if it happens to hold a working seed.py.
    makeUser('.hidden')
    expect(userSlugsWithSeeds(root)).toEqual([])
  })
})

describe('regenerateAll', () => {
  it(
    'writes each user database inside that user folder and nowhere else',
    () => {
      makeUser('devone')
      makeUser('devtwo')

      const written = regenerateAll(root)

      expect(written).toEqual([
        join(root, 'devone', 'synthetic.db'),
        join(root, 'devtwo', 'synthetic.db'),
      ])
      for (const slug of ['devone', 'devtwo']) {
        const db = new Database(join(root, slug, 'synthetic.db'), {
          readonly: true,
        })
        try {
          const row = db.prepare('SELECT merchant FROM spend').get() as {
            merchant: string
          }
          expect(row.merchant).toBe(`${slug.toUpperCase()} PALACE TEST`)
        } finally {
          db.close()
        }
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'targets a stable path, so a second run overwrites rather than creating a second file',
    () => {
      // Replacement semantics belong to each generator, not to this script:
      // the fixture's seed.py does its own `DELETE FROM spend` (see
      // makeUser above), the same way every real users/<slug>/seed.py is
      // expected to. What this test actually pins is narrower — that
      // regenerateAll computes the same target path on every run, so the
      // second run's DELETE lands in the same file the first run wrote
      // rather than a fresh one.
      makeUser('devone')
      regenerateAll(root)
      regenerateAll(root)
      const db = new Database(join(root, 'devone', 'synthetic.db'), {
        readonly: true,
      })
      try {
        expect(
          (db.prepare('SELECT COUNT(*) AS n FROM spend').get() as { n: number }).n,
        ).toBe(1)
      } finally {
        db.close()
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'removes stale -wal and -shm sidecars before regenerating',
    () => {
      // A sidecar left from an older shape can resurrect rows the new
      // generator never wrote. tests/support/synthetic.ts already does this
      // for the same reason.
      makeUser('devone')
      regenerateAll(root)
      writeFileSync(join(root, 'devone', 'synthetic.db-wal'), 'stale')
      regenerateAll(root)
      expect(existsSync(join(root, 'devone', 'synthetic.db-wal'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'leaves a neighbouring platform database byte-identical',
    () => {
      // The header comment in scripts/regen-synthetic.ts claims the
      // separation from platform/dev/synthetic.db is structural — this is
      // what makes that claim tested rather than merely asserted. Mirrors
      // tests/support/noCross.test.ts, which pins the same property for the
      // SIBLING helpers in tests/support/synthetic.ts, not for this script.
      const parent = mkdtempSync(join(tmpdir(), 'stairwell-regen-parent-'))
      try {
        const usersDir = join(parent, 'users')
        mkdirSync(usersDir, { recursive: true })
        const platformDir = join(parent, 'platform', 'dev')
        mkdirSync(platformDir, { recursive: true })
        const platformTarget = join(platformDir, 'synthetic.db')
        writeFileSync(platformTarget, 'not a real database — just bytes to diff')
        const before = readFileSync(platformTarget)

        makeUser('devone', '', usersDir)
        regenerateAll(usersDir)

        expect(readFileSync(platformTarget).equals(before)).toBe(true)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'throws, naming the slug, when a generator fails',
    () => {
      // toThrow(/broken/) alone passed even with the slug-naming wrapper
      // deleted: execFileSync's own error message already contains the
      // failing script's path, and root here is a temp dir directly
      // containing `broken`, so the raw message matches /broken/ regardless
      // of whether regenerateAll adds anything. Asserting on the wrapper's
      // own `users/<slug>/seed.py failed` prefix is a real discriminator,
      // because the raw execFileSync message has no `users/` segment in it
      // — the failure the wrapper exists to prevent is a deploy log that
      // says "regeneration failed" without saying whose folder, sending the
      // reader to the wrong place.
      mkdirSync(join(root, 'broken'), { recursive: true })
      writeFileSync(join(root, 'broken', 'seed.py'), 'raise SystemExit(3)\n')
      expect(() => regenerateAll(root)).toThrow(/users\/broken\/seed\.py failed/)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})
