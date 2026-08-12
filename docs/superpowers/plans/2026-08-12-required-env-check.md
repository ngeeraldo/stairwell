# Required-env presence check: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a missing environment variable fail at deploy time with a named list, instead of surfacing later as a green deploy over a broken feature.

**Architecture:** One committed list of variable NAMES with severities (`deploy/required-env`). A pure TypeScript parser used by the runtime half. A dependency-free bash checker used by the deploy half, because it runs before `npm ci` and cannot assume `node_modules` exists. A test proves the two parsers agree, so the duplication cannot drift silently.

**Tech Stack:** bash, TypeScript, vitest, better-sqlite3-multiple-ciphers.

**Spec:** `docs/superpowers/specs/2026-08-11-required-env-check-design.md`. Section references below (§2.1, D3, D5…) point at it.

**Starting point:** `main` at `1feadb4`, tree clean, 243 tests green.

## Global Constraints

- **Names only, everywhere.** No code path may read, print, log, or store an environment variable's *value*. A check that leaked a secret into a deploy log would be worse than the bug it prevents.
- The guard hook (`.claude/hooks/deny-sensitive-files.sh:48`) denies Read/Edit/Write on `.env` and `.env.*`. **No test fixture may use either name.** Every function takes its path or text as a parameter.
- `transcripts` and `metrics` are append-only. No UPDATE, no DELETE.
- The runtime check **never throws** (D3). A throw in `instrumentation.ts` meets `Restart=on-failure` and becomes a crash loop against a deploy path with no rollback.
- A healthy boot must touch **no database** (D5), preserving `getDb()`'s laziness that ledger I3 depends on.
- `deploy/*` is **exempt** from pre-commit Gate B. Tests there are deliberate, not enforced — do not skip them because nothing complains.
- `tsconfig.json` sets `noUncheckedIndexedAccess: true`; array index access is possibly-undefined.
- Do not use `SKIP_TEST_GATE` or `SKIP_TYPECHECK`.
- Never open, read, or query any `*.db` other than a `synthetic.db` you create in a temp dir. `fake-real.db` in the repo root is a decoy.
- Severity literals are exactly `REQUIRED` and `DEGRADED`.
- **The check must be observed FAILING against a deliberately missing variable before it is trusted.** Ratified by the project owner as a requirement. A guard only ever seen to pass is a guard nobody has tested.

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `deploy/required-env` | The list. Names, severities, purposes. Never values. |
| `lib/env/required.ts` | Pure parse + compare. No I/O, no `process.env`. |
| `lib/env/report.ts` | Runtime reporter. Takes deps explicitly; never throws. |
| `deploy/check-env.sh` | Deploy-time checker. Bash, zero dependencies. |
| `tests/env/required.test.ts` | Parser and comparison. |
| `tests/env/report.test.ts` | Runtime reporter, including never-throws. |
| `tests/deploy/checkEnv.test.ts` | Executes the bash checker; proves both parsers agree. |

**Modify**

| File | Change |
|---|---|
| `deploy/deploy.sh` | Call the checker after the pull, before `npm ci`. |
| `instrumentation.ts` | Call the runtime reporter. |
| `tests/deploy/service.test.ts` | Pin the `.env` path coupling between the unit and the checker. |
| `docs/local-dev.md`, `deploy/PROVISION.md` | Point at `deploy/required-env` (D4). |
| `docs/superpowers/ledgers/step2.md` | Close the queued task. |

---

### Task 1: The list and the parser

**Files:**
- Create: `deploy/required-env`
- Create: `lib/env/required.ts`
- Create: `tests/env/required.test.ts`

**Interfaces:**
- Produces:
  - `type Severity = 'REQUIRED' | 'DEGRADED'`
  - `type RequiredVar = { name: string; severity: Severity; purpose: string }`
  - `parseRequiredEnv(text: string): RequiredVar[]`
  - `missingFrom(vars: RequiredVar[], present: Set<string>): RequiredVar[]`

- [ ] **Step 1: Write the failing test**

Create `tests/env/required.test.ts`:

