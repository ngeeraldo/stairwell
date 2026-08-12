// tests/deploy/checkEnv.test.ts
//
// Executes the real script rather than scanning it. The step-2 lesson that
// motivated this whole guard was a check that reported success while doing
// nothing, so these tests run the thing and read its exit code.
//
// Fixture files are named `env-fixture`, never `.env` or `.env.*`: the guard
// hook (.claude/hooks/deny-sensitive-files.sh:48) denies writes to those, and
// that denial is the rule working.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingFrom, parseRequiredEnv } from '@/lib/env/required'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-checkenv-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Run the checker against two temp files. Returns status and stderr. */
function run(listText: string, envText: string | null) {
  const list = join(dir, 'required-env')
  writeFileSync(list, listText)
  const envFile = join(dir, 'env-fixture')
  if (envText !== null) writeFileSync(envFile, envText)
  const r = spawnSync('./deploy/check-env.sh', [list, envFile], {
    encoding: 'utf8',
  })
  return { status: r.status, stderr: r.stderr, stdout: r.stdout }
}

describe('deploy/check-env.sh', () => {
  it('passes when every variable is present', () => {
    const r = run('A REQUIRED\nB DEGRADED', 'A=x\nB=y')
    expect(r.status).toBe(0)
  })

  it('FAILS when a REQUIRED variable is missing, and names it', () => {
    // The observed-failure requirement: this guard is only trusted because
    // this assertion exists and would not pass against a no-op script.
    const r = run('A REQUIRED', 'B=y')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('A')
    expect(r.stderr).toMatch(/REQUIRED/)
  })

  it('passes but warns when only a DEGRADED variable is missing', () => {
    const r = run('A REQUIRED\nB DEGRADED', 'A=x')
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('B')
    expect(r.stderr).toMatch(/DEGRADED/)
  })

  it('never prints a value', () => {
    // The single worst thing this script could do is leak a secret into a
    // deploy log. Pinned with a distinctive value that would be obvious.
    const r = run('A REQUIRED\nB DEGRADED', 'A=SUPERSECRET-VALUE\nB=OTHER-SECRET')
    expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
    expect(r.stdout + r.stderr).not.toContain('OTHER-SECRET')
  })

  it('recognises a name even when the line uses `export`', () => {
    // systemd would reject `export FOO=x`, but a human editing the file may
    // write it. Reporting FOO as missing there would send them hunting for a
    // variable that is visibly present — a worse failure than the real one.
    const r = run('A REQUIRED', 'export A=x')
    expect(r.status).toBe(0)
  })

  it('ignores comments and blank lines in the env file', () => {
    const r = run('A REQUIRED', '# A=commented-out\n\nA=real')
    expect(r.status).toBe(0)
  })

  it('treats a commented-out variable as missing', () => {
    const r = run('A REQUIRED', '# A=commented-out\n')
    expect(r.status).toBe(1)
  })

  it('treats an unreadable env file as everything missing, and says so', () => {
    const r = run('A REQUIRED', null)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/not readable/i)
  })

  it('exits 2 when the list itself cannot be read', () => {
    const r = spawnSync('./deploy/check-env.sh', [join(dir, 'nope'), join(dir, 'nope2')], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
  })
})

describe('the bash and TypeScript parsers agree', () => {
  // The two implementations exist because the deploy check runs before
  // `npm ci` and cannot assume node_modules. This test is what stops them
  // drifting: same list, same env file, same verdict.
  const listText = [
    '# a comment',
    '',
    'PRESENT_REQ REQUIRED  # present',
    'MISSING_REQ REQUIRED  # missing',
    'PRESENT_DEG DEGRADED  # present',
    'MISSING_DEG DEGRADED  # missing',
  ].join('\n')

  it('report the same missing names', () => {
    const envText = 'PRESENT_REQ=x\nPRESENT_DEG=y\n'
    const r = run(listText, envText)

    const present = new Set(
      envText
        .split('\n')
        .map((l) => l.split('=')[0]?.trim())
        .filter((n): n is string => Boolean(n)),
    )
    const tsMissing = missingFrom(parseRequiredEnv(listText), present).map((v) => v.name)

    expect(tsMissing.sort()).toEqual(['MISSING_DEG', 'MISSING_REQ'])
    for (const name of tsMissing) expect(r.stderr).toContain(name)
    for (const name of ['PRESENT_REQ', 'PRESENT_DEG']) {
      expect(r.stderr).not.toContain(name)
    }
  })

  it('the shipped list parses under both', () => {
    const shipped = readFileSync('deploy/required-env', 'utf8')
    expect(() => parseRequiredEnv(shipped)).not.toThrow()
    // An env file containing every shipped name must pass the bash checker.
    const all = parseRequiredEnv(shipped)
      .map((v) => `${v.name}=x`)
      .join('\n')
    expect(run(shipped, all).status).toBe(0)
  })
})
