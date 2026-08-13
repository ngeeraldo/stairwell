# Unified Proposal Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interview/tweak distinction with a single loop in which every request — first interview or one-word relabel — produces a schema-validated, whole-surface spec version that the friend confirms before anything is built.

**Architecture:** The `specs.payload` TEXT column already holds a validated structured payload (ledger R2), so nothing about the storage changes. What changes is the JSON shape inside it: a `SpecVersion` with stable-id screens and panels, per-value sourcing, and a `change_summary`. Rows written before this change are read as `legacy` forever, because `specs` rejects UPDATE (ledger D4). `propose_spec` stays signal-only; the authoring call gains the current confirmed version as input, a one-shot validation-retry gate, and a second call that renders the mockup from the *validated* payload.

**Tech Stack:** Next.js App Router, TypeScript (strict, `noUncheckedIndexedAccess`), better-sqlite3-multiple-ciphers, `@anthropic-ai/sdk` (`claude-opus-5`, structured outputs via `output_config.format`), vitest. **No new dependencies** — validators are hand-written (ledger D5).

**Spec:** `docs/superpowers/specs/2026-08-13-unified-proposal-loop/` — three files: `01-agent-system-prompt-v2.md`, `02-system-structure-changes.md`, `03-spec-schema.md`. Read all three plus `docs/superpowers/ledgers/unified-loop.md` before Task 1; the ledger records fourteen rulings this plan depends on and every §7 resolution.

## Global Constraints

- **`specs` and `spec_confirmations` are append-only** and deliberately outside `lib/db/reshape.ts`. This change adds **no column to either**. Any task that thinks it needs one has misread the plan.
- **No new npm dependencies.** Not zod, not ajv, not a diff library.
- **Every model call that returns writes a metrics row carrying its real usage.** A cost log reporting zero for a billed turn is fiction (step-4 ledger). Retry attempts each write their own row.
- **Nothing is written to `transcripts` that the friend did not say**, except the deploy announcement and operator question of Task 12, which are stamped `prompt_sha: 'operator'` so they are forever distinguishable from model output.
- **Prompt files are never edited, only added** (`lib/chat/prompt.ts:8`); `prompt_sha` is a content hash stamped on existing rows.
- **`SPEC_JSON_SCHEMA` may only use the supported structured-output subset:** object/array/string/integer/number/boolean/null, `enum`, `const`, `anyOf`, `$ref`/`$defs`, and `additionalProperties: false` on every object. **`minItems`/`minLength`/`maxLength` are NOT supported** — every "min 1" rule in `03-spec-schema.md` is enforced by the hand-written validator, never by the JSON Schema.
- **Test with `npx vitest run`.** Scope with a path. Gate B (pre-commit) needs a staged file under `tests/` for `app|lib|platform|middleware.ts` changes and under `users/<name>/tests/` for that user's folder. `platform/prompts/*` is Gate-B exempt by an explicit arm in `.githooks/pre-commit`.
- **The whole-branch red-test control is standing practice** (step-4 ledger): for every guard a test claims to cover, delete the guarded code, confirm **exactly that one test** goes red, and restore. A test nobody has watched fail is not evidence.
- Behavior-preserving requirement: **the first-ever conversation must be experientially identical.** Ledger R3 names the three things that hold it — retained `title`/`summary`, an explicit empty-spec input, and the unchanged `DELIVERY_FIRST` wording.

---

## File Structure

**New**

| Path | Responsibility |
|---|---|
| `lib/spec/schema.ts` | *(rewritten)* `SpecVersion` types, `SpecShapeError`, `SPEC_JSON_SCHEMA`, `MOCKUP_JSON_SCHEMA`. Types and request contracts only — no parsing. |
| `lib/spec/validate.ts` | `parseSpecDraft`, `sealVersion`, `parseSpecVersion`, `parseMockupInput`, and the cross-field invariants. |
| `lib/spec/legacy.ts` | The six-field payload type and its parser, moved verbatim from today's `schema.ts`. Frozen — nothing new is ever added here. |
| `lib/spec/stored.ts` | `readStoredSpec(json)` → tagged union. The one place any consumer discriminates legacy from current. |
| `lib/spec/diff.ts` | `diffVersions(prev, next)` — screens/panels added, removed, changed, by id. |
| `lib/chat/announce.ts` | Appends an operator-authored assistant transcript row. |
| `platform/prompts/agent-v3.md` | File 01 verbatim. |
| `platform/prompts/spec-v2.md` | The whole-surface field contract, id-stability rules, "given the current version". |
| `platform/prompts/mockup-v1.md` | Mockup rules, lifted from `spec-v1.md`'s mockup section, consuming a validated payload. |
| `scripts/announce-deploy.ts` | Droplet CLI: post the confirmed version's `change_summary` into chat, once per spec. |
| `scripts/ask-user.ts` | Droplet CLI: post a mid-build blocker question into chat. |

**Modified**

| Path | Change |
|---|---|
| `lib/spec/render.ts` | `renderSpecMarkdown` rewritten for `SpecVersion`; today's renderer kept as `renderLegacyMarkdown`. |
| `lib/chat/prompt.ts` | `AGENT_PROMPT = 'agent-v3.md'`, `SPEC_PROMPT = 'spec-v2.md'`, new `MOCKUP_PROMPT`. |
| `lib/chat/client.ts` | `PROPOSE_TOOL.description` reworded; `propose()` takes a `schema` parameter. |
| `lib/spec/author.ts` | Current-version input, retry gate, mockup call, `based_on_version` sealing. |
| `lib/db/specs.ts` | Add `specByVersion`. |
| `lib/chat/context.ts` | Comment rewritten (ledger D11). Values unchanged. |
| `app/[user]/page.tsx` | Read via `readStoredSpec`; pass `first` to the panel. |
| `app/[user]/ChatPanel.tsx` | Card leads with `change_summary`; renders screens; two delivery constants; legacy arm. |
| `app/admin/[user]/page.tsx` | Renders both arms; shows the structural diff; badges legacy rows. |
| `app/api/spec/confirm/route.ts` | `spec_confirmed` metric gains diff counts. |
| `scripts/export-spec.ts` | Renders whichever arm the stored row is. |
| `platform/templates/dashboard/tests/dashboard.test.ts.tmpl` | Gains a write-path test stub. |
| `architecture-overview.md` | The six §6 edits. |
| `CLAUDE.md` | Spec-flow conventions, entry-widget rule, per-user write-path tests. |

---

## Task 1: Spec version types and the request contracts

**Files:**
- Modify: `lib/spec/schema.ts` (full rewrite)
- Create: `lib/spec/legacy.ts`
- Test: `tests/spec/schema.test.ts` (rewrite), `tests/spec/legacy.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `SpecShapeError`, `SPEC_JSON_SCHEMA`, `MOCKUP_JSON_SCHEMA`, and types `SpecVersion`, `SpecDraft`, `Screen`, `Panel`, `ValueSpec`, `EntryWidget`, `EntryField`, `DataRequirement`, `VALUE_KINDS`, `FIELD_TYPES`, `REQUIREMENT_STATUSES`. From `legacy.ts`: `LegacySpecPayload`, `LegacyPanel`, `LEGACY_PANEL_SOURCES`, `parseLegacySpecPayload`.

Nothing imports the new types yet — the tree stays green because `legacy.ts` holds the old parser and the old import sites are repointed in this same task.

- [ ] **Step 1: Move the current six-field implementation into `lib/spec/legacy.ts`**

Copy today's `lib/spec/schema.ts` into `lib/spec/legacy.ts` **in full — nothing is deleted** — and rename as it lands:
`PANEL_SOURCES` → `LEGACY_PANEL_SOURCES`, `Panel` → `LegacyPanel`, `SpecPayload` → `LegacySpecPayload`, `parseSpecPayload` → `parseLegacySpecPayload`, `SPEC_JSON_SCHEMA` → `LEGACY_SPEC_JSON_SCHEMA`, `SpecInput` → `LegacySpecInput`, `parseSpecInput` → `parseLegacySpecInput`. Import `SpecShapeError` from `./schema`. Head the file:

```ts
// lib/spec/legacy.ts
//
// FROZEN. The six-field payload shape that `specs` rows written before the
// unified proposal loop hold, and the reader for them.
//
// specs rejects UPDATE (platform/schema.sql), so those rows can never be
// rewritten into the current shape — see the unified-loop ledger, D4. This
// file therefore has no future: nothing new is ever added here. It exists so
// old rows keep rendering.
//
// The three AUTHORING exports — LEGACY_SPEC_JSON_SCHEMA, LegacySpecInput,
// parseLegacySpecInput — are here only so the branch keeps working on the old
// shape until Task 10 switches the authoring path over. Task 10 deletes them.
// Nothing may author this shape after that.
```

**Repoint five import sites, not four** — `parseSpecInput`/`SPEC_JSON_SCHEMA` have call sites too, and missing them is what would stop the branch compiling at the end of this task:

| File | Was | Now |
|---|---|---|
| `app/[user]/page.tsx` | `parseSpecPayload` | `parseLegacySpecPayload` |
| `app/admin/[user]/page.tsx` | `parseSpecPayload`, `SpecPayload` | `parseLegacySpecPayload`, `LegacySpecPayload` |
| `scripts/export-spec.ts` | `parseSpecPayload` | `parseLegacySpecPayload` |
| `lib/spec/author.ts` | `parseSpecInput`, `SpecPayload` | `parseLegacySpecInput`, `LegacySpecPayload` |
| `lib/chat/client.ts` | `SPEC_JSON_SCHEMA` | `LEGACY_SPEC_JSON_SCHEMA` |

All from `@/lib/spec/legacy`. This keeps every commit between here and Task 10 **actually working end to end on the old shape**, not merely typechecking — `tests/spec/author.test.ts` drives a fake client, so a request contract that disagreed with the parser would pass the suite and fail only against the real API.

Move today's `parseSpecPayload` describe-block out of `tests/spec/schema.test.ts` into a new `tests/spec/legacy.test.ts`, unchanged except for the renames.

- [ ] **Step 2: Write the failing test for the new types and schemas**

`tests/spec/schema.test.ts` (new content):

```ts
import { describe, expect, it } from 'vitest'
import { MOCKUP_JSON_SCHEMA, SPEC_JSON_SCHEMA } from '@/lib/spec/schema'

/** Walk every object node in a JSON Schema, including inside anyOf. */
function objectNodes(node: unknown, out: Record<string, unknown>[] = []) {
  if (typeof node !== 'object' || node === null) return out
  const n = node as Record<string, unknown>
  if (n.type === 'object') out.push(n)
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) value.forEach((v) => objectNodes(v, out))
    else objectNodes(value, out)
  }
  return out
}

describe('SPEC_JSON_SCHEMA', () => {
  it('asks the model for exactly the model-authored fields', () => {
    // based_on_version is server-supplied and must NOT be here (ledger D2):
    // a model-authored lineage pointer becomes a permanent wrong row.
    // mockup_html is a separate call now (ledger D7).
    expect([...SPEC_JSON_SCHEMA.required].sort()).toEqual([
      'background',
      'change_summary',
      'data_requirements',
      'open_questions',
      'screens',
      'summary',
      'title',
    ])
    expect(Object.keys(SPEC_JSON_SCHEMA.properties).sort()).toEqual(
      [...SPEC_JSON_SCHEMA.required].sort(),
    )
  })

  it('sets additionalProperties false on every object node', () => {
    const nodes = objectNodes(SPEC_JSON_SCHEMA)
    expect(nodes.length).toBeGreaterThan(4)
    for (const node of nodes) expect(node.additionalProperties).toBe(false)
  })

  it('uses no constraint keyword outside the supported subset', () => {
    // minItems/minLength/maxLength are NOT in the structured-output subset.
    // A "min 1" rule that lives here would be silently ignored; every one of
    // them belongs in lib/spec/validate.ts instead.
    const json = JSON.stringify(SPEC_JSON_SCHEMA)
    for (const banned of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']) {
      expect(json).not.toContain(banned)
    }
  })

  it('discriminates value kinds with a const, not a bare enum', () => {
    const values = SPEC_JSON_SCHEMA.properties.screens.items.properties.panels
      .items.properties.values
    expect(values.items.anyOf.map((v: { properties: { kind: { const: string } } }) =>
      v.properties.kind.const)).toEqual(['synced', 'entered', 'derived'])
  })
})

