// tests/scripts/exportSpec.test.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import { SpecShapeError, type SpecVersion } from '@/lib/spec/schema'
import { type LegacySpecPayload } from '@/lib/spec/legacy'
import { exportSpec } from '@/scripts/export-spec'

const REPO = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'export-spec.ts')

const MOCKUP = '<!doctype html><html><body>COFFEE PALACE TEST</body></html>'

function payload(overrides: Partial<LegacySpecPayload> = {}): LegacySpecPayload {
  return {
    title: 'Some dashboard TEST',
    summary: 'A summary, COFFEE PALACE TEST.',
    background: 'Loudly-fake background, COFFEE PALACE TEST.',
    panels: [
      { name: 'Panel one', shows: 'Something', why: 'A reason', source: 'plaid' },
    ],
    manual_logging: [],
    open_questions: [],
    ...overrides,
  }
}

const CURRENT_PAYLOAD: SpecVersion = {
  title: 'Did I walk the dog today? TEST',
  summary: 'A one-tap tracker, COFFEE PALACE TEST.',
  background: 'Pivoted from weather TEST.',
  change_summary: 'Added a streak panel TEST.',
  based_on_version: null,
  ops: null,
  screens: [
    {
      id: 'today',
      title: 'Today TEST',
      order: 1,
      panels: [
        {
          id: 'walked_today',
          title: 'Walked today? TEST',
          intent: 'Did I walk the dog TEST?',
          display: 'Yes/no with a tap TEST.',
          context_of_use: null,
          values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day TEST.' }],
          entry: null,
        },
      ],
    },
  ],
  data_requirements: [],
  open_questions: [],
}

/**
 * Insert a spec row with an arbitrary, possibly-invalid payload string,
 * bypassing insertSpec's JSON.stringify — the only way to construct the
 * corrupt-row fixture below, since specs is append-only (no UPDATE).
 */