```ts
// tests/env/required.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { missingFrom, parseRequiredEnv } from '@/lib/env/required'

describe('parseRequiredEnv', () => {
  it('parses name, severity, and purpose', () => {
    expect(parseRequiredEnv('FOO REQUIRED  # why foo matters')).toEqual([
      { name: 'FOO', severity: 'REQUIRED', purpose: 'why foo matters' },
    ])
  })

  it('accepts an entry with no purpose', () => {
    expect(parseRequiredEnv('BAR DEGRADED')).toEqual([
      { name: 'BAR', severity: 'DEGRADED', purpose: '' },
    ])
  })

  it('ignores blank lines and full-line comments', () => {
    const text = ['# a heading', '', '   ', 'FOO REQUIRED', '# trailing note'].join('\n')
    expect(parseRequiredEnv(text).map((v) => v.name)).toEqual(['FOO'])
  })

  it('rejects an unknown severity rather than silently downgrading it', () => {
    // A typo'd severity must not quietly become the permissive case — that
    // would turn a blocking variable into a warning with no signal.
    expect(() => parseRequiredEnv('FOO REQUIRD')).toThrow(/severity/i)
  })

  it('rejects a malformed line rather than skipping it', () => {
    expect(() => parseRequiredEnv('FOO')).toThrow(/NAME SEVERITY/)
    expect(() => parseRequiredEnv('FOO REQUIRED EXTRA')).toThrow(/NAME SEVERITY/)
  })

  it('never returns a value even if someone writes one into the list', () => {
    // The file format has no slot for a value, but a well-meaning edit could
    // add `FOO=secret REQUIRED`. That must fail loudly, not parse into
    // something carrying the secret.
    expect(() => parseRequiredEnv('FOO=supersecret REQUIRED')).toThrow()
  })
})

describe('missingFrom', () => {
  const vars = parseRequiredEnv(['A REQUIRED', 'B DEGRADED'].join('\n'))

  it('returns only the absent ones', () => {
    expect(missingFrom(vars, new Set(['A'])).map((v) => v.name)).toEqual(['B'])
  })

  it('returns nothing when all are present', () => {
    expect(missingFrom(vars, new Set(['A', 'B']))).toEqual([])
  })

  it('returns everything when the set is empty', () => {
    expect(missingFrom(vars, new Set()).map((v) => v.name)).toEqual(['A', 'B'])
  })
})

describe('the shipped deploy/required-env', () => {
  const shipped = parseRequiredEnv(readFileSync('deploy/required-env', 'utf8'))

  it('parses, and is not empty', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  it('lists PLATFORM_DB as REQUIRED', () => {
    // Its absence silently falls back to the SYNTHETIC database
    // (lib/db/instance.ts), so production would serve loudly-fake data with
    // every health check green. That is the reason the tier exists.
    expect(shipped.find((v) => v.name === 'PLATFORM_DB')?.severity).toBe('REQUIRED')
  })

  it('lists ANTHROPIC_API_KEY, which appears nowhere in our source', () => {
    // The SDK reads it internally. A list derived by scanning process.env
    // would miss it — and its absence is what took chat down on the first
    // live deploy. See spec section 2.1.
    expect(shipped.find((v) => v.name === 'ANTHROPIC_API_KEY')?.severity).toBe('DEGRADED')
  })

  it('gives every entry a purpose', () => {
    for (const v of shipped) {
      expect(v.purpose, `${v.name} has no purpose comment`).not.toBe('')
    }
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/env/required.test.ts`
Expected: FAIL — cannot resolve `@/lib/env/required`.

- [ ] **Step 3: Write `lib/env/required.ts`**

```ts
// lib/env/required.ts
//
// Pure parsing and comparison for deploy/required-env. No I/O, no
// process.env, no policy about what to DO with a missing variable — those
// live in the two callers, which need different answers (spec section 3).
//
// NAMES ONLY. Nothing in this module handles an environment variable's
// value, and the file format has no slot for one.

export type Severity = 'REQUIRED' | 'DEGRADED'

export type RequiredVar = {
  name: string
  severity: Severity
  purpose: string
}

const SEVERITIES: readonly string[] = ['REQUIRED', 'DEGRADED']

/**
 * Parse the list. Format per line: `NAME SEVERITY  # purpose`
 *
 * Throws on anything malformed rather than skipping it. A silently dropped
 * line is a variable nobody is checking, which is the exact failure this
 * whole guard exists to prevent.
 */