describe('MOCKUP_JSON_SCHEMA', () => {
  it('asks for one field and nothing else', () => {
    expect([...MOCKUP_JSON_SCHEMA.required]).toEqual(['mockup_html'])
    expect(MOCKUP_JSON_SCHEMA.additionalProperties).toBe(false)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/spec`
Expected: FAIL — `lib/spec/schema.ts` exports no `MOCKUP_JSON_SCHEMA` and `SPEC_JSON_SCHEMA` still has the old fields.

- [ ] **Step 4: Write `lib/spec/schema.ts`**

```ts
// lib/spec/schema.ts
//
// The shape of one spec VERSION: a whole-surface description of a person's
// dashboard, as it would be after the change being proposed.
//
// Two things are deliberately absent from what the model is asked for:
//
//   version           — derived from row position (lib/db/specs.ts), never
//                       stored, so it can neither drift nor race.
//   based_on_version  — supplied by the server from the current confirmed
//                       version at authoring time. A model-authored lineage
//                       pointer is a hallucination that becomes a permanent
//                       row in an append-only table. See ledger D2.
//
// title/summary/background are RETAINED from the pre-unification shape: each
// has live consumers (spec.md's H1, the preview card, the admin pane) and the
// spec doc is silent about them, so existing conventions stand. See ledger D1.

export const VALUE_KINDS = ['synced', 'entered', 'derived'] as const
export type ValueKind = (typeof VALUE_KINDS)[number]

export const FIELD_TYPES = ['number', 'text', 'boolean', 'date', 'choice'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const REQUIREMENT_STATUSES = ['new', 'changed', 'unchanged'] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

/**
 * `id` is NOT in 03-spec-schema.md's ValueSpec, and is added deliberately.
 * That doc's own Rules section demands two invariants — a derived value's
 * `inputs` must reference values that exist, and `annotates` must point at a
 * synced value — and neither is checkable without an identifier on values.
 * It describes `inputs` as "ids/descriptions", which concedes ids exist
 * without giving them anywhere to live. Resolving an underspecification.
 */
export type ValueSpec =
  | { kind: 'synced'; id: string; module: string; description: string }
  | { kind: 'entered'; id: string; description: string }
  | { kind: 'derived'; id: string; description: string; inputs: string[] }

export type EntryField = { name: string; type: FieldType; choices: string[] }

export type EntryWidget = {
  description: string
  fields: EntryField[]
  /** A synced value id this widget annotates, or null when it stands alone. */
  annotates: string | null
}

export type Panel = {
  id: string
  title: string
  intent: string
  display: string
  context_of_use: string | null
  values: ValueSpec[]
  entry: EntryWidget | null
}

export type Screen = { id: string; title: string; order: number; panels: Panel[] }

export type DataRequirement = {
  table: string
  purpose: string
  status: RequirementStatus
}

/** What the model authors. */
export type SpecDraft = {
  title: string
  summary: string
  background: string
  change_summary: string
  screens: Screen[]
  data_requirements: DataRequirement[]
  open_questions: string[]
}

/** What gets stored: the draft plus the server-supplied lineage pointer. */
export type SpecVersion = SpecDraft & { based_on_version: number | null }

export class SpecShapeError extends Error {
  constructor(message: string) {
    super(`spec payload: ${message}`)
    this.name = 'SpecShapeError'
  }
}

const str = { type: 'string' } as const
const strList = { type: 'array', items: str } as const

/**
 * Every optional field in 03-spec-schema.md is REQUIRED-AND-NULLABLE here
 * instead. Structured outputs constrain the response, and a field the model
 * may silently omit is a field it will silently omit; an explicit null is a
 * decision, an absent key is an accident.
 *
 * No minItems anywhere: it is outside the supported structured-output subset
 * and would be ignored. "At least one screen" lives in lib/spec/validate.ts.
 */
const VALUE_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'synced' },
        id: str,
        module: str,
        description: str,
      },
      required: ['kind', 'id', 'module', 'description'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { const: 'entered' }, id: str, description: str },
      required: ['kind', 'id', 'description'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'derived' },
        id: str,
        description: str,
        inputs: strList,
      },
      required: ['kind', 'id', 'description', 'inputs'],
    },
  ],
} as const

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: str,
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: str,
          type: { type: 'string', enum: FIELD_TYPES },
          choices: strList,
        },
        required: ['name', 'type', 'choices'],
      },
    },
    annotates: { type: ['string', 'null'] },
  },
  required: ['description', 'fields', 'annotates'],
} as const

const PANEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: str,
    title: str,
    intent: str,
    display: str,
    context_of_use: { type: ['string', 'null'] },
    values: { type: 'array', items: VALUE_SCHEMA },
    entry: { anyOf: [ENTRY_SCHEMA, { type: 'null' }] },
  },
  required: ['id', 'title', 'intent', 'display', 'context_of_use', 'values', 'entry'],
} as const

export const SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: str,
    summary: str,
    background: str,
    change_summary: str,
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: str,
          title: str,
          order: { type: 'integer' },
          panels: { type: 'array', items: PANEL_SCHEMA },
        },
        required: ['id', 'title', 'order', 'panels'],
      },
    },
    data_requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: str,
          purpose: str,
          status: { type: 'string', enum: REQUIREMENT_STATUSES },
        },
        required: ['table', 'purpose', 'status'],
      },
    },
    open_questions: strList,
  },
  required: [
    'title',
    'summary',
    'background',
    'change_summary',
    'screens',
    'data_requirements',
    'open_questions',
  ],
} as const

/**
 * The mockup call's contract. One field, so the reply cannot arrive wrapped
 * in prose or a markdown fence — the friend's preview is an iframe srcDoc and
 * a stray ``` would render as text inside their dashboard.
 */
export const MOCKUP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { mockup_html: { type: 'string' } },
  required: ['mockup_html'],
} as const
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/spec && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Red-test control**

Change `additionalProperties: false` to `true` on `PANEL_SCHEMA` only. Run `npx vitest run tests/spec/schema.test.ts` — exactly the "sets additionalProperties false" test goes red. Restore. Then add `minItems: 1` to the `screens` array; exactly the supported-subset test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add lib/spec/schema.ts lib/spec/legacy.ts lib/spec/author.ts lib/chat/client.ts \
  tests/spec/schema.test.ts tests/spec/legacy.test.ts \
  app/\[user\]/page.tsx app/admin/\[user\]/page.tsx scripts/export-spec.ts
git commit -m "Describe a whole dashboard, not one conversation's worth of panels"
```

---

## Task 2: The validator and the invariants

**Files:**
- Create: `lib/spec/validate.ts`
- Test: `tests/spec/validate.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `parseSpecDraft(raw: unknown): SpecDraft` — validates model output; throws `SpecShapeError`.
  - `sealVersion(draft: SpecDraft, basedOnVersion: number | null): SpecVersion`
  - `parseSpecVersion(json: string): SpecVersion` — re-validates a stored row.
  - `parseMockupInput(raw: unknown): string`

- [ ] **Step 1: Write the failing tests**

`tests/spec/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import {
  parseMockupInput,
  parseSpecDraft,
  parseSpecVersion,
  sealVersion,
} from '@/lib/spec/validate'

function panel(over: Record<string, unknown> = {}) {
  return {
    id: 'walked_today',
    title: 'Walked today?',
    intent: 'Did I walk the dog today?',
    display: 'A big yes/no with a tap-to-mark control.',
    context_of_use: 'Phone, in bed, before getting up.',
    values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
    entry: {
      description: 'One tap.',
      fields: [{ name: 'walked', type: 'boolean', choices: [] }],
      annotates: null,
    },
    ...over,
  }
}

function draft(over: Record<string, unknown> = {}) {
  return {
    title: 'Did I walk the dog today?',
    summary: 'A one-tap daily tracker.',
    background: 'Pivoted from a weather idea.',
    change_summary: 'The whole dashboard: one tap, a streak, a 30-day rate.',
    screens: [{ id: 'today', title: 'Today', order: 1, panels: [panel()] }],
    data_requirements: [{ table: 'walks', purpose: 'One row per day walked.', status: 'new' }],
    open_questions: [],
    ...over,
  }
}

const screensWith = (...panels: unknown[]) => ({
  screens: [{ id: 'today', title: 'Today', order: 1, panels }],
})

/** Absence, not null — the two are different failures and both are tested. */
const omit = (o: Record<string, unknown>, key: string) => {
  const copy = { ...o }
  delete copy[key]
  return copy
}

describe('parseSpecDraft', () => {
  it('accepts a well-formed draft', () => {
    const parsed = parseSpecDraft(draft())
    expect(parsed.screens[0]!.panels[0]!.id).toBe('walked_today')
    expect(parsed.screens[0]!.panels[0]!.values[0]!.kind).toBe('entered')
  })

  it('trims strings and drops blank list entries', () => {
    const parsed = parseSpecDraft(draft({ title: '  Spaced  ', open_questions: ['a', '  ', 'b'] }))
    expect(parsed.title).toBe('Spaced')
    expect(parsed.open_questions).toEqual(['a', 'b'])
  })

  it('rejects a draft carrying based_on_version', () => {
    // The server supplies it. A model-authored one is a permanent wrong row.
    expect(() => parseSpecDraft(draft({ based_on_version: 3 }))).toThrow(SpecShapeError)
  })

  it.each([
    ['a non-object', 42],
    ['zero screens', draft({ screens: [] })],
    ['a screen with zero panels', draft({ screens: [{ id: 'a', title: 'A', order: 1, panels: [] }] })],
    ['a panel with zero values', draft(screensWith(panel({ values: [] })))],
    ['an unknown value kind', draft(screensWith(panel({ values: [{ kind: 'psychic', id: 'x', description: 'y' }] })))],
    ['a blank id', draft(screensWith(panel({ id: '  ' })))],
    ['an id with a space', draft(screensWith(panel({ id: 'walked today' })))],
    ['an id with a capital', draft(screensWith(panel({ id: 'Walked' })))],
    ['a bad entry field type', draft(screensWith(panel({ entry: { description: 'd', fields: [{ name: 'n', type: 'blob', choices: [] }], annotates: null } })))],
    ['a bad requirement status', draft({ data_requirements: [{ table: 't', purpose: 'p', status: 'maybe' }] })],
    ['an absent entry key', draft(screensWith(omit(panel(), 'entry')))],
    ['an absent context_of_use key', draft(screensWith(omit(panel(), 'context_of_use')))],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSpecDraft(raw)).toThrow(SpecShapeError)
  })

  it('rejects duplicate panel ids across different screens', () => {
    expect(() =>
      parseSpecDraft(
        draft({
          screens: [
            { id: 'a', title: 'A', order: 1, panels: [panel()] },
            { id: 'b', title: 'B', order: 2, panels: [panel()] },
          ],
        }),
      ),
    ).toThrow(/duplicate panel id/)
  })

  it('rejects duplicate value ids across different panels', () => {
    expect(() =>
      parseSpecDraft(draft(screensWith(panel(), panel({ id: 'other' })))),
    ).toThrow(/duplicate value id/)
  })

  it('rejects a derived input naming a value that does not exist', () => {
    const derived = panel({
      id: 'streak',
      values: [{ kind: 'derived', id: 'streak_days', description: 'Consecutive days.', inputs: ['nope'] }],
      entry: null,
    })
    expect(() => parseSpecDraft(draft(screensWith(panel(), derived)))).toThrow(/unknown value/)
  })

  it('accepts a derived input naming a value in another panel', () => {
    const derived = panel({
      id: 'streak',
      values: [{ kind: 'derived', id: 'streak_days', description: 'Consecutive days.', inputs: ['walk_flag'] }],
      entry: null,
    })
    expect(() => parseSpecDraft(draft(screensWith(panel(), derived)))).not.toThrow()
  })

  it('rejects annotates pointing at a non-synced value', () => {
    // walk_flag is `entered`. Annotation only makes sense against synced rows.
    expect(() =>
      parseSpecDraft(draft(screensWith(panel({ entry: { description: 'd', fields: [], annotates: 'walk_flag' } })))),
    ).toThrow(/annotates/)
  })

  it('accepts annotates pointing at a synced value', () => {
    const synced = panel({
      id: 'eating_out',
      values: [{ kind: 'synced', id: 'eating_out_txns', module: 'plaid', description: 'Restaurant transactions.' }],
      entry: { description: 'Tag a meal.', fields: [{ name: 'tag', type: 'text', choices: [] }], annotates: 'eating_out_txns' },
    })
    expect(() => parseSpecDraft(draft(screensWith(synced)))).not.toThrow()
  })
})

describe('sealVersion', () => {
  it('attaches the server-supplied lineage pointer', () => {
    expect(sealVersion(parseSpecDraft(draft()), 4).based_on_version).toBe(4)
    expect(sealVersion(parseSpecDraft(draft()), null).based_on_version).toBeNull()
  })
})

describe('parseSpecVersion', () => {
  it('round-trips a sealed version', () => {
    const sealed = sealVersion(parseSpecDraft(draft()), 2)
    expect(parseSpecVersion(JSON.stringify(sealed)).based_on_version).toBe(2)
  })

  it('rejects a stored row with no based_on_version key', () => {
    expect(() => parseSpecVersion(JSON.stringify(draft()))).toThrow(SpecShapeError)
  })

  it('throws SpecShapeError on malformed JSON', () => {
    expect(() => parseSpecVersion('{"title": "broken')).toThrow(SpecShapeError)
  })
})

describe('parseMockupInput', () => {
  it('returns the html', () => {
    expect(parseMockupInput({ mockup_html: '<!doctype html><p>COFFEE PALACE TEST</p>' })).toContain('TEST')
  })

  it('rejects an empty mockup', () => {
    expect(() => parseMockupInput({ mockup_html: '   ' })).toThrow(SpecShapeError)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/validate.test.ts`
