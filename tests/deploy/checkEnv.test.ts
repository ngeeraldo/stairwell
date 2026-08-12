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
import { parseRequiredEnv } from '@/lib/env/required'
import { reportMissingEnv } from '@/lib/env/report'

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

describe('deploy/check-env.sh cannot fail open', () => {
  // Every case below was demonstrated PASSING (exit 0) against the shipped
  // script during the whole-branch review. A guard that only reports success
  // adds confidence without adding safety, which is worse than no guard —
  // the two false-green deploys that motivated this branch are the precedent.
  // These are the review's exact reproductions, kept as regressions.

  it("does not downgrade a typo'd severity to the permissive tier (C1)", () => {
    // Before the fix: "MISSING (DEGRADED): PLATFORM_DB", "deploy continues.",
    // exit 0. One character turned the only blocking variable into a warning.
    const r = run('PLATFORM_DB REQUIRD  # typo', 'OTHER=1')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/expected severity REQUIRED or DEGRADED/)
    expect(r.stderr).not.toMatch(/deploy continues/)
  })

  it('rejects a missing severity field rather than defaulting it', () => {
    const r = run('PLATFORM_DB', 'OTHER=1')
    expect(r.status).toBe(2)
  })

  it('rejects a lowercase severity rather than defaulting it', () => {
    const r = run('PLATFORM_DB required', 'OTHER=1')
    expect(r.status).toBe(2)
  })

  it('names a malformed line by NUMBER, counted as an editor shows it', () => {
    // The comment and the blank line must count, or the number sends a human
    // to the wrong place — the only thing a malformed line may contribute.
    const r = run('# header\n\nA REQUIRED\nB REQUIRD\n', 'A=x')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/line 4:/)
  })

  it('never echoes a value smuggled into the LIST (C2)', () => {
    // Before the fix: "MISSING (REQUIRED): FOO=SUPERSECRET-VALUE" — straight
    // into the deploy log. Identical to the defect fixed in the TypeScript
    // parser by c7939b5 and left standing in the half that runs at deploy
    // time. The pre-existing non-leak test only covered the ENV FILE; the
    // LIST is the vector that produced the original Critical.
    const r = run('FOO=SUPERSECRET-VALUE REQUIRED  # smuggled', 'OTHER=1')
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
    expect(r.stderr).toMatch(/not a valid variable name/)
  })

  it('never echoes a value smuggled into an extra field of the LIST', () => {
    const r = run('FOO REQUIRED SUPERSECRET-VALUE', 'OTHER=1')
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
  })

  it('never echoes an unvalidated severity token', () => {
    const r = run('FOO SUPERSECRET-VALUE', 'OTHER=1')
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
  })

  it('does not treat a name as a regex when testing presence (I1)', () => {
    // Before the fix: exit 0. `grep -qx PLATFORM.DB` matched PLATFORMXDB, so
    // an absent variable read as present. The name check now rejects the line
    // first; `grep -qxF` is the independent second guard behind it.
    const r = run('PLATFORM.DB REQUIRED  # p', 'PLATFORMXDB=1')
    expect(r.status).toBe(2)
  })

  it('counts a name written with an EMPTY value as missing (I2)', () => {
    // Before the fix: exit 0. `PLATFORM_DB=` — the name pasted, the value
    // forgotten — satisfied the bash `=.*` match while lib/env/report.ts
    // counted it missing. It is not the documented fallback either:
    // lib/db/instance.ts uses `??`, so '' is passed straight to
    // openPlatformDb. Neither the intended path nor the documented one.
    const r = run('PLATFORM_DB REQUIRED  # p', 'PLATFORM_DB=\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/MISSING \(REQUIRED\): PLATFORM_DB/)
  })

  it('still accepts a one-character value', () => {
    // The empty-value fix must not become an off-by-one that rejects `A=x`.
    expect(run('A REQUIRED', 'A=x').status).toBe(0)
  })

  it('reports nothing but the error when a LATER line is malformed', () => {
    // parseRequiredEnv throws before returning any entry, so a partial list
    // of MISSING lines followed by a parse error would read as a complete
    // answer that happened to also warn. Buffer, then decide.
    const r = run('A REQUIRED\nB REQUIRD', 'OTHER=1')
    expect(r.status).toBe(2)
    expect(r.stderr).not.toMatch(/MISSING/)
  })
})

