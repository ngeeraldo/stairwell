# Change-only specs and `conversation.md` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spec row stops restating the whole dashboard and describes only the change, written against `users/<slug>/current.md`; `pull-spec.sh` hands the builder the conversation that produced it.

**Architecture:** A new live shape (`lib/spec/change.ts`) carries a server-written `shape: 'change'` tag, which gives `lib/spec/stored.ts` a third arm ahead of its existing `screens`-array test. Everything that reads a shape already in the table — `schema.ts`, `fields.ts`, `patch.ts`, `diff.ts`, `legacy.ts`, `renderSpecMarkdown` — becomes a frozen reader; only the authoring surface is deleted. `authorSpec` stops reading the current spec row entirely and is handed `current.md`'s body as a parameter, from the same read the chat call already does.

**Tech Stack:** TypeScript, Next.js App Router, vitest, better-sqlite3-multiple-ciphers, bash.

**Spec:** `docs/superpowers/specs/2026-08-18-built-is-truth-design.md` — §5, §5.1 and §9 carry this plan's resolutions, dated 2026-08-19.

## Global Constraints

- **This is plan 3 of 3.** Plan 1 (`current.md`) and plan 2 (mockup-loop removal) are merged to `main`. Nothing in this plan reintroduces a mockup, a preview or a confirmation.
- **Do not work on `main`.** The branch is `plan-3`. Run `git branch --show-current` first and stop if it says `main`.
- **Nothing sacred is dropped.** `specs`, `spec_confirmations`, `spec_screen_mockups`, `transcripts` and `metrics` keep their rows and their append-only triggers. `specs.mockup_html` stays a `NOT NULL` column and keeps being written as `''`.
- **`specs` rejects UPDATE.** Every payload shape ever written must keep parsing and rendering forever. That is why §9's deletions are the AUTHORING surface only — see Task 6.
- **Prompt files are added, never edited** once their commit reaches `main`, and never deleted. `spec-v4.md` is a new file; `spec-v2.md` and `spec-v3.md` stay on disk and stop being referenced.
- **Metrics never carry user values.** Every metric row this plan writes carries counts and fixed enum words only — never a panel name, a screen name, or a description.
- **A `description` in a spec is a friend-derived string.** Any error message that interpolates one must be a `SpecShapeError`, so `metricMessage` in `lib/spec/author.ts` redacts it. This is the invariant that has already leaked once (author.ts's own `metricMessage` docstring).
- Tests run with `npx vitest run` (scope with a path). Gate B: a commit touching `app/`, `lib/`, `platform/`, `scripts/`, `middleware.ts` needs a test under `tests/`.
- **No test in the default suite may reach the network.** Clients are injected parameters.

---

### Task 1: The change shape

**Files:**
- Create: `lib/spec/change.ts`
- Modify: `lib/spec/fields.ts` (export three more helpers)
- Modify: `lib/spec/schema.ts` (header comment only)
- Test: `tests/spec/change.test.ts`

**Interfaces:**
- Consumes: `SpecShapeError`, `DataRequirement`, `REQUIREMENT_STATUSES` from `@/lib/spec/schema`; `record`, `text`, `textList`, `arrayField`, `nonEmptyArray`, `oneOf`, `requirement` from `@/lib/spec/fields`.
- Produces:
  - `CHANGE_ACTIONS`, `ChangeAction`, `CHANGE_TARGETS`, `ChangeTarget`
  - `SpecChangeEntry = { action, target, name, description }`
  - `SpecChangeDraft = { change_summary, changes, data_requirements, open_questions }`
  - `SpecChange = SpecChangeDraft & { shape: 'change'; based_on_version: number | null }`
  - `SPEC_CHANGE_JSON_SCHEMA`
  - `parseSpecChangeDraft(raw: unknown): SpecChangeDraft` — validates MODEL output
  - `sealChange(draft: SpecChangeDraft, basedOnVersion: number | null): SpecChange`
  - `parseStoredChange(json: string): SpecChange` — validates a STORED row

`lib/spec/fields.ts` currently keeps `oneOf`, `nonEmptyArray` and `requirement` private. Export them rather than writing second copies: `requirement` in particular is the `data_requirements` parser, and two implementations of it would be two answers to "is `status` valid".

- [ ] **Step 1: Write the failing test**

Create `tests/spec/change.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import {
  parseSpecChangeDraft,
  parseStoredChange,
  sealChange,
  SPEC_CHANGE_JSON_SCHEMA,
} from '@/lib/spec/change'

/** What the model is asked for. No `shape`, no `based_on_version` — both are
 *  the server's to write. */
const DRAFT = {
  change_summary: 'Adds a weekly average and drops the time-of-day panel.',
  changes: [
    {
      action: 'add',
      target: 'panel',
      name: 'Weekly average',
      description:
        'On the main screen, under the streak. Averages the last seven logged days and ignores days before they started.',
    },
    {
      action: 'remove',
      target: 'panel',
      name: 'Time of day',
      description: 'They stopped using it.',
    },
  ],
  data_requirements: [
    { table: 'walk_log', purpose: 'One row per logged day.', status: 'unchanged' },
  ],
  open_questions: [],
}

describe('parseSpecChangeDraft', () => {
  it('accepts a well-formed draft', () => {
    const draft = parseSpecChangeDraft(DRAFT)
    expect(draft.changes).toHaveLength(2)
    expect(draft.changes[0]!.action).toBe('add')
    expect(draft.changes[0]!.target).toBe('panel')
    expect(draft.changes[1]!.name).toBe('Time of day')
    expect(draft.data_requirements[0]!.status).toBe('unchanged')
  })

  it('rejects an empty changes list', () => {
    // A spec that changes nothing is not a proposal. The agent should not
    // have been called, and a row saying so is permanent.
    expect(() => parseSpecChangeDraft({ ...DRAFT, changes: [] })).toThrow(/changes is empty/)
  })

  it('rejects an unknown action', () => {
    const bad = { ...DRAFT, changes: [{ ...DRAFT.changes[0], action: 'tweak' }] }
    expect(() => parseSpecChangeDraft(bad)).toThrow(/action is not one of add, change, remove/)
  })

  it('rejects an unknown target', () => {
    const bad = { ...DRAFT, changes: [{ ...DRAFT.changes[0], target: 'value' }] }
    expect(() => parseSpecChangeDraft(bad)).toThrow(/target is not one of screen, panel/)
  })

  it('rejects a blank description', () => {
    const bad = { ...DRAFT, changes: [{ ...DRAFT.changes[0], description: '   ' }] }
    expect(() => parseSpecChangeDraft(bad)).toThrow(/description is empty/)
  })

  it('rejects a model-authored shape tag', () => {
    // The tag is what readStoredSpec discriminates on. A model that could
    // write it could make a row claim to be something it is not, permanently.
    expect(() => parseSpecChangeDraft({ ...DRAFT, shape: 'change' })).toThrow(/shape is supplied by the server/)
  })

  it('rejects a model-authored based_on_version', () => {
    expect(() => parseSpecChangeDraft({ ...DRAFT, based_on_version: 3 })).toThrow(
      /based_on_version is supplied by the server/,
    )
  })

  it('names the failing path', () => {
    const bad = { ...DRAFT, changes: [DRAFT.changes[0], { ...DRAFT.changes[1], name: '' }] }
    // The message goes back to the model on the retry attempt, so it has to
    // say WHICH entry failed, not just that one did.
    expect(() => parseSpecChangeDraft(bad)).toThrow(/changes\[1\]\.name/)
  })
})

describe('sealChange and parseStoredChange', () => {
  it('round-trips through JSON', () => {
    const sealed = sealChange(parseSpecChangeDraft(DRAFT), 2)
    expect(sealed.shape).toBe('change')
    expect(sealed.based_on_version).toBe(2)

    const read = parseStoredChange(JSON.stringify(sealed))
    expect(read).toEqual(sealed)
  })

  it('accepts a null lineage pointer for a first version', () => {
    const sealed = sealChange(parseSpecChangeDraft(DRAFT), null)
    expect(parseStoredChange(JSON.stringify(sealed)).based_on_version).toBeNull()
  })

  it('refuses a stored row that is not tagged', () => {
    const untagged = { ...sealChange(parseSpecChangeDraft(DRAFT), 1), shape: undefined }
    expect(() => parseStoredChange(JSON.stringify(untagged))).toThrow(SpecShapeError)
  })

  it('refuses a non-integer lineage pointer', () => {
    const sealed = { ...sealChange(parseSpecChangeDraft(DRAFT), 1), based_on_version: 1.5 }
    expect(() => parseStoredChange(JSON.stringify(sealed))).toThrow(/based_on_version/)
  })

  it('throws SpecShapeError on unparsable JSON', () => {
    expect(() => parseStoredChange('{')).toThrow(SpecShapeError)
  })
})

describe('SPEC_CHANGE_JSON_SCHEMA', () => {
  it('requires every field and forbids extras', () => {
    // Structured outputs constrain the response; a field the model may omit
    // is a field it will omit. additionalProperties:false is what stops it
    // inventing a `screens` key that would make readStoredSpec pick the
    // wrong arm.
    expect(SPEC_CHANGE_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(SPEC_CHANGE_JSON_SCHEMA.required).toEqual([
      'change_summary',
      'changes',
      'data_requirements',
      'open_questions',
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/spec/change.test.ts`
Expected: FAIL — `lib/spec/change.ts` does not exist.

- [ ] **Step 3: Export the shared helpers from `fields.ts`**

At the bottom of `lib/spec/fields.ts`, extend the existing re-export line and its comment:

```typescript
// Exported because validate.ts still needs them directly (record/text for
// parseMockupInput and parseSpecVersion's based_on_version check; draftFrom
// for re-validating a stored payload without re-checking based_on_version;
// arrayField for parseScreenMockups' `screens` array).
// textList and integer are exported for lib/spec/patch.ts, which reuses them
// for its own open_questions and update_screen.order fields.
//
// oneOf, nonEmptyArray and requirement are exported for lib/spec/change.ts —
// the LIVE shape. This file is otherwise a frozen reader (see its header),
// and handing out a string-validation helper is not authoring a new shape.
// `requirement` in particular must not be copied: two implementations of the
// data_requirements parser would be two answers to "is this status valid".
export { record, text, textList, integer, arrayField, oneOf, nonEmptyArray, requirement }
```

- [ ] **Step 4: Write `lib/spec/change.ts`**

```typescript
// lib/spec/change.ts
//
// THE LIVE SPEC SHAPE. A spec row describes the CHANGE a friend asked for,
// against the dashboard as it exists — which is users/<slug>/current.md, not
// a previous spec row. It does not restate the whole surface, and it carries
// no ids.
//
// Everything else under lib/spec/ is a reader for a shape already in the
// table: schema.ts, fields.ts, patch.ts, diff.ts and legacy.ts. `specs`
// rejects UPDATE, so those rows can never be rewritten and their parsers can
// never be retired. The boundary between "authored now" and "only ever read"
// is this file's existence — see the design doc, §9.
//
// `shape` is what lib/spec/stored.ts discriminates on, and it is SERVER-
// WRITTEN. parseSpecChangeDraft rejects a model that tries to author it, for
// the same reason it rejects an authored based_on_version: a model-supplied
// discriminator is a hallucination becoming a permanent row in an append-only
// table (unified-loop ledger D2).
import {
  REQUIREMENT_STATUSES,
  SpecShapeError,
  type DataRequirement,
} from './schema'
import { arrayField, nonEmptyArray, oneOf, record, requirement, text, textList } from './fields'

export const CHANGE_ACTIONS = ['add', 'change', 'remove'] as const
export type ChangeAction = (typeof CHANGE_ACTIONS)[number]

export const CHANGE_TARGETS = ['screen', 'panel'] as const
export type ChangeTarget = (typeof CHANGE_TARGETS)[number]

/**
 * One thing that changes.
 *
 * `name` is what the friend calls it, never an id: there are no ids in this
 * shape. `description` is PROSE and carries everything a typed sub-object
 * used to — what the panel shows, how it behaves, what feeds it, when it is
 * looked at. Without ids there is nothing for a `values[]` entry's `inputs`
 * or an entry widget's `annotates` to point at, and the cross-field
 * invariants those needed (lib/spec/fields.ts's checkInvariants) existed to
 * protect the diff — which a change-only spec IS. `data_requirements` below
 * stays structured, because "which tables does this need" is the part a
 * validator can still usefully hold.
 */
export type SpecChangeEntry = {
  action: ChangeAction
  target: ChangeTarget
  name: string
  description: string
}

/** What the model authors. */
export type SpecChangeDraft = {
  change_summary: string
  changes: SpecChangeEntry[]
  data_requirements: DataRequirement[]
  open_questions: string[]
}

export const CHANGE_SHAPE = 'change'

/** What gets stored: the draft, the discriminator, and the server-supplied
 *  lineage pointer. */
export type SpecChange = SpecChangeDraft & {
  shape: typeof CHANGE_SHAPE
  based_on_version: number | null
}

const str = { type: 'string' } as const

/**
 * `additionalProperties: false` is load-bearing beyond tidiness: a reply that
 * invented a `screens` key would be read by lib/spec/stored.ts as the OLD
 * whole-surface shape, permanently, since `specs` rejects UPDATE.
 *
 * No minItems: it is outside the supported structured-output subset and would
 * be silently ignored. "At least one change" is enforced in the validator.
 */
export const SPEC_CHANGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    change_summary: str,
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: CHANGE_ACTIONS },
          target: { type: 'string', enum: CHANGE_TARGETS },
          name: str,
          description: str,
        },
        required: ['action', 'target', 'name', 'description'],
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
    open_questions: { type: 'array', items: str },
  },
  required: ['change_summary', 'changes', 'data_requirements', 'open_questions'],
} as const

function changeEntry(raw: unknown, at: string): SpecChangeEntry {
  const src = record(raw, at)
  return {
    action: oneOf(text(src, 'action', at), CHANGE_ACTIONS, `${at}.action`),
    target: oneOf(text(src, 'target', at), CHANGE_TARGETS, `${at}.target`),
    name: text(src, 'name', at),
    description: text(src, 'description', at),
  }
}

/** The four fields, from an already-checked object. Shared by the model-output
 *  validator and the stored-row reader, so the two can never diverge about
 *  what a change is. */
function draftFrom(src: Record<string, unknown>): SpecChangeDraft {
  return {
    change_summary: text(src, 'change_summary', 'spec'),
    changes: nonEmptyArray(src, 'changes', 'spec').map((c, i) => changeEntry(c, `changes[${i}]`)),
    data_requirements: arrayField(src, 'data_requirements', 'spec').map((r, i) =>
      requirement(r, `data_requirements[${i}]`),
    ),
    open_questions: textList(src, 'open_questions', 'spec'),
  }
}

/** Validate MODEL output. Rejects both server-written fields outright. */
export function parseSpecChangeDraft(raw: unknown): SpecChangeDraft {
  const src = record(raw, 'spec')
  if ('shape' in src) {
    throw new SpecShapeError('shape is supplied by the server and must not be authored')
  }
  if ('based_on_version' in src) {
    throw new SpecShapeError('based_on_version is supplied by the server and must not be authored')
  }
  return draftFrom(src)
}

/** Attach the discriminator and the lineage pointer. The only place a
 *  SpecChange is constructed. */
export function sealChange(draft: SpecChangeDraft, basedOnVersion: number | null): SpecChange {
  return { ...draft, shape: CHANGE_SHAPE, based_on_version: basedOnVersion }
}

/**
 * Re-validate a stored payload on the way out of the database.
 *
 * Checks the tag itself rather than trusting the caller's dispatch: this
 * function must be independently correct, so that a row reaching it by any
 * route is proven to be what it claims.
 */
export function parseStoredChange(json: string): SpecChange {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }
  const src = record(parsed, 'spec')
  if (src.shape !== CHANGE_SHAPE) {
    throw new SpecShapeError(`shape is not "${CHANGE_SHAPE}"`)
  }
  const based = src.based_on_version
  if (based !== null && (typeof based !== 'number' || !Number.isInteger(based))) {
    throw new SpecShapeError('based_on_version is neither an integer nor null')
  }
  return sealChange(draftFrom(src), based)
}
```

- [ ] **Step 5: Mark `schema.ts` as a frozen reader with live vocabulary**

Replace the first paragraph of `lib/spec/schema.ts`'s header comment with:

```typescript
// lib/spec/schema.ts
//
// FROZEN, in the same sense lib/spec/legacy.ts is — with one exception named
// below. `Screen`, `Panel`, `ValueSpec`, `EntryWidget`, `SpecDraft` and
// `SpecVersion` describe the WHOLE-SURFACE shape, which nothing authors any
// more (lib/spec/change.ts owns what is written now). They stay because
// `specs` rejects UPDATE: rows in this shape can never be rewritten, and
// parseSpecVersion re-validates every one of them on the way out.
//
// THE EXCEPTION, and it is deliberate: `SpecShapeError`, `DataRequirement`
// and `REQUIREMENT_STATUSES` are shared, live vocabulary. lib/spec/change.ts
// imports all three, the same way frozen legacy.ts already imports
// SpecShapeError from here. An error class and a data-requirement status are
// not a payload shape.
//
// The shape of one spec VERSION: a whole-surface description of a person's
// dashboard, as it would be after the change being proposed.
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/spec/`
Expected: PASS, including the pre-existing `fields`, `schema`, `validate`, `patch` and `applyPatch` suites — nothing in this task changes their behaviour.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/spec/change.ts lib/spec/fields.ts lib/spec/schema.ts tests/spec/change.test.ts
git commit -m "Add the change-only spec shape

A spec row now describes the change against the dashboard as built, not the
whole surface. shape: 'change' is server-written and is what lib/spec/stored.ts
will discriminate on; the draft validator rejects a model that authors it, the
same as it already rejects based_on_version."
```

---

### Task 2: Render a change spec

**Files:**
- Modify: `lib/spec/render.ts`
- Test: `tests/spec/render.test.ts`

**Interfaces:**
- Consumes: `SpecChange`, `ChangeAction`, `ChangeTarget` from `@/lib/spec/change`.
- Produces: `renderChangeMarkdown(change: SpecChange, meta: RenderMeta): string`, where `RenderMeta` is `render.ts`'s existing `{ slug, version, confirmedAt }`.

The two existing renderers are unchanged. `renderSpecMarkdown` becomes frozen alongside `renderLegacyMarkdown` — the admin pane and a re-pull of an old spec both still go through it, and a re-export must not produce a diff nobody asked for.

- [ ] **Step 1: Write the failing test**

Append to `tests/spec/render.test.ts`:

```typescript
import { renderChangeMarkdown } from '@/lib/spec/render'
import { parseSpecChangeDraft, sealChange } from '@/lib/spec/change'

describe('renderChangeMarkdown', () => {
  const CHANGE = sealChange(
    parseSpecChangeDraft({
      change_summary: 'Adds a weekly average.',
      changes: [
        {
          action: 'add',
          target: 'panel',
          name: 'Weekly average',
          description: 'Under the streak. Mean of the last seven logged days.',
        },
        {
          action: 'remove',
          target: 'screen',
          name: 'History',
          description: 'They never opened it.',
        },
      ],
      data_requirements: [
        { table: 'walk_log', purpose: 'One row per logged day.', status: 'unchanged' },
      ],
      open_questions: ['Should the average ignore weekends?'],
    }),
    2,
  )
  const META = { slug: 'devtwo', version: 3, confirmedAt: 1_700_000_000_000 }

  it('leads with the slug and version, not a model-authored title', () => {
    // title/summary/background do not exist on this shape (design §5.0.1).
    // The H1 is a fact about the file, so it cannot go stale or be renamed
    // by a model between versions.
    expect(renderChangeMarkdown(CHANGE, META)).toContain('# devtwo — spec v3')
  })

  it('carries the do-not-hand-edit banner, like the other renderers', () => {
    expect(renderChangeMarkdown(CHANGE, META)).toContain('Do not hand-edit')
  })

  it('renders each change with its action, target and name', () => {
    const md = renderChangeMarkdown(CHANGE, META)
    expect(md).toContain('### Add panel — Weekly average')
    expect(md).toContain('### Remove screen — History')
    expect(md).toContain('Mean of the last seven logged days.')
  })

  it('renders data requirements and open questions', () => {
    const md = renderChangeMarkdown(CHANGE, META)
    expect(md).toContain('`walk_log` — unchanged — One row per logged day.')
    expect(md).toContain('- Should the average ignore weekends?')
  })

  it('says _None._ for an empty open questions list', () => {
    const empty = sealChange({ ...CHANGE, open_questions: [] }, 2)
    expect(renderChangeMarkdown(empty, META)).toContain('_None._')
  })

  it('escapes a heading a friend wrote inside a description', () => {
    // Same guarantee as the other two renderers: line-leading markdown
    // structure from text of unknown provenance is neutralised, and the
    // attack has to start on its own line for a single-line fixture to prove
    // anything (see renderPanel's docstring).
    const attack = sealChange(
      parseSpecChangeDraft({
        change_summary: 'Fine.',
        changes: [
          {
            action: 'add',
            target: 'panel',
            name: 'Fine',
            description: 'First line.\n# pwned',
          },
        ],
        data_requirements: [],
        open_questions: [],
      }),
      null,
    )
    expect(renderChangeMarkdown(attack, META)).toContain('\\# pwned')
  })
})
```

The last fixture is built as a fresh literal rather than spread from `CHANGE`: `parseSpecChangeDraft` rejects a `shape` or `based_on_version` key outright, and `CHANGE` is already sealed with both. The attack has to start on its own line — a single-line fixture goes green whether the escaping is there or not, and would pin nothing (see `renderPanel`'s docstring in the same file).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/spec/render.test.ts`
Expected: FAIL — `renderChangeMarkdown` is not exported.

- [ ] **Step 3: Implement**

Add to `lib/spec/render.ts`, after `renderSpecMarkdown`. It reuses this file's existing module-scoped `safeMarkdown` and `list` — one implementation of the escaping rule, for the reason `safeMarkdown`'s own docstring gives.

```typescript
/** Sentence-case labels for the three actions, so a heading reads as an
 *  instruction to the builder rather than as an enum. */
const ACTION_LABEL: Record<ChangeAction, string> = {
  add: 'Add',
  change: 'Change',
  remove: 'Remove',
}

/** One change: a heading naming what to do to what, then the description. The
 *  heading carries `name` unescaped-looking but escaped — a name is
 *  model-authored free text like everything else on this shape, unlike the
 *  validated slug ids the frozen renderer above could safely inline. */
function renderChange(change: SpecChangeEntry): string {
  return (
    `### ${ACTION_LABEL[change.action]} ${change.target} — ${safeMarkdown(change.name)}\n\n` +
    safeMarkdown(change.description)
  )
}