Expected: FAIL — `lib/spec/validate.ts` does not exist.

- [ ] **Step 3: Write `lib/spec/validate.ts`**

```ts
// lib/spec/validate.ts
//
// A schema-constrained REQUEST is not a guarantee about the row that reaches
// an append-only table. This module is the last gate, and its error messages
// are fed back to the model on the retry attempt (lib/spec/author.ts) — so
// they name the exact path that failed, not just the fact of failure.
import {
  FIELD_TYPES,
  REQUIREMENT_STATUSES,
  SpecShapeError,
  VALUE_KINDS,
  type DataRequirement,
  type EntryField,
  type EntryWidget,
  type Panel,
  type Screen,
  type SpecDraft,
  type SpecVersion,
  type ValueSpec,
} from './schema'

/** Stable ids are the whole basis of diffing, so their shape is pinned. */
const ID = /^[a-z0-9]+(_[a-z0-9]+)*$/

function record(raw: unknown, at: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecShapeError(`${at} is not an object`)
  }
  return raw as Record<string, unknown>
}

function text(src: Record<string, unknown>, key: string, at: string): string {
  const value = src[key]
  if (typeof value !== 'string') throw new SpecShapeError(`${at}.${key} is not a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new SpecShapeError(`${at}.${key} is empty`)
  return trimmed
}

/** Required-and-nullable: the key must be present, the value may be null. */
function nullableText(src: Record<string, unknown>, key: string, at: string): string | null {
  if (!(key in src)) throw new SpecShapeError(`${at}.${key} is missing (use null if it does not apply)`)
  if (src[key] === null) return null
  return text(src, key, at)
}

function id(src: Record<string, unknown>, at: string): string {
  const value = text(src, 'id', at)
  if (!ID.test(value)) {
    throw new SpecShapeError(
      `${at}.id "${value}" is not a slug (lowercase letters, digits, single underscores)`,
    )
  }
  return value
}

function textList(src: Record<string, unknown>, key: string, at: string): string[] {
  const value = src[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${at}.${key} is not an array`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new SpecShapeError(`${at}.${key} contains a non-string entry`)
    const trimmed = entry.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

function oneOf<T extends string>(value: string, allowed: readonly T[], at: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SpecShapeError(`${at} is not one of ${allowed.join(', ')}`)
  }
  return value as T
}

function nonEmptyArray(src: Record<string, unknown>, key: string, at: string): unknown[] {
  const value = src[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${at}.${key} is not an array`)
  // Enforced HERE, not in SPEC_JSON_SCHEMA: minItems is outside the supported
  // structured-output subset and would be silently ignored there.
  if (value.length === 0) throw new SpecShapeError(`${at}.${key} is empty`)
  return value
}

function valueSpec(raw: unknown, at: string): ValueSpec {
  const src = record(raw, at)
  const kind = oneOf(text(src, 'kind', at), VALUE_KINDS, `${at}.kind`)
  const base = { id: id(src, at), description: text(src, 'description', at) }
  if (kind === 'synced') return { kind, ...base, module: text(src, 'module', at) }
  if (kind === 'entered') return { kind, ...base }
  return { kind, ...base, inputs: textList(src, 'inputs', at) }
}

function entryField(raw: unknown, at: string): EntryField {
  const src = record(raw, at)
  return {
    name: text(src, 'name', at),
    type: oneOf(text(src, 'type', at), FIELD_TYPES, `${at}.type`),
    choices: textList(src, 'choices', at),
  }
}

function entryWidget(raw: unknown, at: string): EntryWidget {
  const src = record(raw, at)
  const value = src.annotates
  if (!('annotates' in src)) {
    throw new SpecShapeError(`${at}.annotates is missing (use null if it does not apply)`)
  }
  if (value !== null && typeof value !== 'string') {
    throw new SpecShapeError(`${at}.annotates is neither a string nor null`)
  }
  return {
    description: text(src, 'description', at),
    fields: (Array.isArray(src.fields) ? src.fields : []).map((f, i) =>
      entryField(f, `${at}.fields[${i}]`),
    ),
    annotates: value === null ? null : value.trim() || null,
  }
}

function panel(raw: unknown, at: string): Panel {
  const src = record(raw, at)
  return {
    id: id(src, at),
    title: text(src, 'title', at),
    intent: text(src, 'intent', at),
    display: text(src, 'display', at),
    context_of_use: nullableText(src, 'context_of_use', at),
    values: nonEmptyArray(src, 'values', at).map((v, i) => valueSpec(v, `${at}.values[${i}]`)),
    // Presence is required, like context_of_use and annotates. A silently
    // absent `entry` reads as "no entry widget" — which is a panel that
    // quietly cannot be fed, on a dashboard whose whole point was logging.
    // An explicit null is a decision; a missing key is an accident.
    entry: entryOrNull(src, at),
  }
}

function entryOrNull(src: Record<string, unknown>, at: string): EntryWidget | null {
  if (!('entry' in src)) {
    throw new SpecShapeError(`${at}.entry is missing (use null if the panel takes no input)`)
  }
  return src.entry === null ? null : entryWidget(src.entry, `${at}.entry`)
}

function screen(raw: unknown, at: string): Screen {
  const src = record(raw, at)
  const order = src.order
  if (typeof order !== 'number' || !Number.isInteger(order)) {
    throw new SpecShapeError(`${at}.order is not an integer`)
  }
  return {
    id: id(src, at),
    title: text(src, 'title', at),
    order,
    panels: nonEmptyArray(src, 'panels', at).map((p, i) => panel(p, `${at}.panels[${i}]`)),
  }
}

function requirement(raw: unknown, at: string): DataRequirement {
  const src = record(raw, at)
  return {
    table: text(src, 'table', at),
    purpose: text(src, 'purpose', at),
    status: oneOf(text(src, 'status', at), REQUIREMENT_STATUSES, `${at}.status`),
  }
}

/**
 * Cross-field invariants (03-spec-schema.md > Rules). Shape validation cannot
 * express any of these, and every one of them protects the diff: a duplicate
 * id makes "panel X changed" ambiguous forever, in an append-only record.
 */
function checkInvariants(draft: SpecDraft): void {
  const screenIds = new Set<string>()
  const panelIds = new Set<string>()
  const values = new Map<string, ValueSpec>()

  for (const s of draft.screens) {
    if (screenIds.has(s.id)) throw new SpecShapeError(`duplicate screen id "${s.id}"`)
    screenIds.add(s.id)
    for (const p of s.panels) {
      if (panelIds.has(p.id)) throw new SpecShapeError(`duplicate panel id "${p.id}"`)
      panelIds.add(p.id)
      for (const v of p.values) {
        if (values.has(v.id)) throw new SpecShapeError(`duplicate value id "${v.id}"`)
        values.set(v.id, v)
      }
    }
  }

  for (const s of draft.screens) {
    for (const p of s.panels) {
      for (const v of p.values) {
        if (v.kind !== 'derived') continue
        for (const input of v.inputs) {
          if (!values.has(input)) {
            throw new SpecShapeError(
              `derived value "${v.id}" lists input "${input}", which is not a value in this version`,
            )
          }
        }
      }
      const annotates = p.entry?.annotates
      if (annotates === undefined || annotates === null) continue
      const target = values.get(annotates)
      if (!target) {
        throw new SpecShapeError(`panel "${p.id}" annotates "${annotates}", which is not a value in this version`)
      }
      if (target.kind !== 'synced') {
        throw new SpecShapeError(
          `panel "${p.id}" annotates "${annotates}", which is ${target.kind}, not synced — ` +
            `annotation labels synced rows`,
        )
      }
    }
  }
}

function draftFrom(src: Record<string, unknown>): SpecDraft {
  const parsed: SpecDraft = {
    title: text(src, 'title', 'spec'),
    summary: text(src, 'summary', 'spec'),
    background: text(src, 'background', 'spec'),
    change_summary: text(src, 'change_summary', 'spec'),
    screens: nonEmptyArray(src, 'screens', 'spec').map((s, i) => screen(s, `screens[${i}]`)),
    data_requirements: (Array.isArray(src.data_requirements) ? src.data_requirements : []).map(
      (r, i) => requirement(r, `data_requirements[${i}]`),
    ),
    open_questions: textList(src, 'open_questions', 'spec'),
  }
  checkInvariants(parsed)
  return parsed
}

/** Validate MODEL output. Rejects a model-authored based_on_version outright. */
export function parseSpecDraft(raw: unknown): SpecDraft {
  const src = record(raw, 'spec')
  if ('based_on_version' in src) {
    throw new SpecShapeError('based_on_version is supplied by the server and must not be authored')
  }
  return draftFrom(src)
}

/** Attach the lineage pointer. The only place a SpecVersion is constructed. */
export function sealVersion(draft: SpecDraft, basedOnVersion: number | null): SpecVersion {
  return { ...draft, based_on_version: basedOnVersion }
}

/** Re-validate a stored payload on the way out of the database. */
export function parseSpecVersion(json: string): SpecVersion {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }
  const src = record(parsed, 'spec')
  const based = src.based_on_version
  if (based !== null && (typeof based !== 'number' || !Number.isInteger(based))) {
    throw new SpecShapeError('based_on_version is neither an integer nor null')
  }
  return { ...draftFrom(src), based_on_version: based }
}

export function parseMockupInput(raw: unknown): string {
  return text(record(raw, 'mockup'), 'mockup_html', 'mockup')
}
```

- [ ] **Step 4: Run and typecheck**

Run: `npx vitest run tests/spec && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Red-test control on each invariant**

Delete the duplicate-panel-id check → exactly that test reds. Restore. Delete the derived-inputs loop → exactly the unknown-value test reds. Restore. Delete the `target.kind !== 'synced'` branch → exactly the annotates test reds. Restore. Delete the `based_on_version in src` guard in `parseSpecDraft` → exactly that test reds. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/spec/validate.ts tests/spec/validate.test.ts
git commit -m "Refuse a spec whose ids cannot be diffed"
```

---

## Task 3: Reading a stored row that might be either shape

**Files:**
- Create: `lib/spec/stored.ts`
- Test: `tests/spec/stored.test.ts`

**Interfaces:**
- Consumes: `parseSpecVersion`, `parseLegacySpecPayload`, `SpecShapeError`.
- Produces: `type StoredSpec = { kind: 'version'; version: SpecVersion } | { kind: 'legacy'; payload: LegacySpecPayload }` and `readStoredSpec(json: string): StoredSpec`.

- [ ] **Step 1: Write the failing test**

`tests/spec/stored.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import { readStoredSpec } from '@/lib/spec/stored'

