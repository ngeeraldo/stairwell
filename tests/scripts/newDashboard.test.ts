// tests/scripts/newDashboard.test.ts
//
// Runs the real script as a subprocess with cwd pointed at a disposable
// sandbox, the same way tests/scripts/pullSpec.test.ts does — so
// `users/<slug>` lands inside the sandbox and never inside the real tree, no
// matter how the process exits.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
      for (const entry of ['schema.sql', 'seed.py', 'queries.ts', 'dashboard.tsx']) {
        expect(existsSync(join(dir, entry))).toBe(true)
      }
      expect(existsSync(join(dir, 'tests', 'dashboard.test.ts'))).toBe(true)

      // No placeholder survives anywhere.
      for (const entry of ['schema.sql', 'seed.py', 'queries.ts', 'dashboard.tsx']) {
        expect(readFileSync(join(dir, entry), 'utf8')).not.toContain('__SLUG__')
      }
      expect(readFileSync(join(dir, 'dashboard.tsx'), 'utf8')).toContain('devthree')

      // The registry is NOT edited — the script prints the line instead.
      expect(output).toContain("devthree: () => import('@/users/devthree/dashboard')")
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
    'refuses to overwrite an existing folder',
    () => {
      const sandbox = makeSandbox()
      mkdirSync(join(sandbox, 'users', 'devthree'), { recursive: true })
      const { status, output } = run(sandbox, ['devthree'])
      expect(status).toBe(2)
      expect(output).toMatch(/already exists/)
      expect(existsSync(join(sandbox, 'users', 'devthree', 'schema.sql'))).toBe(false)
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
    'produces a folder that passes the conventions sweep and generates data',
    () => {
      // The scaffold is only worth having if what comes out of it is valid on
      // the first run. This is the same check tests/users/conventions.test.ts
      // makes, applied to the generated folder rather than to a committed one.
      const sandbox = makeSandbox()
      expect(run(sandbox, ['devthree']).status).toBe(0)
      const dir = join(sandbox, 'users', 'devthree')
      const target = join(dir, 'synthetic.db')
      execFileSync('python3', [join(dir, 'seed.py'), target], { stdio: 'pipe' })
      expect(existsSync(target)).toBe(true)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})
