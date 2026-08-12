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

  it('derives presence from the LAST assignment, not from any line (R1)', () => {
    // Before the fix: exit 0. The script asked whether the name appeared on
    // SOME line; systemd's EnvironmentFile and dotenv both take the LAST
    // assignment. So the process receives PLATFORM_DB='' while the guard
    // reports it present — and lib/db/instance.ts uses `??`, so '' is passed
    // straight to openPlatformDb rather than falling back. Reachable by
    // exactly the workflow deploy/PROVISION.md prescribes: append KEY=value
    // below an existing key.
    const r = run(
      'PLATFORM_DB REQUIRED  # p',
      'PLATFORM_DB=SUPERSECRET-VALUE\nPLATFORM_DB=\n',
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/MISSING \(REQUIRED\): PLATFORM_DB/)
    // Last-wins parsing must not have brought a value anywhere near output.
    expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
  })

  it('lets a LATER real assignment win over an earlier empty one', () => {
    // The mirror of R1: last-wins has to work in both directions, or the fix
    // becomes "any empty line anywhere marks the variable missing" and the
    // guard starts blocking healthy deploys.
    expect(run('A REQUIRED', 'A=\nA=x\n').status).toBe(0)
  })

  it('counts a whitespace-only value as missing', () => {
    // systemd strips surrounding whitespace from an unquoted value, so this
    // yields A='' — the same shape as I2, one space further along.
    expect(run('A REQUIRED', 'A=   \n').status).toBe(1)
  })

  it('counts a quoted-empty value as missing', () => {
    // systemd strips surrounding quotes (ledger residual 6 corrected the
    // comment that claimed otherwise), so both of these yield ''.
    expect(run('A REQUIRED', 'A=""\n').status).toBe(1)
    expect(run('A REQUIRED', "A=''\n").status).toBe(1)
  })

  it('still counts a quoted NON-empty value as present', () => {
    // The quoted-empty rule must not swallow every quoted value. A=" " is a
    // one-space value under systemd, which lib/env/report.ts counts present.
    expect(run('A REQUIRED', 'A="x"\n').status).toBe(0)
    expect(run('A REQUIRED', 'A=" "\n').status).toBe(0)
  })
})

describe('deploy/check-env.sh rejects a checklist with no entries', () => {
  // "No checklist" and "nothing missing" must never share an exit code — the
  // same false-green class as the two deploys that motivated this branch, one
  // level up. Exit 2, not 1: this is a broken-list condition, matching how the
  // script already reports a malformed line and an unreadable list. deploy.sh
  // branches on the status and aborts on both, so it stays fail-closed.

  it('exits 2 on an empty list', () => {
    const r = run('', 'A=x')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/checklist missing or empty/i)
  })

  it('exits 2 on a comments-only list, without echoing the comments', () => {
    const r = run('# nothing to see here SUPERSECRET-VALUE\n# more\n', 'A=x')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/checklist missing or empty/i)
    expect(r.stdout + r.stderr).not.toContain('SUPERSECRET-VALUE')
  })

  it('exits 2 on a blank-lines-only list', () => {
    const r = run('\n\n   \n\t\n', 'A=x')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/checklist missing or empty/i)
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
      // Residual 1. The `env` column is the point of this row: systemd and
      // dotenv both take the LAST assignment, so the process receives A=''
      // even though A=x appears in the file. Declaring the union of lines
      // here instead ({ A: 'x' }) is precisely the wrong belief that let the
      // bash half report present while the app got an empty string.
      what: 'a key assigned twice, empty last (last-wins)',
      list: 'A REQUIRED',
      envFile: 'A=x\nA=\n',
      env: { A: '' },
      bashExit: 1,
      tsThrows: false,
      missing: [{ name: 'A', severity: 'REQUIRED' }],
    },
    {
      what: 'a key assigned twice, real value last (last-wins)',
      list: 'A REQUIRED',
      envFile: 'A=\nA=x\n',
      env: { A: 'x' },
      bashExit: 0,
      tsThrows: false,
      missing: [],
    },
    {
      // systemd strips surrounding whitespace from an unquoted value.
      what: 'a whitespace-only value',
      list: 'A REQUIRED',
      envFile: 'A=   \n',
      env: { A: '' },
      bashExit: 1,
      tsThrows: false,
      missing: [{ name: 'A', severity: 'REQUIRED' }],
    },
    {
      // systemd strips surrounding quotes, so this is the empty string too
      // (ledger residual 6 corrected the comment that said otherwise).
      what: 'a quoted-empty value',
      list: 'A REQUIRED',
      envFile: 'A=""\n',
      env: { A: '' },
      bashExit: 1,
      tsThrows: false,
      missing: [{ name: 'A', severity: 'REQUIRED' }],
    },
    {
      what: 'a quoted value that is a single space',
      list: 'A REQUIRED',
      envFile: 'A=" "\n',
      env: { A: ' ' },
      bashExit: 0,
      tsThrows: false,
      missing: [],
    },
    {
      // Residual 3. DESIGNED DIVERGENCE: bash is the gate and exits 2 on a
      // checklist with no entries, because "no checklist" and "nothing
      // missing" must not share an exit code. lib/env/report.ts is the
      // runtime witness and reports nothing for an empty list — it has no
      // list to diff against and must never throw. Same split as the
      // tsThrows rows below.
      what: 'an empty list',
      list: '',
      envFile: 'A=x\n',
      env: { A: 'x' },
      bashExit: 2,
      tsThrows: false,
      missing: [],
    },
    {
      what: 'a comments-and-blank-lines-only list',
      list: '# heading\n\n   \n',
      envFile: 'A=x\n',
      env: { A: 'x' },
      bashExit: 2,
      tsThrows: false,
      missing: [],
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
      // Residual 2, PINNED AS-IS, not endorsed. Every other malformed-line
      // row pairs the bad line with an ABSENT variable; this is the untested
      // cell the ledger names. bash's presence `continue` runs before the
      // severity `case`, so a malformed severity on a PRESENT variable is
      // never noticed and the deploy proceeds — while the TypeScript parser
      // rejects the same list outright. Fail-closed (it becomes an exit 2 the
      // moment A goes absent), which is why it was parked. If someone moves
      // the `continue` below the `case`, this row turns red and the change is
      // visible rather than silent — change the 0 to a 2 then.
      what: "a typo'd severity on a PRESENT variable",
      list: 'A REQUIRD',
      envFile: 'A=x\n',
      env: { A: 'x' },
      bashExit: 0,
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
