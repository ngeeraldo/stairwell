// tests/scripts/exportSpec.test.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { insertSpec } from '@/lib/db/specs'
import { appendTranscript } from '@/lib/db/appendOnly'
import { SpecShapeError, type SpecVersion } from '@/lib/spec/schema'
import { type LegacySpecPayload } from '@/lib/spec/legacy'
import { parseSpecChangeDraft, sealChange } from '@/lib/spec/change'
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

// A change-only row. Nothing writes this shape yet (Task 5 switches
// authoring over), but the export has to be ready the moment something does
// — same reasoning as CURRENT_PAYLOAD/devfour above, one shape later.
const CHANGE_PAYLOAD = sealChange(
  parseSpecChangeDraft({
    change_summary: 'Added a weekly average TEST.',
    changes: [
      {
        action: 'add',
        target: 'panel',
        name: 'Weekly average TEST',
        description: 'Mean of the last seven logged days TEST.',
      },
    ],
    data_requirements: [],
    open_questions: [],
  }),
  null,
)

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
/**
 * A temp `users/` tree, threaded into exportSpec as its `usersDir`.
 *
 * `notes/v<n>.md` existing is what "this version was BUILT" means
 * (lib/spec/conversation.ts, lib/chat/announce.ts), and it is what decides how
 * far back the conversation slice reaches. The repo's real users/ tree has no
 * notes files at all, so without this every fixture account below would read
 * as "nothing built yet" and every slice would run from the beginning of time
 * — which is the right answer for some of them and would silently hide the
 * boundary for the rest.
 */
let usersDir: string

/** Write a minimal, parseable notes file — presence is all exportSpec reads. */
function markBuilt(slug: string, version: number, at: string): void {
  mkdirSync(join(usersDir, slug, 'notes'), { recursive: true })
  writeFileSync(
    join(usersDir, slug, 'notes', `v${version}.md`),
    `---\nslug: ${slug}\nversion: ${version}\nbuilt_at: ${at}\n---\n\n` +
      '## What shipped\n\nA panel TEST.\n\n## Built differently\n\n' +
      '## Open\n\n## Notes for the next build\n',
  )
}

// Real-scale timestamps for devfive's fixture (module scope so the test
// below can assert against the exact value) — see the comment at their use
// site in beforeAll for why small relative-order integers would not do.
const DEVFIVE_OLDER_AT = Date.UTC(2026, 7, 18)
const DEVFIVE_NEWER_AT = Date.UTC(2026, 7, 19)