function insertRawSpec(
  db: PlatformDb,
  row: {
    accountId: number
    conversationId: string
    promptSha: string
    payloadText: string
    mockupHtml: string
    at: number
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO specs
       (account_id, conversation_id, prompt_sha, payload, mockup_html, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.accountId,
      row.conversationId,
      row.promptSha,
      row.payloadText,
      row.mockupHtml,
      row.at,
    )
  return Number(info.lastInsertRowid)
}

let dir: string
let db: PlatformDb

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-export-spec-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))

  const devoneId = await createAccount(db, {
    slug: 'devone',
    role: 'user',
    password: 'TEST-DEV-ONE',
  })
  const devtwoId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'TEST-DEV-TWO',
  })
  const devthreeId = await createAccount(db, {
    slug: 'devthree',
    role: 'user',
    password: 'TEST-DEV-THREE',
  })
  const devfourId = await createAccount(db, {
    slug: 'devfour',
    role: 'user',
    password: 'TEST-DEV-FOUR',
  })
  // 'ghost' is deliberately never created.

  // devone: a proposal that was never confirmed. currentSpec must find
  // nothing, and exportSpec must refuse loudly rather than fall back to it.
  insertSpec(db, {
    accountId: devoneId,
    conversationId: 'conv-devone',
    promptSha: 'sha-devone-0001',
    payload: payload({ title: 'A draft devone never confirmed TEST' }),
    mockupHtml: MOCKUP,
    at: 1_000,
  })

  // devtwo: an OLDER spec that gets confirmed, then a NEWER unconfirmed
  // draft on top of it. currentSpec (and so exportSpec) must still pick the
  // confirmed, older one — the newest PROPOSAL is not the build contract.
  const devtwoConfirmedId = insertSpec(db, {
    accountId: devtwoId,
    conversationId: 'conv-devtwo',
    promptSha: 'sha-devtwo-0001',
    payload: payload({
      title: 'Eating out and the car fund',
      summary:
        'This is the confirmed one; a later draft came after it but was never confirmed.',
    }),
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId: devtwoConfirmedId, accountId: devtwoId, at: 1_500 })
  insertSpec(db, {
    accountId: devtwoId,
    conversationId: 'conv-devtwo',
    promptSha: 'sha-devtwo-0002',
    payload: payload({ title: 'A newer draft nobody confirmed yet TEST' }),
    mockupHtml: '<!doctype html><html><body>SHOULD NOT BE EXPORTED TEST</body></html>',
    at: 2_000,
  })

  // devthree: a CONFIRMED spec whose stored payload is corrupt JSON. Task 3
  // finding: parseLegacySpecPayload throws SpecShapeError on a row like this,
  // and exportSpec must let that propagate as a clear, named failure rather
  // than a generic crash or (worse) a silently empty export.
  const corruptId = insertRawSpec(db, {
    accountId: devthreeId,
    conversationId: 'conv-devthree',
    promptSha: 'sha-devthree-0001',
    payloadText: '{not valid json',
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId: corruptId, accountId: devthreeId, at: 1_500 })

  // devfour: a CONFIRMED spec in the CURRENT whole-surface shape. Nothing
  // writes this shape yet (Task 10 switches authoring over), but the export
  // has to be ready the moment something does — a build contract that
  // rendered the wrong shape would be discovered by a human reading spec.md
  // after the fact, not by anything that fails loudly.
  const currentId = insertSpec(db, {
    accountId: devfourId,
    conversationId: 'conv-devfour',
    promptSha: 'sha-devfour-0001',
    payload: CURRENT_PAYLOAD,
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  confirmSpec(db, { specId: currentId, accountId: devfourId, at: 1_500 })
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('exportSpec', () => {
  it('renders the confirmed spec and returns the mockup verbatim', () => {
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('# Eating out and the car fund')
    expect(out.spec_md).toContain('v1')
    expect(out.mockup_html).toBe(MOCKUP)
  })

  it('exports the newest CONFIRMED spec, not the newest proposal', () => {
    // The file is the build contract, and only a confirmed spec is one.
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('confirmed one')
    // The unconfirmed, newer draft's own title must not have leaked in.
    expect(out.spec_md).not.toContain('newer draft')
  })

  it('refuses an account with no confirmed spec, naming why', () => {
    expect(() => exportSpec(db, 'devone')).toThrow(/no confirmed spec/)
  })

  it('refuses an unknown slug', () => {
    expect(() => exportSpec(db, 'ghost')).toThrow(/no account/)
  })

  it('renders a current-shape row through the whole-surface renderer', () => {
    // `## What changed` exists only in renderSpecMarkdown. Asserting on it is
    // asserting that exportSpec picked the right renderer for the row's
    // actual shape, not merely that it produced some markdown.
    const out = exportSpec(db, 'devfour')
    expect(out.spec_md).toContain('## What changed')
    expect(out.spec_md).toContain('Added a streak panel TEST.')
    expect(out.spec_md).toContain('`walked_today`')
    // The legacy renderer's own section headings must NOT appear: they are
    // what a wrong-arm export would produce.
    expect(out.spec_md).not.toContain('## Manual logging')
  })

  it('exports a legacy row byte-for-byte as it does today', () => {
    // Pre-unification rows can never be rewritten (`specs` rejects UPDATE),
    // so their export is frozen output. Pinned as exact bytes rather than
    // substrings: a re-pull that produced a spurious diff in a build contract
    // would be a human's problem to untangle, silently, later.
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toBe(`# Eating out and the car fund

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** devtwo
- **Spec version:** v1
- **Confirmed:** 1970-01-01T00:00:01.500Z

## Summary

This is the confirmed one; a later draft came after it but was never confirmed.

## Background

Loudly-fake background, COFFEE PALACE TEST.

## Panels

### 1. Panel one

- **Shows:** Something
- **Why:** A reason
- **Source:** plaid

## Manual logging

_None._

## Open questions

_None._
`)
  })

  it('names the failure instead of crashing when the stored payload is corrupt', () => {
    expect(() => exportSpec(db, 'devthree')).toThrow(SpecShapeError)
    expect(() => exportSpec(db, 'devthree')).toThrow(/spec payload/)
  })
})

/**
 * The CLI wrapper, as a real subprocess — the command pull-spec.sh actually
 * shells out to. This is the load-bearing addition: export-spec.ts used to
 * fall back to platform/dev/synthetic.db when PLATFORM_DB was unset, and
 * that fallback is exactly what would write a friend's spec.md from fake
 * data on the droplet if $STAIRWELL was ever forgotten (pull-spec.sh:53's
 * comment names the same hazard). It now refuses instead; these tests pin
 * that refusal at the process boundary, not just in exportSpec() itself.
 */
describe('scripts/export-spec.ts (CLI)', () => {
  function run(
    args: string[],
    env: Record<string, string | undefined> = {},
  ): { status: number; output: string } {
    // Build the child's env from a CLONE of process.env — never mutate the
    // real process.env, which several tests in this repo do without
    // try/finally and which would leak PLATFORM_DB across files that share a
    // worker if this test ever did the same.
    const childEnv = { ...process.env, ...env }
    if (!('PLATFORM_DB' in env)) delete childEnv.PLATFORM_DB
    try {
      const output = execFileSync('npx', ['tsx', SCRIPT, ...args], {
        cwd: REPO,
        env: childEnv,
        stdio: 'pipe',
        encoding: 'utf8',
      })
      return { status: 0, output }
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string }
      return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
    }
  }

  it('refuses to run when PLATFORM_DB is not set', () => {
    const { status, output } = run(['devtwo'])
    expect(status).not.toBe(0)
    expect(output).toContain('PLATFORM_DB is not set')
  })

  it('refuses even when PLATFORM_DB is an explicit empty string', () => {
    const { status, output } = run(['devtwo'], { PLATFORM_DB: '' })
    expect(status).not.toBe(0)
    expect(output).toContain('PLATFORM_DB is not set')
  })

  it('exports the confirmed spec to stdout as JSON once PLATFORM_DB is set', () => {
    const { status, output } = run(['devtwo'], { PLATFORM_DB: join(dir, 'synthetic.db') })
    expect(status).toBe(0)
    const parsed = JSON.parse(output) as { spec_md: string; mockup_html: string }
    expect(parsed.spec_md).toContain('# Eating out and the car fund')
    expect(parsed.mockup_html).toBe(MOCKUP)
  })
})