/**
 * A change-only spec, as the build contract on disk.
 *
 * The H1 is the slug and the version, not a title: this shape has no `title`
 * (design §5.0.1). That is deliberate rather than a gap — the whole dashboard's
 * name and purpose live in users/<slug>/current.md, and a model-authored title
 * re-emitted on every change is exactly the whole-surface habit this shape
 * removes.
 *
 * Deterministic: a pure function of `change` and `meta`, so a re-pull produces
 * no spurious diff.
 */
export function renderChangeMarkdown(change: SpecChange, meta: RenderMeta): string {
  const changes = change.changes.map(renderChange).join('\n\n')
  const dataRequirements =
    change.data_requirements.length === 0
      ? '_None._'
      : change.data_requirements.map(dataRequirementLine).join('\n')

  return `# ${safeMarkdown(meta.slug)} — spec v${meta.version}

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** ${meta.slug}
- **Spec version:** v${meta.version}
- **Version date:** ${new Date(meta.confirmedAt).toISOString()}
- **Based on:** ${change.based_on_version === null ? 'nothing — this is the first version' : `v${change.based_on_version}`}

## What changed

${safeMarkdown(change.change_summary)}

## Changes

${changes}

## Data requirements

${dataRequirements}

## Open questions

${list(change.open_questions)}
`
}
```

Add the imports at the top of the file:

```typescript
import type { ChangeAction, SpecChange, SpecChangeEntry } from './change'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/spec/render.test.ts`
Expected: PASS, with every pre-existing assertion in that file still green.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/spec/render.ts tests/spec/render.test.ts
git commit -m "Render a change-only spec

The H1 is the slug and version rather than a model-authored title: this shape
has none, because the dashboard's name and purpose live in current.md."
```

