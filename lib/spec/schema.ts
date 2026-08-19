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
//
// Two things are deliberately absent from what the model is asked for:
//
//   version           — derived from row position (lib/db/specs.ts), never
//                       stored, so it can neither drift nor race.
//   based_on_version  — supplied by the server from the account's current
//                       version at authoring time. A model-authored lineage
//                       pointer is a hallucination that becomes a permanent
//                       row in an append-only table. See ledger D2.
//
// title/summary/background are RETAINED from the pre-unification shape: each
// has live consumers (spec.md's H1, the admin pane) and the spec doc is
// silent about them, so existing conventions stand. See ledger D1.
//
// `import type` only: patch.ts imports from this file (schema.ts -> patch.ts
// would be the cycle). Erased at compile time, so it creates no runtime edge.
import type { SpecPatchOp } from './patch'

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

/**
 * What gets stored: the draft, the server-supplied lineage pointer, and the
 * ops that produced it.
 *
 * `ops` is NULL for a version authored whole-surface (v1, and the one-time
 * fallback for a legacy base). Null says "this version was not produced by a
 * patch"; an empty array would say "it was produced by a patch that changed
 * nothing", which is a different and impossible claim.
 *
 * It rides INSIDE payload, flat beside the version's own fields, because
 * readStoredSpec identifies a row of THIS shape by a top-level `screens`
 * array and draftFrom picks named keys. (That check is second now, not
 * first: readStoredSpec tests the change shape's explicit `shape` tag ahead
 * of it — see lib/spec/stored.ts. No row of this shape carries that tag, so
 * the `screens` test is still what decides every one of them.) A
 * `{ patch, version }` wrapper would break the discriminator and every
 * consumer with it. No new column on `specs`.
 */
export type SpecVersion = SpecDraft & {
  based_on_version: number | null
  ops: SpecPatchOp[] | null
}

export class SpecShapeError extends Error {
  constructor(message: string) {
    super(`spec payload: ${message}`)
    this.name = 'SpecShapeError'
  }
}

// The whole-surface authoring schemas that lived here — SPEC_JSON_SCHEMA and
// the PANEL_SCHEMA / SCREEN_SCHEMA / VALUE_SCHEMA / ENTRY_SCHEMA it and
// lib/spec/patch.ts's PATCH_JSON_SCHEMA were built from — are gone with the
// authoring path that used them. Nothing constrains a model to this shape any
// more (lib/spec/change.ts's SPEC_CHANGE_JSON_SCHEMA is what does now); the
// TYPES above stay, because parseSpecVersion still reads stored rows into
// them. The two schemas below are HISTORICAL rather than deleted, for the
// reason each of their comments gives.

/**
 * The mockup call's contract. One field, so the reply cannot arrive wrapped
 * in prose or a markdown fence — the friend's preview was an iframe srcDoc
 * and a stray ``` would have rendered as text inside their dashboard.
 *
 * HISTORICAL as of Task 18 (final review, Minor 8): no production code calls
 * this anymore — superseded by the scoped, per-screen call below
 * (SCREEN_MOCKUP_JSON_SCHEMA) and lib/spec/mockupCompose.ts's composeMockup,
 * which drew only the screens a patch touched instead of the whole document
 * every time. Both that successor and composeMockup were later deleted too,
 * along with the rest of the mockup loop. Kept, not deleted, for the same
 * reason lib/chat/prompt.ts's MOCKUP_PROMPT is: nothing may retroactively
 * change what an already-stamped `mockup_prompt_sha` points at.
 */
export const MOCKUP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { mockup_html: { type: 'string' } },
  required: ['mockup_html'],
} as const

/**
 * The per-screen mockup call's contract. An ARRAY, so one call draws every
 * affected screen — a call per screen would multiply latency by the number of
 * screens for no gain, since they are drawn from one prompt anyway.
 */
export const SCREEN_MOCKUP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, html: { type: 'string' } },
        required: ['id', 'html'],
      },
    },
  },
  required: ['screens'],
} as const