const LEGACY = JSON.stringify({
  title: 'Did I walk the dog today?',
  summary: 'A one-tap tracker.',
  background: 'Pivoted from weather.',
  panels: [{ name: 'Walked today?', shows: 'Yes/no', why: 'They asked', source: 'manual' }],
  manual_logging: ['One tap per day.'],
  open_questions: [],
})

const CURRENT = JSON.stringify({
  title: 'Did I walk the dog today?',
  summary: 'A one-tap tracker.',
  background: 'Pivoted from weather.',
  change_summary: 'Added a streak.',
  based_on_version: 1,
  screens: [
    {
      id: 'today',
      title: 'Today',
      order: 1,
      panels: [
        {
          id: 'walked_today',
          title: 'Walked today?',
          intent: 'Did I walk the dog?',
          display: 'Yes/no with a tap.',
          context_of_use: null,
          values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
          entry: null,
        },
      ],
    },
  ],
  data_requirements: [],
  open_questions: [],
})

describe('readStoredSpec', () => {
  it('reads a pre-unification row as legacy', () => {
    const stored = readStoredSpec(LEGACY)
    expect(stored.kind).toBe('legacy')
    if (stored.kind !== 'legacy') throw new Error('unreachable')
    expect(stored.payload.panels[0]!.name).toBe('Walked today?')
  })

  it('reads a current row as a version', () => {
    const stored = readStoredSpec(CURRENT)
    expect(stored.kind).toBe('version')
    if (stored.kind !== 'version') throw new Error('unreachable')
    expect(stored.version.screens[0]!.panels[0]!.id).toBe('walked_today')
  })

  it('reports a CURRENT-shaped row that is malformed as a current-shape error', () => {
    // Discrimination is on `screens`, so a row that clearly meant to be
    // current must not be reported as "bad legacy" — that message would send
    // a reader looking at the wrong schema for a row nobody can fix.
    const broken = JSON.parse(CURRENT)
    broken.screens[0].panels[0].id = 'Not A Slug'
    expect(() => readStoredSpec(JSON.stringify(broken))).toThrow(/slug/)
  })

  it('throws SpecShapeError for a row that is neither', () => {
    expect(() => readStoredSpec('{"nonsense": true}')).toThrow(SpecShapeError)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/stored.test.ts` — FAIL, module missing.

- [ ] **Step 3: Write `lib/spec/stored.ts`**

```ts
// lib/spec/stored.ts
//
// The ONE place anything discriminates a pre-unification row from a current
// one. `specs` rejects UPDATE, so rows written before the unified loop can
// never be rewritten into the current shape — they are read as legacy
// forever (unified-loop ledger, D4). Four consumers need that fallback; each
// re-implementing the try/catch is four chances to get the arm wrong.
import { SpecShapeError, type SpecVersion } from './schema'
import { parseLegacySpecPayload, type LegacySpecPayload } from './legacy'
import { parseSpecVersion } from './validate'

export type StoredSpec =
  | { kind: 'version'; version: SpecVersion }
  | { kind: 'legacy'; payload: LegacySpecPayload }

export function readStoredSpec(json: string): StoredSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Discriminate on `screens`, then commit. A current-shaped row that fails
  // validation must report the CURRENT-shape error, not fall through and
  // report a legacy one — a reader chasing the wrong schema for a row that
  // can never be edited is worse than a precise failure.
  const hasScreens =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { screens?: unknown }).screens)

  if (hasScreens) return { kind: 'version', version: parseSpecVersion(json) }
  return { kind: 'legacy', payload: parseLegacySpecPayload(json) }
}
```

- [ ] **Step 4: Run, typecheck, red-test control**

Run: `npx vitest run tests/spec && npx tsc --noEmit`. Then replace the `hasScreens` branch with a plain try-`parseSpecVersion`-catch-`parseLegacySpecPayload`: exactly the "reports a CURRENT-shaped row" test reds. Restore.

- [ ] **Step 5: Commit**

```bash
git add lib/spec/stored.ts tests/spec/stored.test.ts
git commit -m "Keep reading the specs nobody can rewrite"
```

---

## Task 4: The structural diff

**Files:**
- Create: `lib/spec/diff.ts`
- Test: `tests/spec/diff.test.ts`

**Interfaces:**
- Consumes: `SpecVersion`, `Screen`, `Panel`.
- Produces:

```ts
export type SpecDiff = {
  screens: { added: string[]; removed: string[]; changed: string[] }
  panels: { added: string[]; removed: string[]; changed: string[] }
}
export function diffVersions(prev: SpecVersion | null, next: SpecVersion): SpecDiff
export function diffCounts(diff: SpecDiff): {
  screens_added: number; screens_removed: number; screens_changed: number
  panels_added: number; panels_removed: number; panels_changed: number
}
```

- [ ] **Step 1: Write the failing test**

`tests/spec/diff.test.ts` — build two versions from a shared factory (reuse the `draft()`/`panel()` helpers from Task 2, copied into this file so the tests are independent) and assert:

```ts
it('reports every panel as added when there is no prior version', () => {
  expect(diffVersions(null, v1).panels.added).toEqual(['walked_today'])
  expect(diffVersions(null, v1).panels.removed).toEqual([])
})

it('reports a renamed title as changed, not as added-and-removed', () => {
  // This is the whole point of stable ids. A title is display text and may
  // change freely; the id is what says "this is the same panel".
  const renamed = withPanelTitle(v1, 'walked_today', 'Did you walk?')
  expect(diffVersions(v1, renamed).panels).toEqual({ added: [], removed: [], changed: ['walked_today'] })
})

it('reports a new panel as added and leaves the untouched one out of changed', () => {
  const grown = withExtraPanel(v1, 'streak')
  expect(diffVersions(v1, grown).panels.added).toEqual(['streak'])
  expect(diffVersions(v1, grown).panels.changed).toEqual([])
})

it('reports a dropped panel as removed', () => {
  expect(diffVersions(withExtraPanel(v1, 'streak'), v1).panels.removed).toEqual(['streak'])
})

it('reports a panel moved between screens as changed, not moved', () => {
  // A move is not its own category for the pilot; the panel's containing
  // screen is part of what changed about it.
  expect(diffVersions(v1, movedToNewScreen(v1, 'walked_today')).panels.changed).toEqual(['walked_today'])
})

it('ignores key order and whitespace when deciding "changed"', () => {
  expect(diffVersions(v1, reserialize(v1)).panels.changed).toEqual([])
})

it('counts what it found', () => {
  expect(diffCounts(diffVersions(null, v1))).toMatchObject({ panels_added: 1, panels_removed: 0 })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/diff.test.ts` — FAIL, module missing.

- [ ] **Step 3: Write `lib/spec/diff.ts`**

Implementation notes the engineer needs:

- Index panels by id into `Map<string, { screenId: string; panel: Panel }>` for both versions.
- `added` = in next, not in prev. `removed` = in prev, not in next. `changed` = in both AND the canonical serialisations differ.
- **Canonical serialisation, not `JSON.stringify` of the object.** Write a small `canonical(value: unknown): string` that sorts object keys recursively before stringifying — otherwise a payload whose keys arrived in a different order reads as "changed" every version, and the metric becomes noise. Include the containing screen id in a panel's canonical form so a move counts as a change.
- Screens compare on `{id, title, order}` plus the *set* of panel ids they contain — not the panels themselves, or every panel edit would also mark its screen changed.
- Sort every output array so the result is deterministic (it feeds an append-only metric row).

- [ ] **Step 4: Run and typecheck**

Run: `npx vitest run tests/spec && npx tsc --noEmit`

- [ ] **Step 5: Red-test control**

Replace `canonical()` with a bare `JSON.stringify` → exactly the key-order test reds. Restore. Drop the screen id from a panel's canonical form → exactly the moved-panel test reds. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/spec/diff.ts tests/spec/diff.test.ts
git commit -m "Say which panel changed, by name, between two versions"
```

---

## Task 5: Rendering spec.md from a version

**Files:**
- Modify: `lib/spec/render.ts`
- Test: `tests/spec/render.test.ts`

**Interfaces:**
- Produces: `renderSpecMarkdown(version: SpecVersion, meta: { slug: string; version: number; confirmedAt: number }): string` and `renderLegacyMarkdown(payload: LegacySpecPayload, meta: same): string` (today's function, renamed, body unchanged).

- [ ] **Step 1: Write the failing tests**

Keep every existing test in `tests/spec/render.test.ts`, repointed at `renderLegacyMarkdown` — that renderer's behaviour must not move, because it renders rows nobody can fix. Add for the new renderer:

```ts
it('renders sections in the stable order the spec doc fixes', () => {
  const md = renderSpecMarkdown(version, meta)
  const order = ['## What changed', '## Summary', '## Background', '## Screens',
                 '## Entered by hand', '## Data requirements', '## Open questions']
  const positions = order.map((h) => md.indexOf(h))
  expect(positions.every((p) => p >= 0)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
})

it('carries each panel id, so the build knows what the diff was talking about', () => {
  expect(renderSpecMarkdown(version, meta)).toContain('`walked_today`')
})

it('labels each value with its source kind', () => {
  const md = renderSpecMarkdown(version, meta)
  expect(md).toMatch(/entered.*One tap per day/i)
})

it('derives the entered-by-hand section from entered values', () => {
  // manual_logging is gone; this section is computed, not authored, so it can
  // never disagree with the values it summarises.
  expect(renderSpecMarkdown(version, meta)).toContain('One tap per day')
})

it('says so plainly when a version has no entered values', () => {
  expect(renderSpecMarkdown(allSyncedVersion, meta)).toMatch(/## Entered by hand\n\n_None\._/)
})

it('escapes a leading # or fence in every interpolated field', () => {
  // Differential: same fixture through every field, one at a time.
  for (const field of ['title', 'summary', 'background', 'change_summary']) {
    const hostile = { ...version, [field]: '# pwned\n```' }
    expect(renderSpecMarkdown(hostile, meta)).not.toMatch(/^# pwned$/m)
  }
})

it('escapes hostile text inside a panel and a value too', () => {
  // The step-4 ledger flagged the fixture-based escaping test as able to miss
  // a NEW interpolation site. The new renderer has many more sites, so this
  // walks panel and value fields as well, not just the top-level ones.
  const hostile = withPanelIntent(version, 'walked_today', '# pwned')
  expect(renderSpecMarkdown(hostile, meta)).not.toMatch(/^# pwned$/m)
})

it('is deterministic', () => {
  expect(renderSpecMarkdown(version, meta)).toBe(renderSpecMarkdown(version, meta))
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/render.test.ts`

- [ ] **Step 3: Implement**

Rename the existing export to `renderLegacyMarkdown` (body untouched, including `safeMarkdown`). Extract `safeMarkdown` and `list` to module scope so both renderers share exactly one escaping implementation — the step-4 ledger's "deferred, accepted" entry warns that a new interpolation site with no matching fixture regresses silently, and two copies of the escaper would make that worse.

`renderSpecMarkdown` emits, in order: H1 title with the generated-file banner; the slug/version/confirmed metadata list; `## What changed` (`change_summary`); `## Summary`; `## Background`; `## Screens` (each screen an `###` by `order`, each panel an `####` carrying `` `id` ``, then `- **Intent:**`, `- **Shows:**`, `- **When/where:**` when non-null, a `- **Values:**` sub-list of `` `id` — kind — description ``, and `- **Entry:**` when present); `## Entered by hand` (derived: every `kind: 'entered'` value across the version, `_None._` if empty); `## Data requirements` (table + status + purpose, `_None._` if empty); `## Open questions` (`_None._` if empty).

- [ ] **Step 4: Run, typecheck, red-test control**

Run: `npx vitest run tests/spec && npx tsc --noEmit`. Then remove the `safeMarkdown` call from the panel-intent interpolation only → exactly the panel-escaping test reds. Restore.

- [ ] **Step 5: Commit**

```bash
git add lib/spec/render.ts tests/spec/render.test.ts
git commit -m "Write a build contract that names every panel it describes"
```

---

## Task 6: The three prompts

**Files:**
- Create: `platform/prompts/agent-v3.md`, `platform/prompts/spec-v2.md`, `platform/prompts/mockup-v1.md`
- Modify: `lib/chat/prompt.ts`
- Test: `tests/chat/prompt.test.ts`

**Interfaces:**
- Produces: `AGENT_PROMPT = 'agent-v3.md'`, `SPEC_PROMPT = 'spec-v2.md'`, `MOCKUP_PROMPT = 'mockup-v1.md'`.

`platform/prompts/*` is Gate-B exempt (runtime prose, not logic), so the prompt *wording* is never tested. `lib/chat/prompt.ts` is not exempt.

- [ ] **Step 1: Write `platform/prompts/agent-v3.md`**

The body of `docs/superpowers/specs/2026-08-13-unified-proposal-loop/01-agent-system-prompt-v2.md`, **verbatim, minus the `>` handoff-note block and the `---` under it** — that note addresses the builder, not the agent. Do not edit `agent-v2.md`; rows point at its hash.

**The spec file carries an approval-time amendment to "After a build ships" — take it as it now stands on disk, do not restore the handoff's original wording.** The agent has no way to observe a deploy: Task 12 makes the announcement an operator-authored row Nico posts by CLI. Telling the model that announcing deploys is its job invites it to confirm a build that has not shipped, to someone who asked "is it done yet?" — the one question where a wrong answer costs the promise. The amended section instead tells it a message will appear and that it must never confirm a deploy without one.

- [ ] **Step 2: Write `platform/prompts/spec-v2.md`**

New file. Must cover, in prose:

- What it is given: the whole conversation, oldest first, **and the current confirmed version as JSON** (or an explicit statement that the spec is empty).
- What it emits: the complete next version of the whole surface — every screen and panel the dashboard should have after this change, not only what this conversation touched. Carrying a panel forward unchanged is normal and expected.
- **Id stability, stated as the load-bearing rule it is:** reuse the exact id from the current version for anything that is the same thing; ids are lowercase slugs with single underscores; never rename or reuse an id; a changed display title with an unchanged id is how a rename is expressed. Deleting a panel means leaving its id out — and any deletion must be named in `change_summary`.
- Each field: `title`, `summary` (what the dashboard is, whole-surface), `background` (residue about the person, not a recap), `change_summary` (what changed against the current version; for v1, the whole dashboard briefly — this is the line the friend reads first), `screens`/`panels` with `intent`/`display`/`context_of_use`, per-value sourcing with the three kinds, `entry` widgets, `data_requirements`, `open_questions`.
- The sourcing rule from file 01's "what you know about what is possible": Plaid for bank/card, entered by hand, or derived. **Investments and liabilities are not connected** — a panel needing them is an `open_question`, not a panel.
- `null` is the answer for `context_of_use` and `entry` when they do not apply — never omit the key.
- **No mockup.** It is a separate call now.

- [ ] **Step 3: Write `platform/prompts/mockup-v1.md`**

Lift the "## The mockup" section of `spec-v1.md` verbatim (self-contained HTML, no `<script>`, no external anything, inline CSS only, phone-width, and the loudly-fake-values rule with "COFFEE PALACE TEST"). Add: it is given a validated spec version as JSON, and **every screen and panel in it appears in the mockup, and nothing that is not in it does** — the preview is a promise about what will be built.

- [ ] **Step 4: Update `lib/chat/prompt.ts` and its test**

Point `AGENT_PROMPT` and `SPEC_PROMPT` at the new files, add `MOCKUP_PROMPT`. In `tests/chat/prompt.test.ts` add:

```ts
it('names prompt files that exist on disk', () => {
  for (const name of [AGENT_PROMPT, SPEC_PROMPT, MOCKUP_PROMPT]) {
    expect(existsSync(promptPath(name))).toBe(true)
  }
})

it('keeps superseded prompts on disk, because rows point at their hashes', () => {
  // prompt_sha is a content hash stamped on every transcript and spec row.
  // Deleting a superseded prompt orphans every row that names it.
  for (const name of ['agent-v2.md', 'spec-v1.md']) {
    expect(existsSync(promptPath(name))).toBe(true)
  }
})
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/chat/prompt.test.ts && npx tsc --noEmit`

```bash
git add platform/prompts/agent-v3.md platform/prompts/spec-v2.md platform/prompts/mockup-v1.md \
  lib/chat/prompt.ts tests/chat/prompt.test.ts
git commit -m "Talk to one stakeholder about the next version of their whole app"
```

---

## Task 7: `propose()` takes its schema from the caller

**Files:**
- Modify: `lib/chat/client.ts`
- Test: `tests/chat/client.test.ts`

**Interfaces:**
- Produces: `propose(args: { system: string; messages: ChatMessage[]; signal: AbortSignal; schema: object }): Promise<ProposeResult>` on `ChatClient`.

- [ ] **Step 1: Write the failing test**

In `tests/chat/client.test.ts`, add a case asserting the schema reaches the request, and update every existing `propose` fake to the new signature:

```ts
it('sends the caller-supplied schema as output_config.format', async () => {
  const seen: Record<string, unknown>[] = []
  const sdk = fakeSdk((body) => { seen.push(body); return completeJsonMessage('{"ok":true}') })
  await anthropicClient(sdk).propose({
    system: 's', messages: [{ role: 'user', content: 'u' }],
    signal: new AbortController().signal, schema: MOCKUP_JSON_SCHEMA,
  })
  expect(seen[0]!.output_config).toMatchObject({
    format: { type: 'json_schema', schema: MOCKUP_JSON_SCHEMA },
  })
})
```

Keep the existing `tests/chat/client.test.ts` assertion that every propose fake throws on `sdk.beta.messages.create` — the step-4 ledger records that faking `create` is what let a non-streaming request the real SDK refuses pass the suite for a whole task.

Also update the `PROPOSE_TOOL` description assertion (add one if absent):

```ts
it('describes propose_spec as proposing a whole next version', () => {
  expect(PROPOSE_TOOL.description).not.toMatch(/interview/i)
  expect(PROPOSE_TOOL.input_schema.properties).toEqual({})
})
```

- [ ] **Step 2: Run, watch it fail, implement**

In `lib/chat/client.ts`: remove the `SPEC_JSON_SCHEMA` import; add `schema: object` to the `propose` signature on both `ChatClient` and the implementation, and use it in `output_config.format`. Reword `PROPOSE_TOOL.description`:

```ts
  description:
    'Propose the next version of this person\'s whole dashboard. Takes no ' +
    'arguments. Calling this ends your turn; a preview is written and shown ' +
    'to them as a card leading with what changed, which they can accept or ' +
    'push back on.',
```

Leave `SPEC_MAX_TOKENS`, `SPEC_TIMEOUT_MS`, and the streaming requirement exactly as they are, including the comment block explaining why the call must stream.

- [ ] **Step 3: Run, typecheck, commit**

Run: `npx vitest run tests/chat && npx tsc --noEmit`

```bash
git add lib/chat/client.ts tests/chat/client.test.ts
git commit -m "Let the caller say what shape it is asking for"
```

---

## Task 8: `specByVersion`, and the context comment

**Files:**
- Modify: `lib/db/specs.ts`, `lib/chat/context.ts`
- Test: `tests/db/specs.test.ts`, `tests/chat/context.test.ts`

**Interfaces:**
- Produces: `specByVersion(db: PlatformDb, accountId: number, version: number): SpecRecord | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
it('finds a spec by its derived version number', () => {
  // Version is position, so this cannot be a WHERE clause — it has to walk
  // the same derivation readSpecs does, or the two disagree.
  expect(specByVersion(db, account, 2)?.id).toBe(secondSpecId)
})

it('returns undefined for a version that does not exist', () => {
  expect(specByVersion(db, account, 99)).toBeUndefined()
})

it('does not find another account\'s spec', () => {
  expect(specByVersion(db, otherAccount, 1)).toBeUndefined()
})
```

- [ ] **Step 2: Implement**

```ts
/**
 * The proposal at a given version number. Version is derived from position
 * (see readSpecs), so this walks the same derivation rather than adding a
 * WHERE clause that could disagree with it.
 */
export function specByVersion(
  db: PlatformDb,
  accountId: number,
  version: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId).find((s) => s.version === version)
}
```

- [ ] **Step 3: Rewrite the `ChatContext` comment**

Values unchanged (ledger D11). Replace the docstring on `contextFor`:

```ts
/**
 * Which ERA this turn belongs to, for the cost log. NOT a pipeline branch:
 * nothing reads this to decide behaviour, and after the unified proposal loop
 * there is only one loop to branch to. It answers architecture-overview line
 * 136's question — how much cost goes into winning someone over versus
 * keeping them — and the boundary is still CONFIRMATION, because a spec that
 * was offered and not accepted has not ended the interview.
 *
 * The value 'tweak' is kept rather than renamed even though the tweak/build
 * distinction is gone everywhere else: metrics is append-only and cannot be
 * migrated, so a rename would split one series across two spellings for a
 * wording change. See the unified-loop ledger, D11.
 */
```

Add to `tests/chat/context.test.ts`:

```ts
it('keeps both era labels, because metrics rows already carry them', () => {
  // A rename here splits an append-only series. See ledger D11.
  expect(contextFor(db, freshAccount)).toBe('interview')
  expect(contextFor(db, confirmedAccount)).toBe('tweak')
})
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/db tests/chat && npx tsc --noEmit`

```bash
git add lib/db/specs.ts lib/chat/context.ts tests/db/specs.test.ts tests/chat/context.test.ts
git commit -m "Find a version by number, and stop calling a cost label a mode"
```

---

## Task 9: Every reader handles both shapes

This task lands **before** Task 10 on purpose. At this point no current-shape row exists anywhere, so every path still runs the legacy arm and the tree stays green — but the readers are ready when Task 10 starts writing the new shape. Reversing these two tasks ships a window where a friend's confirmed proposal renders as nothing.

**Files:**
- Modify: `app/[user]/page.tsx`, `app/[user]/ChatPanel.tsx`, `app/admin/[user]/page.tsx`, `scripts/export-spec.ts`, `lib/spec/author.ts` *(type + return site only — see below)*
- Test: `tests/routing/userSpace.test.ts`, `tests/chat/panel.test.ts`, `tests/admin/specPane.test.ts`, `tests/scripts/exportSpec.test.ts`

**Interfaces:**
- Consumes: `readStoredSpec`, `diffVersions`, `renderSpecMarkdown`, `renderLegacyMarkdown`, `hasConfirmedSpec`, `specByVersion`.
- Produces (ChatPanel):

```ts
export type CardSpec =
  | { kind: 'version'; version: SpecVersion }
  | { kind: 'legacy'; payload: LegacySpecPayload }
export type CardProposal = {
  id: number
  version: number
  spec: CardSpec
  mockup_html: string
  confirmed?: boolean
}
export const DELIVERY_FIRST: string
export const DELIVERY_CHANGE: string
export function SpecCard(props: {
  proposal: CardProposal
  live: boolean
  busy: boolean
  first: boolean
  confirmError?: boolean
  onConfirm: (specId: number) => void
}): JSX.Element
```

**`lib/spec/author.ts` changes here too, and the scope is exactly two things:** the `Proposal` type becomes `{ id: number; version: number; spec: CardSpec; mockup_html: string }`, and the single `return` at the end of the success path wraps the still-legacy payload as `spec: { kind: 'legacy', payload: parsed.payload }`. **Nothing else in that file moves — the authoring path is still Task 10's.**

This is not optional tidying. `Proposal` is what the NDJSON `proposal` line carries (`app/api/chat/route.ts`), so a card streamed mid-turn and a card rendered on page load must have one shape at every commit. Leaving `Proposal` on the old shape here would mean `page.tsx` builds a `CardProposal` from `readStoredSpec` while the stream sends something else, and the two would disagree until Task 10. ChatPanel keeps importing `Proposal` type-only.

- [ ] **Step 1: Write the failing tests**

`tests/chat/panel.test.ts` — add:

```ts
it('leads a current-shape card with what changed, not with the summary', () => {
  const html = renderToStaticMarkup(<SpecCard proposal={versionProposal} live busy={false} first={false} onConfirm={noop} />)
  expect(html.indexOf('Added a streak')).toBeLessThan(html.indexOf('A one-tap tracker'))
})

it('lists every panel of a current-shape card, across screens', () => {
  const html = renderToStaticMarkup(<SpecCard proposal={twoScreenProposal} live busy={false} first={false} onConfirm={noop} />)
  expect(html).toContain('Walked today?')
  expect(html).toContain('Current streak')
})

it('still renders a legacy card exactly as before', () => {
  const html = renderToStaticMarkup(<SpecCard proposal={legacyProposal} live busy={false} first={false} onConfirm={noop} />)
  expect(html).toContain('Did I walk the dog today?')
  expect(html).toContain('Walked today?')
})

it('promises tomorrow morning on a first dashboard', () => {
  const html = renderToStaticMarkup(<SpecCard proposal={versionProposal} live busy={false} first onConfirm={noop} />)
  expect(html).toContain(DELIVERY_FIRST)
  expect(html).not.toContain(DELIVERY_CHANGE)
})

it('promises a few hours on a later change', () => {
  // The card must not tell someone their one-word relabel arrives tomorrow
  // morning when the agent just said small changes land within hours.
  const html = renderToStaticMarkup(<SpecCard proposal={versionProposal} live busy={false} first={false} onConfirm={noop} />)
  expect(html).toContain(DELIVERY_CHANGE)
  expect(html).not.toContain(DELIVERY_FIRST)
})

it('shows the same delivery line on a confirmed card as on the live one', () => {
  for (const first of [true, false]) {
    const live = renderToStaticMarkup(<SpecCard proposal={versionProposal} live busy={false} first={first} onConfirm={noop} />)
    const done = renderToStaticMarkup(<SpecCard proposal={{ ...versionProposal, confirmed: true }} live={false} busy={false} first={first} onConfirm={noop} />)
    const line = first ? DELIVERY_FIRST : DELIVERY_CHANGE
    expect(live).toContain(line)
    expect(done).toContain(line)
  }
})

it('keeps the first-dashboard wording byte-identical to what shipped in step 4', () => {
  // The behaviour-preserving requirement, pinned. This is the most
  // load-bearing promise in the pilot and it is made at the exact moment the
  // friend decides.
  expect(DELIVERY_FIRST).toBe(
    "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.",
  )
})
```

`tests/admin/specPane.test.ts` — add: a current-shape row renders its screens, panels and per-value sourcing; a legacy row renders as today **and carries a visible legacy marker**; a current row whose payload is corrupt still degrades to "Unreadable proposal" rather than 500ing; the diff against `based_on_version` renders, and a v1 (`based_on_version: null`) renders without one.

`tests/scripts/exportSpec.test.ts` — add: a confirmed current-shape row exports markdown containing `## What changed`; a confirmed legacy row exports byte-identically to today (snapshot the current output first, then assert against it).

`tests/routing/userSpace.test.ts` — add: the page passes `first: true` when the account has no confirmed spec and `first: false` once it has one.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/chat/panel.test.ts tests/admin tests/scripts/exportSpec.test.ts tests/routing/userSpace.test.ts`

- [ ] **Step 3: Implement**

**`app/[user]/page.tsx`** — replace the `parseSpecPayload` call with `readStoredSpec(newest.payload)`, keeping the narrow `SpecShapeError` rethrow exactly as it is (anything else still escapes). Compute `const first = !hasConfirmedSpec(getDb(), accountId)` and pass it to `ChatPanel`.

**`app/[user]/ChatPanel.tsx`** —

```tsx
// Fixed chrome, not agent prose, for the same reason it always was: this is
// the most load-bearing promise in the pilot and it is made at the exact
// moment the friend decides, so it cannot depend on a model remembering to
// say it. What is NEW is that there are two of them.
//
// Under the unified loop the same card carries a one-word relabel and a
// first dashboard. One sentence cannot be honest about both — "tomorrow
// morning" over-promises the wait on a small change and contradicts what the
// agent's own prompt says (small changes land within a few hours). Selected
// by whether this account has a confirmed version yet, computed server-side.
export const DELIVERY_FIRST =
  "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning."
export const DELIVERY_CHANGE =
  'This gets built as soon as possible — small changes usually land within a few hours.'
```

`SpecCard` renders, in order: `<h3>` title (from either arm), then for a current-shape card a `<p>` of `change_summary` **before** the `<p>` of `summary`, then screens→panels as a nested list showing each panel title and `display`. The legacy arm renders exactly today's markup. The iframe (`sandbox=""`, `srcDoc`) is unchanged — `tests/spec/sandbox.test.ts` pins it and must keep passing untouched.

`ProposalRegion` and `ChatPanel` thread `first` through to `SpecCard`.

**`app/admin/[user]/page.tsx`** — switch to `readStoredSpec`; keep the narrow `SpecShapeError` rethrow. For a current row, resolve the base via `specByVersion(db, account.id, version.based_on_version)` when non-null, read *its* payload through `readStoredSpec`, and render `diffVersions` output as an added/removed/changed list — a legacy base yields no diff, rendered as "first structured version". Keep `open_questions` above the rest of the spec, for the reason the existing comment gives. Badge legacy rows: `<em>Pre-unification spec (legacy shape)</em>`.

**`scripts/export-spec.ts`** — branch on `readStoredSpec` and call the matching renderer. Keep the "compute spec_md first, before the return object" ordering and its comment: `exportSpec` must build both strings or neither.

- [ ] **Step 4: Run everything, typecheck, build**

Run: `npx vitest run && npx tsc --noEmit && npx next build`

- [ ] **Step 5: Red-test control**

Hardcode `first={true}` in `ProposalRegion` → exactly the "few hours" test reds. Restore. Swap the order of the `change_summary` and `summary` paragraphs → exactly the leads-with test reds. Restore. Drop the legacy arm from the admin pane → exactly the legacy-render test reds. Restore.

- [ ] **Step 6: Commit**

```bash
git add app lib/spec/author.ts scripts/export-spec.ts tests
git commit -m "Lead the card with what changed, and promise a wait that fits the change"
```

---

## Task 10: The emission path — current version in, validation retry, mockup call

The switchover. After this task, new proposals are written in the new shape.

**Files:**
- Modify: `lib/spec/author.ts`
- Test: `tests/spec/author.test.ts`

**Interfaces:**
- Produces: `Proposal = { id: number; version: number; spec: CardSpec; mockup_html: string }`; `MAX_SPEC_ATTEMPTS = 2`.
- Consumes: `currentSpec`, `readStoredSpec`, `renderLegacyMarkdown`, `parseSpecDraft`, `sealVersion`, `parseMockupInput`, `SPEC_JSON_SCHEMA`, `MOCKUP_JSON_SCHEMA`, `SPEC_PROMPT`, `MOCKUP_PROMPT`.

- [ ] **Step 1: Write the failing tests**

`tests/spec/author.test.ts` — keep every existing failure-path test (abort, stream error, truncated, unparsable, unexpected) working against the new two-call shape, and add:

```ts
it('gives the writer the current confirmed version as JSON', async () => {
  const { messages } = await runAuthor({ confirmed: v1Row })
  expect(JSON.stringify(messages)).toContain('"walked_today"')
})

it('tells the writer the spec is empty on the first-ever proposal', async () => {
  // Behaviour-preserving: the v1 path must send a prompt of the same SHAPE,
  // not a prompt with a section missing.
  const { messages } = await runAuthor({ confirmed: undefined })
  expect(JSON.stringify(messages)).toMatch(/no confirmed spec|empty/i)
})

it('feeds a legacy current spec in as rendered markdown', async () => {
  const { messages } = await runAuthor({ confirmed: legacyRow })
  expect(JSON.stringify(messages)).toContain('Did I walk the dog today?')
})

it('never writes the authoring scaffolding to transcripts', async () => {
  await runAuthor({})
  expect(readTranscript(db, account)).toHaveLength(0)
})

it('retries once with the validator message when the draft fails validation', async () => {
  const client = proposeReturning([badDraft, goodDraft], goodMockup)
  const proposal = await authorSpec(deps(client), input)
  expect(proposal).toBeDefined()
  expect(client.proposeCalls[1]!.messages.at(-1)!.content).toContain('duplicate panel id')
})

it('records a metric for the FAILED attempt as well as the successful one', async () => {
  // The failed attempt returned a complete response and spent real, billed
  // tokens. A cost log reporting zero for it is fiction.
  await authorSpec(deps(proposeReturning([badDraft, goodDraft], goodMockup)), input)
  const rows = readMetrics(db)
  expect(rows.filter((r) => r.event === 'spec_error')).toHaveLength(1)
  expect(JSON.parse(rows.find((r) => r.event === 'spec_error')!.data).attempt).toBe(1)
  expect(JSON.parse(rows.find((r) => r.event === 'spec_proposed')!.data).attempt).toBe(2)
  expect(JSON.parse(rows.find((r) => r.event === 'spec_error')!.data).output).toBeGreaterThan(0)
})

it('gives up after exactly two attempts and writes no row', async () => {
  const client = proposeReturning([badDraft, badDraft], goodMockup)
  expect(await authorSpec(deps(client), input)).toBeUndefined()
  expect(client.proposeCalls.filter((c) => c.schema === SPEC_JSON_SCHEMA)).toHaveLength(2)
  expect(readSpecs(db, account)).toHaveLength(0)
})

it('does NOT retry a truncated or unparsable reply', async () => {
  // Those failed for a reason another sample will not fix, and each costs a
  // full authoring latency the friend is watching a spinner through.
  const client = proposeThrowing(new ChatStreamError({ kind: 'truncated_spec', ... }, 'x'))
  expect(await authorSpec(deps(client), input)).toBeUndefined()
  expect(client.proposeCalls).toHaveLength(1)
})

it('does not retry after the signal aborts', async () => {
  const client = proposeReturning([badDraft, goodDraft], goodMockup)
  const controller = new AbortController()
  client.onCall(() => controller.abort())
  await authorSpec(deps(client), { ...input, signal: controller.signal })
  expect(client.proposeCalls).toHaveLength(1)
})

it('calls the mockup writer with the VALIDATED payload, after the spec call', async () => {
  const client = proposeReturning([goodDraft], goodMockup)
  await authorSpec(deps(client), input)
  const mockupCall = client.proposeCalls[1]!
  expect(mockupCall.schema).toBe(MOCKUP_JSON_SCHEMA)
  expect(JSON.stringify(mockupCall.messages)).toContain('"walked_today"')
})

it('writes NO spec row when the mockup call fails', async () => {
  // mockup_html is NOT NULL and a spec row without its preview is a card the
  // friend cannot read. Both calls succeed or neither is stored.
  const client = proposeReturning([goodDraft], new Error('boom'))
  expect(await authorSpec(deps(client), input)).toBeUndefined()
  expect(readSpecs(db, account)).toHaveLength(0)
  expect(readMetrics(db).find((r) => r.event === 'spec_error')).toBeDefined()
  expect(JSON.parse(readMetrics(db).at(-1)!.data).kind).toBe('mockup_failed')
})

it('puts the SPEC call\'s billed tokens on the mockup_failed row', async () => {
  // On the happy path those tokens ride on spec_proposed. No spec_proposed is
  // written here, so this row is their only home — see ledger D15.
  await authorSpec(deps(proposeReturning([goodDraft], new Error('boom'))), input)
  const data = JSON.parse(readMetrics(db).at(-1)!.data)
  expect(data.output).toBe(SPEC_CALL_OUTPUT_TOKENS)
})

it('reports the mockup call\'s own usage as null when it failed before responding', async () => {
  // Zero is a claim that nothing was billed. For a connection failure that is
  // true of the mockup call and false of the spec call — hence two fields.
  await authorSpec(deps(proposeReturning([goodDraft], connectionError())), input)
  expect(JSON.parse(readMetrics(db).at(-1)!.data).mockup_output).toBeNull()
})

it('reports the mockup call\'s own usage when it failed AFTER responding', async () => {
  const truncated = new ChatStreamError(
    { kind: 'truncated_spec', status: null, type: null, usage: mockupUsage, served: SERVED },
    'x',
  )
  await authorSpec(deps(proposeReturning([goodDraft], truncated)), input)
  expect(JSON.parse(readMetrics(db).at(-1)!.data).mockup_output).toBe(mockupUsage.output)
})

it('stores the server-supplied based_on_version, not a model-authored one', async () => {
  // v1 exists and is confirmed; the model's draft carries no lineage field.
  const proposal = await authorSpec(deps(client), input)
  const stored = readStoredSpec(readSpecs(db, account)[0]!.payload)
  expect(stored.kind).toBe('version')
  expect((stored as { version: SpecVersion }).version.based_on_version).toBe(1)
})

it('stores null based_on_version when nothing is confirmed yet', async () => { /* ... */ })
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/spec/author.test.ts`

- [ ] **Step 3: Implement**

Keep `authorSpec`'s existing contract intact: **it never throws, on any path**, and the whole body stays inside one outer try/catch for the reason its docstring gives — it runs after the assistant row is already appended, and a throw would kill the stream after the reply was saved.

Structural changes inside it:

```ts
export const MAX_SPEC_ATTEMPTS = 2

// Inside authorSpec, before the attempt loop:
const current = currentSpec(db, input.accountId)
const basedOn = current?.version ?? null

/**
 * The current confirmed version, as the writer sees it. Three arms, because
 * all three are real states and none may silently look like another:
 *   - none      → an explicit "this is the first version", so the v1 prompt
 *                 has the same SHAPE as every later one. Behaviour-preserving.
 *   - current   → JSON, because id stability is the point and ids must be
 *                 copyable verbatim.
 *   - legacy    → rendered markdown plus a note that ids must be assigned
 *                 fresh. A legacy row has no ids to stabilise against.
 */
function currentVersionBlock(): string { /* ... */ }
```

The attempt loop, replacing today's single `client.propose` + `parseSpecInput`:

```ts
let draft: SpecDraft | undefined
let attempt = 0
let feedback: string | undefined

while (attempt < MAX_SPEC_ATTEMPTS) {
  attempt += 1
  // Every retry message is a CALL-TIME construct and is never appended to
  // transcripts — same rule as "Write the spec now." above.
  const attemptMessages = feedback
    ? [...specMessages, { role: 'user' as const, content: retryMessage(feedback) }]
    : specMessages

  result = await client.propose({ system, messages: attemptMessages, signal: input.signal, schema: SPEC_JSON_SCHEMA })
  // (the existing catch around propose is unchanged, and returns — no retry
  //  for an API failure, a truncated reply, or an unparsable one)

  try {
    draft = parseSpecDraft(result.input)
    break
  } catch (error) {
    if (!(error instanceof SpecShapeError)) throw error
    // Each failed attempt gets its own row: it returned a complete response
    // and cost real, billed tokens.
    appendMetric(db, { accountId: input.accountId, event: 'spec_error', at: now(), data: {
      ...result.usage, ...base, ...result.served,
      kind: 'malformed_spec', status: null, type: null, attempt, message: error.message,
    }})
    if (input.signal.aborted) return undefined
    feedback = error.message
  }
}
if (!draft) return undefined
```

Then the mockup call, guarded so a failure writes no row:

```ts
let mockupHtml: string
try {
  const mockup = await client.propose({
    system: loadPrompt(MOCKUP_PROMPT).text,
    messages: [{ role: 'user', content: JSON.stringify(draft) }],
    signal: input.signal,
    schema: MOCKUP_JSON_SCHEMA,
  })
  mockupHtml = parseMockupInput(mockup.input)
} catch (error) {
  // mockup_html is NOT NULL, and a spec row with no preview is a card the
  // friend cannot read. Both calls land or neither does.
  //
  // The four standard counters are the SPEC call's, not the mockup call's —
  // see ledger D15. On the success path those tokens ride on spec_proposed;
  // no spec_proposed is written here, so this row is their only home, and
  // every other row in the log means the same thing by those four names.
  // The mockup call's own usage rides alongside under mockup_* names, null
  // when it failed before any response came back (zero would be a claim that
  // nothing was billed, which a truncated mockup makes false).
  const shape = error instanceof ChatStreamError ? error.shape : UNKNOWN_ERROR
  appendMetric(db, {
    accountId: input.accountId,
    event: 'spec_error',
    at: now(),
    data: {
      ...result.usage, ...base, ...result.served,
      kind: 'mockup_failed', status: shape.status, type: shape.type, attempt,
      message: error instanceof Error ? error.message : String(error),
      mockup_input: shape.usage?.input ?? null,
      mockup_output: shape.usage?.output ?? null,
      mockup_cache_read: shape.usage?.cache_read ?? null,
      mockup_cache_creation: shape.usage?.cache_creation ?? null,
    },
  })
  return undefined
}

const id = insertSpec(db, { ...stamp, payload: sealVersion(draft, basedOn), mockupHtml, at: now() })
```

The version read-back after `insertSpec`, the `spec_proposed` append (now carrying `attempt`), and the outer catch all stay exactly as they are. `Proposal` returns `spec: { kind: 'version', version: sealed }` — replacing the `kind: 'legacy'` wrapper Task 9 put at that return site — so the NDJSON `proposal` line matches what `SpecCard` expects.

**Then delete the three legacy AUTHORING exports** that Task 1 kept alive only to carry the branch to here: `LEGACY_SPEC_JSON_SCHEMA`, `LegacySpecInput`, and `parseLegacySpecInput` come out of `lib/spec/legacy.ts`. Nothing authors the legacy shape after this commit — `legacy.ts` is a reader again, which is what its header says it is. `parseLegacySpecPayload` and `LegacySpecPayload` **stay**; four consumers still read old rows through them. `npx tsc --noEmit` is what proves nothing still references the deleted three.

- [ ] **Step 4: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: all green. This is the first point at which the whole loop works end to end.

- [ ] **Step 5: Red-test control**

Change `MAX_SPEC_ATTEMPTS` to 1 → exactly the retry test reds. Restore. Delete the failed-attempt `appendMetric` → exactly the failed-attempt-metric test reds. Restore. Move `insertSpec` above the mockup call → exactly the no-row-on-mockup-failure test reds. Restore. Replace `basedOn` with a value read from `result.input` → exactly the server-supplied test reds. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/spec/author.ts tests/spec/author.test.ts
git commit -m "Never store a spec the validator rejected, and never one without its preview"
```

---

## Task 11: Confirmation records what changed

**Files:**
- Modify: `app/api/spec/confirm/route.ts`
- Test: `tests/spec/confirm.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('records the structural diff counts on spec_confirmed', () => {
  // The diff between confirmed versions is the canonical record of what a
  // request WAS — it replaces classifying chat text after the fact.
  const data = JSON.parse(confirmAndReadMetric(v2Row).data)
  expect(data).toMatchObject({ spec_id: v2Row.id, version: 2, panels_added: 1, panels_changed: 0 })
})

it('records counts only — never a panel id or a title', () => {
  // Metrics is the unencrypted platform database. Counts are structural;
  // a panel title is the friend's own words.
  const data = JSON.parse(confirmAndReadMetric(v2Row).data)
  expect(JSON.stringify(data)).not.toContain('walked_today')
  expect(JSON.stringify(data)).not.toContain('Walked today?')
})

it('counts every panel as added for a first confirmed version', () => {
  expect(JSON.parse(confirmAndReadMetric(v1Row).data).panels_added).toBe(1)
})

it('still confirms, and still fires the alert, when the diff cannot be computed', () => {
  // A legacy base, or a corrupt base row that can never be repaired, must
  // not stop a friend pressing Build this.
  const response = confirm(rowWithLegacyBase)
  expect(response.status).toBe(200)
  expect(alerts).toHaveLength(1)
})
```

- [ ] **Step 2: Implement**

Between `confirmSpec` and `appendMetric`, compute the counts inside their own try/catch that swallows to `{}` on any failure — the existing 404/409/double-click logic and the fire-and-forget `alerter` call are untouched:

```ts
// Counts, never content: metrics is the unencrypted platform database, and a
// panel title is the friend's own words. This is the same bound that makes
// dashboard_write's slug-and-panel-only policy true.
//
// Wrapped because a diff is a nice-to-have and a confirmation is not: a
// legacy base (which has no ids to diff against) or a corrupt base row that
// can never be repaired must not stop someone pressing Build this.
let counts: Record<string, number> = {}
try {
  const stored = readStoredSpec(spec.payload)
  if (stored.kind === 'version') {
    const baseRow = stored.version.based_on_version === null
      ? undefined
      : specByVersion(db, session.account_id, stored.version.based_on_version)
    const base = baseRow ? readStoredSpec(baseRow.payload) : undefined
    counts = diffCounts(
      diffVersions(base?.kind === 'version' ? base.version : null, stored.version),
    )
  }
} catch { /* a diff is not worth failing a confirmation over */ }
```

- [ ] **Step 3: Run, red-test control, commit**

Run: `npx vitest run tests/spec/confirm.test.ts && npx tsc --noEmit`. Remove the try/catch → exactly the still-confirms test reds. Restore.

```bash
git add app/api/spec/confirm/route.ts tests/spec/confirm.test.ts
git commit -m "Record the size of what was agreed, without recording what it said"
```

---

## Task 12: Post-build announcements in chat

**Files:**
- Create: `lib/chat/announce.ts`, `scripts/announce-deploy.ts`, `scripts/ask-user.ts`
- Test: `tests/chat/announce.test.ts`, `tests/scripts/announceDeploy.test.ts`

**Interfaces:**
- Produces:

```ts
export const OPERATOR_SHA = 'operator'
export function announce(
  db: PlatformDb,
  input: { accountId: number; body: string; at: number },
): void
export function announceDeploy(db: PlatformDb, slug: string, now: () => number):
  { announced: boolean; reason?: 'no_confirmed_spec' | 'already_announced' }
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('announce', () => {
  it('appends an assistant row the friend sees next time they open the page', () => {
    announce(db, { accountId, body: 'Your streak panel is live.', at: 1 })
    expect(readTranscript(db, accountId).at(-1)).toMatchObject({ role: 'assistant', body: 'Your streak panel is live.' })
  })

  it('stamps prompt_sha "operator", so a human message is never mistaken for model output', () => {
    // Every other transcript row's prompt_sha is a content hash of the prompt
    // that produced it. This row had no prompt: a person typed it. The log of
    // record has to be able to tell those apart, permanently.
    announce(db, { accountId, body: 'x', at: 1 })
    expect(readTranscript(db, accountId).at(-1)!.prompt_sha).toBe('operator')
  })

  it('refuses an empty body', () => {
    // An empty body breaks every later turn for that account, forever
    // (lib/chat/history.ts). transcripts cannot be corrected.
    expect(() => announce(db, { accountId, body: '   ', at: 1 })).toThrow()
  })

  it('joins the conversation rather than starting a stray one', () => {
    expect(announce_and_read().conversation_id).toBe(existingConversationId)
  })
})

describe('announceDeploy', () => {
  it('posts the confirmed version\'s change summary', () => {
    announceDeploy(db, 'devtwo', () => 1)
    expect(readTranscript(db, accountId).at(-1)!.body).toContain('Added a streak')
  })

  it('refuses when the account has no confirmed spec', () => {
    expect(announceDeploy(db, 'devone', () => 1)).toMatchObject({ announced: false, reason: 'no_confirmed_spec' })
    expect(readTranscript(db, devoneId)).toHaveLength(0)
  })

  it('is idempotent per spec — a re-deploy does not say it twice', () => {
    // deploy.sh may run several times against the same confirmed version.
    // transcripts is append-only, so a duplicate is permanent.
    announceDeploy(db, 'devtwo', () => 1)
    expect(announceDeploy(db, 'devtwo', () => 2)).toMatchObject({ announced: false, reason: 'already_announced' })
    expect(readTranscript(db, accountId).filter((r) => r.prompt_sha === 'operator')).toHaveLength(1)
  })

  it('announces again after a NEW version is confirmed', () => {
    announceDeploy(db, 'devtwo', () => 1)
    confirmAnother()
    expect(announceDeploy(db, 'devtwo', () => 2).announced).toBe(true)
  })

  it('announces a legacy confirmed spec using its title', () => {
    // A legacy row has no change_summary. Falling back to the title beats
    // saying nothing on the one morning the promise is being kept.
    expect(announceDeploy(db, 'legacyUser', () => 1).announced).toBe(true)
  })
})
```

- [ ] **Step 2: Implement `lib/chat/announce.ts`**

```ts
// lib/chat/announce.ts
//
// The builder speaking through the agent surface: a deploy landing, or a
// mid-build question only the friend can answer. file 02 §4 asks for both to
// arrive in chat, and chat is the log of record, so they are ordinary
// assistant transcript rows.
//
// prompt_sha is the sentinel 'operator' rather than a content hash, because
// this row was typed by a person and no prompt produced it. Every other row
// in the table can be traced to the exact prompt text behind it; this one
// says, permanently, that there was none. transcripts is append-only — the
// distinction has to be right at write time or not at all.
export const OPERATOR_SHA = 'operator'
```

`announce` throws on a blank body (an empty body breaks every later turn for that account, and the row cannot be deleted), resolves the conversation with `conversationIdFor`, uses `sessionId: OPERATOR_SHA` (no session exists), and appends with `appendTranscript`.

`announceDeploy` reads `currentSpec`, refuses when there is none, checks for an existing `deploy_announced` metric carrying that `spec_id`, composes the body from `change_summary` (current shape) or `title` (legacy), calls `announce`, and appends a `deploy_announced` metric with `{ spec_id, version }`.

- [ ] **Step 3: Write the two CLI entry points**

Both follow `scripts/export-spec.ts`'s shape exactly: `openPlatformDb(process.env.PLATFORM_DB ?? …)`, `try/finally` close, non-zero exit with a usage line on bad args. Head both with the same "THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico" comment `export-spec.ts` carries.

```
npx tsx scripts/announce-deploy.ts <slug>
npx tsx scripts/ask-user.ts <slug> "<question>"
```

Neither is wired into `deploy/deploy.sh`. **This is deliberate** — `deploy.sh` deploys the whole service, not one user's dashboard, and a deploy that also posted "your streak panel is live" into every account's chat would be a lie in an append-only log for every account that was not the reason for the deploy. It is a one-line command Nico runs when a specific user's build ships, and it goes in `docs/local-dev.md` with the exact command to copy.

- [ ] **Step 4: Run, red-test control, commit**

Run: `npx vitest run tests/chat/announce.test.ts tests/scripts && npx tsc --noEmit`. Remove the already-announced check → exactly the idempotency test reds. Restore. Change `OPERATOR_SHA` to a real sha → exactly the stamp test reds. Restore.

```bash
git add lib/chat/announce.ts scripts/announce-deploy.ts scripts/ask-user.ts tests docs/local-dev.md
git commit -m "Say it in chat when a build lands, in a row nobody will mistake for the model"
```

---

## Task 13: Per-user tests cover the write path

**Files:**
- Create: `users/devtwo/tests/write.test.ts`
- Modify: `platform/templates/dashboard/tests/dashboard.test.ts.tmpl`
- Test: `tests/scripts/newDashboard.test.ts`

File 02 §5: "Per-user `tests/` must cover write paths (inserts, annotation joins), not just rendering." Today `users/devtwo/tests/` covers reads and the seed; the only write-path coverage lives in `tests/routing/walkRoute.test.ts`, which is platform scope.

- [ ] **Step 1: Write `users/devtwo/tests/write.test.ts`**

Build a temp database from `users/devtwo/schema.sql` (not from `synthetic.db` — the point is to exercise the shape a real write lands in), insert through the same `INSERT OR IGNORE INTO walks (day, at)` statement the walk route uses, and assert `queries.ts` reads it back:

```ts
it('a tap becomes a walked day the queries can see', () => {
  insertWalk(db, '2026-08-13')
  expect(walkedOn(db, '2026-08-13')).toBe(true)
})

it('a second tap on the same day changes nothing', () => {
  // Idempotent by primary key, not by a read-then-write. If this ever needed
  // a check-then-insert, a double tap would race.
  insertWalk(db, '2026-08-13')
  insertWalk(db, '2026-08-13')
  expect(countWalks(db)).toBe(1)
})

it('a fresh insert extends the streak the panel renders', () => {
  // The composed product, not the halves: step 6a's headline defect existed
  // only where the write path and the read path met.
  insertWalk(db, '2026-08-12')
  insertWalk(db, '2026-08-13')
  expect(currentStreak(db, '2026-08-13')).toBe(2)
})

it('the 30-day rate moves when a day is logged', () => {
  const before = last30(db, '2026-08-13').walked
  insertWalk(db, '2026-08-13')
  expect(last30(db, '2026-08-13').walked).toBe(before + 1)
})
```

- [ ] **Step 2: Add a write-path stub to the scaffold template**

`platform/templates/dashboard/tests/dashboard.test.ts.tmpl` gains a commented block showing the same pattern, so a scaffolded dashboard starts with the shape rather than acquiring it later. Add an assertion in `tests/scripts/newDashboard.test.ts` that the scaffolded test file mentions the write path.

**Not added to the `tests/users/conventions.test.ts` sweep, and this is a deliberate limit:** the sweep cannot tell whether a dashboard *has* a write path — that lives in a platform route and in the spec version, neither of which is a file in the user's folder. Demanding a write test of a read-only dashboard like `devone` would be a false failure. It is a convention plus a scaffold, enforced by review, not a gate. Recorded in the ledger's residuals when the branch lands.

- [ ] **Step 3: Run and commit**

Run: `npx vitest run users/devtwo tests/scripts/newDashboard.test.ts`

```bash
git add users/devtwo/tests/write.test.ts platform/templates tests/scripts/newDashboard.test.ts
git commit -m "Prove a tap reaches the panel, not just that the panel renders"
```

---

## Task 14: The living documents

**Files:**
- Modify: `architecture-overview.md`, `CLAUDE.md`
- Test: none — both are Gate-B exempt by path.

- [ ] **Step 1: `architecture-overview.md`, the six §6 edits**

1. **§5 "The agent's core job"** → retitle "The agent's core job — PM for one stakeholder". Reframe: the agent is product manager for a product with exactly one stakeholder, working over a single living versioned spec. Keep monitoring-first and goals-optional intact in substance. Remove "tweak requests" as a distinct category from the bullet on iteration. Add the product-identity convention: each user's product is a bespoke personal app whose screens may serve any rhythm — glanced at over coffee, or used in the moment before and after a practice session — with one invariant, **every app has a morning surface**, the glanceable daily front door, designed for every user because it is the retention instrument the hypothesis at the top of this document measures.
2. **§6 "Tweak loop"** → retitle "The proposal loop" and rewrite to the §1 ladder: chat → discovery proportional to ambiguity → readiness gate → `propose_spec` → validated version N+1 appended → preview card leading with what changed → confirm → ntfy → build to "make the code match vN+1" → deploy → the agent announces in chat → loop. State that first interview, new screen, and relabel are the same journey at different diff sizes. Replace the deferred message-mirror/approval-gate bullet: the confirmed version *is* the approval gate, and it is never optional.
3. **§2 "Data layer"** → add: dashboards may render entry widgets; the widget POSTs to a platform route, which holds the only writable handle and the four ordered checks; annotations on synced rows live in the user's own tables keyed to those rows, never as edits to shared-module tables — the shared-module rule applied to writes, so a login sync or re-pull cannot trample them.
4. **§1** (the interview → spec bullet) → spec versions are whole-surface; every change ships through a confirmed version including small ones; the preview leads with what changed.
5. **System-shape diagram** → one loop instead of "first-join interview, goal planning, tweak requests"; add the deploy-announcement arrow back into chat; change the `/users/<name>/` note for `spec.md` to "agent-emitted, user-confirmed build spec — rendered from the latest confirmed version"; note the admin portal's three panes as transcripts, spec versions with diffs, and metrics (the request queue is superseded — ledger D12).
6. **§9 Metrics** → add spec-version diffs as a first-class metric artifact: the structural diff between a confirmed version and its base replaces classifying chat text, and is what settles the expressible-as-config versus needed-custom-code question.

Also correct §7's "request queue" pane description and add a line noting the `requests` table is unused and superseded.

- [ ] **Step 2: `CLAUDE.md`**

Add to the spec/dashboard conventions:

- A spec version is whole-surface; `specs.payload` holds it; version is derived from row position and `based_on_version` is supplied by the server, never by the model.
- Rows written before the unified loop are legacy and can never be rewritten — `specs` rejects UPDATE. Read every stored payload through `lib/spec/stored.ts`.
- Prompt files are added, never edited (already implied; state it in CLAUDE.md too, since `prompt_sha` traceability is a data-safety property).
- A dashboard may render an entry widget, but the form POSTs to a platform route — the read-only-handle rule is unchanged and unweakened.
- Annotations on synced rows live in the user's own tables keyed to those rows, never as edits to shared-module tables.
- Per-user `tests/` cover write paths, not only rendering (convention + scaffold, not a sweep gate).
- Metrics carry counts, never spec content — the existing "metrics never carry user values" rule, extended to spec diffs.
- Under **Sacred data**, name the consequence: `deploy_announced` rows are not disposable telemetry — `announceDeploy` reads them to decide whether it has already spoken, so pruning one makes a weeks-old build announce itself again into an append-only transcript. Ledger D16.

- [ ] **Step 3: Full gate run**

```bash
npx vitest run
npx tsc --noEmit
npx next build
.claude/hooks/test-hooks.sh
```

All four must pass. Per this project's memory: these are four separate layers and none implies another — run each explicitly.

- [ ] **Step 4: Commit**

```bash
git add architecture-overview.md CLAUDE.md
git commit -m "Write down that there is one loop now"
```

---

## Self-review against the spec

**Coverage.** File 02 §1 unified loop → Tasks 6, 10, 14. §2 whole-surface versioning → Tasks 1, 2, 8, 10. §3 emission path, validation-retry gate, current-version input, separate mockup, proportional preview, always-confirm → Tasks 6, 7, 9, 10. §3's critique pass → deliberately deferred, ledger D8. §4 post-build announcements and blocker questions → Task 12. §5 entry widgets, annotations, per-user write tests → Tasks 1 (schema), 13 (tests), 14 (conventions); the generalized write route is out of scope, ledger D10. §6 all six doc edits → Task 14. §7 all three assumptions → ledger R1–R3. §8 out-of-scope list respected: no multi-dashboard, no build automation, no watchers, encryption/Plaid/synthetic/admin-read-only/ntfy untouched. File 03 schema → Tasks 1, 2; all four "additional invariants" tested in Task 2; diffing → Task 4; rendering → Task 5; migration note → ledger D4.

**Type consistency.** `SpecDraft` (model-authored) vs `SpecVersion` (`SpecDraft & { based_on_version }`) is the single distinction the whole plan turns on: `parseSpecDraft` returns the first, `sealVersion` produces the second, `parseSpecVersion` returns the second. `CardSpec`/`StoredSpec` are the same two-arm union under two names — `StoredSpec` is what `lib/spec/stored.ts` returns, `CardSpec` is the client-safe alias ChatPanel imports type-only; Task 9 must define `CardSpec` as `StoredSpec` re-exported, not as a parallel declaration that can drift.

**One deviation from the spec's letter, recorded:** `03-spec-schema.md` marks `context_of_use`, `entry`, and `annotates` optional. They are required-and-nullable here. Structured outputs constrain the response, and a field the model may omit is one it will omit — an explicit `null` is a decision, an absent key is an accident. The validator's message says so.