// devseven's three specs — v1 built, v2 superseded, v3 the one being pulled.
const DEVSEVEN_V1_AT = Date.UTC(2026, 7, 10)
const DEVSEVEN_V2_AT = Date.UTC(2026, 7, 12)
const DEVSEVEN_V3_AT = Date.UTC(2026, 7, 14)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-export-spec-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  usersDir = join(dir, 'users')
  mkdirSync(usersDir, { recursive: true })

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
  const devsixId = await createAccount(db, {
    slug: 'devsix',
    role: 'user',
    password: 'TEST-DEV-SIX',
  })
  const devsevenId = await createAccount(db, {
    slug: 'devseven',
    role: 'user',
    password: 'TEST-DEV-SEVEN',
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
  // The conversation behind devtwo's only spec. A line-leading '#' on
  // purpose: spec.md neutralises those (lib/spec/render.ts) because it is a
  // designed document; conversation.md must carry them through untouched.
  appendTranscript(db, {
    accountId: devtwoId,
    sessionId: 'sess-devtwo',
    conversationId: 'conv-devtwo',
    promptSha: 'sha-devtwo-0001',
    role: 'user',
    body: '# COFFEE PALACE TEST — what I actually meant',
    at: 900,
  })

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
  // Two conversations, one on either side of devfive's older spec. The export
  // must carry only the SECOND — the conversation behind the version it is
  // exporting, not the account's whole history (lib/spec/conversation.ts).
  for (const row of [
    { body: 'OLD CONVERSATION COFFEE PALACE TEST', at: DEVFIVE_OLDER_AT - 1_000 },
    { body: 'NEW CONVERSATION COFFEE PALACE TEST', at: DEVFIVE_OLDER_AT + 1_000 },
  ]) {
    appendTranscript(db, {
      accountId: devfiveId,
      sessionId: 'sess-devfive',
      conversationId: 'conv-devfive',
      promptSha: 'sha-devfive-0002',
      role: 'user',
      body: row.body,
      at: row.at,
    })
  }

  // devsix: a spec in the change-only shape. Same rationale as devfour above,
  // one shape later — nothing writes this yet, but the export must already
  // know how to render it.
  insertSpec(db, {
    accountId: devsixId,
    conversationId: 'conv-devsix',
    promptSha: 'sha-devsix-0001',
    payload: CHANGE_PAYLOAD,
    mockupHtml: MOCKUP,
    at: 1_000,
  })

  // devseven: the SUPERSEDED case (design §7). Three specs; only v1 was ever
  // built. v2 was authored, never built, and superseded by v3 — which is
  // legitimate now that nothing confirms a spec: a friend can ask for two
  // things on two days and the builder builds the highest.
  //
  // v3's spec.md is a change against current.md, and current.md still
  // describes v1. So the conversation beside it must reach back to v1 too, or
  // what the friend said before v2 is in neither file.
  for (const row of [
    { sha: 'sha-devseven-0001', at: DEVSEVEN_V1_AT },
    { sha: 'sha-devseven-0002', at: DEVSEVEN_V2_AT },
    { sha: 'sha-devseven-0003', at: DEVSEVEN_V3_AT },
  ]) {
    insertSpec(db, {
      accountId: devsevenId,
      conversationId: 'conv-devseven',
      promptSha: row.sha,
      payload: CHANGE_PAYLOAD,
      mockupHtml: '',
      at: row.at,
    })
  }
  for (const row of [
    { body: 'BEFORE THE BUILD COFFEE PALACE TEST', at: DEVSEVEN_V1_AT - 1_000 },
    { body: 'THE WEEKLY AVERAGE COFFEE PALACE TEST', at: DEVSEVEN_V1_AT + 1_000 },
    { body: 'AND DROP THAT PANEL COFFEE PALACE TEST', at: DEVSEVEN_V2_AT + 1_000 },
  ]) {
    appendTranscript(db, {
      accountId: devsevenId,
      sessionId: 'sess-devseven',
      conversationId: 'conv-devseven',
      promptSha: 'sha-devseven-0003',
      role: 'user',
      body: row.body,
      at: row.at,
    })
  }

  // What was actually BUILT, on disk. devfive v1 and devseven v1 shipped;
  // devseven v2 was superseded and deliberately has no notes file.
  markBuilt('devfive', 1, '2026-08-18')
  markBuilt('devseven', 1, '2026-08-18')
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('exportSpec', () => {
  it('renders the current spec', () => {
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('# Eating out and the car fund')
    expect(out.spec_md).toContain('v1')
  })

  it('exports the newest spec, confirmed or not — nothing confirms any more', () => {
    // The newest spec IS the build contract now (lib/db/specs.ts's
    // currentSpec). devfive's older spec has a historical confirmation and
    // its newer one does not — the newer one still wins.
    const out = exportSpec(db, 'devfive', usersDir)
    expect(out.spec_md).toContain('A newer spec on top TEST')
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
    const out = exportSpec(db, 'devfive', usersDir)
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

  it('renders a change-shaped row through the change renderer', () => {
    // '## Changes' exists only in renderChangeMarkdown. Asserting on it is
    // asserting that exportSpec picked the right renderer for the row's
    // actual shape, same check as the devfour case above, one shape later.
    const out = exportSpec(db, 'devsix')
    expect(out.spec_md).toContain('## Changes')
    expect(out.spec_md).toContain('Weekly average TEST')
  })

  it('exports the conversation behind the spec, verbatim', () => {
    const out = exportSpec(db, 'devtwo')
    expect(out.conversation_md).toContain('devtwo')
    expect(out.conversation_md).toContain('## user')
    // Untouched — no escaping, no reflow. See lib/spec/conversation.ts.
    expect(out.conversation_md).toContain('# COFFEE PALACE TEST — what I actually meant')
  })

  it('slices the conversation to the last BUILT version, not the whole history', () => {
    // devfive has two specs and one conversation on either side of the older
    // one, and v1 WAS built (markBuilt in beforeAll). Exporting v2 must carry
    // the second and not the first: a change-only spec is read against what
    // the friend said since the thing current.md describes.
    const out = exportSpec(db, 'devfive', usersDir)
    expect(out.conversation_md).toContain('NEW CONVERSATION COFFEE PALACE TEST')
    expect(out.conversation_md).not.toContain('OLD CONVERSATION COFFEE PALACE TEST')
    expect(out.conversation_md).toContain('v2')
  })

  it('reaches back past a superseded spec to the last version with build notes', () => {
    // devseven: v1 built, v2 authored and superseded (no notes/v2.md), v3 the
    // current one. Slicing on `spec.version - 1` would start at v2 and drop
    // what the friend said about the weekly average — half the conversation
    // v3's spec.md actually covers, in neither file, with nothing on disk
    // saying so. The boundary is the notes file, exactly as it is for
    // lib/chat/announce.ts's announceTarget.
    const out = exportSpec(db, 'devseven', usersDir)
    expect(out.conversation_md).toContain('THE WEEKLY AVERAGE COFFEE PALACE TEST')
    expect(out.conversation_md).toContain('AND DROP THAT PANEL COFFEE PALACE TEST')
    // Still exclusive at the built boundary: what was said BEFORE v1 shipped
    // belongs to v1's own slice.
    expect(out.conversation_md).not.toContain('BEFORE THE BUILD COFFEE PALACE TEST')
    expect(out.conversation_md).toContain('v3')
  })

  it('takes the whole conversation when no version has ever been built', () => {
    // Same account, same three specs, pointed at a users/ tree with no notes
    // files in it: nothing has shipped, so this is a first build and every
    // row belongs to it — including the one before v1.
    const out = exportSpec(db, 'devseven', join(dir, 'no-builds'))
    expect(out.conversation_md).toContain('BEFORE THE BUILD COFFEE PALACE TEST')
    expect(out.conversation_md).toContain('THE WEEKLY AVERAGE COFFEE PALACE TEST')
  })

  it('says so, rather than emitting nothing, when a version has no conversation rows', () => {
    // devfour has a spec and no transcript at all. An empty file with no
    // explanation reads as a failed pull; this reads as "there was nothing".
    const out = exportSpec(db, 'devfour')
    expect(out.conversation_md).toContain('No conversation')
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
    const parsed = JSON.parse(output) as { spec_md: string; conversation_md: string }
    expect(parsed.spec_md).toContain('# Eating out and the car fund')
    // Both halves cross the process boundary — pull-spec.sh pipes this exact
    // JSON into write-spec-pair.ts, which needs both keys.
    expect(parsed.conversation_md).toContain('# COFFEE PALACE TEST — what I actually meant')
  })
})