export function parseRequiredEnv(text: string): RequiredVar[] {
  const out: RequiredVar[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const hash = line.indexOf('#')
    const decl = (hash === -1 ? line : line.slice(0, hash)).trim()
    const purpose = hash === -1 ? '' : line.slice(hash + 1).trim()

    const parts = decl.split(/\s+/)
    const name = parts[0]
    const severity = parts[1]

    if (parts.length !== 2 || name === undefined || severity === undefined) {
      throw new Error(
        `deploy/required-env: expected "NAME SEVERITY", got: ${raw.trim()}`,
      )
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`deploy/required-env: not a variable name: ${name}`)
    }
    if (!SEVERITIES.includes(severity)) {
      throw new Error(
        `deploy/required-env: unknown severity "${severity}" for ${name} ` +
          `(expected REQUIRED or DEGRADED)`,
      )
    }

    out.push({ name, severity: severity as Severity, purpose })
  }

  return out
}

/** The entries whose names are absent from `present`. */
export function missingFrom(
  vars: RequiredVar[],
  present: Set<string>,
): RequiredVar[] {
  return vars.filter((v) => !present.has(v.name))
}
```

- [ ] **Step 4: Write `deploy/required-env`**

```
# Environment variables this deployment requires, by NAME only. Never values.
#
# Format:   NAME  SEVERITY  # purpose
#
# SEVERITY
#   REQUIRED   Absence BLOCKS the deploy. The app would be wrong, not merely
#              reduced — a false green nobody goes looking for.
#   DEGRADED   Absence WARNS loudly at deploy time. One feature stops working
#              and its own error path carries it; everything else is fine.
#
# VARIABLES READ BY DEPENDENCIES BELONG HERE TOO. ANTHROPIC_API_KEY appears
# nowhere in this repo's source — the Anthropic SDK reads it internally — and
# its absence is what took chat down on the first live deploy. A list derived
# by scanning our own code would have missed exactly the variable that mattered.
#
# OUT OF SCOPE, deliberately:
#   NODE_ENV, PORT   supplied by deploy/stairwell.service's own Environment=
#                    lines, not by the EnvironmentFile this check reads.
#   ADMIN_PASSWORD   needed once by scripts/create-dev-users.ts at seed time,
#                    never by the running server. Listing it would block every
#                    deploy over a variable the service does not use.
#   CHAT_MODEL       has an intended default (claude-opus-5). Absence is not a
#                    failure.

PLATFORM_DB        REQUIRED  # Path to the platform database. Absent, lib/db/instance.ts falls back to the SYNTHETIC dev database and production serves loudly-fake data with every health check green.
ANTHROPIC_API_KEY  DEGRADED  # Read by @anthropic-ai/sdk. Absent, POST /api/chat returns 503 and logs a chat_error; the rest of the site is unaffected.
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/env/required.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add deploy/required-env lib/env/required.ts tests/env/required.test.ts
git commit -m "Add the required-env list and its parser

One committed list of variable NAMES with severities, and a pure parser
with no I/O and no policy — the two callers need different answers to
'what do I do about a missing one', so neither answer lives here.

The list is hand-maintained on purpose: ANTHROPIC_API_KEY appears nowhere
in our source because the SDK reads it internally, so a list derived by
scanning process.env would have missed the one variable whose absence took
chat down."
```

---

### Task 2: The deploy-time checker

**Files:**
- Create: `deploy/check-env.sh`
- Create: `tests/deploy/checkEnv.test.ts`

**Interfaces:**
- Consumes: `deploy/required-env` (Task 1), `parseRequiredEnv` / `missingFrom` (Task 1) for the agreement test
- Produces: `deploy/check-env.sh <required-env-file> <env-file>` — exit 0 when no `REQUIRED` name is missing, exit 1 when one is, exit 2 on a usage or unreadable-list error. Missing names go to stderr.

**Why bash rather than reusing the TypeScript.** This runs *before* `npm ci` (the ruled placement), so `node_modules` may not exist — on a fresh clone it certainly does not. A dependency-free bash script is the only thing guaranteed to run at that point. The duplicated parsing is ~10 lines, and Step 1's agreement test is what keeps the two from drifting.

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/checkEnv.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/deploy/checkEnv.test.ts`
Expected: FAIL — `./deploy/check-env.sh` does not exist (`spawnSync` returns a non-zero status with an ENOENT error).

