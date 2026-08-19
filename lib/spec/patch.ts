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
//
// WHY PANEL GRANULARITY, kept because it explains the vocabulary a stored row
// still uses: a finer op (set_panel_title) would have saved ~150 tokens
// against replace_panel and would have cost an op vocabulary large enough that
// the validator could no longer be exhaustive. Panels are the unit a friend
// thinks in and the unit lib/spec/diff.ts reports on.
//
// The field parsers come from fields.ts, never from validate.ts — that
// direction is the cycle.
import { SpecShapeError, type Panel, type Screen } from './schema'
import { integer, parsePanel, parseScreen } from './fields'

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

export function parseOp(raw: unknown, at: string): SpecPatchOp {
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
