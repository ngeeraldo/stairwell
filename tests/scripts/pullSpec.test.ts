// tests/scripts/pullSpec.test.ts
//
// Exercises scripts/pull-spec.sh only in --local mode: the ssh (droplet)
// path is untestable here by design (CLAUDE.md > Testing: tests must not
// attempt any ssh), and pull-spec.sh's own header says --local is the only
// form an agent runs.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import type { SpecPayload } from '@/lib/spec/schema'

const REPO = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'pull-spec.sh')

// Disposable, unmistakably-synthetic slugs — never real dashboards. Removed
// from users/ in afterEach regardless of how the test ends.
const CONFIRMED_SLUG = 'pullspectest-confirmed'
const UNCONFIRMED_SLUG = 'pullspectest-unconfirmed'

function userDir(slug: string): string {
  return join(REPO, 'users', slug)
}

const tempDirs: string[] = []

afterEach(() => {
  rmSync(userDir(CONFIRMED_SLUG), { recursive: true, force: true })
  rmSync(userDir(UNCONFIRMED_SLUG), { recursive: true, force: true })
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

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
  const dir = mkdtempSync(join(tmpdir(), 'stairwell-pull-spec-'))
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

/** Run pull-spec.sh as a real subprocess from the repo root. */
function run(args: string[], platformDb: string): { status: number; output: string } {
  try {
    const output = execFileSync(SCRIPT, args, {
      cwd: REPO,
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
    const dbPath = await makeDb({
      slug: CONFIRMED_SLUG,
      confirm: true,
      title: 'Pulled via pull-spec.sh TEST',
      mockupHtml: '<!doctype html><html><body>PULL SPEC TEST</body></html>',
    })

    const { status } = run([CONFIRMED_SLUG, '--local'], dbPath)

    expect(status).toBe(0)
    expect(readFileSync(join(userDir(CONFIRMED_SLUG), 'spec.md'), 'utf8')).toContain(
      '# Pulled via pull-spec.sh TEST',
    )
    expect(readFileSync(join(userDir(CONFIRMED_SLUG), 'mockup.html'), 'utf8')).toBe(
      '<!doctype html><html><body>PULL SPEC TEST</body></html>',
    )
  })

  it('overwrites both files on a second pull, as documented', async () => {
    const first = await makeDb({
      slug: CONFIRMED_SLUG,
      confirm: true,
      title: 'First pull TEST',
      mockupHtml: '<!doctype html><html><body>FIRST PULL TEST</body></html>',
    })
    run([CONFIRMED_SLUG, '--local'], first)

    const second = await makeDb({
      slug: CONFIRMED_SLUG,
      confirm: true,
      title: 'Second pull, meant to replace the first file TEST',
      mockupHtml: '<!doctype html><html><body>SECOND PULL TEST</body></html>',
    })
    const { status } = run([CONFIRMED_SLUG, '--local'], second)

    expect(status).toBe(0)
    const specMd = readFileSync(join(userDir(CONFIRMED_SLUG), 'spec.md'), 'utf8')
    expect(specMd).toContain('# Second pull, meant to replace the first file TEST')
    expect(specMd).not.toContain('First pull TEST')
    expect(readFileSync(join(userDir(CONFIRMED_SLUG), 'mockup.html'), 'utf8')).toBe(
      '<!doctype html><html><body>SECOND PULL TEST</body></html>',
    )
  })

  it('writes NEITHER file and exits non-zero when the account has no confirmed spec', async () => {
    // The partial-write hazard this guards against: a spec.md from one
    // proposal sitting next to a mockup.html from nowhere.
    const dbPath = await makeDb({
      slug: UNCONFIRMED_SLUG,
      confirm: false,
      title: 'Never confirmed TEST',
      mockupHtml: '<!doctype html><html><body>NEVER CONFIRMED TEST</body></html>',
    })

    const { status, output } = run([UNCONFIRMED_SLUG, '--local'], dbPath)

    expect(status).not.toBe(0)
    expect(output).toMatch(/no confirmed spec/)
    expect(existsSync(userDir(UNCONFIRMED_SLUG))).toBe(false)
  })

  it('requires a user argument and writes nothing', () => {
    const { status, output } = run([], join(tmpdir(), 'unused.db'))

    expect(status).toBe(2)
    expect(output).toMatch(/usage/)
  })
})