- [ ] **Step 3: Write `deploy/check-env.sh`**

```bash
#!/usr/bin/env bash
# Presence check for required environment variables.
#
#   deploy/check-env.sh <required-env-file> <env-file>
#
# Exit 0  no REQUIRED name missing (DEGRADED ones may be, and warn)
# Exit 1  at least one REQUIRED name missing
# Exit 2  usage error, or the list itself is unreadable
#
# NAMES ONLY. This script must never read, print, or log a VALUE. The parse
# below discards everything from the first `=` onward before the name ever
# enters a variable, so there is no code path where a secret could reach the
# deploy log this runs in.
#
# Why bash and not the TypeScript parser it duplicates: this runs BEFORE
# `npm ci`, so node_modules may not exist — on a fresh clone it does not.
# tests/deploy/checkEnv.test.ts pins that the two parsers agree.
set -euo pipefail

# Whole body inside main(), called on the last line, matching deploy.sh's
# own idiom so bash parses the entire file before executing any of it.
main() {
  if [ $# -ne 2 ]; then
    echo "usage: check-env.sh <required-env-file> <env-file>" >&2
    exit 2
  fi

  local list=$1 envfile=$2

  if [ ! -r "$list" ]; then
    echo "check-env: cannot read the required-env list at $list" >&2
    exit 2
  fi

  local present=""
  if [ -r "$envfile" ]; then
    # Names only: optional leading `export `, then NAME, then everything from
    # `=` onward dropped. A commented line never matches, so it reads as absent.
    present=$(sed -n \
      's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' \
      "$envfile")
  else
    echo "check-env: $envfile is not readable — treating every variable as missing" >&2
  fi

  local blocked=0 warned=0 name severity
  while read -r name severity _rest; do
    [ -z "$name" ] && continue
    if printf '%s\n' "$present" | grep -qx -- "$name"; then
      continue
    fi
    if [ "$severity" = "REQUIRED" ]; then
      echo "MISSING (REQUIRED): $name" >&2
      blocked=$((blocked + 1))
    else
      echo "MISSING (DEGRADED): $name — that feature will not work" >&2
      warned=$((warned + 1))
    fi
  done < <(sed 's/#.*//' "$list" | grep -v '^[[:space:]]*$')

  if [ "$blocked" -gt 0 ]; then
    echo >&2
    echo "check-env: $blocked required variable(s) missing from $envfile." >&2
    echo "Add each as KEY=value — no 'export', no quotes; systemd parses the" >&2
    echo "file literally and both end up inside the name or the value." >&2
    return 1
  fi

  if [ "$warned" -gt 0 ]; then
    echo "check-env: $warned degraded variable(s) missing — deploy continues." >&2
  fi
  return 0
}

main "$@"
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x deploy/check-env.sh`

Note: `setup.sh` repairs the exec bit on the git hooks, not on this. Git records the mode, so committing it executable is what carries it to the droplet.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/deploy/checkEnv.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Observe the required failure explicitly, and record it**

The plan's global constraints require this guard to be *seen failing*. The test at Step 1 does that, but run it in isolation and capture the output for your report:

Run: `npx vitest run tests/deploy/checkEnv.test.ts -t "FAILS when a REQUIRED variable is missing"`

Then confirm it is not vacuous — temporarily change `return 1` to `return 0` in the `blocked` branch, re-run the same test, and record that it FAILS. Revert. Both observations go in your report.

- [ ] **Step 7: Full suite and commit**

```bash
npx vitest run
git add deploy/check-env.sh tests/deploy/checkEnv.test.ts
git commit -m "Add the deploy-time env presence checker

Bash rather than the TypeScript parser it duplicates, because it runs
before npm ci and cannot assume node_modules exists — on a fresh clone it
does not. A test pins that the two parsers agree, so the duplication
cannot drift silently.

Names only: the parse drops everything from the first = onward before the
name enters a variable, and a test asserts no value ever reaches stdout or
stderr. Leaking a secret into a deploy log would be worse than the bug
this prevents."
```

---

### Task 3: Wire it into the deploy

**Files:**
- Modify: `deploy/deploy.sh` (insert between the re-exec block and `npm ci`)
- Modify: `tests/deploy/service.test.ts`

**Interfaces:**
- Consumes: `deploy/check-env.sh` (Task 2), `deploy/required-env` (Task 1)

