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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import type { SpecPayload } from '@/lib/spec/schema'

const REPO = resolve(__dirname, '..', '..')

// Disposable, unmistakably-synthetic slugs — never real dashboards.
const CONFIRMED_SLUG = 'pullspectest-confirmed'
const UNCONFIRMED_SLUG = 'pullspectest-unconfirmed'

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

const PANEL: SpecPayload['panels'][number] = {
  name: 'Panel',
  shows: 'Something',
  why: 'A reason',
  source: 'plaid',
}

/** Build a fresh temp platform db with one account and one spec in it. */
async function makeDb(opts: {
  slug: string
  confirm: boolean
  title: string
  mockupHtml: string
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
    mockupHtml: opts.mockupHtml,
    at: 1_000,
  })
  if (opts.confirm) confirmSpec(db, { specId, accountId, at: 1_500 })
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
 * users/<name>/spec.md as if they were a friend's real confirmed spec.
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

describe('scripts/pull-spec.sh --local', () => {
  it('writes spec.md and mockup.html from the confirmed spec', async () => {
    const sandbox = makeSandbox()
    const dbPath = await makeDb({
      slug: CONFIRMED_SLUG,
      confirm: true,
      title: 'Pulled via pull-spec.sh TEST',
      mockupHtml: '<!doctype html><html><body>PULL SPEC TEST</body></html>',
    })

    const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], dbPath)

    expect(status).toBe(0)
    expect(readFileSync(join(userDir(sandbox, CONFIRMED_SLUG), 'spec.md'), 'utf8')).toContain(
      '# Pulled via pull-spec.sh TEST',
    )
    expect(readFileSync(join(userDir(sandbox, CONFIRMED_SLUG), 'mockup.html'), 'utf8')).toBe(
      '<!doctype html><html><body>PULL SPEC TEST</body></html>',
    )
  }, SUBPROCESS_TIMEOUT_MS)

  it('overwrites both files on a second pull, as documented', async () => {
    const sandbox = makeSandbox()
    const first = await makeDb({
      slug: CONFIRMED_SLUG,
      confirm: true,
      title: 'First pull TEST',
      mockupHtml: '<!doctype html><html><body>FIRST PULL TEST</body></html>',
    })
    run(sandbox, [CONFIRMED_SLUG, '--local'], first)

    const second = await makeDb({
      slug: CONFIRMED_SLUG,
      confirm: true,
      title: 'Second pull, meant to replace the first file TEST',
      mockupHtml: '<!doctype html><html><body>SECOND PULL TEST</body></html>',
    })
    const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], second)

    expect(status).toBe(0)
    const specMd = readFileSync(join(userDir(sandbox, CONFIRMED_SLUG), 'spec.md'), 'utf8')
    expect(specMd).toContain('# Second pull, meant to replace the first file TEST')
    expect(specMd).not.toContain('First pull TEST')
    expect(readFileSync(join(userDir(sandbox, CONFIRMED_SLUG), 'mockup.html'), 'utf8')).toBe(
      '<!doctype html><html><body>SECOND PULL TEST</body></html>',
    )
  }, SUBPROCESS_TIMEOUT_MS)

  it('writes NEITHER file and exits non-zero when the account has no confirmed spec', async () => {
    // The partial-write hazard this guards against: a spec.md from one
    // proposal sitting next to a mockup.html from nowhere.
    const sandbox = makeSandbox()
    const dbPath = await makeDb({
      slug: UNCONFIRMED_SLUG,
      confirm: false,
      title: 'Never confirmed TEST',
      mockupHtml: '<!doctype html><html><body>NEVER CONFIRMED TEST</body></html>',
    })

    const { status, output } = run(sandbox, [UNCONFIRMED_SLUG, '--local'], dbPath)

    expect(status).not.toBe(0)
    expect(output).toMatch(/no confirmed spec/)
    expect(existsSync(userDir(sandbox, UNCONFIRMED_SLUG))).toBe(false)
  }, SUBPROCESS_TIMEOUT_MS)

  it('requires a user argument and writes nothing', () => {
    const sandbox = makeSandbox()
    const { status, output } = run(sandbox, [], join(tmpdir(), 'unused.db'))

    expect(status).toBe(2)
    expect(output).toMatch(/usage/)
  }, SUBPROCESS_TIMEOUT_MS)
})
