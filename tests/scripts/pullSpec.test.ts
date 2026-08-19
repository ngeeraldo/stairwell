// tests/scripts/pullSpec.test.ts
//
// Exercises scripts/pull-spec.sh only in --local mode: the ssh (droplet)
// path is untestable here by design (CLAUDE.md > Testing: tests must not
// attempt any ssh), and pull-spec.sh's own header says --local is the only
// form an agent runs.
//
// This file covers the WRAPPER end to end (a real subprocess, a real tsx
// invocation chain, a real synthetic platform db). The atomic-write
// guarantee itself — precondition / write / move-aside / commit, and what
// happens when each throws — moved into scripts/write-spec-pair.ts and is
// covered precisely there, in tests/scripts/writeSpecPair.test.ts, via
// dependency-injected fault points rather than filesystem contortions
// against this shell script. That move happened because a fault aimed at
// pull-spec.sh from outside (a pre-created directory at a specific path)
// could not reliably tell two adjacent guards apart — round 3 of the
// step-4 review caught a case where a test named for the commit-rename
// guard was, in fact, only ever reaching the guard before it.
//
// It writes a PAIR again — spec.md and conversation.md (plan
// 2026-08-19-change-only-specs, Task 7) — and the JSON reaches
// write-spec-pair.ts on STDIN rather than as an argv argument, because a
// whole conversation can exceed ARG_MAX. That is not a detail a static scan
// can prove, so there is a test below that pushes a payload past the limit
// and asserts the pull still succeeds.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { insertSpec } from '@/lib/db/specs'
import { appendTranscript } from '@/lib/db/appendOnly'
import type { LegacySpecPayload } from '@/lib/spec/legacy'

const REPO = resolve(__dirname, '..', '..')

// Disposable, unmistakably-synthetic slugs — never real dashboards.
const CONFIRMED_SLUG = 'pullspectest-confirmed'
const NO_SPEC_SLUG = 'pullspectest-nospec'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

/**
 * pull-spec.sh resolves `scripts/export-spec.ts` and `users/<user>` as
 * paths relative to its own process cwd — by design, it assumes it is run
 * from the repo root. Symlinking only what it (and tsx's own module/
 * tsconfig resolution) actually touches lets it run for real with cwd
 * pointed at a disposable sandbox instead: `users/<user>` then lands
 * inside the sandbox, never inside the real repo's users/ tree, no matter
 * how the process exits — including a hard kill mid-test, which afterEach
 * cannot protect against.
 */
function makeSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'stairwell-pull-spec-sandbox-'))
  tempDirs.push(sandbox)
  for (const name of ['scripts', 'node_modules', 'tsconfig.json', 'lib', 'platform']) {
    symlinkSync(join(REPO, name), join(sandbox, name))
  }
  return sandbox
}

function userDir(sandbox: string, slug: string): string {
  return join(sandbox, 'users', slug)
}

const PANEL: LegacySpecPayload['panels'][number] = {
  name: 'Panel',
  shows: 'Something',
  why: 'A reason',
  source: 'plaid',
}

/**
 * Build a fresh temp platform db with one account and one spec in it.
 *
 * Nothing confirms any more (lib/db/specs.ts's confirmSpec is gone), so this
 * no longer takes a `confirm` option — the row it writes is exportable the
 * moment it exists. Inserted directly into spec_confirmations, the way
 * tests/db/specs.test.ts's own fixtures now do, so a caller that wants a
 * HISTORICAL confirmation on the row can still add one.
 *
 * `mockupHtml` is still a required insertSpec argument — specs.mockup_html
 * stays a NOT NULL column (Data safety, CLAUDE.md) — but it is fixed rather
 * than caller-supplied: nothing reads it back through this wrapper any more
 * (export-spec.ts stopped emitting it as of the mockup-loop removal, plan
 * 2026-08-19-remove-the-mockup-loop, Task 6), so a per-test value would only
 * be dead configuration.
 */
