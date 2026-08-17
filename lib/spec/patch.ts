// lib/spec/patch.ts
//
// A scoped change to one person's dashboard: what the spec-writer emits when
// there is a current confirmed version to change.
//
// WHY PANEL GRANULARITY. A finer op (set_panel_title) would save ~150 tokens
// against replace_panel and would cost an op vocabulary large enough that the
// validator can no longer be exhaustive. Panels are the unit a friend thinks in
// and the unit lib/spec/diff.ts already reports on, so making them the unit of
// change already gets the win: output proportional to CHANGED PANELS.
//
// The stored row is still the whole surface — applyPatch produces it and
// lib/spec/validate.ts validates it, unchanged. The ops ride alongside so the
// card and the mockup know what actually changed.
// Every import at the top of the file. PANEL_SCHEMA and SCREEN_SCHEMA come
// from schema.ts (Step 5 exports them); the field parsers come from fields.ts
// (Step 1), never from validate.ts — that direction is the cycle.
import {
  PANEL_SCHEMA,
  SCREEN_SCHEMA,
  SpecShapeError,
  type Panel,
  type Screen,
} from './schema'
import { parsePanel, parseScreen } from './fields'

/**
 * Extends SpecShapeError deliberately, and it buys two things for free:
 * lib/spec/author.ts's retry loop already treats a SpecShapeError as the one
 * retryable failure, and metricMessage() already redacts its quoted ids before
 * they reach the append-only metrics log.
 */
export class SpecPatchError extends SpecShapeError {
  constructor(message: string) {
    super(message)
    this.name = 'SpecPatchError'
  }
}

export type SpecPatchOp =
  | { op: 'set_meta'; title: string | null; summary: string | null; background: string | null }
  | { op: 'add_screen'; screen: Screen }
  | { op: 'update_screen'; id: string; title: string; order: number }
  | { op: 'remove_screen'; id: string }
  | { op: 'add_panel'; screen_id: string; panel: Panel }
  | { op: 'replace_panel'; panel: Panel }
  | { op: 'move_panel'; panel_id: string; screen_id: string }
  | { op: 'remove_panel'; id: string }

export const OP_NAMES = [
  'set_meta',
  'add_screen',
  'update_screen',
  'remove_screen',
  'add_panel',
  'replace_panel',
  'move_panel',
  'remove_panel',
] as const

/** What the model emits. `based_on_version` and `ops` on the stored row are
 * the server's; neither is authored here. */
export type SpecPatch = {
  change_summary: string
  data_requirements: unknown[]
  open_questions: string[]
  ops: SpecPatchOp[]
}

const str = { type: 'string' } as const
const nullableStr = { type: ['string', 'null'] } as const

export const PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    change_summary: str,
    data_requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { table: str, purpose: str, status: str },
        required: ['table', 'purpose', 'status'],
      },
    },
    open_questions: { type: 'array', items: str },
    ops: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { const: 'set_meta' },
              title: nullableStr,
              summary: nullableStr,
              background: nullableStr,
            },
            required: ['op', 'title', 'summary', 'background'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'add_screen' }, screen: SCREEN_SCHEMA },
            required: ['op', 'screen'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { const: 'update_screen' },
              id: str,
              title: str,
              order: { type: 'integer' },
            },
            required: ['op', 'id', 'title', 'order'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'remove_screen' }, id: str },
            required: ['op', 'id'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'add_panel' }, screen_id: str, panel: PANEL_SCHEMA },
            required: ['op', 'screen_id', 'panel'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'replace_panel' }, panel: PANEL_SCHEMA },
            required: ['op', 'panel'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'move_panel' }, panel_id: str, screen_id: str },
            required: ['op', 'panel_id', 'screen_id'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'remove_panel' }, id: str },
            required: ['op', 'id'],
          },
        ],
      },
    },
  },
  required: ['change_summary', 'data_requirements', 'open_questions', 'ops'],
} as const

function obj(raw: unknown, at: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecPatchError(`${at} is not an object`)
  }
  return raw as Record<string, unknown>
}

function reqText(src: Record<string, unknown>, key: string, at: string): string {
  const value = src[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SpecPatchError(`${at}.${key} is not a non-empty string`)
  }
  return value.trim()
}

function optText(src: Record<string, unknown>, key: string, at: string): string | null {
  if (!(key in src) || src[key] === null) return null
  return reqText(src, key, at)
}

function parseOp(raw: unknown, at: string): SpecPatchOp {
  const src = obj(raw, at)
  const op = reqText(src, 'op', at)
  switch (op) {
    case 'set_meta':
      return {
        op,
        title: optText(src, 'title', at),
        summary: optText(src, 'summary', at),
        background: optText(src, 'background', at),
      }
    case 'add_screen':
      return { op, screen: parseScreen(src.screen, `${at}.screen`) }
    case 'update_screen': {
      const order = src.order
      if (typeof order !== 'number' || !Number.isInteger(order)) {
        throw new SpecPatchError(`${at}.order is not an integer`)
      }
      return { op, id: reqText(src, 'id', at), title: reqText(src, 'title', at), order }
    }
    case 'remove_screen':
      return { op, id: reqText(src, 'id', at) }
    case 'add_panel':
      return {
        op,
        screen_id: reqText(src, 'screen_id', at),
        panel: parsePanel(src.panel, `${at}.panel`),
      }
    case 'replace_panel':
      return { op, panel: parsePanel(src.panel, `${at}.panel`) }
    case 'move_panel':
      return {
        op,
        panel_id: reqText(src, 'panel_id', at),
        screen_id: reqText(src, 'screen_id', at),
      }
    case 'remove_panel':
      return { op, id: reqText(src, 'id', at) }
    default:
      throw new SpecPatchError(`${at}.op "${op}" is not one of ${OP_NAMES.join(', ')}`)
  }
}

export function parsePatch(raw: unknown): SpecPatch {
  const src = obj(raw, 'patch')
  // Same rule as parseSpecDraft: the lineage pointer is the server's, and a
  // model-authored one is a hallucination that becomes a permanent row.
  if ('based_on_version' in src) {
    throw new SpecPatchError('based_on_version is supplied by the server and must not be authored')
  }

  const ops = src.ops
  if (!Array.isArray(ops)) throw new SpecPatchError('patch.ops is not an array')
  // The agent prompt already forbids proposing when nothing changed ("a
  // proposal card whose changelog would read 'nothing changed' is a bug").
  // This is that rule made structural.
  if (ops.length === 0) throw new SpecPatchError('patch.ops is empty — a patch must change something')

  const requirements = src.data_requirements
  if (!Array.isArray(requirements)) {
    throw new SpecPatchError('patch.data_requirements is not an array')
  }
  const questions = src.open_questions
  if (!Array.isArray(questions)) throw new SpecPatchError('patch.open_questions is not an array')

  return {
    change_summary: reqText(src, 'change_summary', 'patch'),
    // Passed through untouched: applyPatch hands these to parseSpecDraft, which
    // is the validator that owns their shape. Validating them twice, in two
    // places, is two chances to disagree.
    data_requirements: requirements,
    open_questions: questions.filter((q): q is string => typeof q === 'string'),
    ops: ops.map((o, i) => parseOp(o, `patch.ops[${i}]`)),
  }
}