---

### Task 3: The third arm on `readStoredSpec`

**Files:**
- Modify: `lib/spec/stored.ts`
- Modify: `lib/chat/announce.ts` (`announceTarget`'s headline)
- Modify: `scripts/export-spec.ts` (renderer choice)
- Modify: `app/admin/[user]/page.tsx` (a third body, open questions, the Spec tab)
- Modify: `lib/spec/author.ts` (`currentVersionBlock`'s unreachable arm — deleted next task)
- Test: `tests/spec/stored.test.ts`, `tests/scripts/exportSpec.test.ts`, `tests/admin/specPane.test.ts`, `tests/chat/announce.test.ts`

**Interfaces:**
- Consumes: `parseStoredChange`, `SpecChange`, `CHANGE_SHAPE` from `@/lib/spec/change`; `renderChangeMarkdown` from `@/lib/spec/render`.
- Produces: `StoredSpec` gains a third member, `{ kind: 'change'; change: SpecChange }`.

**This is the hole the design doc had.** `readStoredSpec` decides today by asking whether `payload.screens` is an array. A change-only row has no `screens`, so every row Task 5 writes would be read as LEGACY and fail the frozen six-field parser — in the admin pane, in `export-spec.ts` and in the announcer alike. Doing it BEFORE anything writes a change row means no commit in this plan can produce a row its own readers reject.

The compiler finds every consumer for you: each one currently does `stored.kind === 'version' ? … : …` and the `else` branch stops type-checking the moment a third member exists.

- [ ] **Step 1: Write the failing test**

In `tests/spec/stored.test.ts`, add a third fixture beside `LEGACY` and `CURRENT`, and a describe block:

```typescript
const CHANGE = JSON.stringify({
  shape: 'change',
  based_on_version: 2,
  change_summary: 'Added a weekly average.',
  changes: [
    {
      action: 'add',
      target: 'panel',
      name: 'Weekly average',
      description: 'Mean of the last seven logged days.',
    },
  ],
  data_requirements: [],
  open_questions: [],
})

describe('readStoredSpec, three arms', () => {
  it('reads a tagged row as a change', () => {
    const stored = readStoredSpec(CHANGE)
    expect(stored.kind).toBe('change')
    if (stored.kind !== 'change') throw new Error('unreachable')
    expect(stored.change.changes[0]!.name).toBe('Weekly average')
    expect(stored.change.based_on_version).toBe(2)
  })

  it('checks the tag BEFORE the screens array', () => {
    // Belt and braces against a payload carrying both. The tag is explicit
    // and a `screens` key on a change row could only be model junk that got
    // past additionalProperties — the tag is the stronger claim, and `specs`
    // rejects UPDATE so whichever arm this picks, it picks forever.
    const both = { ...JSON.parse(CHANGE), screens: [] }
    expect(readStoredSpec(JSON.stringify(both)).kind).toBe('change')
  })

  it('reports a malformed CHANGE row as a change-shape error, not a legacy one', () => {
    const broken = JSON.parse(CHANGE)
    broken.changes = []
    expect(() => readStoredSpec(JSON.stringify(broken))).toThrow(/changes is empty/)
  })

  it('still reads an untagged whole-surface row as a version', () => {
    expect(readStoredSpec(CURRENT).kind).toBe('version')
  })

  it('still reads a pre-unification row as legacy', () => {
    expect(readStoredSpec(LEGACY).kind).toBe('legacy')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/spec/stored.test.ts`
Expected: FAIL — `kind` is `'legacy'` for the tagged row, and the legacy parser rejects it for a missing `panels`.

- [ ] **Step 3: Add the arm**

Rewrite `lib/spec/stored.ts`:

```typescript
// lib/spec/stored.ts
//
// The ONE place anything discriminates between the three payload shapes
// `specs` holds. `specs` rejects UPDATE, so no row can ever be rewritten into
// a newer shape — a pre-unification row is read as legacy forever, and a
// whole-surface row as a version forever (unified-loop ledger, D4). Every
// consumer needs all three arms; each re-implementing the dispatch is three
// chances to get an arm wrong.
import { SpecShapeError, type SpecVersion } from './schema'
import { parseLegacySpecPayload, type LegacySpecPayload } from './legacy'
import { CHANGE_SHAPE, parseStoredChange, type SpecChange } from './change'
import { parseSpecVersion } from './validate'

export type StoredSpec =
  | { kind: 'change'; change: SpecChange }
  | { kind: 'version'; version: SpecVersion }
  | { kind: 'legacy'; payload: LegacySpecPayload }

export function readStoredSpec(json: string): StoredSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }

  const src = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}

  // THE TAG IS CHECKED FIRST, and it is unambiguous in both directions: no
  // row written before change-only specs carries `shape`, no row written
  // after carries `screens`, and neither set can ever move. Checking the tag
  // ahead of the screens array means a payload that somehow carried both is
  // read as what it explicitly claims to be, rather than by inference.
  //
  // Then discriminate on `screens`, then commit. A row that clearly meant to
  // be one shape must report THAT shape's error rather than falling through
  // to the next parser — a reader chasing the wrong schema for a row nobody
  // can fix is worse than a precise failure.
  if (src.shape === CHANGE_SHAPE) return { kind: 'change', change: parseStoredChange(json) }
  if (Array.isArray(src.screens)) return { kind: 'version', version: parseSpecVersion(json) }
  return { kind: 'legacy', payload: parseLegacySpecPayload(json) }
}
```

`CHANGE_SHAPE` is imported from `./change` rather than spelled `'change'` here, so the one literal that decides an arm is declared beside the type it tags.

- [ ] **Step 4: Fix every consumer the compiler names**

Run `npx tsc --noEmit` and work the list. There are four:

**`lib/chat/announce.ts`** — `announceTarget`'s headline:

```typescript
  // Every arm answers "what is this build about" with the best thing it has.
  // A change row and a whole-surface row both carry change_summary; a legacy
  // row has no such field at all, so it falls back to its title. Saying
  // something generic beats saying nothing on the one morning the promise
  // ("your build landed") is being kept.
  const stored = readStoredSpec(spec.payload)
  const headline =
    stored.kind === 'change'
      ? stored.change.change_summary
      : stored.kind === 'version'
        ? stored.version.change_summary
        : stored.payload.title
```

**`scripts/export-spec.ts`** — the renderer choice:

```typescript
  const stored = readStoredSpec(spec.payload)
  const spec_md =
    stored.kind === 'change'
      ? renderChangeMarkdown(stored.change, meta)
      : stored.kind === 'version'
        ? renderSpecMarkdown(stored.version, meta)
        : renderLegacyMarkdown(stored.payload, meta)
```

with `renderChangeMarkdown` added to that file's import from `@/lib/spec/render`.

**`app/admin/[user]/page.tsx`** — three edits.

Add a body component beside `VersionBody` and `LegacyBody`:

```tsx
/**
 * A change-only proposal: what the friend asked to change, and nothing about
 * what already exists. The whole surface is users/<slug>/current.md, which
 * this pane deliberately does not duplicate — a second copy of the current
 * state is a second thing that can be out of date.
 */
function ChangeBody({ change }: { change: SpecChange }) {
  return (
    <>
      <p>{change.change_summary}</p>
      <ul className="mt-2 space-y-1">
        {change.changes.map((entry, index) => (
          <li key={`${entry.target}-${entry.name}-${index}`}>
            <strong>
              {entry.action} {entry.target} — {entry.name}
            </strong>
            <p className="text-muted-foreground">{entry.description}</p>
          </li>
        ))}
      </ul>
      {change.data_requirements.length > 0 && (
        <>
          <h4 className="mt-2 font-medium">Data requirements</h4>
          <ul>
            {change.data_requirements.map((requirement) => (
              <li key={requirement.table}>
                <code>{requirement.table}</code> — {requirement.status} — {requirement.purpose}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
```

In `InlineCard`, replace the two-arm body ternary:

```tsx
          {stored.kind === 'change' ? (
            <ChangeBody change={stored.change} />
          ) : stored.kind === 'version' ? (
            <VersionBody version={stored.version} />
          ) : (
            <LegacyBody payload={stored.payload} />
          )}
```

In `TranscriptPane`, the `openQuestions` prop:

```tsx
                      openQuestions={
                        stored === undefined
                          ? []
                          : stored.kind === 'change'
                            ? stored.change.open_questions
                            : stored.kind === 'version'
                              ? stored.version.open_questions
                              : stored.payload.open_questions
                      }
```

`comparison` needs no change: it is already guarded by `stored?.kind === 'version'`, and that stays exactly right — **a change spec IS the diff**, so there is nothing to compare it against and `compareToBase` must not be reached for one.

And the Spec tab's renderer choice:

```tsx
                  {withoutFileBanner(
                    currentStored.kind === 'change'
                      ? renderChangeMarkdown(currentStored.change, specMeta)
                      : currentStored.kind === 'version'
                        ? renderSpecMarkdown(currentStored.version, specMeta)
                        : renderLegacyMarkdown(currentStored.payload, specMeta),
                  )}
```

The `{ slug, version, confirmedAt }` object is currently built twice, once per
arm, and a third arm would make it three. Build it once, inside the branch that
has already proven `current` is defined — the JSX below `current === undefined ||
currentStored === undefined ? … :` — using an IIFE or by lifting that whole arm
into a small `SpecTab({ user, current, stored })` component beside the other
body components. Either is fine; what matters is that the three renderer calls
share one meta object rather than three copies of the same `confirmed_at ??
at` fallback.

**`lib/spec/author.ts`** — `currentVersionBlock` gains an arm that cannot run:

```typescript
  // UNREACHABLE, and deleted with this whole function by the next task. No
  // change-shaped row can exist yet, because nothing writes one until
  // authoring switches over. The arm is here so the compiler can prove the
  // union is covered; a SpecShapeError so that if it somehow does run, it is
  // redacted by metricMessage like every other spec-content error.
  if (stored.kind === 'change') {
    throw new SpecShapeError('a change-shaped spec has no whole-surface version to show')
  }
```

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run tests/spec tests/admin tests/chat/announce.test.ts tests/scripts/exportSpec.test.ts`
Expected: PASS. `tests/admin/specPane.test.ts` has two comments (lines 159 and 434) asserting that "`screens` is present, so readStoredSpec commits to the CURRENT arm" — those stay true. If any assertion depended on a two-arm union, widen it rather than weakening what it checks.

- [ ] **Step 6: Add a change-row test for the readers**

In `tests/scripts/exportSpec.test.ts`, add one case: seed a spec whose payload is `sealChange(parseSpecChangeDraft({…}), null)` and assert `exportSpec(db, slug).spec_md` contains `## Changes` and the change's name. In `tests/chat/announce.test.ts`, add one case: a change-shaped payload plus a notes file, and assert `announceTarget(...).headline` equals the payload's `change_summary`. Follow each file's existing fixture helpers rather than building new ones.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/spec/stored.ts lib/chat/announce.ts scripts/export-spec.ts \
  'app/admin/[user]/page.tsx' lib/spec/author.ts \
  tests/spec/stored.test.ts tests/scripts/exportSpec.test.ts \
  tests/chat/announce.test.ts tests/admin/specPane.test.ts
git commit -m "Read a change-shaped spec row: three arms, tag checked first

lib/spec/stored.ts discriminated on payload.screens being an array. A
change-only spec has none, so every row the next task writes would have been
read as a pre-unification legacy row and rejected by its parser — in the admin
pane, in export-spec and in the announcer alike. Readers land before writers so
no commit produces a row its own readers refuse."
```

---

### Task 4: `spec-v4.md`

**Files:**
- Create: `platform/prompts/spec-v4.md`
- Modify: `lib/chat/prompt.ts`
- Test: `tests/chat/prompt.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is prose plus one constant.
- Produces: `SPEC_PROMPT = 'spec-v4.md'`. `SPEC_PATCH_PROMPT` is deleted as a constant; `spec-v3.md` stays on disk.

`spec-v2.md` and `spec-v3.md` both describe a "current confirmed version" and a preview card. Nothing confirms and nothing previews. Prompts are added, never edited: this is a new file, and the two old ones are never deleted because `prompt_sha` on existing spec rows names them.

- [ ] **Step 1: Write `platform/prompts/spec-v4.md`**

```markdown
You are writing the CHANGE to one person's dashboard, from the conversation
they just had with the agent.

You are not talking to them. Nobody reads your output as prose — it becomes a
structured record, validated and stored permanently, and it is what the person
and the tool that build the dashboard by hand work from.

## What you are given

The whole conversation for this account, oldest first, and a description of
the dashboard **as it exists right now**, written by the builder after the last
build. That description is the truth about what is deployed. Trust it over
anything earlier in the conversation, including anything the agent said about
what the dashboard does.

If there is no such description, nothing has been built yet and everything you
describe is new.

## What you emit

Only what CHANGES. You are not restating the dashboard — the description you
were given already does that, and a second copy of it is a second thing that
can go out of date.

A panel nobody mentioned this time is a panel you say nothing about. Do not
re-describe it to keep it; re-describing is how it gets subtly reworded into
something nobody asked for.

Four fields: `change_summary`, `changes`, `data_requirements`,
`open_questions`.

## The fields

**change_summary** — what is changing, in plain language, leading with the
change itself. This is the line the friend reads in the deploy announcement
once it is built, so open with the news rather than a recap of the whole
dashboard. Anything you are removing must be named here.

**changes** — at least one entry. Each entry:

- `action` — `add`, `change`, or `remove`.
- `target` — `screen` or `panel`. A screen is a place in the app; a panel is
  one thing to look at on a screen.
- `name` — what the friend calls it. Not an identifier, not a slug: the words
  they would use.
- `description` — everything the builder needs, in prose:
  - For an **add**: what it shows and how, where it goes, what feeds it —
    whether the numbers come from a connected bank account, from something
    they log by hand, or are computed from other numbers — and when and where
    they look at it, if the conversation established that. If it takes input,
    say what they type and how often.
  - For a **change**: what is different now, and what stays. Name it by the
    words the current description uses, so the builder can find it.
  - For a **remove**: which one, and why they no longer want it.

  Write it as sentences, not as a list of field names. The builder reads this
  next to the conversation and the code.

An entry that changes nothing is not an entry. If nothing changed, you should
not have been called.

**data_requirements** — the custom tables this change needs beyond what shared
modules already provide. Anywhere the change introduces something logged by
hand, something computed and stored, or a note against synced data, there is a
table behind it: name it with `table`, `purpose`, and a `status` of `new`,
`changed`, or `unchanged`. An empty list means this change needs nothing new.

**open_questions** — anything you could not resolve in conversation: a
feasibility question only the builder can answer, a decision only Nico can
make, anything you are unsure is possible. This is read first and treated as a
to-do list. An empty list is a real, complete answer — never invent items to
fill it.

## What the dashboard can be built from

Bank and card data, if they connect an account. Anything they choose to log by
hand. Anything computed from those two. That is the whole list.

Investments and liabilities are not connected. Anything that would need either
is not a panel — it belongs in `open_questions`, named plainly rather than
guessed at.

## Restraint

Only describe changes the conversation supports. Do not round out the
dashboard with sensible additions nobody asked for — an unasked-for panel is a
promise made on someone's behalf.

If the description you were given says something was deliberately left out,
that was a decision. Do not propose it again unless they asked for it again in
this conversation.

## No mockup, no preview, nothing to confirm

Nobody sees a drawing of this before it is built, and nobody presses a button
to approve it. What you write is what gets built. Do not refer to a preview, a
card, or a confirmation anywhere in your output.
```

- [ ] **Step 2: Point the constant at it**

In `lib/chat/prompt.ts`, replace the `SPEC_PROMPT` docstring and value, and delete the `SPEC_PATCH_PROMPT` export entirely:

```typescript
/**
 * The spec-authoring prompt. Separate from the interview prompt so the output
 * contract can be iterated without touching interview wording, and so the two
 * eras stay separable in the record.
 *
 * v4 makes the spec change-only. The writer's base is users/<slug>/current.md
 * — the builder's description of what is actually deployed — instead of the
 * previous spec row, which was a prediction written before any code existed.
 * It emits change_summary, changes, data_requirements and open_questions:
 * no ids, no whole-surface restatement, and no title/summary/background,
 * which current.md now answers.
 *
 * It also drops two false premises v2 and v3 both carried: a "current
 * confirmed version" (nothing confirms) and a preview card the change_summary
 * would appear in (nothing previews).
 *
 * spec-v2.md and spec-v3.md stay on disk. spec-v3.md was SPEC_PATCH_PROMPT,
 * used when a current-shape version existed to patch; there is one authoring
 * path now, so that constant is gone while the file it named is not —
 * prompt_sha on existing spec rows points at both.
 */
export const SPEC_PROMPT = 'spec-v4.md'
```

- [ ] **Step 3: Run the prompt tests**

Run: `npx vitest run tests/chat/prompt.test.ts`
Expected: PASS. That suite sweeps `platform/prompts/*.md` from disk, so v4 is covered without an edit. If it enumerates the exported constants, drop `SPEC_PATCH_PROMPT` from that list.

- [ ] **Step 4: Verify no reference survives**

```bash
grep -rn "SPEC_PATCH_PROMPT" --include='*.ts' --include='*.tsx' app lib scripts tests
```
Expected: only `lib/spec/author.ts`, which Task 5 rewrites. If it prints nothing else, the constant's removal is contained.

Note: this commit leaves `lib/spec/author.ts` importing a constant that no longer exists, so it does not typecheck on its own. Commit it with `SKIP_TYPECHECK=1` and the reason in the message — Task 5 is the other half and lands immediately after.

- [ ] **Step 5: Commit**

```bash
git add platform/prompts/spec-v4.md lib/chat/prompt.ts tests/chat/prompt.test.ts
SKIP_TYPECHECK=1 git commit -m "spec-v4: write the change, against current.md

The base is the builder's description of what is deployed, not the previous
spec row. Drops the whole-surface restatement, the ids, and two premises v2 and
v3 both still carried: a confirmed version and a preview card.

SKIP_TYPECHECK: lib/spec/author.ts still imports the deleted SPEC_PATCH_PROMPT.
The next task rewrites that file and restores a clean tsc."
```

---

### Task 5: Author a change

**Files:**
- Modify: `lib/spec/author.ts`
- Modify: `lib/chat/turn.ts` (one field on the `authorSpec` call)
- Test: `tests/spec/author.test.ts`, `tests/chat/turn.test.ts`

**Interfaces:**
- Consumes: `SPEC_CHANGE_JSON_SCHEMA`, `parseSpecChangeDraft`, `sealChange`, `SpecChangeDraft` from `@/lib/spec/change`; `SPEC_PROMPT` from `@/lib/chat/prompt`.
- Produces:
  - `Proposal = { id: number; version: number; at: number }` — `spec` is dropped.
  - `AuthorInput = { accountId, conversationId, signal, currentState: string | null }`.
  - Metric rows carrying `authoring_mode: 'change'` and `changes_count: number | null`.

**Why `currentState` is a parameter.** `authorSpec` is handed an `accountId`, not a slug, and has no business touching the filesystem. `app/api/chat/route.ts` already reads `current.md` for the chat call itself (line ~150) and passes the body into `runTurn` as `input.currentState`. Threading the same value on to `authorSpec` means **one read and two consumers**: the agent and the spec writer cannot disagree about what the dashboard currently is.

`Proposal.spec` is read nowhere but `tests/spec/author.test.ts` — the card that consumed it is gone. Drop the field rather than converting it.

- [ ] **Step 1: Write the failing test**

`tests/spec/author.test.ts` already has a fake `ChatClient`, a temp platform db, and helpers for driving `authorSpec`. Reuse them. Add:

```typescript
import { parseStoredChange } from '@/lib/spec/change'

/** A well-formed change, as the model would return it. */
const CHANGE_INPUT = {
  change_summary: 'Adds a weekly average.',
  changes: [
    {
      action: 'add',
      target: 'panel',
      name: 'Weekly average',
      description: 'Under the streak. Mean of the last seven logged days.',
    },
  ],
  data_requirements: [],
  open_questions: [],
}

describe('authorSpec writes a change', () => {
  it('stores a tagged change payload', async () => {
    const proposal = await authorSpec(deps({ input: CHANGE_INPUT }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: '## What this is for\nA walk tracker.\n',
    })
    expect(proposal).toBeDefined()
    const change = parseStoredChange(readSpecs(db, 1)[0]!.payload)
    expect(change.shape).toBe('change')
    expect(change.changes[0]!.name).toBe('Weekly average')
  })

  it('supplies based_on_version from the record, never from the model', async () => {
    // One spec already exists in this account, so the next is based on v1.
    // The model is not asked for it and cannot author it — parseSpecChangeDraft
    // rejects the key outright.
    await authorSpec(deps({ input: CHANGE_INPUT }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: null,
    })
    await authorSpec(deps({ input: CHANGE_INPUT }), {
      accountId: 1,
      conversationId: 'c2',
      signal: new AbortController().signal,
      currentState: null,
    })
    const newest = parseStoredChange(readSpecs(db, 1)[0]!.payload)
    expect(newest.based_on_version).toBe(1)
  })

  it('puts current.md in front of the writer when there is one', async () => {
    const client = recordingClient({ input: CHANGE_INPUT })
    await authorSpec(deps({ client }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: '## Panels\nA streak, and nothing else.\n',
    })
    const messages = client.lastCall!.messages
    expect(messages.some((m) => m.content.includes('A streak, and nothing else.'))).toBe(true)
  })

  it('tells the writer nothing is built when there is no current.md', async () => {
    const client = recordingClient({ input: CHANGE_INPUT })
    await authorSpec(deps({ client }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: null,
    })
    const messages = client.lastCall!.messages
    expect(messages.some((m) => m.content.includes('nothing has been built'))).toBe(true)
  })

  it('records authoring_mode and a change count on the success row', async () => {
    await authorSpec(deps({ input: CHANGE_INPUT }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: null,
    })
    const row = metricRows(db, 'spec_proposed')[0]!
    expect(row.authoring_mode).toBe('change')
    expect(row.changes_count).toBe(1)
    // The bound: a count, never a name. Nothing in this row may carry the
    // words a friend used.
    expect(JSON.stringify(row)).not.toContain('Weekly average')
  })

  it('records a null change count when nothing parsed', async () => {
    await authorSpec(deps({ input: { change_summary: 'x' } }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: null,
    })
    const row = metricRows(db, 'spec_error').at(-1)!
    expect(row.authoring_mode).toBe('change')
    expect(row.changes_count).toBeNull()
  })

  it('redacts quoted content from the failure message', async () => {
    // metricMessage's contract: a SpecShapeError's quoted strings are
    // friend-derived and `metrics` rejects UPDATE.
    await authorSpec(deps({ input: { ...CHANGE_INPUT, changes: [{ ...CHANGE_INPUT.changes[0], action: 'tweak' }] } }), {
      accountId: 1,
      conversationId: 'c1',
      signal: new AbortController().signal,
      currentState: null,
    })
    const row = metricRows(db, 'spec_error').at(-1)!
    expect(row.message).not.toContain('Weekly average')
  })
})
```

Adapt `deps(...)`, `recordingClient(...)` and `metricRows(...)` to whatever the file already calls them; do not invent parallel helpers.

Delete from this file every test that drives the PATCH path or asserts on `proposal.spec` — the patch arm and the `spec` field both go in this task. That is roughly `tests/spec/author.test.ts:243-246`, `:633-720` and `:840-900`; read each before deleting and keep any assertion that is really about metrics, aborts or retries by rewriting it against the change path.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/spec/author.test.ts`
Expected: FAIL — `AuthorInput` has no `currentState`, and the file does not compile because `SPEC_PATCH_PROMPT` no longer exists.

- [ ] **Step 3: Rewrite the authoring path**

In `lib/spec/author.ts`:

**Imports.** Drop `SPEC_PATCH_PROMPT`, `SPEC_JSON_SCHEMA`, `parseSpecDraft`, `sealVersion`, `renderLegacyMarkdown`, `readStoredSpec`, `StoredSpec`, `SpecDraft`, and everything from `./patch`. Add:

```typescript
import { SpecShapeError } from './schema'
import {
  parseSpecChangeDraft,
  sealChange,
  SPEC_CHANGE_JSON_SCHEMA,
  type SpecChangeDraft,
} from './change'
```

`currentSpec` and `readSpecs` stay — `based_on_version` and the version read-back both need them. `SpecRecord` is no longer needed.

**`Proposal`.** Reduce to what anything actually reads:

```typescript
/**
 * One authored proposal. Three fields, because that is all anything consumes:
 * app/api/chat/route.ts fires an alert on its existence, and nothing else
 * looks at it.
 *
 * `spec` used to carry the payload as a StoredSpec, for the card that
 * rendered it mid-turn. That card is gone (mockup-loop removal), and the
 * field was read by nothing but this module's own tests. `mockup_html`,
 * `preview_html` and `first` went with the card in the same removal.
 */
export type Proposal = { id: number; version: number; at: number }
```

**`AuthorInput`.** Add the field, with the reasoning:

```typescript
export type AuthorInput = {
  accountId: number
  conversationId: string
  signal: AbortSignal
  /**
   * users/<slug>/current.md's BODY, or null when the account has no built
   * dashboard. Passed in rather than read here: this function is handed an
   * accountId, not a slug, and reading the filesystem is not its job.
   *
   * app/api/chat/route.ts performs the one read, for the chat call itself,
   * and lib/chat/turn.ts hands the same value on. One read, two consumers —
   * the agent talking to the friend and the writer recording what they asked
   * for cannot disagree about what the dashboard currently is.
   */
  currentState: string | null
}
```

**Replace `currentVersionBlock` with `currentStateBlock`:**

```typescript
/**
 * What the writer is shown as the dashboard that exists.
 *
 * This USED TO render the current spec ROW — model output that no build ever
 * touched, so a second conversation was written against a prediction rather
 * than against the dashboard the friend actually has. That is the whole defect
 * this design exists to remove (design §0). Two arms now, not three: there is
 * one authoring path, because the base is a description rather than a
 * structure with ids to stabilise against.
 *
 * The absent arm is a real state, not a degraded one: an account whose
 * dashboard has not been built yet. Saying so explicitly gives the prompt the
 * same SHAPE on both paths rather than one with a section missing.
 */
function currentStateBlock(currentState: string | null): string {
  if (currentState === null) {
    return (
      'There is no dashboard for this account yet — nothing has been built. ' +
      'Everything you describe is new, so every entry in `changes` is an ' +
      '`add`.'
    )
  }
  return (
    'This is their dashboard as it exists right now, written by the builder ' +
    'after the last build. It is the truth about what is deployed — trust it ' +
    'over anything earlier in this conversation. Describe only what changes ' +
    'against it.\n\n' +
    currentState
  )
}
```

**`retryMessage`** — change its last paragraph to match the shape being asked for:

```typescript
    'Write the change again, as one object, with that problem fixed. Do not ' +
    'reply with prose, an apology, or only the part that changed.'
```

**Delete `modeFields`** and every call to it. `authoring_mode` is a constant now and `ops_count` names something that no longer exists. Replace with a single expression at each metrics site:

```typescript
changes_count: draft?.changes.length ?? null,
```

and put `authoring_mode: 'change' as const` inside `metricBase`, which every site already spreads. Write the reason above `metricBase`:

```typescript
    // authoring_mode is a CONSTANT now — there is one authoring path — and it
    // is still written on every row. Dropping it would split the series at the
    // era boundary, which is the same reason contextFor still says 'tweak'
    // (unified-loop D11): a query grouping spec rows by mode must be able to
    // see 'patch', 'whole' and 'change' as three eras of one field rather
    // than as one field that stopped existing. `ops_count` is NOT kept the
    // same way: ops are gone, and a column that can only ever be null is a
    // lie in a table nobody can correct. `changes_count` replaces it — a
    // count, never a name, per the standing metrics bound.
```

**Delete the outer catch's `mode` variable.** It existed to record `null` for a call that failed before a mode was chosen; there is nothing to choose. `promptSha: null` on that row stays exactly as it is — a failure before `loadPrompt` still had no prompt.

**The body.** The whole `current`/`storedCurrent`/`base`/`mode` block collapses to:

```typescript
    const loaded = loadPrompt(SPEC_PROMPT)
    promptSha = loaded.sha
    const system = loaded.text
```

and the messages become:

```typescript
    const specMessages = [
      ...history,
      { role: 'user' as const, content: currentStateBlock(input.currentState) },
      ...(last?.role === 'assistant'
        ? [{ role: 'user' as const, content: 'Write the change now.' }]
        : []),
    ]
```

**The attempt loop.** One parse, no phase discrimination — there is no patch to apply, so the `phase` variable and its long comment go:

```typescript
      let draftAttempt: SpecChangeDraft
      try {
        draftAttempt = parseSpecChangeDraft(proposed.input)
        draft = draftAttempt
        break
      } catch (error) {
        if (!(error instanceof SpecShapeError)) throw error
        appendMetric(db, {
          accountId: input.accountId,
          event: 'spec_error',
          at: now(),
          data: {
            ...proposed.usage,
            ...metricBase,
            ...proposed.served,
            kind: 'malformed_spec',
            status: null,
            type: null,
            attempt,
            message: metricMessage(error),
            changes_count: null,
          },
        })
        if (input.signal.aborted) return undefined
        feedback = error.message
      }
```

with `let draft: SpecChangeDraft | undefined` declared above the loop. `kind` is now always `'malformed_spec'` — `'patch_failed'` named a phase that no longer exists, and rows already carrying it keep meaning what they said.

**The seal and insert:**

```typescript
    const sealed = sealChange(draft, currentSpec(db, input.accountId)?.version ?? null)
```

The long comment above the old `sealVersion` call — on why the lineage pointer is re-read at write time rather than reused — stays verbatim. It is still exactly true: authoring runs in the background, a friend can send another message mid-call, and a pointer read before the call would name the version this one superseded.

The `insertSpec` call is unchanged, including `mockupHtml: ''` and its comment.

**The schema** passed to `client.propose` is `SPEC_CHANGE_JSON_SCHEMA`, unconditionally.

**The return:**

```typescript
    return { id, version, at }
```

- [ ] **Step 4: Thread `currentState` through `turn.ts`**

In `lib/chat/turn.ts`, the `authorSpec` call around line 492:

```typescript
      proposal = await authorSpec({
        accountId: input.accountId,
        conversationId,
        // NOT input.signal — see authoringSignal's docstring. Passing the
        // request's signal here is what made a wifi hop destroy a proposal.
        signal: input.authoringSignal,
        // The SAME value the system prompt was built from a few lines above
        // (CURRENT_STATE_BLOCK). One read in the route, two consumers here:
        // the agent and the spec writer cannot disagree about what the
        // dashboard currently is.
        currentState: input.currentState,
      })
```

`app/api/chat/route.ts` needs no change — `currentState` already reaches `runTurn`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/spec/author.test.ts tests/chat/turn.test.ts tests/chat/route.test.ts`
Expected: PASS. `tests/chat/turn.test.ts` builds `RunTurnInput` objects that already carry `currentState`; if any test double for `authorSpec` asserts on its argument, extend the assertion rather than relaxing it.

- [ ] **Step 6: Full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS and clean. Task 4's `SKIP_TYPECHECK` debt is paid here. `tests/spec/patch.test.ts` and `tests/spec/applyPatch.test.ts` still pass — the applier is untouched until Task 6.

- [ ] **Step 7: Commit**

```bash
git add lib/spec/author.ts lib/chat/turn.ts tests/spec/author.test.ts tests/chat/turn.test.ts
git commit -m "Author a change against current.md, not against the last spec row

authorSpec built its picture of what exists from the newest spec row — model
output no build ever touched, which is why a second conversation was written
against a prediction. The base is now current.md's body, passed in from the
same read the chat call already does, so the agent and the writer cannot
disagree about what is deployed.

One authoring path: no patch/whole split, no ids, no ops. authoring_mode stays
on every metric row as a constant so the series spans all three eras;
ops_count is replaced by changes_count, since a field that can only ever be
null is a lie in a table nobody can correct."
```

---

### Task 6: Delete the authoring surface, freeze the readers

**Files:**
- Modify: `lib/spec/patch.ts`, `lib/spec/schema.ts`, `lib/spec/validate.ts`, `lib/spec/fields.ts`, `lib/spec/diff.ts`, `lib/spec/render.ts` (header comments and deletions)
- Modify: `scripts/shots.ts`
- Delete: `tests/spec/applyPatch.test.ts`
- Modify: `tests/spec/patch.test.ts`, `tests/spec/schema.test.ts`, `tests/spec/validate.test.ts`
- Test: `tests/scripts/shots.test.ts`

**Interfaces:**
- Consumes: `parseSpecChangeDraft`, `sealChange` from `@/lib/spec/change`; `parseSpecVersion` from `@/lib/spec/validate`.
- Produces: nothing new. This task only removes and annotates.

**The rule, and it is narrower than the design doc's §9 originally claimed:** the AUTHORING surface is deleted; every READER of a shape already in the table is frozen, not removed. `parseSpecVersion` re-validates a stored whole-surface row through `draftFrom` → `parseScreen` → `parsePanel` → `checkInvariants`, and reads its `ops` key through `parseOp`. None of that can go.

- [ ] **Step 1: Delete what nothing calls**

Verify each is unreferenced before deleting it:

```bash
for sym in PATCH_JSON_SCHEMA parsePatch applyPatch SpecPatch parseSpecDraft SPEC_JSON_SCHEMA; do
  echo "--- $sym"
  grep -rn "\b$sym\b" --include='*.ts' --include='*.tsx' app lib scripts tests
done
```

Then delete:

- `lib/spec/patch.ts`: `PATCH_JSON_SCHEMA`, `parsePatch`, `SpecPatch`, `applyPatch`, `findScreen`, `findPanel`, `panelExists`, and the `Working` type. **Keep** `SpecPatchError`, `SpecPatchOp`, `OP_NAMES`, `parseOp`, `obj`, `reqText`, `optText` — `parseSpecVersion` reads stored `ops` through `parseOp`.
- `lib/spec/schema.ts`: `SPEC_JSON_SCHEMA`, and the now-unused `PANEL_SCHEMA`/`SCREEN_SCHEMA` if nothing else references them (check: `SCREEN_SCHEMA` was shared with `PATCH_JSON_SCHEMA`, which is going). `MOCKUP_JSON_SCHEMA` and `SCREEN_MOCKUP_JSON_SCHEMA` are already marked HISTORICAL — leave them exactly as they are.
- `lib/spec/fields.ts`: `parseSpecDraft`, and the re-export of it from `validate.ts`.
- `tests/spec/applyPatch.test.ts`: delete the file.
- `tests/spec/patch.test.ts`: delete every test of `parsePatch`, `applyPatch` and `PATCH_JSON_SCHEMA`. **Keep every `parseOp` test** — that reader is live.
- `tests/spec/schema.test.ts`, `tests/spec/validate.test.ts`: delete assertions about `SPEC_JSON_SCHEMA` and `parseSpecDraft`; keep everything about `parseSpecVersion`, `sealVersion` and the stored shape.

- [ ] **Step 2: Write the FROZEN headers**

Each of these files gets a header paragraph saying what it now is. Use `lib/spec/legacy.ts`'s existing header as the model — it is the precedent and the wording should rhyme.

`lib/spec/patch.ts`:

```typescript
// lib/spec/patch.ts
//
// FROZEN, and reduced to a READER. Ops were how a whole-surface version was
// authored against its predecessor; nothing authors that shape any more
// (lib/spec/change.ts owns what is written now), so PATCH_JSON_SCHEMA,
// parsePatch and applyPatch are gone.
//
// parseOp, SpecPatchOp and OP_NAMES stay because lib/spec/validate.ts's
// parseSpecVersion reads the `ops` key on every stored whole-surface row
// through them, and `specs` rejects UPDATE — those rows can never be
// rewritten and their `ops` can never be dropped. Nothing new is ever added
// here.
```

`lib/spec/diff.ts` — append to its existing header:

```typescript
// FROZEN as of change-only specs. diffVersions compares two whole-surface
// versions by stable id, and nothing authors that shape any more. Its one
// caller is app/admin/[user]/page.tsx, rendering the history of accounts that
// have such rows; a change-only spec IS the diff, so nothing computes one for
// the live shape. diffCounts has no production caller and is kept beside the
// function it summarises rather than deleted from under a future one.
```

`lib/spec/fields.ts` — append to its existing header:

```typescript
// FROZEN, with one live edge. Every parser below reads the whole-surface
// shape, which nothing authors any more — they run on the way OUT of the
// database, from parseSpecVersion. The live edge is the six helpers exported
// at the bottom: lib/spec/change.ts reuses record, text, textList,
// arrayField, oneOf, nonEmptyArray and requirement rather than writing a
// second copy of "is this status valid".
```

`lib/spec/render.ts` — add above `renderSpecMarkdown`:

```typescript
/**
 * FROZEN, in the same sense renderLegacyMarkdown above is. It renders
 * whole-surface rows, which nothing authors any more (renderChangeMarkdown
 * below is the live renderer). Its behaviour must not move: spec.md is a
 * build contract, and re-pulling an old spec must not produce a diff nobody
 * asked for.
 */
```

`lib/spec/validate.ts` — replace its header's first paragraph:

```typescript
// lib/spec/validate.ts
//
// FROZEN. parseSpecVersion re-validates a STORED whole-surface payload on the
// way out of the database — a shape nothing authors any more. The model-output
// validator that lived here (parseSpecDraft, re-exported from ./fields) is
// gone with the schema it guarded; lib/spec/change.ts owns validating what is
// written now.
//
// A schema-constrained REQUEST is not a guarantee about the row that reaches
// an append-only table, and that reasoning still holds for the live shape —
// it just lives next door.
```

- [ ] **Step 3: Rework the `scripts/shots.ts` spec fixtures**

Three call sites seed specs, and they build their payloads through `parseSpecDraft` — which no longer exists. **Seed one row of each of the three shapes**, so the screenshot review actually exercises the admin pane's three arms:

- `friend-new` (line ~312): a CHANGE row. Build it with `parseSpecChangeDraft(...)` + `sealChange(draft, null)`. Keep every `TEST`/`COFFEE PALACE TEST` marker in the free text — `tests/users/conventions.test.ts` decides the marker rule per folder, and a fixture with free text carries it. Drop the `mockupHtml` document for `''`; nothing serves it.
- `friend-tweak` (line ~440 and ~478): two rows, v1 and v2, both CHANGE rows, so the pane shows a version with a lineage pointer (`sealChange(draft, 1)` on the second). Delete both `insertScreenMockups` calls and the fragment constants — this fixture's whole point was the carry-forward of an untouched screen's fragment, and there are no fragments. Rename its docstring accordingly.
- `admin` (line ~596): leave the LEGACY payload exactly as it is. It is the only fixture proving the legacy arm still renders, and it must not be modernised.

Then add a fourth seed, or extend `admin`, so one WHOLE-SURFACE row exists too — build it with `parseSpecVersion(JSON.stringify({...}))`, which is a reader and still validates, so a malformed fixture throws in the harness instead of degrading to a blank card. Keep the comment explaining why fixtures are validated rather than hand-written; it is the reason this file catches bad fixtures at all.

- [ ] **Step 4: Run everything**

```bash
npx vitest run
npx tsc --noEmit
```
Expected: PASS and clean.

- [ ] **Step 5: Review the screens as pictures**

```bash
npm run shots -- --task=6
```

`screenshots/screens.ts` says what each screen has to look like. Check specifically: the admin transcript pane renders a change card, a whole-surface card and a legacy card without any of them collapsing to "Unreadable proposal (corrupt payload)"; the Spec tab renders `## Changes` as real markdown headings; no screen shows a preview, a card button, or a stage bar. This is a review gate, not a test, and it has caught things no test in this repo can see (onboarding ledger D16).

- [ ] **Step 6: Commit**

```bash
git add lib/spec scripts/shots.ts tests/spec
git rm tests/spec/applyPatch.test.ts
git commit -m "Delete the whole-surface authoring surface, freeze its readers

specs rejects UPDATE, so every payload shape ever written must keep parsing:
parseSpecVersion re-validates stored rows through all of fields.ts and reads
their ops through parseOp. Those are frozen readers, not removals. What goes is
what AUTHORS the old shape — SPEC_JSON_SCHEMA, parseSpecDraft,
PATCH_JSON_SCHEMA, parsePatch, applyPatch.

shots.ts now seeds one row of each of the three shapes, so the screenshot
review exercises every arm of the admin pane rather than one."
```

---

### Task 7: `conversation.md`

**Files:**
- Create: `lib/spec/conversation.ts`
- Modify: `scripts/export-spec.ts`, `scripts/write-spec-pair.ts`, `scripts/pull-spec.sh`, `.gitignore`
- Test: `tests/spec/conversation.test.ts`, `tests/scripts/exportSpec.test.ts`, `tests/scripts/writeSpecPair.test.ts`, `tests/scripts/pullSpec.test.ts`, `tests/repo/gitignore.test.ts`

**Interfaces:**
- Consumes: `TranscriptRow`, `readTranscript` from `@/lib/db/appendOnly`; `SpecRecord` from `@/lib/db/specs`.
- Produces:
  - `conversationRows(rows: TranscriptRow[], spec: SpecRecord, specs: SpecRecord[]): TranscriptRow[]`
  - `renderConversationMarkdown(rows: TranscriptRow[], meta: { slug: string; version: number }): string`
  - `SpecContent = { spec_md: string; conversation_md: string }` (`scripts/write-spec-pair.ts`)

**The slice.** Rows with `prev.at < at <= spec.at`, oldest first, where `prev` is the spec row one version below. A first spec has no `prev` and takes everything up to `spec.at`. The bound is exclusive at the bottom and inclusive at the top so a row written in the same millisecond as the previous spec is not counted twice across two pulls.

**Why it is gitignored** is a data-safety line, not housekeeping: `spec.md` is a designed artifact describing a dashboard; a raw transcript is everything a friend said, including whatever they said around the dashboard. The guard hook denies `.db` and `.env`, not markdown, so the gitignore entry, the written reason, and the test below are the whole defence.

- [ ] **Step 1: Write the failing tests**

Create `tests/spec/conversation.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { conversationRows, renderConversationMarkdown } from '@/lib/spec/conversation'

const row = (id: number, role: string, body: string, at: number) => ({
  id,
  account_id: 1,
  session_id: 's',
  conversation_id: 'c',
  prompt_sha: 'sha',
  role,
  body,
  at,
})

const spec = (id: number, version: number, at: number) => ({
  id,
  account_id: 1,
  conversation_id: 'c',
  prompt_sha: 'sha',
  payload: '{}',
  mockup_html: '',
  at,
  confirmed_at: null,
  version,
})

// readSpecs returns newest first — mirror that here.
const SPECS = [spec(2, 2, 200), spec(1, 1, 100)]
const ROWS = [
  row(1, 'user', 'before v1', 50),
  row(2, 'assistant', 'at v1', 100),
  row(3, 'user', 'after v1', 150),
  row(4, 'assistant', 'at v2', 200),
  row(5, 'user', 'after v2', 250),
]

describe('conversationRows', () => {
  it('takes everything up to a first spec', () => {
    const got = conversationRows(ROWS, SPECS[1]!, SPECS)
    expect(got.map((r) => r.body)).toEqual(['before v1', 'at v1'])
  })

  it('takes only the rows since the previous spec', () => {
    // The conversation that produced v2 — not the one that produced v1.
    const got = conversationRows(ROWS, SPECS[0]!, SPECS)
    expect(got.map((r) => r.body)).toEqual(['after v1', 'at v2'])
  })

  it('is exclusive at the bottom and inclusive at the top', () => {
    // A row written in the same millisecond as the previous spec belongs to
    // that spec's slice, not to this one — otherwise two consecutive pulls
    // both carry it.
    const got = conversationRows(ROWS, SPECS[0]!, SPECS)
    expect(got.some((r) => r.body === 'at v1')).toBe(false)
    expect(got.some((r) => r.body === 'at v2')).toBe(true)
  })

  it('returns oldest first', () => {
    const got = conversationRows(ROWS, SPECS[1]!, SPECS)
    expect(got[0]!.at).toBeLessThan(got[1]!.at)
  })
})

describe('renderConversationMarkdown', () => {
  const META = { slug: 'devtwo', version: 2 }

  it('names the slug and the version it belongs to', () => {
    const md = renderConversationMarkdown([ROWS[2]!], META)
    expect(md).toContain('devtwo')
    expect(md).toContain('v2')
  })

  it('carries each row verbatim under a role heading', () => {
    const md = renderConversationMarkdown([ROWS[2]!, ROWS[3]!], META)
    expect(md).toContain('## user')
    expect(md).toContain('## assistant')
    expect(md).toContain('after v1')
    expect(md).toContain('at v2')
  })

  it('does not escape or reflow what someone said', () => {
    // spec.md escapes line-leading markdown because it is a designed
    // document. This is a transcript: it is read by a builder, never
    // rendered to a friend, and altering someone's words to tidy a layout is
    // not a trade this file gets to make.
    const md = renderConversationMarkdown([row(9, 'user', '# a heading I typed', 1)], META)
    expect(md).toContain('# a heading I typed')
  })

  it('says so when there is nothing in the slice', () => {
    expect(renderConversationMarkdown([], META)).toContain('No conversation')
  })
})
```

Create `tests/repo/gitignore.test.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * conversation.md is a friend's raw transcript. The guard hook
 * (.claude/hooks/deny-sensitive-files.sh) denies .db and .env files, not
 * markdown, so the .gitignore entry is the only thing standing between a
 * pulled transcript and every clone of this repo forever. A rule with no gate
 * behind it is a paragraph; this is the gate.
 */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('conversation.md is never committable', () => {
  it('is ignored for a folder that exists', () => {
    expect(ignored('users/devtwo/conversation.md')).toBe(true)
  })

  it('is ignored for a folder that does not exist yet', () => {
    // The next friend's folder has to be covered before it is created.
    expect(ignored('users/somefriendwhodoesnotexistyet/conversation.md')).toBe(true)
  })

  it('does not accidentally ignore spec.md, which IS tracked', () => {
    // The pattern must be narrow. spec.md is a designed artifact describing a
    // dashboard and has always been committed.
    expect(ignored('users/devtwo/spec.md')).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/spec/conversation.test.ts tests/repo/gitignore.test.ts`
Expected: FAIL — the module does not exist, and `.gitignore` has no entry.

- [ ] **Step 3: Write `lib/spec/conversation.ts`**

```typescript
// lib/spec/conversation.ts
//
// The conversation that produced one spec version, as a file the builder
// reads beside spec.md. The spec says what to build; the conversation says
// what they meant.
//
// GITIGNORED, and that is a data-safety line rather than housekeeping — see
// .gitignore and CLAUDE.md. spec.md is a designed artifact describing a
// dashboard; this is everything a friend said, including whatever they said
// around the dashboard. It is a working input pulled fresh when needed. The
// record of record stays `transcripts` on the droplet, append-only.
import type { TranscriptRow } from '@/lib/db/appendOnly'
import type { SpecRecord } from '@/lib/db/specs'

/**
 * The transcript rows belonging to one spec version.
 *
 * `prev.at < at <= spec.at`. Exclusive at the bottom so a row written in the
 * same millisecond as the previous spec belongs to that spec's slice and not
 * to two of them; inclusive at the top because the rows that produced a spec
 * include the one the agent wrote just before calling the tool.
 *
 * A first version has no predecessor and takes everything up to its own
 * timestamp.
 *
 * `specs` is passed in rather than re-read: readSpecs derives `version` from
 * ROW POSITION, and a second derivation could disagree with the first
 * (lib/db/specs.ts).
 */
export function conversationRows(
  rows: TranscriptRow[],
  spec: SpecRecord,
  specs: SpecRecord[],
): TranscriptRow[] {
  const previous = specs.find((s) => s.version === spec.version - 1)
  const after = previous?.at ?? Number.NEGATIVE_INFINITY
  return rows
    .filter((r) => r.at > after && r.at <= spec.at)
    .sort((a, b) => a.at - b.at || a.id - b.id)
}

/**
 * The slice as markdown.
 *
 * NOTHING IS ESCAPED OR REFLOWED. lib/spec/render.ts neutralises line-leading
 * markdown structure because spec.md is a designed document that a person
 * reads as rendered output. This is a transcript: it is read as a source, by a
 * builder, and altering what someone said to tidy a layout is not a trade this
 * file gets to make. It is never rendered to a friend and never served by the
 * app.
 */
export function renderConversationMarkdown(
  rows: TranscriptRow[],
  meta: { slug: string; version: number },
): string {
  const header =
    `# ${meta.slug} — the conversation behind spec v${meta.version}\n\n` +
    '<!-- Generated from the transcript by scripts/pull-spec.sh.\n' +
    '     Gitignored: this is a raw transcript, not a designed artifact.\n' +
    '     Do not hand-edit: the next pull overwrites this file. -->\n'

  if (rows.length === 0) {
    return `${header}\n_No conversation rows fall between the previous spec and this one._\n`
  }

  const body = rows
    .map((r) => `## ${r.role} — ${new Date(r.at).toISOString()}\n\n${r.body}`)
    .join('\n\n')

  return `${header}\n${body}\n`
}
```

- [ ] **Step 4: Emit it from `export-spec.ts`**

```typescript
export function exportSpec(
  db: PlatformDb,
  slug: string,
): { spec_md: string; conversation_md: string } {
```

Inside, after the existing renderer choice — reusing `readSpecs` so `conversationRows` gets the same derived versions the rest of this function used:

```typescript
  // The conversation that produced THIS version, not the whole history: the
  // builder needs what they meant this time. See lib/spec/conversation.ts.
  const conversation_md = renderConversationMarkdown(
    conversationRows(readTranscript(db, account.id), spec, readSpecs(db, account.id)),
    { slug, version: spec.version },
  )

  return { spec_md, conversation_md }
```

`currentSpec` already walks `readSpecs`, so calling it here is one extra read of a small table on an operator CLI — cheap, and it keeps the version derivation in one place.

- [ ] **Step 5: Write both files atomically**

Rewrite `scripts/write-spec-pair.ts` so the four guards cover a LIST of files rather than one. The name is right again: it is a pair.

```typescript
export type SpecContent = { spec_md: string; conversation_md: string }

/** One output file, mid-write. */
type Target = { path: string; tmp: string; backup: string; body: string; backedUp: boolean }
```

`writeSpecPair(dir, content, fsOps)` then:

1. **Precondition** — for EVERY target, refuse upfront if the final path exists and is not a plain file. Nothing is touched if this fires for any of them.
2. **Write** — every temp file. On a throw, unlink every temp written so far and rethrow.
3. **Move aside** — every existing final file to its `.bak`, recording `backedUp` per target. On a throw, restore any already-moved originals, unlink every temp, rethrow.
4. **Commit** — rename every temp into place. On a throw, unlink whatever landed, restore every backup, unlink every remaining temp, rethrow.

Keep the header comment's honest statement of what is NOT covered, and update it: a SIGKILL anywhere in the sequence, and an ordinary failure striking again during a rollback already in progress. With two files the atomicity guarantee is real again rather than vestigial — a half-written pair is exactly the state rollback exists to prevent.

The CLI entry point at the bottom reads its JSON from **stdin**, not `argv[3]`:

```typescript
if (process.argv[1]?.endsWith('write-spec-pair.ts')) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: tsx scripts/write-spec-pair.ts <dir> < payload.json')
    process.exit(2)
  }
  // STDIN, not argv. A whole transcript can exceed ARG_MAX, and the failure
  // would be an exec error from the shell rather than anything this script
  // could report.
  const json = readFileSync(0, 'utf8')
  writeSpecPair(dir, JSON.parse(json) as SpecContent)
  console.log(`Wrote ${dir}/spec.md and ${dir}/conversation.md`)
}
```

Extend `tests/scripts/writeSpecPair.test.ts` the way it already works — inject a `renameSync` that fails for exactly one call — and add a case proving that a failure while committing the SECOND file restores the first. That case is the whole reason atomicity matters again.

- [ ] **Step 6: Pipe it in `pull-spec.sh`**

```bash
  printf '%s' "$json" | npx tsx scripts/write-spec-pair.ts "users/$user"

  echo "spec.md is Gate B exempt — commit it when you are ready."
  echo "conversation.md is gitignored on purpose — it is a raw transcript."
