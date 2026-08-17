// tests/scripts/newDashboard.test.ts
//
// Runs the real script as a subprocess with cwd pointed at a disposable
// sandbox, the same way tests/scripts/pullSpec.test.ts does — so
// `users/<slug>` lands inside the sandbox and never inside the real tree, no
// matter how the process exits.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'

/** See tests/scripts/pullSpec.test.ts — the droplet spawns processes slowly. */
const SUBPROCESS_TIMEOUT_MS = 60_000

const REPO = resolve(__dirname, '..', '..')
const sandboxes: string[] = []

afterEach(() => {
  while (sandboxes.length > 0) {
    const d = sandboxes.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

function makeSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'stairwell-new-dashboard-'))
  sandboxes.push(sandbox)
  for (const name of ['scripts', 'platform']) {
    symlinkSync(join(REPO, name), join(sandbox, name))
  }
  return sandbox
}

function run(sandbox: string, args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync(
      join(sandbox, 'scripts', 'new-dashboard.sh'),
      args,
      { cwd: sandbox, stdio: 'pipe', encoding: 'utf8' },
    )
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

describe('scripts/new-dashboard.sh', () => {
  it(
    'creates every required entry, with the slug substituted',
    () => {
      const sandbox = makeSandbox()
      const { status, output } = run(sandbox, ['devthree'])

      expect(status).toBe(0)
      const dir = join(sandbox, 'users', 'devthree')
      for (const entry of ['migrations/README.md', 'seed.py', 'queries.ts', 'dashboard.tsx']) {
        expect(existsSync(join(dir, entry))).toBe(true)
      }
      expect(existsSync(join(dir, 'tests', 'dashboard.test.ts'))).toBe(true)

      // No placeholder survives anywhere.
      for (const entry of ['migrations/README.md', 'seed.py', 'queries.ts', 'dashboard.tsx']) {
        expect(readFileSync(join(dir, entry), 'utf8')).not.toContain('__SLUG__')
      }
      expect(readFileSync(join(dir, 'dashboard.tsx'), 'utf8')).toContain('devthree')

      // The registry is NOT edited — the script prints the line instead.
      expect(output).toContain("devthree: () => import('@/users/devthree/dashboard')")

      // Task 13 / File 02 §5: per-user tests must cover write paths, not just
      // rendering. A scaffolded dashboard starts with that shape sketched in
      // a commented block, so a write-path test is something the folder is
      // BORN with rather than something acquired later only if someone
      // remembers users/devtwo/tests/write.test.ts existed as precedent.
      expect(readFileSync(join(dir, 'tests', 'dashboard.test.ts'), 'utf8')).toContain('write path')
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it('scaffolds a notes/ directory with its README', () => {
    // <dir> is the temp scaffold this file's existing helper produces.
    const sandbox = makeSandbox()
    expect(run(sandbox, ['devthree']).status).toBe(0)
    const dir = join(sandbox, 'users', 'devthree')
    expect(existsSync(join(dir, 'notes', 'README.md'))).toBe(true)
    expect(readFileSync(join(dir, 'notes', 'README.md'), 'utf8')).toContain(
      'Added, never edited',
    )
  })

  it(
    'points at the runbook instead of restating the build sequence',
    () => {
      // The epilogue used to list `npm run synthetic`, `npx vitest` and
      // `pull-spec.sh` as a three-step flow of its own. That copy went stale
      // within two days of docs/runbook.md being written: it never learned
      // about the <slug>/v<n> branch, so following it built on main, and it
      // never learned about `npm run shots`, so it skipped the picture review
      // CLAUDE.md requires before a commit.
      //
      // Pinned as absences, not just as a present pointer, because a pointer
      // sitting underneath a stale command list is exactly the state this
      // replaced — the reader follows the commands and never reaches the line
      // telling them not to.
      const sandbox = makeSandbox()
      const { status, output } = run(sandbox, ['devthree'])

      expect(status).toBe(0)
      expect(output).toContain('docs/runbook.md')
      expect(output).toMatch(/do not build on main/i)

      for (const restated of ['npm run synthetic', 'npx vitest', 'pull-spec.sh', 'npm run shots']) {
        expect(output).not.toContain(restated)
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'refuses an invalid slug and creates nothing',
    () => {
      const sandbox = makeSandbox()
      for (const bad of ['../escape', 'Dev Three', 'DEVTHREE', 'dev.three']) {
        const { status } = run(sandbox, [bad])
        expect(status).toBe(2)
      }
      expect(existsSync(join(sandbox, 'users'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'refuses each reserved slug and creates nothing',
    () => {
      // Mirrors RESERVED_SLUGS in lib/auth/slug.ts. Kept as a separate test
      // from the invalid-charset one above so a reserved name that also
      // happens to be charset-valid (every one of these is) is pinned on
      // its own, not accidentally covered by a broader assertion.
      const sandbox = makeSandbox()
      for (const reserved of ['admin', 'login', 'unlock', 'api', '_next', 'favicon.ico']) {
        const { status } = run(sandbox, [reserved])
        expect(status).toBe(2)
      }
      expect(existsSync(join(sandbox, 'users'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'refuses to overwrite an existing folder',
    () => {
      const sandbox = makeSandbox()
      mkdirSync(join(sandbox, 'users', 'devthree'), { recursive: true })
      const { status, output } = run(sandbox, ['devthree'])
      expect(status).toBe(2)
      expect(output).toMatch(/already exists/)
      expect(existsSync(join(sandbox, 'users', 'devthree', 'migrations'))).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'requires a slug',
    () => {
      const sandbox = makeSandbox()
      const { status, output } = run(sandbox, [])
      expect(status).toBe(2)
      expect(output).toMatch(/usage/)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  it(
    'produces a folder with NO shape, and a seed that runs anyway',
    () => {
      // WHAT A SCAFFOLD IS FOR, restated after it stopped shipping a shape.
      //
      // This used to assert the opposite: that the generated folder declared
      // tables and that seed.py wrote loudly-fake rows into them. It did,
      // because the template carried a `transactions` table copied from
      // devone — so every dashboard began life pretending to be about
      // spending, whatever the friend had asked for, and the placeholder got
      // extended rather than replaced.
      //
      // The demands that remain are the ones that make a folder USABLE on the
      // first run: seed.py executes, and the file it must create exists —
      // lib/db/userData.ts opens synthetic.db with fileMustExist in dev, so a
      // missing file is a dashboard that cannot render at all.
      const sandbox = makeSandbox()
      expect(run(sandbox, ['devthree']).status).toBe(0)
      const dir = join(sandbox, 'users', 'devthree')

      // No shape, and no manifest to describe one.
      const migrations = readdirSync(join(dir, 'migrations'))
      expect(migrations.filter((f) => f.endsWith('.sql'))).toEqual([])
      expect(migrations).toContain('README.md')
      expect(existsSync(join(dir, 'migrations', 'manifest.json'))).toBe(false)

      const target = join(dir, 'synthetic.db')
      execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })
      expect(existsSync(target)).toBe(true)

      const db = new Database(target, { readonly: true, fileMustExist: true })
      try {
        const tables = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .all() as { name: string }[]
        ).map((r) => r.name)
        // Empty, and that is the point: the friend's real database is empty
        // too until someone designs a shape, so the two agree from day one.
        expect(tables).toEqual([])
        expect(db.pragma('user_version', { simple: true })).toBe(0)
      } finally {
        db.close()
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})