async function makeDb(opts: {
  slug: string
  title: string
  confirmedAt?: number
  /** Transcript rows to sit BEFORE the spec, so they land in its slice. */
  transcript?: { role: string; body: string }[]
}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stairwell-pull-spec-db-'))
  tempDirs.push(dir)
  const path = join(dir, 'synthetic.db')
  const db = openPlatformDb(path)
  const accountId = await createAccount(db, {
    slug: opts.slug,
    role: 'user',
    password: 'TEST-PULL-SPEC',
  })
  const specId = insertSpec(db, {
    accountId,
    conversationId: 'conv-1',
    promptSha: 'sha-pull-0001',
    payload: {
      title: opts.title,
      summary: 'Synthetic fixture for the pull-spec.sh wrapper test.',
      background: 'COFFEE PALACE TEST background.',
      panels: [PANEL],
      manual_logging: [],
      open_questions: [],
    },
    mockupHtml: '',
    at: 1_000,
  })
  // Written at `at: 900`, before the spec's own 1_000, so conversationRows'
  // `prev.at < at <= spec.at` slice picks them up (lib/spec/conversation.ts).
  for (const [index, row] of (opts.transcript ?? []).entries()) {
    appendTranscript(db, {
      accountId,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'sha-pull-0001',
      role: row.role,
      body: row.body,
      at: 900 + index,
    })
  }
  if (opts.confirmedAt !== undefined) {
    db.prepare(
      'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
    ).run(specId, accountId, opts.confirmedAt)
  }
  db.close()
  return path
}

/**
 * Build a fresh temp platform db with an account that has NO spec at all —
 * the only case exportSpec (and so pull-spec.sh) still refuses.
 */
async function makeEmptyDb(slug: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stairwell-pull-spec-db-'))
  tempDirs.push(dir)
  const path = join(dir, 'synthetic.db')
  const db = openPlatformDb(path)
  await createAccount(db, { slug, role: 'user', password: 'TEST-PULL-SPEC' })
  db.close()
  return path
}

