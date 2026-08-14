// tests/scripts/shots.test.ts
//
// The screenshot harness is a REVIEW gate, not a test (onboarding ledger D16),
// so what is testable about it is its bookkeeping: that the screen list is
// complete and honest, that a screen marked live can actually be photographed,
// and that the data-safety refusal really refuses.
//
// Deliberately NOT tested: that Chromium launches, or that a shot resembles
// anything. Running it does the first; a human (or Claude, reading the PNG)
// does the second. Mocking a browser to assert we called it would prove
// nothing and would be the kind of test this project keeps finding and
// deleting.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCREENS, VIEWPORT_HEIGHT, WIDTHS } from '@/screenshots/screens'

const REPO = resolve(__dirname, '..', '..')

/**
 * The seeder map lives in scripts/shots.ts, which runs main() on import and so
 * cannot be imported here. Read the states it declares out of the source
 * instead — crude, but it is checking a fact about that file, and the
 * alternative (splitting a six-line map into its own module so a test can
 * import it) is structure added for the test rather than for the code.
 */
function seedableStates(): Set<string> {
  const source = readFileSync(join(REPO, 'scripts', 'shots.ts'), 'utf8')
  const block = source.slice(
    source.indexOf('const SEEDERS'),
    source.indexOf('async function waitForServer'),
  )
  const states = new Set<string>()
  for (const match of block.matchAll(/^ {2}'?([a-z-]+)'?:/gm)) states.add(match[1]!)
  return states
}

describe('the screen list', () => {
  it('photographs both of the widths the spec names, and nothing else', () => {
    // onboarding-ux-spec.md: "test every screen at 375px AND 1440px". A third
    // width would be a design decision; dropping one would silently narrow the
    // gate to whichever viewport the author happened to have open.
    expect([...WIDTHS]).toEqual([375, 1440])
    for (const width of WIDTHS) expect(VIEWPORT_HEIGHT[width]).toBeGreaterThan(0)
  })

  it('gives every screen at least two things to check', () => {
    // A screen listed with nothing to check is a screen nobody is really
    // reviewing — it produces a PNG and a feeling.
    for (const screen of SCREENS) {
      expect(screen.assertions.length, `${screen.id} has too few assertions`).toBeGreaterThanOrEqual(2)
    }
  })

  it('has no duplicate ids, since the id is the filename', () => {
    const ids = SCREENS.map((s) => s.id)
    expect(new Set(ids).size, `duplicate id in ${ids.join(', ')}`).toBe(ids.length)
  })

  it('covers every surface this branch ships', () => {
    // The spec's own list: S0-S5, both shell states, the card, the dialog, and
    // the admin panes. Named explicitly so deleting a screen from screens.ts
    // is a decision someone has to make here too, rather than a quiet
    // narrowing of what gets looked at.
    const ids = new Set(SCREENS.map((s) => s.id))
    for (const required of [
      's0-dead-link',
      's1-the-deal',
      's2-set-password',
      's3-shell-placeholder',
      's3-shell-dashboard',
      's4-login',
      's5-forgot',
      'card-proposal',
      'card-fullscreen',
      'admin-transcript',
    ]) {
      expect(ids.has(required), `missing screen: ${required}`).toBe(true)
    }
  })
})

describe('a live screen can actually be photographed', () => {
  // `live` is the coordination flag between screens.ts and the tasks that
  // build the screens. Flipping it early is the failure mode: the harness
  // would navigate to a 404 and save a screenshot of it, which looks exactly
  // like coverage. These two assertions are what make that loud.
  const liveScreens = SCREENS.filter((s) => s.live)

  it('has at least one live screen, so the harness is never vacuously green', () => {
    expect(liveScreens.length).toBeGreaterThan(0)
  })

  it.each(liveScreens.map((s) => [s.id, s] as const))(
    '%s has its route file on disk',
    (_id, screen) => {
      expect(existsSync(join(REPO, screen.routeFile)), `${screen.routeFile} does not exist`).toBe(true)
    },
  )

  it.each(liveScreens.map((s) => [s.id, s] as const))(
    '%s has a seeder for its state',
    (_id, screen) => {
      expect(seedableStates().has(screen.state), `no seeder for '${screen.state}'`).toBe(true)
    },
  )
})

describe('the temp tree', () => {
  it('is pointed at by the HARNESS process, not only by the server it spawns', () => {
    // The seeders run in the harness process and create real encrypted
    // databases through lib/db/encryptedUserDb.ts, which resolves USERS_DIR at
    // call time. Setting it only in the spawned server's env left a stray
    // users/<fixture>/ folder in the repo — which tests/users/conventions.test.ts
    // then swept and skipped three checks over, the closest this suite gets to
    // a silent failure.
    //
    // A source check, like seedableStates above: the alternative is running
    // the whole harness inside a test, which downloads nothing and proves
    // little for thirty seconds of Chromium.
    const source = readFileSync(join(REPO, 'scripts', 'shots.ts'), 'utf8')
    const assignment = source.indexOf('process.env.USERS_DIR = usersDir')
    const firstSeed = source.indexOf('const SEEDERS')
    expect(assignment, 'harness must set USERS_DIR for itself').toBeGreaterThan(-1)
    expect(
      source.indexOf('await seed(dbPath, usersDir)'),
      'USERS_DIR must be set before any seeder runs',
    ).toBeGreaterThan(assignment)
    expect(firstSeed).toBeGreaterThan(-1)
  })
})

describe('the data-safety refusal', () => {
  it('refuses to run when PLATFORM_DB points inside the repo', () => {
    // The one guard in this file that protects data rather than bookkeeping.
    // Run for real, as a subprocess, because what matters is that the SCRIPT
    // refuses — a unit test of an exported predicate would pass while main()
    // called it too late, or not at all.
    let output = ''
    let exitCode = 0
    try {
      output = execFileSync('npx', ['tsx', 'scripts/shots.ts', '--task=guard-test'], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PLATFORM_DB: join(REPO, 'platform', 'dev', 'synthetic.db') },
      })
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      exitCode = e.status ?? 1
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }

    expect(output).toContain('Refusing to run')
    expect(output).toContain('inside the repo')
    // It must not have got as far as building or launching anything.
    expect(output).not.toContain('Building')
    expect(exitCode).not.toBe(0)
  }, 60_000)
})