**This task changes the deploy contract.** A new abort point is exactly the kind of change CLAUDE.md governs, and the deploy script has already produced one self-exempting bug — the deploy that first shipped `smoke.sh` skipped its own gate. Read `deploy/deploy.sh:39-65` before editing so the re-exec reasoning is fresh.

- [ ] **Step 1: Write the failing test**

Append to `tests/deploy/service.test.ts`:

```ts
describe('deploy/deploy.sh env gate', () => {
  const script = readFileSync('deploy/deploy.sh', 'utf8')

  it('calls check-env.sh', () => {
    expect(script).toMatch(/check-env\.sh/)
  })

  it('calls it AFTER the pull and BEFORE npm ci', () => {
    // Ordering is the whole design. After the pull, so a deploy that
    // introduces a new requirement enforces it on itself — the same
    // reasoning as the re-exec block. Before npm ci, so a missing variable
    // costs seconds rather than a full build and test cycle.
    const pull = script.indexOf('git pull --ff-only')
    const check = script.indexOf('check-env.sh')
    const install = script.indexOf('npm ci')
    expect(pull).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(pull)
    expect(check).toBeLessThan(install)
  })

  it('aborts the deploy when the check fails', () => {
    const check = script.indexOf('check-env.sh')
    const after = script.slice(check, check + 400)
    expect(after).toMatch(/exit 1/)
  })

  it('checks the same file the systemd unit loads', () => {
    // The unit's EnvironmentFile and the path deploy.sh checks must be the
    // same file, or the gate validates something the service never reads.
    // deploy.sh cds to the repo root, which IS the unit's WorkingDirectory.
    const envFileLine = unit
      .split('\n')
      .find((l) => l.trimStart().startsWith('EnvironmentFile='))
    expect(envFileLine).toBeDefined()
    const unitPath = envFileLine!.split('=').slice(1).join('=').trim()
    expect(unitPath.endsWith('/.env')).toBe(true)

    const workingDir = unit
      .split('\n')
      .find((l) => l.trimStart().startsWith('WorkingDirectory='))
    expect(workingDir).toBeDefined()
    const wd = workingDir!.split('=').slice(1).join('=').trim()
    expect(unitPath).toBe(`${wd}/.env`)

    // And deploy.sh must pass a path that resolves to that same file from
    // the repo root it cds into.
    expect(script).toMatch(/check-env\.sh\s+deploy\/required-env\s+\.env/)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/deploy/service.test.ts`
Expected: FAIL — `check-env.sh` does not appear in `deploy.sh`.

- [ ] **Step 3: Edit `deploy/deploy.sh`**

Insert immediately after the closing `fi` of the re-exec block (currently line 65) and immediately before the `# 3. Install.` comment:

```bash
  # 2b. Required configuration must be present before anything expensive
  #     happens, and before the restart that would make a gap live.
  #
  #     Placed AFTER the pull so a deploy that introduces a new requirement
  #     enforces it on itself — the same reasoning as the re-exec above —
  #     and BEFORE npm ci so a missing variable costs seconds rather than a
  #     full install, build and test cycle.
  #
  #     Names only. deploy/check-env.sh never prints a value, and must not
  #     be changed to: this output goes straight into a deploy log.
  #
  #     `.env` here is the same file the systemd unit loads as its
  #     EnvironmentFile — main() cds to the repo root, which is the unit's
  #     WorkingDirectory. tests/deploy/service.test.ts pins that coupling.
  if ! ./deploy/check-env.sh deploy/required-env .env; then
    echo >&2
    echo "DEPLOY ABORTED — required configuration missing." >&2
    echo "The running version is untouched." >&2
    echo >&2
    exit 1
  fi
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/deploy/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the gate actually blocks, end to end**

Static scans cannot show the abort works. Run the real script's gate in isolation against a deliberately incomplete file:

```bash
tmp=$(mktemp -d)
printf 'ANTHROPIC_API_KEY=x\n' > "$tmp/env-fixture"    # PLATFORM_DB deliberately absent
./deploy/check-env.sh deploy/required-env "$tmp/env-fixture"; echo "exit=$?"
rm -rf "$tmp"
```

Expected: `MISSING (REQUIRED): PLATFORM_DB` on stderr and `exit=1`. Record the output in your report — this is the observed-failure requirement applied to the shipped list rather than a fixture.

- [ ] **Step 6: Full suite, typecheck, build, commit**

```bash
npx vitest run && npx tsc --noEmit && npx next build
git add deploy/deploy.sh tests/deploy/service.test.ts
git commit -m "Gate the deploy on required configuration being present

