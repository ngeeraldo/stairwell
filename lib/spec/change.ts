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
