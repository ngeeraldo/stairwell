// lib/spec/schema.ts
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
 * readStoredSpec discriminates on a top-level `screens` array and draftFrom
 * picks named keys. A `{ patch, version }` wrapper would break the
 * discriminator and every consumer with it. No new column on `specs`.
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

export const PANEL_SCHEMA = {
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

/** One declaration, two consumers: SPEC_JSON_SCHEMA below and PATCH_JSON_SCHEMA
 * (lib/spec/patch.ts) for its add_screen op. */
export const SCREEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: str,
    title: str,
    order: { type: 'integer' },
    panels: { type: 'array', items: PANEL_SCHEMA },
  },
  required: ['id', 'title', 'order', 'panels'],
} as const

export const SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: str,
    summary: str,
    background: str,
    change_summary: str,
    screens: { type: 'array', items: SCREEN_SCHEMA },
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