New abort point after the pull and before npm ci. After, so a deploy that
introduces a requirement enforces it on itself — the same reasoning as the
re-exec block above it. Before, so a missing variable costs seconds rather
than a full install, build and test cycle.

Tests pin the ordering and that the path checked is the same file the
systemd unit loads, which would otherwise be a silent coupling: a gate
validating a file the service never reads would pass while proving
nothing."
```

---

### Task 4: The runtime witness

**Files:**
- Create: `lib/env/report.ts`
- Create: `tests/env/report.test.ts`
- Modify: `instrumentation.ts`
- Modify: `tests/instrumentation.test.ts`

**Interfaces:**
- Consumes: `parseRequiredEnv`, `missingFrom`, `RequiredVar` (Task 1); `appendMetric` from `@/lib/db/appendOnly`
- Produces: `reportMissingEnv(deps): RequiredVar[]` — returns the missing entries, writes an `env_missing` metric when the list is non-empty, and **never throws**

**The metric event name is `env_missing`.** It is permanent vocabulary in an append-only table, in the same family as `chat_turn` / `chat_error` / `stream_aborted` / `chat_empty_reply`.

- [ ] **Step 1: Write the failing test**

Create `tests/env/report.test.ts`:

```ts
// tests/env/report.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { reportMissingEnv } from '@/lib/env/report'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-envreport-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const LIST = ['A REQUIRED  # a', 'B DEGRADED  # b'].join('\n')

function metrics() {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string | null
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data ?? 'null') }))
}

