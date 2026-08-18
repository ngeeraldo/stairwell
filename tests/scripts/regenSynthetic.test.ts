// tests/scripts/regenSynthetic.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
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
import {
  regenerateAll,
  regenerateAllEmpty,
  userSlugsWithSeeds,
} from '@/scripts/regen-synthetic'

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

  it(
    'leaves a real <slug>.db byte-identical — this is "survives a deploy"',
    () => {
      // regen-synthetic runs on every deploy. If it touched the encrypted
      // database, every tap a friend had logged would be destroyed by the next
      // deploy, silently. The checkpoint phrase "the row survives a deploy" is
      // exactly this assertion.
      makeUser('devtwo')
      const real = join(root, 'devtwo', 'devtwo.db')
      writeFileSync(real, 'PRETEND ENCRYPTED BYTES')
      const before = readFileSync(real)

      regenerateAll(root)

      expect(readFileSync(real).equals(before)).toBe(true)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})

/**
 * A folder shaped the way a real one is: migrations/ owns the shape, and
 * seed.py applies them before inserting. `makeUser` above predates migrations
 * and writes a schema.sql instead — left alone deliberately, since every
 * regenerateAll test around it only needs *a* generator that works, and
 * rewriting them is not this change.
 */
function makeMigratedUser(slug: string, migrations: Record<string, string>) {
  const dir = join(root, slug)
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(join(dir, 'migrations', name), sql)
  }
  writeFileSync(
    join(dir, 'seed.py'),
    [
      'import os, sqlite3, sys',
      'here = os.path.dirname(os.path.abspath(__file__))',
      'mig = os.path.join(here, "migrations")',
      'db = sqlite3.connect(sys.argv[1])',
      'names = sorted(f for f in os.listdir(mig) if f.endswith(".sql"))',
      'for n in names:',
      '    db.executescript(open(os.path.join(mig, n), encoding="utf-8").read())',
      'if names:',
      '    db.execute("PRAGMA user_version = %d" % int(names[-1][:3]))',
      'db.execute("INSERT INTO spend VALUES (\'PALACE TEST\')")',
      'db.commit()',
      'db.close()',
      '',
    ].join('\n'),
  )
}

