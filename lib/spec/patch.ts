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
import { integer, parsePanel, parseScreen, parseSpecDraft, textList } from './fields'
import type { SpecDraft, SpecVersion } from './schema'

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
    case 'set_meta': {
      const title = optText(src, 'title', at)
      const summary = optText(src, 'summary', at)
      const background = optText(src, 'background', at)
      // Same failure mode as an empty ops list, a different door: three
      // nulls is an op that changes nothing, and it would otherwise slip
      // past the "ops must not be empty" check into a permanent no-op row.
      if (title === null && summary === null && background === null) {
        throw new SpecPatchError(
          `${at} is a set_meta op with title, summary, and background all null — it changes nothing`,
        )
      }
      return { op, title, summary, background }
    }
    case 'add_screen':
      return { op, screen: parseScreen(src.screen, `${at}.screen`) }
    case 'update_screen': {
      // integer() is the same rule parseScreen uses for a screen's own
      // order — reused here rather than re-implemented, so the two cannot
      // drift apart.
      const order = integer(src, 'order', at)
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

  return {
    change_summary: reqText(src, 'change_summary', 'patch'),
    // Passed through untouched: applyPatch hands this to parseSpecDraft, which
    // is the validator that owns its shape. Validating it twice, in two
    // places, is two chances to disagree.
    data_requirements: requirements,
    // textList is the same helper draftFrom uses for the whole-surface
    // open_questions: it throws on a non-string entry instead of silently
    // dropping it — the same "answer became none" laundering arrayField's
    // comment (fields.ts) warns against, applied to a smaller field.
    open_questions: textList(src, 'open_questions', 'patch'),
    ops: ops.map((o, i) => parseOp(o, `patch.ops[${i}]`)),
  }
}

type Working = { title: string; summary: string; background: string; screens: Screen[] }

function findScreen(work: Working, id: string, op: string): Screen {
  const screen = work.screens.find((s) => s.id === id)
  if (!screen) throw new SpecPatchError(`${op} names screen "${id}", which does not exist`)
  return screen
}

function findPanel(work: Working, id: string, op: string): { screen: Screen; index: number } {
  for (const screen of work.screens) {
    const index = screen.panels.findIndex((p) => p.id === id)
    if (index !== -1) return { screen, index }
  }
  throw new SpecPatchError(`${op} names panel "${id}", which does not exist`)
}

function panelExists(work: Working, id: string): boolean {
  return work.screens.some((s) => s.panels.some((p) => p.id === id))
}

/**
 * Apply a patch to the current confirmed version and return the WHOLE next
 * draft.
 *
 * Pure: no database, no clock, no model, no mutation of `base`. That is what
 * makes the untouched panels a COPY rather than a regeneration, which is the
 * drift half of why this exists.
 *
 * The result is handed to parseSpecDraft — the SAME validator the whole-surface
 * path uses. Every cross-field invariant (unique ids, derived inputs resolve,
 * annotates points at a synced value, no empty screen) is therefore checked
 * exactly once, in one place, with error messages that are already good retry
 * feedback. Nothing here re-implements any of it.
 *
 * The draft is built by NAMING its seven fields, never by spreading `base`:
 * a spread would carry `based_on_version` (and, from Task 11, `ops`) into an
 * object parseSpecDraft rejects outright, and would silently pick up any
 * field a future SpecVersion gains.
 */
export function applyPatch(base: SpecVersion, patch: SpecPatch): SpecDraft {
  const work: Working = {
    title: base.title,
    summary: base.summary,
    background: base.background,
    // structuredClone, so nothing downstream can reach back into the stored
    // version through a shared array or object reference.
    screens: structuredClone(base.screens),
  }

  for (const op of patch.ops) {
    switch (op.op) {
      case 'set_meta':
        if (op.title !== null) work.title = op.title
        if (op.summary !== null) work.summary = op.summary
        if (op.background !== null) work.background = op.background
        break

      case 'add_screen':
        if (work.screens.some((s) => s.id === op.screen.id)) {
          throw new SpecPatchError(`add_screen names screen "${op.screen.id}", which already exists`)
        }
        for (const p of op.screen.panels) {
          if (panelExists(work, p.id)) {
            throw new SpecPatchError(`add_screen carries panel "${p.id}", which already exists`)
          }
        }
        work.screens.push(structuredClone(op.screen))
        break

      case 'update_screen': {
        const screen = findScreen(work, op.id, 'update_screen')
        screen.title = op.title
        screen.order = op.order
        break
      }

      case 'remove_screen': {
        findScreen(work, op.id, 'remove_screen')
        work.screens = work.screens.filter((s) => s.id !== op.id)
        break
      }

      case 'add_panel': {
        const screen = findScreen(work, op.screen_id, 'add_panel')
        if (panelExists(work, op.panel.id)) {
          throw new SpecPatchError(`add_panel names panel "${op.panel.id}", which already exists`)
        }
        screen.panels.push(structuredClone(op.panel))
        break
      }

      case 'replace_panel': {
        // In place, keeping its position: a replace is a relabel or a reshape,
        // never a reorder, and a panel that silently jumped to the end of its
        // screen would register in the diff as a change nobody asked for.
        const { screen, index } = findPanel(work, op.panel.id, 'replace_panel')
        screen.panels[index] = structuredClone(op.panel)
        break
      }

      case 'move_panel': {
        const target = findScreen(work, op.screen_id, 'move_panel')
        const { screen, index } = findPanel(work, op.panel_id, 'move_panel')
        const [moved] = screen.panels.splice(index, 1)
        target.panels.push(moved!)
        break
      }

      case 'remove_panel': {
        const { screen, index } = findPanel(work, op.id, 'remove_panel')
        screen.panels.splice(index, 1)
        break
      }
    }
  }

  return parseSpecDraft({
    title: work.title,
    summary: work.summary,
    background: work.background,
    change_summary: patch.change_summary,
    screens: work.screens,
    data_requirements: patch.data_requirements,
    open_questions: patch.open_questions,
  })
}
