// tests/scripts/pullSpec.test.ts
//
// Exercises scripts/pull-spec.sh only in --local mode: the ssh (droplet)
// path is untestable here by design (CLAUDE.md > Testing: tests must not
// attempt any ssh), and pull-spec.sh's own header says --local is the only
// form an agent runs.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
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
  })

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
  })

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
  })

  it('requires a user argument and writes nothing', () => {
    const sandbox = makeSandbox()
    const { status, output } = run(sandbox, [], join(tmpdir(), 'unused.db'))

    expect(status).toBe(2)
    expect(output).toMatch(/usage/)
  })

  describe('atomic write (no half-written pair)', () => {
    // pull-spec.sh's node -e block writes spec.md then mockup.html. Forcing
    // a real filesystem failure on the SECOND file — by pre-occupying its
    // final path with a directory, the same shape a disk-full or
    // permission failure produces from the script's point of view — is
    // exactly the case that leaves spec.md written and mockup.html missing
    // if the two writes are not guarded. This is the classic historical
    // bug shape, not a synthetic one: against the pre-fix script (direct
    // writeFileSync to each final path, in order), spec.md WOULD land on
    // disk before the second writeFileSync hit EISDIR on the directory.

    it('leaves NEITHER file on a fresh pull when the second write fails partway', async () => {
      const sandbox = makeSandbox()
      const dbPath = await makeDb({
        slug: CONFIRMED_SLUG,
        confirm: true,
        title: 'Should never land TEST',
        mockupHtml: '<!doctype html><html><body>SHOULD NEVER LAND TEST</body></html>',
      })

      const dir = userDir(sandbox, CONFIRMED_SLUG)
      mkdirSync(dir, { recursive: true })
      // Occupy mockup.html's final path with a directory, so writing to it
      // fails no matter what the write step looks like.
      mkdirSync(join(dir, 'mockup.html'))

      const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], dbPath)

      expect(status).not.toBe(0)
      expect(existsSync(join(dir, 'spec.md'))).toBe(false)
      // mockup.html is still the directory we made, never replaced by a file.
      expect(existsSync(join(dir, 'mockup.html'))).toBe(true)
    })

    it('does not half-overwrite a pre-existing pair from an earlier successful pull', async () => {
      const sandbox = makeSandbox()
      const first = await makeDb({
        slug: CONFIRMED_SLUG,
        confirm: true,
        title: 'Earlier successful pull TEST',
        mockupHtml: '<!doctype html><html><body>EARLIER PULL TEST</body></html>',
      })
      const { status: firstStatus } = run(sandbox, [CONFIRMED_SLUG, '--local'], first)
      expect(firstStatus).toBe(0)

      const dir = userDir(sandbox, CONFIRMED_SLUG)
      const specBefore = readFileSync(join(dir, 'spec.md'), 'utf8')

      const second = await makeDb({
        slug: CONFIRMED_SLUG,
        confirm: true,
        title: 'Should not replace the earlier pull TEST',
        mockupHtml: '<!doctype html><html><body>SHOULD NOT REPLACE TEST</body></html>',
      })
      // Replace the existing mockup.html FILE with a directory to force a
      // real filesystem failure on the second file for the re-pull too.
      // This necessarily destroys the ability to assert mockup.html's own
      // content is untouched (the test itself just removed it) — the
      // meaningful assertion here is spec.md, which this setup step never
      // touches, still holding the FIRST pull's content rather than the
      // second (failed) pull's.
      rmSync(join(dir, 'mockup.html'))
      mkdirSync(join(dir, 'mockup.html'))

      const { status } = run(sandbox, [CONFIRMED_SLUG, '--local'], second)

      expect(status).not.toBe(0)
      // spec.md must still hold the FIRST pull's content, not the second's
      // — the fix must refuse before EITHER file is touched, not just
      // before mockup.html specifically.
      expect(readFileSync(join(dir, 'spec.md'), 'utf8')).toBe(specBefore)
      expect(readFileSync(join(dir, 'spec.md'), 'utf8')).not.toContain(
        'Should not replace the earlier pull TEST',
      )
      // mockup.html must still be the directory this test made, never
      // replaced by a file — proves the write did not partially succeed.
      expect(statSync(join(dir, 'mockup.html')).isDirectory()).toBe(true)
    })
  })
})