describe('reportMissingEnv', () => {
  it('returns nothing and writes nothing when all are present', () => {
    let opened = false
    const missing = reportMissingEnv({
      listText: LIST,
      env: { A: 'x', B: 'y' },
      db: () => {
        opened = true
        return db
      },
      now: () => 1_000,
    })

    expect(missing).toEqual([])
    // D5: a healthy boot must not touch the database at all. getDb() is
    // lazy on purpose, and ledger I3's documented failure mode depends on
    // it — opening here would move a reshape throw into startup.
    expect(opened).toBe(false)
    expect(metrics()).toEqual([])
  })

  it('records an env_missing metric naming the missing variables', () => {
    const missing = reportMissingEnv({
      listText: LIST,
      env: { A: 'x' },
      db: () => db,
      now: () => 1_000,
    })

    expect(missing.map((v) => v.name)).toEqual(['B'])
    const rows = metrics()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toBe('env_missing')
    expect(rows[0]!.data).toMatchObject({
      missing: [{ name: 'B', severity: 'DEGRADED' }],
      required: 0,
      degraded: 1,
    })
  })

  it('counts REQUIRED and DEGRADED separately', () => {
    reportMissingEnv({ listText: LIST, env: {}, db: () => db, now: () => 1 })
    expect(metrics()[0]!.data).toMatchObject({ required: 1, degraded: 1 })
  })

  it('never records a VALUE, only names', () => {
    reportMissingEnv({
      listText: LIST,
      env: { A: 'SUPERSECRET-VALUE' },
      db: () => db,
      now: () => 1,
    })
    expect(JSON.stringify(metrics())).not.toContain('SUPERSECRET-VALUE')
  })

  it('never throws when the database is unavailable', () => {
    // D3: a throw here meets Restart=on-failure and becomes a crash loop
    // against a deploy path with no rollback. Reporting a config problem
    // must never be the thing that takes the site down.
    expect(() =>
      reportMissingEnv({
        listText: LIST,
        env: {},
        db: () => {
          throw new Error('database unavailable')
        },
        now: () => 1,
      }),
    ).not.toThrow()
  })

  it('never throws when the list itself is malformed', () => {
    expect(() =>
      reportMissingEnv({
        listText: 'THIS IS NOT VALID',
        env: {},
        db: () => db,
        now: () => 1,
      }),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/env/report.test.ts`
Expected: FAIL — cannot resolve `@/lib/env/report`.

- [ ] **Step 3: Write `lib/env/report.ts`**

```ts
// lib/env/report.ts
//
// The runtime half of the required-env check: the loud witness, not the gate.
// deploy/check-env.sh is the hard gate (design spec D3).
//
// This function NEVER THROWS. A throw reaches instrumentation.ts, which fails
// startup, which meets systemd's Restart=on-failure and becomes a crash loop
// — against a deploy path with no rollback (ledger I3). Crash-looping in front
// of a friend over a config typo is the wrong failure.
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric } from '@/lib/db/appendOnly'
import { missingFrom, parseRequiredEnv, type RequiredVar } from './required'

export type ReportDeps = {
  listText: string
  env: Record<string, string | undefined>
  /**
   * Called ONLY when something is missing. A healthy boot must not open the
   * database: getDb() is lazy by design, and ledger I3's documented failure
   * mode — a reshape problem surfacing as a per-request 500 rather than a
   * failed startup — depends on that laziness (design spec D5).
   */
  db: () => PlatformDb
  now: () => number
}

export function reportMissingEnv(deps: ReportDeps): RequiredVar[] {
  try {
    const vars = parseRequiredEnv(deps.listText)
    const present = new Set(
      Object.entries(deps.env)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([name]) => name),
    )
    const missing = missingFrom(vars, present)
    if (missing.length === 0) return []

    appendMetric(deps.db(), {
      accountId: null,
      event: 'env_missing',
      at: deps.now(),
      data: {
        // Names and severities only. Never a value.
        missing: missing.map((v) => ({ name: v.name, severity: v.severity })),
        required: missing.filter((v) => v.severity === 'REQUIRED').length,
        degraded: missing.filter((v) => v.severity === 'DEGRADED').length,
      },
    })
    return missing
  } catch {
    // Deliberately swallowed. See the file comment: this function reporting a
    // problem must never become a bigger problem than the one it reports.
    return []
  }
}
```

- [ ] **Step 4: Run the report tests**

Run: `npx vitest run tests/env/report.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into `instrumentation.ts`**

Replace the body of `register()`:

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { sweep, SWEEP_INTERVAL_MS } = await import('@/lib/session/keymap')
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()

  // The loud witness for missing configuration (design spec D3). Never
  // throws, and touches no database unless something is actually missing.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const { reportMissingEnv } = await import('@/lib/env/report')
  const { getDb } = await import('@/lib/db/instance')

  try {
    const listText = readFileSync(
      resolve(process.cwd(), 'deploy/required-env'),
      'utf8',
    )
    const missing = reportMissingEnv({
      listText,
      env: process.env,
      db: getDb,
      now: Date.now,
    })
    for (const v of missing) {
      console.warn(`[env] missing ${v.severity}: ${v.name} — ${v.purpose}`)
    }
  } catch {
    // Reading the list is best-effort too. A missing or unreadable list must
    // not prevent the server from starting.
  }
}
```

Also extend the file's top doc comment to say it now has two jobs.

- [ ] **Step 6: Extend `tests/instrumentation.test.ts`**

Add, following the file's existing idiom (it already saves and restores `NEXT_RUNTIME` in `afterEach`):

```ts
  it('reports missing env without throwing, and not on the edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    const { register } = await import('@/instrumentation')
    // The edge isolate has no keymap and no database handle; register() must
    // return without touching either.
    await expect(register()).resolves.toBeUndefined()
  })

  it('never rejects even if the required-env list cannot be read', async () => {
    // Startup must survive a missing list. A server that will not boot
    // because it could not find its own checklist is worse than the gap.
    process.env.NEXT_RUNTIME = 'nodejs'
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-path-for-test')
    vi.spyOn(global, 'setInterval').mockReturnValue({
      unref: vi.fn(),
    } as unknown as NodeJS.Timeout)

    const { register } = await import('@/instrumentation')
    await expect(register()).resolves.toBeUndefined()
    cwd.mockRestore()
  })
```

- [ ] **Step 7: Full suite, typecheck, build**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: all clean. The build matters here — `instrumentation.ts` is a Next entry point and a bad dynamic import is exactly the class of error that passes `tsc` and the suite while breaking the build.

- [ ] **Step 8: Commit**

```bash
git add lib/env/report.ts tests/env/report.test.ts instrumentation.ts tests/instrumentation.test.ts
git commit -m "Report missing configuration at startup without ever throwing

The runtime half is a witness, not a gate: deploy/check-env.sh blocks, this
records an env_missing metric and continues. A throw here would fail
startup, meet Restart=on-failure, and crash-loop against a deploy path with
no rollback.

A healthy boot touches no database. getDb() is called only when something
is actually missing, so the laziness ledger I3's failure mode depends on is
preserved — opening the database at boot would move a reshape throw into
startup, which is the crash loop this design exists to avoid."
```

---

### Task 5: One source of truth in the docs

**Files:**
- Modify: `docs/local-dev.md`
- Modify: `deploy/PROVISION.md`
- Modify: `docs/superpowers/ledgers/step2.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Point `docs/local-dev.md` at the list**

Replace its enumeration of environment variables with a pointer to `deploy/required-env` as the source of truth, keeping the *how* — that a value goes in an untracked `.env.local`, never committed, and that the guard hook denies reading it. Add that a missing variable now surfaces as a `[env] missing …` warning at `npm run dev` rather than at first use.

Do not restate the variable names. That duplication is the drift this task removes (design spec D4).

- [ ] **Step 2: Point `deploy/PROVISION.md` at the list**

Same treatment for the droplet: `deploy/required-env` names what must be present; PROVISION explains that the values live in `/home/deploy/stairwell/.env`, outside the repo, in `KEY=value` form with no `export` and no quotes. Add that `deploy.sh` now aborts before `npm ci` when a `REQUIRED` name is absent.

- [ ] **Step 3: Add the rule to CLAUDE.md**

Under the deploy section, one entry:

```markdown
- Every environment variable the deployed service needs is listed by NAME in
  `deploy/required-env`, with a severity. `deploy/deploy.sh` aborts before
  `npm ci` if a `REQUIRED` one is missing from the droplet's `.env`;
  `instrumentation.ts` records an `env_missing` metric at startup but never
  throws. Values live only in `.env` files, which the guard hook denies
  reading. Adding a variable means adding it to that list — including
  variables read by dependencies rather than by our own code.
```

- [ ] **Step 4: Close the queued task in the ledger**

In `docs/superpowers/ledgers/step2.md`, mark the "Queued task — required-env presence check" section CLOSED, naming the commits and noting that items 15 and 16 are now guarded for the config half. Leave the original text — a ledger records history.

- [ ] **Step 5: Full suite and commit**

```bash
npx vitest run
git add docs/local-dev.md deploy/PROVISION.md CLAUDE.md docs/superpowers/ledgers/step2.md
git commit -m "Make deploy/required-env the single source of truth for env vars

local-dev.md and PROVISION.md each maintained their own list, which is the
drift this removes. Both now point at deploy/required-env and keep only the
part that differs: where the value goes and in what format.

CLAUDE.md gains the rule, including the part a future contributor cannot
infer — that variables read by dependencies belong in the list too, which
is why ANTHROPIC_API_KEY is in it despite appearing nowhere in our source."
```

---

## Self-review notes

**Spec coverage.** §1 scope → T1 (list), T2 (checker), T3 (deploy), T4 (runtime), T5 (docs). §2.1 hand-maintained list → T1 Step 4 comment + T1 test asserting `ANTHROPIC_API_KEY` is listed. §2.2 no `.env` fixture → T2 fixtures named `env-fixture`, every function takes a path or text. §2.3 two homes → T2 and T4. §2.4 severities → T1 format, T2 behaviour. §3 shape → the file structure table. §4 non-goals → no validity check anywhere, no new dependency, no value handling. D1 file over systemd env → T3 passes `.env`. D2 tiers → T2 exit codes. D3 never throws → T4 tests. D4 one source of truth → T5. D5 no database on a healthy boot → T4 Step 1's `opened` assertion. §6 testing → each task's tests, plus the observed-failure runs in T2 Step 6 and T3 Step 5.

**Known gap, deliberate.** No test boots Next.js and asserts the startup warning appears in a real server's output. The suite has no such harness, and adding one is out of scope. `register()` is exercised directly, which is how `tests/instrumentation.test.ts` already works.

**Deliberate duplication.** The parsing logic exists in bash and TypeScript because the deploy check runs before `npm ci`. T2's agreement test is the mitigation; if it is ever deleted, the duplication becomes a real drift risk rather than a managed one.
