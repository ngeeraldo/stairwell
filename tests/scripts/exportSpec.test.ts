// tests/scripts/exportSpec.test.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { insertSpec } from '@/lib/db/specs'
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

// Real-scale timestamps for devfive's fixture (module scope so the test
// below can assert against the exact value) — see the comment at their use
// site in beforeAll for why small relative-order integers would not do.
const DEVFIVE_OLDER_AT = Date.UTC(2026, 7, 18)
const DEVFIVE_NEWER_AT = Date.UTC(2026, 7, 19)

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
  const devfiveId = await createAccount(db, {
    slug: 'devfive',
    role: 'user',
    password: 'TEST-DEV-FIVE',
  })
  // 'ghost' is deliberately never created.

  // devone: an account with no spec at all — nothing was ever authored.
  // currentSpec must find nothing, and exportSpec must refuse loudly rather
  // than crash on a missing row deeper in the pipeline. (No insertSpec call:
  // this is the only account left with zero rows in `specs`.)

  // devtwo: a single spec, with a historical confirmation. Used for the
  // byte-for-byte export test below — one row, unambiguous. Nothing in the
  // application writes spec_confirmations any more (lib/db/specs.ts's
  // confirmSpec is gone); inserted directly, the way tests/db/specs.test.ts's
  // own fixtures now do.
  const devtwoSpecId = insertSpec(db, {
    accountId: devtwoId,
    conversationId: 'conv-devtwo',
    promptSha: 'sha-devtwo-0001',
    payload: payload({
      title: 'Eating out and the car fund',
      summary: 'This is the confirmed one; a later draft came after it but was never confirmed.',
    }),
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  db.prepare(
    'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
  ).run(devtwoSpecId, devtwoId, 1_500)

  // devthree: a spec whose stored payload is corrupt JSON, with a historical
  // confirmation. Task 3 finding: parseLegacySpecPayload throws
  // SpecShapeError on a row like this, and exportSpec must let that
  // propagate as a clear, named failure rather than a generic crash or
  // (worse) a silently empty export.
  const corruptId = insertRawSpec(db, {
    accountId: devthreeId,
    conversationId: 'conv-devthree',
    promptSha: 'sha-devthree-0001',
    payloadText: '{not valid json',
    mockupHtml: MOCKUP,
    at: 1_000,
  })
  db.prepare(
    'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
  ).run(corruptId, devthreeId, 1_500)

  // devfour: a spec in the CURRENT whole-surface shape. Nothing writes this
  // shape yet (Task 10 switches authoring over), but the export has to be
  // ready the moment something does — a build contract that rendered the
  // wrong shape would be discovered by a human reading spec.md after the
  // fact, not by anything that fails loudly. No confirmation needed for this
  // to be exportable any more.
  insertSpec(db, {
    accountId: devfourId,
    conversationId: 'conv-devfour',
    promptSha: 'sha-devfour-0001',
    payload: CURRENT_PAYLOAD,
    mockupHtml: MOCKUP,
    at: 1_000,
  })

  // devfive: an OLDER spec with a historical confirmation, then a NEWER spec
  // on top of it that was never confirmed. currentSpec now picks the NEWEST
  // spec regardless of confirmation (lib/db/specs.ts) — the newest proposal
  // IS the build contract now, so exportSpec must pick the newer one rather
  // than falling back to the historically-confirmed older row.
  //
  // Real-scale timestamps (module-scoped constants above), not this file's
  // usual small relative-order integers: the newer spec has no confirmation,
  // so its exported date falls back to its own `at`
  // (scripts/export-spec.ts's `?? spec.at`), and a small integer like
  // `2_000` renders as an ISO string still inside 1970 — indistinguishable
  // from the epoch-zero date the old `confirmed_at!` assertion would have
  // produced. Only a real-scale `at` makes "the export does not say 1970"
  // mean anything (see the devfive test below).
  insertSpec(db, {
    accountId: devfiveId,
    conversationId: 'conv-devfive',
    promptSha: 'sha-devfive-0001',
    payload: payload({ title: 'An older, once-confirmed spec TEST' }),
    mockupHtml: '<!doctype html><html><body>OLDER MOCKUP TEST</body></html>',
    at: DEVFIVE_OLDER_AT,
  })
  const devfiveOlderId = db
    .prepare('SELECT id FROM specs WHERE account_id = ? ORDER BY id LIMIT 1')
    .get(devfiveId) as { id: number }
  db.prepare(
    'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
  ).run(devfiveOlderId.id, devfiveId, DEVFIVE_OLDER_AT + 500)
  insertSpec(db, {
    accountId: devfiveId,
    conversationId: 'conv-devfive',
    promptSha: 'sha-devfive-0002',
    payload: payload({ title: 'A newer spec on top TEST' }),
    mockupHtml: '<!doctype html><html><body>NEWER MOCKUP TEST</body></html>',
    at: DEVFIVE_NEWER_AT,
  })
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('exportSpec', () => {
  it('renders the current spec and returns its mockup verbatim', () => {
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('# Eating out and the car fund')
    expect(out.spec_md).toContain('v1')
    expect(out.mockup_html).toBe(MOCKUP)
  })

  it('exports the newest spec, confirmed or not — nothing confirms any more', () => {
    // The newest spec IS the build contract now (lib/db/specs.ts's
    // currentSpec). devfive's older spec has a historical confirmation and
    // its newer one does not — the newer one still wins.
    const out = exportSpec(db, 'devfive')
    expect(out.spec_md).toContain('A newer spec on top TEST')
    expect(out.mockup_html).toBe('<!doctype html><html><body>NEWER MOCKUP TEST</body></html>')
    // The older, historically-confirmed spec must not be what gets exported
    // once something newer exists.
    expect(out.spec_md).not.toContain('An older, once-confirmed spec TEST')
  })

  it('falls back to the spec\'s own timestamp, never 1970, when the current spec has no confirmation', () => {
    // devfive's newer spec (see beforeAll) has confirmed_at: null — a bare
    // `spec.confirmed_at!` would render `new Date(null)`, the silent
    // 1970-01-01 bug this pins against. DEVFIVE_NEWER_AT is a real-scale
    // timestamp specifically so this assertion means something: a small
    // relative-order integer like this file's other fixtures use would
    // ALSO render inside 1970, correctly-fixed or not.
    const out = exportSpec(db, 'devfive')
    expect(out.spec_md).not.toContain('1970')
    expect(out.spec_md).toContain(new Date(DEVFIVE_NEWER_AT).toISOString())
  })

  it('refuses an account with no spec at all, naming why', () => {
    expect(() => exportSpec(db, 'devone')).toThrow(/no spec/)
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

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** devtwo
- **Spec version:** v1
- **Version date:** 1970-01-01T00:00:01.500Z

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

  it('exports the current spec to stdout as JSON once PLATFORM_DB is set', () => {
    const { status, output } = run(['devtwo'], { PLATFORM_DB: join(dir, 'synthetic.db') })
    expect(status).toBe(0)
    const parsed = JSON.parse(output) as { spec_md: string; mockup_html: string }
    expect(parsed.spec_md).toContain('# Eating out and the car fund')
    expect(parsed.mockup_html).toBe(MOCKUP)
  })
})