describe('the bash and TypeScript halves agree', () => {
  // The two implementations exist because the deploy check runs before
  // `npm ci` and cannot assume node_modules (design spec D3). This table is
  // what stops them drifting.
  //
  // The previous version of this test fed both halves ONE well-formed list,
  // asserted that names appeared in stderr, and never looked at bash's exit
  // code. That is the single region where the two cannot disagree — every
  // fail-open finding in the review lived in the region it left uncovered.
  // So: malformed shapes are the point of the table, and the assertion is the
  // exit CODE, not a substring.
  //
  // There is no third parser here. The TypeScript side has no env-file parser
  // by design, so each case declares BOTH the env file bash reads AND the
  // process.env that systemd yields from that same file; the pairing is the
  // claim under test. (The old version built an ad-hoc `l.split('=')[0]`
  // parser inline and then agreed with itself — it could not have noticed
  // that bash treats `# A=x` as absent.)

  type Missing = { name: string; severity: 'REQUIRED' | 'DEGRADED' }

  type Case = {
    what: string
    list: string
    /** What bash reads. */
    envFile: string
    /** What systemd yields in process.env from that same file. */
    env: Record<string, string | undefined>
    bashExit: 0 | 1 | 2
    /** Whether lib/env/required.ts rejects the list outright. */
    tsThrows: boolean
    /** Both halves must agree on this, when the list parses. */
    missing?: Missing[]
  }

  const cases: Case[] = [
    {
      what: 'everything present',
      list: 'A REQUIRED\nB DEGRADED',
      envFile: 'A=x\nB=y\n',
      env: { A: 'x', B: 'y' },
      bashExit: 0,
      tsThrows: false,
      missing: [],
    },
    {
      what: 'a REQUIRED name absent',
      list: 'A REQUIRED\nB DEGRADED',
      envFile: 'B=y\n',
      env: { B: 'y' },
      bashExit: 1,
      tsThrows: false,
      missing: [{ name: 'A', severity: 'REQUIRED' }],
    },
    {
      what: 'a DEGRADED name absent',
      list: 'A REQUIRED\nB DEGRADED',
      envFile: 'A=x\n',
      env: { A: 'x' },
      bashExit: 0,
      tsThrows: false,
      missing: [{ name: 'B', severity: 'DEGRADED' }],
    },
    {
      what: 'both absent — severities must not swap',
      list: 'A REQUIRED\nB DEGRADED',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 1,
      tsThrows: false,
      missing: [
        { name: 'A', severity: 'REQUIRED' },
        { name: 'B', severity: 'DEGRADED' },
      ],
    },
    {
      what: 'comments and blank lines in the list',
      list: '# heading\n\n   \nA REQUIRED  # why\n',
      envFile: 'A=x\n',
      env: { A: 'x' },
      bashExit: 0,
      tsThrows: false,
      missing: [],
    },
    {
      what: 'an `export` prefix in the env file',
      list: 'A REQUIRED',
      envFile: 'export A=x\n',
      env: { A: 'x' },
      bashExit: 0,
      tsThrows: false,
      missing: [],
    },
    {
      what: 'a commented-out entry in the env file',
      list: 'A REQUIRED',
      envFile: '# A=x\n',
      env: {},
      bashExit: 1,
      tsThrows: false,
      missing: [{ name: 'A', severity: 'REQUIRED' }],
    },
    {
      what: 'a name written with an empty value',
      list: 'A REQUIRED',
      envFile: 'A=\n',
      env: { A: '' },
      bashExit: 1,
      tsThrows: false,
      missing: [{ name: 'A', severity: 'REQUIRED' }],
    },
    {
      what: "a typo'd severity",
      list: 'A REQUIRD',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'a missing severity field',
      list: 'A',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'a lowercase severity',
      list: 'A required',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'a name containing `=` (a smuggled value)',
      list: 'A=SUPERSECRET-VALUE REQUIRED',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'a name containing a regex metacharacter',
      list: 'PLATFORM.DB REQUIRED',
      envFile: 'PLATFORMXDB=1\n',
      env: { PLATFORMXDB: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'an extra field',
      list: 'A REQUIRED SUPERSECRET-VALUE',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'a name with a hyphen',
      list: 'A-B REQUIRED',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
    {
      what: 'a name starting with a digit',
      list: '1A REQUIRED',
      envFile: 'OTHER=1\n',
      env: { OTHER: '1' },
      bashExit: 2,
      tsThrows: true,
    },
  ]

  /** Name+severity pairs bash reported, read back out of its own output. */
  function bashMissing(stderr: string): Missing[] {
    const out: Missing[] = []
    const re = /^MISSING \((REQUIRED|DEGRADED)\): ([A-Za-z_][A-Za-z0-9_]*)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(stderr)) !== null) {
      out.push({ name: m[2]!, severity: m[1] as 'REQUIRED' | 'DEGRADED' })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The real runtime consumer. db() throws: nothing here needs a database,
   *  and reportMissingEnv is documented to survive that. */
  function tsMissing(listText: string, env: Record<string, string | undefined>) {
    return reportMissingEnv({
      listText,
      env,
      db: () => {
        throw new Error('no database in this test')
      },
      now: () => 0,
    })
      .map((v) => ({ name: v.name, severity: v.severity }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  for (const c of cases) {
    it(`agree on: ${c.what}`, () => {
      const r = run(c.list, c.envFile)
      expect(r.status, `bash exit for ${c.what}`).toBe(c.bashExit)

      if (c.tsThrows) {
        expect(() => parseRequiredEnv(c.list)).toThrow()
        // DESIGNED DIVERGENCE, not an oversight. bash is the gate and exits
        // 2, blocking the deploy. lib/env/report.ts is the runtime witness
        // and must NEVER throw — a throw reaches instrumentation.ts, fails
        // startup, and meets systemd's Restart=on-failure as a crash loop on
        // a deploy path with no rollback. So it swallows the parse error and
        // reports nothing. The gate is what catches a broken list.
        expect(tsMissing(c.list, c.env)).toEqual([])
      } else {
        const expected = [...c.missing!].sort((a, b) => a.name.localeCompare(b.name))
        expect(tsMissing(c.list, c.env)).toEqual(expected)
        expect(bashMissing(r.stderr)).toEqual(expected)
      }

      expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
    })
  }

  it('the shipped list parses under both', () => {
    const shipped = readFileSync('deploy/required-env', 'utf8')
    expect(() => parseRequiredEnv(shipped)).not.toThrow()
    // An env file containing every shipped name must pass the bash checker.
    const all = parseRequiredEnv(shipped)
      .map((v) => `${v.name}=x`)
      .join('\n')
    expect(run(shipped, all).status).toBe(0)
    // …and an env file that has every shipped name with an EMPTY value must
    // not. That is the hand-edit slip I2 covers, against the real list.
    const empty = parseRequiredEnv(shipped)
      .map((v) => `${v.name}=`)
      .join('\n')
    expect(run(shipped, empty).status).toBe(1)
  })
})