describe('the CLI’s output', () => {
  // Spawned for real, rather than by calling regenerateAll and spying on
  // console.log. The defect these cover was NOT in the logic — regenerateAll
  // did exactly what it was written to do — it was that execFileSync's
  // stdio: 'pipe' captured each seed.py's stdout into a buffer nobody read, so
  // the line docs/runbook.md step 7.2 tells you to watch for never reached a
  // terminal. A test that stubs the console proves the string was passed to
  // console.log; only running the process proves a human would see it.
  function runCli(args: string[] = []): string {
    return execFileSync('npx', ['tsx', 'scripts/regen-synthetic.ts', ...args], {
      encoding: 'utf8',
      env: { ...process.env, USERS_DIR: root },
    })
  }

  /** A seed.py that announces itself, the way every real one does. */
  function makeTalkingUser(slug: string, line: string) {
    const dir = join(root, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'seed.py'),
      [
        'import sqlite3, sys',
        'db = sqlite3.connect(sys.argv[1])',
        'db.executescript("CREATE TABLE IF NOT EXISTS spend (merchant TEXT);")',
        'db.commit()',
        'db.close()',
        `print(${JSON.stringify(line)})`,
        '',
      ].join('\n'),
    )
  }

  it(
    'shows what each seed.py printed',
    () => {
      // The real thing this protects: a scaffolded folder whose migration has
      // not landed prints exactly this, and an empty database is otherwise a
      // legitimate state that nothing else in the pipeline objects to.
      makeTalkingUser('devone', 'devone: no shape yet, empty database -> x.db')

      expect(runCli()).toContain('devone: no shape yet, empty database')
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'falls back to naming the file when a seed prints nothing',
    () => {
      makeUser('devone')

      expect(runCli()).toContain(`Regenerated ${join(root, 'devone', 'synthetic.db')}`)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'names the file in --empty, where there is no seed to speak for it',
    () => {
      makeTalkingUser('devone', 'devone: 5 rows')
      const out = runCli(['--empty'])

      expect(out).toContain(`Regenerated ${join(root, 'devone', 'synthetic.db')}`)
      // The seed did not run at all, so its line must not appear — printing it
      // would claim rows exist in a database built to have none.
      expect(out).not.toContain('devone: 5 rows')
      expect(out).toContain('EMPTY: shape only, no rows')
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})

describe('regenerateAllEmpty', () => {
  it('applies the shape and writes no rows', () => {
    makeMigratedUser('devone', {
      '001_initial.sql': 'CREATE TABLE spend (merchant TEXT NOT NULL);',
    })

    regenerateAllEmpty(root)

    const db = new Database(join(root, 'devone', 'synthetic.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM spend').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  })

  it('empties a database that seed.py had already filled', () => {
    // The actual workflow: you have been building against sample rows, and you
    // want to see the screen a friend gets on their first morning. If this
    // only worked on a fresh checkout it would be useless.
    makeMigratedUser('devone', {
      '001_initial.sql': 'CREATE TABLE spend (merchant TEXT NOT NULL);',
    })
    regenerateAll(root)

    const filled = new Database(join(root, 'devone', 'synthetic.db'), { readonly: true })
    try {
      expect((filled.prepare('SELECT COUNT(*) AS c FROM spend').get() as { c: number }).c)
        .toBeGreaterThan(0)
    } finally {
      filled.close()
    }

    regenerateAllEmpty(root)

    const db = new Database(join(root, 'devone', 'synthetic.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM spend').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  }, SUBPROCESS_TIMEOUT_MS)

  it('applies migrations in order and stamps user_version to the last one', () => {
    // 002 ALTERs what 001 created, so an out-of-order application throws
    // rather than quietly producing a different shape.
    makeMigratedUser('devone', {
      '001_initial.sql': 'CREATE TABLE spend (merchant TEXT NOT NULL);',
      '002_add_amount.sql': 'ALTER TABLE spend ADD COLUMN amount_cents INTEGER;',
    })

    regenerateAllEmpty(root)

    const db = new Database(join(root, 'devone', 'synthetic.db'), { readonly: true })
    try {
      const columns = (db.pragma('table_info(spend)') as { name: string }[]).map((c) => c.name)
      expect(columns).toEqual(['merchant', 'amount_cents'])
      // Matches what seed.py stamps, so an empty synthetic database does not
      // look like one the migration runner still owes work to.
      expect(db.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      db.close()
    }
  })

  it('creates an empty database for a scaffolded folder with no migrations', () => {
    // The scaffolded state (tests/users/conventions.test.ts): a folder exists,
    // nobody has designed a shape. seed.py produces an empty file here too,
    // and lib/db/userData.ts opens synthetic.db with fileMustExist in dev — so
    // the file has to exist either way.
    mkdirSync(join(root, 'devone'), { recursive: true })
    writeFileSync(join(root, 'devone', 'seed.py'), 'import sys, sqlite3\nsqlite3.connect(sys.argv[1]).close()\n')

    expect(regenerateAllEmpty(root)).toEqual([join(root, 'devone', 'synthetic.db')])
    expect(existsSync(join(root, 'devone', 'synthetic.db'))).toBe(true)
  })

  it('leaves a real <slug>.db byte-identical, same as regenerateAll', () => {
    // Same property the deploy test above pins, asserted separately because
    // this mode deletes and rewrites through a different code path — it never
    // spawns seed.py, so it does not inherit that guarantee.
    makeMigratedUser('devtwo', {
      '001_initial.sql': 'CREATE TABLE spend (merchant TEXT NOT NULL);',
    })
    const real = join(root, 'devtwo', 'devtwo.db')
    writeFileSync(real, 'PRETEND ENCRYPTED BYTES')
    const before = readFileSync(real)

    regenerateAllEmpty(root)

    expect(readFileSync(real).equals(before)).toBe(true)
  })

  it('skips a non-slug directory, same as the seeded path', () => {
    makeMigratedUser('devone', {
      '001_initial.sql': 'CREATE TABLE spend (merchant TEXT NOT NULL);',
    })
    mkdirSync(join(root, '.hidden', 'migrations'), { recursive: true })
    writeFileSync(join(root, '.hidden', 'seed.py'), '')
    writeFileSync(join(root, '.hidden', 'migrations', '001_initial.sql'), 'CREATE TABLE x (a TEXT);')

    expect(regenerateAllEmpty(root)).toEqual([join(root, 'devone', 'synthetic.db')])
    expect(existsSync(join(root, '.hidden', 'synthetic.db'))).toBe(false)
  })
})