/** Run pull-spec.sh as a real subprocess, cwd pinned to a disposable sandbox. */
function run(
  sandbox: string,
  args: string[],
  platformDb: string,
): { status: number; output: string } {
  try {
    const output = execFileSync(join(sandbox, 'scripts', 'pull-spec.sh'), args, {
      cwd: sandbox,
      env: { ...process.env, PLATFORM_DB: platformDb },
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
  }
}

/**
 * Every test in this file spawns the real shell script, and each pull inside it
 * spawns `npx tsx` TWICE — once to export, once to write — with npx
 * re-resolving the binary on each call. That is seconds of genuine work, and
 * vitest's 5-second default is not a budget for it.
 *
 * It first bit on the droplet, not here: the deploy of 2026-08-13 aborted
 * because the two-pull test crossed 5s there while passing locally. The suite
 * runs about 1.7x slower on that box (85s vs 50s), so a laptop-calibrated
 * default is the wrong gate — and `deploy/deploy.sh` runs the suite before the
 * restart, so a false timeout blocks a deploy over nothing.
 *
 * Deliberately per-file rather than a global `testTimeout` in vitest.config.ts:
 * these four tests are legitimately slow, and raising the ceiling everywhere
 * would mask a genuine hang in the ~490 tests that should finish in
 * milliseconds. Still far below any real hang, so this fails fast when
 * something is actually wrong.
 */
const SUBPROCESS_TIMEOUT_MS = 60_000

/**
 * The droplet path, by static scan — the same idiom as tests/deploy/. It
 * cannot be executed here (tests must not ssh), and that is exactly how it
 * shipped broken: only --local was ever exercised.
 *
 * What went wrong: a non-interactive ssh loads no profile and no systemd
 * EnvironmentFile, so PLATFORM_DB was unset on the far side and
 * export-spec.ts fell back to the SYNTHETIC database on the production box.
 * It surfaced as a confusing "directory does not exist" only because
 * platform/dev/ is absent from the droplet's checkout — git will not create a
 * directory whose only contents are gitignored. With that directory present,
 * the failure mode is silent and much worse: synthetic rows written into
 * users/<name>/spec.md as if they were a friend's real spec.
 *
 * This pins the fix, not the bug. It cannot prove the remote command runs;
 * only a real pull can, and one has.
 */
describe('scripts/pull-spec.sh droplet path', () => {
  const script = readFileSync('scripts/pull-spec.sh', 'utf8')

  /**
   * Two scoping rules, both learned by drilling the first version of these
   * tests rather than by reading them:
   *
   * 1. Strip comments. A raw scan matches the script's own prose — the comment
   *    explaining the `.env` sourcing put that string in the --local half of
   *    the file and reddened the third test for a reason unrelated to the
   *    code. The same hazard tests/deploy names.
   * 2. Scope to the REMOTE command. A bare indexOf over the whole script
   *    compares positions across two branches: --local invokes export-spec.ts
   *    earlier, correctly, with no .env at all.
   */
  const code = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  const sshCommand = code.slice(code.indexOf('ssh deploy@'))

  it('sources .env on the droplet before invoking export-spec.ts', () => {
    const sourcesEnv = sshCommand.indexOf('. ./.env')
    const invokesExport = sshCommand.indexOf('npx tsx scripts/export-spec.ts')
    expect(sourcesEnv).toBeGreaterThan(-1)
    expect(invokesExport).toBeGreaterThan(-1)
    expect(sourcesEnv).toBeLessThan(invokesExport)
  })

  it('exports what it sources, so PLATFORM_DB reaches the child process', () => {
    // `. ./.env` alone defines the variables in the remote shell without
    // exporting them, so `npx tsx` would still see PLATFORM_DB unset and the
    // bug would survive the fix. `set -a` is the load-bearing half.
    expect(sshCommand).toMatch(/set -a && \. \.\/\.env && set \+a && npx tsx/)
  })

  it('leaves --local alone, which needs no .env', () => {
    // The other half of the scoping: --local reads PLATFORM_DB from the
    // caller's own environment and must not start sourcing a droplet file.
    const localBranch = code.slice(0, code.indexOf('ssh deploy@'))
    expect(localBranch).toContain('npx tsx scripts/export-spec.ts')
    expect(localBranch).not.toContain('. ./.env')
  })
})

/**
 * The payload handoff, by static scan. The runtime test above proves a
 * 1.5MB payload arrives; this pins WHY it can — that the JSON is piped rather
 * than handed to write-spec-pair.ts as an argument. Both branches (--local
 * and ssh) join at the same single invocation, so one scan covers both.
 */
describe('scripts/pull-spec.sh payload handoff', () => {
  const code = readFileSync('scripts/pull-spec.sh', 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  it('pipes the JSON into write-spec-pair.ts on stdin', () => {
    expect(code).toMatch(/printf '%s' "\$json" \| npx tsx scripts\/write-spec-pair\.ts "users\/\$user"/)
  })

  it('never passes the JSON as an argv argument', () => {
    // A whole transcript can exceed ARG_MAX; that failure comes from execve,
    // before the script under test gets a chance to report anything.
    const invocation = code.slice(code.indexOf('write-spec-pair.ts'))
    expect(invocation.split('\n')[0]).not.toContain('$json"')
  })

  it('invokes write-spec-pair.ts exactly once, so both branches share the pipe', () => {
    expect(code.match(/npx tsx scripts\/write-spec-pair\.ts/g)).toHaveLength(1)
  })
})

describe('scripts/pull-spec.sh --local', () => {
  it('writes spec.md from the current spec', async () => {
    const sandbox = makeSandbox()
    const dbPath = await makeDb({
      slug: CONFIRMED_SLUG,
      confirmedAt: 1_500,
      title: 'Pulled via pull-spec.sh TEST',
    })

    const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], dbPath)

    expect(status).toBe(0)
    expect(readFileSync(join(userDir(sandbox, CONFIRMED_SLUG), 'spec.md'), 'utf8')).toContain(
      '# Pulled via pull-spec.sh TEST',
    )
  }, SUBPROCESS_TIMEOUT_MS)

  it('writes conversation.md beside it, carrying the transcript verbatim', async () => {
    const sandbox = makeSandbox()
    const dbPath = await makeDb({
      slug: CONFIRMED_SLUG,
      confirmedAt: 1_500,
      title: 'Pulled with a conversation TEST',
      transcript: [
        // A line-leading '#' on purpose: spec.md neutralises those because it
        // is a designed document; a transcript must survive untouched.
        { role: 'user', body: '# COFFEE PALACE TEST wants a spend panel' },
        { role: 'assistant', body: 'Noted, COFFEE PALACE TEST.' },
      ],
    })

    const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], dbPath)

    expect(status).toBe(0)
    const conversation = readFileSync(
      join(userDir(sandbox, CONFIRMED_SLUG), 'conversation.md'),
      'utf8',
    )
    expect(conversation).toContain('## user')
    expect(conversation).toContain('# COFFEE PALACE TEST wants a spend panel')
    expect(conversation).toContain('Noted, COFFEE PALACE TEST.')
  }, SUBPROCESS_TIMEOUT_MS)

  it('delivers a payload far past ARG_MAX, which only stdin can carry', async () => {
    // THE POINT OF THE PIPE. Passed as argv this fails at execve before
    // write-spec-pair.ts runs at all — E2BIG on macOS (ARG_MAX ~1MB for the
    // whole argument vector) and E2BIG on Linux too (MAX_ARG_STRLEN caps a
    // SINGLE argument at 128KB). Either way the operator gets a shell error
    // with nothing naming the length of the transcript as the cause. 1.5MB of
    // transcript body is comfortably past both limits.
    const sandbox = makeSandbox()
    const HUGE = `COFFEE PALACE TEST ${'x'.repeat(1_500_000)} END COFFEE PALACE TEST`
    const dbPath = await makeDb({
      slug: CONFIRMED_SLUG,
      confirmedAt: 1_500,
      title: 'Pulled with a very long conversation TEST',
      transcript: [{ role: 'user', body: HUGE }],
    })

    const { status, output } = run(sandbox, [CONFIRMED_SLUG, '--local'], dbPath)

    expect(output).not.toMatch(/Argument list too long|E2BIG/)
    expect(status).toBe(0)
    const conversation = readFileSync(
      join(userDir(sandbox, CONFIRMED_SLUG), 'conversation.md'),
      'utf8',
    )
    // Not just "it ran" — the whole body arrived, start and end.
    expect(conversation.length).toBeGreaterThan(1_500_000)
    expect(conversation).toContain('END COFFEE PALACE TEST')
  }, SUBPROCESS_TIMEOUT_MS)

  it('overwrites the file on a second pull, as documented', async () => {
    const sandbox = makeSandbox()
    const first = await makeDb({
      slug: CONFIRMED_SLUG,
      confirmedAt: 1_500,
      title: 'First pull TEST',
      transcript: [{ role: 'user', body: 'First conversation TEST' }],
    })
    run(sandbox, [CONFIRMED_SLUG, '--local'], first)

    const second = await makeDb({
      slug: CONFIRMED_SLUG,
      confirmedAt: 1_500,
      title: 'Second pull, meant to replace the first file TEST',
      transcript: [{ role: 'user', body: 'Second conversation TEST' }],
    })
    const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], second)

    expect(status).toBe(0)
    const specMd = readFileSync(join(userDir(sandbox, CONFIRMED_SLUG), 'spec.md'), 'utf8')
    expect(specMd).toContain('# Second pull, meant to replace the first file TEST')
    expect(specMd).not.toContain('First pull TEST')
    // Both halves of the pair move together, or the build contract and the
    // conversation behind it would describe different pulls.
    const conversation = readFileSync(
      join(userDir(sandbox, CONFIRMED_SLUG), 'conversation.md'),
      'utf8',
    )
    expect(conversation).toContain('Second conversation TEST')
    expect(conversation).not.toContain('First conversation TEST')
  }, SUBPROCESS_TIMEOUT_MS)

  it('writes nothing and exits non-zero when the account has no spec at all', async () => {
    // The partial-write hazard write-spec-pair.ts's guards defend against: a
    // spec.md left half-written by a failure partway through the rename
    // sequence — or, now that there are two files again, a spec.md written
    // beside a stale conversation.md. The outcome this test pins is the same
    // as it always was: a refusal upstream must reach here as "wrote
    // nothing", not "wrote a stale file".
    //
    // Nothing confirms any more (lib/db/specs.ts's currentSpec is the newest
    // spec, full stop), so the only account left that exportSpec refuses is
    // one with no spec row at all — makeEmptyDb, not makeDb with an
    // unconfirmed one.
    const sandbox = makeSandbox()
    const dbPath = await makeEmptyDb(NO_SPEC_SLUG)

    const { status, output } = run(sandbox, [NO_SPEC_SLUG, '--local'], dbPath)

    expect(status).not.toBe(0)
    expect(output).toMatch(/no spec/)
    expect(existsSync(userDir(sandbox, NO_SPEC_SLUG))).toBe(false)
  }, SUBPROCESS_TIMEOUT_MS)

  it('requires a user argument and writes nothing', () => {
    const sandbox = makeSandbox()
    const { status, output } = run(sandbox, [], join(tmpdir(), 'unused.db'))

    expect(status).toBe(2)
    expect(output).toMatch(/usage/)
  }, SUBPROCESS_TIMEOUT_MS)
})