```

Update the file's header comment: it writes a PAIR again — `spec.md`, tracked, and `conversation.md`, gitignored — and the payload goes over stdin because a transcript can exceed `ARG_MAX`.

- [ ] **Step 7: Add the gitignore entry**

Append to `.gitignore`, below the secrets block:

```
# A friend's raw transcript, pulled beside spec.md by scripts/pull-spec.sh so
# the builder can read what they meant. NEVER committed: spec.md is a designed
# artifact describing a dashboard, and this is everything they said, including
# whatever they said around it. The record of record is the append-only
# `transcripts` table on the droplet. The guard hook denies .db and .env, not
# markdown — this line and tests/repo/gitignore.test.ts are the whole defence.
# See CLAUDE.md > Data safety.
users/*/conversation.md
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/spec/conversation.test.ts tests/repo/gitignore.test.ts tests/scripts/`
Expected: PASS. `tests/scripts/pullSpec.test.ts` may assert on the argv invocation — update it to the stdin form and assert the pipe actually delivers, rather than deleting the case.

- [ ] **Step 9: Prove it end to end against synthetic data**

```bash
./scripts/pull-spec.sh devtwo --local
git status --porcelain users/devtwo/
```
Expected: `spec.md` shows as modified or untracked; `conversation.md` does not appear at all. If it appears, the gitignore pattern is wrong and the test above should have caught it — fix the pattern, not the test.

- [ ] **Step 10: Commit**

```bash
git add lib/spec/conversation.ts scripts/export-spec.ts scripts/write-spec-pair.ts \
  scripts/pull-spec.sh .gitignore tests/spec/conversation.test.ts \
  tests/repo/gitignore.test.ts tests/scripts/
git commit -m "Pull the conversation behind a spec, and keep it out of git

The spec says what to build; the conversation says what they meant, and a
change-only spec leans on it harder than a whole-surface one did. It is a raw
transcript, so it is gitignored with a test behind the pattern rather than a
paragraph — the guard hook covers .db and .env, not markdown.

The payload moves to stdin: a whole transcript can exceed ARG_MAX, and that
failure would come from the shell rather than from anything this script could
report."
```

---

### Task 8: The announce gate on `current.md`

**Files:**
- Modify: `scripts/announce-deploy.ts`
- Test: `tests/scripts/announceDeploy.test.ts`

**Interfaces:**
- Consumes: `readCurrentState`, `CurrentStateError` from `@/lib/build/currentState`.
- Produces: `AnnounceOutcome['kind']` gains `'current_state_missing'` and `'current_state_stale'`, both refusals.

Design §4.1: `announce-deploy.ts` refuses to announce version `n` unless `current.md` says `n`. Not an mtime comparison — a fresh clone rewrites every mtime, so a check that passed on the laptop and failed on the droplet would be worse than none. Plan 2 deferred this deliberately.

Two kinds, not one, for the reason `notes_missing` and `notes_invalid` are two: they need different instructions. "There is no usable `current.md`" means write one; "it says v2 and you are announcing v3" means the build forgot to rewrite it.

- [ ] **Step 1: Write the failing test**

Add to `tests/scripts/announceDeploy.test.ts`, following its existing fixture helpers:

```typescript
describe('the current.md gate', () => {
  it('refuses when current.md names an older version', async () => {
    // The failure this exists to catch: a build that shipped and forgot to
    // rewrite current.md. The friend is not announced to, and Nico finds out.
    writeNote(usersDir, slug, 2)
    writeCurrentState(usersDir, slug, 1)
    const outcome = await runAnnounce(deps, { slug, send: false })
    expect(outcome.kind).toBe('current_state_stale')
    expect(outcome.message).toContain('v1')
    expect(outcome.message).toContain('v2')
  })

  it('refuses when current.md is absent', async () => {
    writeNote(usersDir, slug, 1)
    const outcome = await runAnnounce(deps, { slug, send: false })
    expect(outcome.kind).toBe('current_state_missing')
  })

  it('refuses when current.md exists but does not parse', async () => {
    writeNote(usersDir, slug, 1)
    writeFileSync(join(usersDir, slug, 'current.md'), 'not a current state')
    const outcome = await runAnnounce(deps, { slug, send: false })
    expect(outcome.kind).toBe('current_state_missing')
    expect(outcome.message).toContain('frontmatter')
  })

  it('proceeds when the versions match', async () => {
    writeNote(usersDir, slug, 1)
    writeCurrentState(usersDir, slug, 1)
    const outcome = await runAnnounce(deps, { slug, send: false })
    expect(outcome.kind).toBe('drafted')
  })

  it('costs no model call when it refuses', async () => {
    // Same reasoning as the target check: a refusal must not pay for a draft.
    writeNote(usersDir, slug, 2)
    writeCurrentState(usersDir, slug, 1)
    await runAnnounce(deps, { slug, send: false })
    expect(draftCalls).toBe(0)
  })

  it('exits non-zero on both refusals', () => {
    expect(exitCodeFor('current_state_stale')).toBe(1)
    expect(exitCodeFor('current_state_missing')).toBe(1)
  })
})
```

Add a `writeCurrentState(usersDir, slug, version)` helper beside the file's existing `writeNote`, writing a minimal file `lib/build/currentState.ts` accepts: `slug` and `version` frontmatter, then all five headings in order — `## What this is for`, `## Screens`, `## Panels`, `## What can be entered`, `## Deliberately not included`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/scripts/announceDeploy.test.ts`
Expected: FAIL — the outcome is `'drafted'` in every case, and the two kinds are not in the union.

- [ ] **Step 3: Add the gate**

In `scripts/announce-deploy.ts`, extend the union:

```typescript
    | 'current_state_missing'
    | 'current_state_stale'
```

Place the check immediately after the target resolves and before `readBuildNotes` — the notes file is what SELECTED the target, so it exists; what has not been proven is that the build finished the job:

```typescript
  // THE STALENESS GATE (design §4.1). A build that shipped and forgot to
  // rewrite current.md leaves the chat agent describing a dashboard that no
  // longer exists — and the agent trusts current.md over everything else, so
  // the error compounds silently through every later conversation. Refusing
  // the announcement is how that gets found, and Nico is the one who finds it.
  //
  // Compares VERSIONS, never mtimes: a fresh clone rewrites every mtime, so a
  // check that passed on the laptop and failed on the droplet would be worse
  // than none.
  let currentState: CurrentState | null
  try {
    currentState = readCurrentState(opts.slug, deps.usersDir)
  } catch (error) {
    // readCurrentState throws when the file EXISTS and does not parse. Same
    // outcome kind as absent — there is no usable description either way —
    // but carry the parser's own message, which names the section or the
    // frontmatter line that failed.
    return {
      kind: 'current_state_missing',
      message: error instanceof CurrentStateError ? error.message : String(error),
      warnings,
    }
  }
  if (currentState === null) {
    return {
      kind: 'current_state_missing',
      message:
        `no users/${opts.slug}/current.md — write it before announcing v${target.version}`,
      warnings,
    }
  }
  if (currentState.version !== target.version) {
    return {
      kind: 'current_state_stale',
      message:
        `users/${opts.slug}/current.md says v${currentState.version} but ` +
        `v${target.version} is being announced — rewrite it to describe what ` +
        'was just built',
      warnings,
    }
  }
```

Add both kinds to `exitCodeFor`'s `refusal` list.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/scripts/announceDeploy.test.ts tests/chat/announce.test.ts`
Expected: PASS. Existing tests in that file that reach `'drafted'` or `'announced'` now need a matching `current.md` in their fixture — add it via the new helper rather than moving the gate.

- [ ] **Step 5: Commit**

```bash
git add scripts/announce-deploy.ts tests/scripts/announceDeploy.test.ts
git commit -m "Refuse to announce a version current.md does not describe

A build that ships and forgets to rewrite current.md leaves the chat agent
describing a dashboard that no longer exists — and the agent is told to trust
current.md over everything else, so it compounds through every later
conversation. Versions, never mtimes: a fresh clone rewrites every mtime."
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/runbook.md`, `docs/dashboard-build-rules.md`
- Modify: `docs/superpowers/specs/2026-08-18-built-is-truth-design.md` (status line)

Docs are exempt from Gate B by path, so there is no test. The verification is reading each claim against the code — this repo has no gate that catches a doc going false.

- [ ] **Step 1: CLAUDE.md**

In **Schema & module rules**, rewrite the spec bullets:

- A spec version is **change-only**, not whole-surface. It describes what changes against `users/<slug>/current.md`, which is the dashboard as built. It carries `change_summary`, `changes`, `data_requirements` and `open_questions` — no ids, no `title`/`summary`/`background`, no screens or panels restated.
- `payload.shape` is `'change'`, server-written, and is what `lib/spec/stored.ts` discriminates on — **checked before** the `screens` array. Three arms: change, version, legacy. Every consumer handles all three.
- `based_on_version` is still server-supplied and still re-read at write time. `ops` is gone from what is authored; stored rows keep theirs and `parseOp` keeps reading them.
- Delete the paragraph describing the eight patch ops, `applyPatch` and the three authoring paths — replace it with one sentence saying there is one authoring path and where the old shape's readers now live (frozen, `lib/spec/{schema,fields,patch,diff,legacy}.ts`).
- Metrics: `authoring_mode` is `'change'` on every new row and `ops_count` is replaced by `changes_count`. Keep the bound sentence verbatim — a mode name and a count, never an op and never a name.

In **Data safety**, add a bullet for `conversation.md`: pulled beside `spec.md`, gitignored, a raw transcript rather than a designed artifact, with `tests/repo/gitignore.test.ts` as the gate and the note that the guard hook does not cover markdown.

In **Onboarding** / **Build contract**, record that `announce-deploy.ts` now refuses a `current.md` version mismatch.

- [ ] **Step 2: docs/runbook.md**

Flow B's build step now pulls two files, and step 9 can refuse on a stale `current.md`. Give the operator the exact commands:

```bash
./scripts/pull-spec.sh <slug>          # writes spec.md (tracked) + conversation.md (ignored)
```

and say plainly that rewriting `users/<slug>/current.md` is part of the build, not a follow-up — the announcement will refuse without it.

- [ ] **Step 3: docs/dashboard-build-rules.md**

Update the index entries whose sources changed, keeping the citation on each line. The build contract is now `spec.md` (the change), `conversation.md` (what they meant), `current.md` (what exists) and the code.

- [ ] **Step 4: Update the design doc's status**

Change the status line to record that all three plans are built, once Task 9 lands.

- [ ] **Step 5: Verify each claim, then commit**

Read each changed bullet against the file it describes. Then:

```bash
npx vitest run
npx tsc --noEmit
git add CLAUDE.md docs/runbook.md docs/dashboard-build-rules.md \
  docs/superpowers/specs/2026-08-18-built-is-truth-design.md
git commit -m "Document change-only specs and conversation.md"
```

---

## Done when

- `npx vitest run` green, `npx tsc --noEmit` clean, `npx next build` succeeds.
- `readStoredSpec` returns three arms, with a stored fixture for each, and the tag is checked before the `screens` array.
- Nothing under `lib/`, `app/` or `scripts/` authors a whole-surface spec: `SPEC_JSON_SCHEMA`, `parseSpecDraft`, `PATCH_JSON_SCHEMA`, `parsePatch` and `applyPatch` are gone.
- Every whole-surface and legacy row still parses, renders in the admin pane, and re-exports byte-identically.
- `authorSpec` reads no stored payload; its base is `current.md`'s body, threaded from the route's single read.
- `./scripts/pull-spec.sh <slug> --local` writes both files, and `git status` never shows `conversation.md`.
- `announce-deploy` refuses a `current.md` version mismatch and exits non-zero.
- `npm run shots` reviewed as pictures: the admin pane renders a change card, a whole-surface card and a legacy card.

## Not in this plan

A code-reading tool for the chat agent (design D1 — revisit once `current.md` has failed a real conversation). Plaid (step 6b). Any change to how a dashboard is built, tested or screenshotted. Backfilling `background` into `current.md` — the loss is recorded in design §5.0.1 and is deliberate.
