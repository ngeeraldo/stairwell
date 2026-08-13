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
// It is a READER, and only a reader. The three authoring exports it briefly
// carried — LEGACY_SPEC_JSON_SCHEMA, LegacySpecInput, parseLegacySpecInput —
// existed only to keep the branch working on the old shape until the
// authoring path switched over, and are gone with that switch. Nothing may
// author this shape again: lib/spec/schema.ts and lib/spec/validate.ts own
// what gets written.

import { SpecShapeError } from './schema'

export const LEGACY_PANEL_SOURCES = ['plaid', 'manual', 'derived'] as const
export type LegacyPanelSource = (typeof LEGACY_PANEL_SOURCES)[number]

export type LegacyPanel = {
  name: string
  shows: string
  why: string
  source: LegacyPanelSource
}

export type LegacySpecPayload = {
  title: string
  summary: string
  background: string
  panels: LegacyPanel[]
  manual_logging: string[]
  open_questions: string[]
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecShapeError(`${what} is not an object`)
  }
  return raw as Record<string, unknown>
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new SpecShapeError(`${key} is not a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new SpecShapeError(`${key} is empty`)
  return trimmed
}

/** Non-empty entries only. An empty list is legitimate; a blank entry is not. */
function textList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${key} is not an array`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new SpecShapeError(`${key} contains a non-string entry`)
    }
    const trimmed = entry.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

function panels(source: Record<string, unknown>): LegacyPanel[] {
  const value = source.panels
  if (!Array.isArray(value)) throw new SpecShapeError('panels is not an array')
  // Zero panels is not a dashboard. Rejecting here means a degenerate
  // proposal fails loudly at authoring time rather than becoming a permanent
  // row that renders as an empty card.
  if (value.length === 0) throw new SpecShapeError('panels is empty')
  return value.map((entry, index) => {
    const panel = asRecord(entry, `panels[${index}]`)
    const source_ = text(panel, 'source')
    if (!(LEGACY_PANEL_SOURCES as readonly string[]).includes(source_)) {
      throw new SpecShapeError(`panels[${index}].source is not one of ${LEGACY_PANEL_SOURCES.join(', ')}`)
    }
    return {
      name: text(panel, 'name'),
      shows: text(panel, 'shows'),
      why: text(panel, 'why'),
      source: source_ as LegacyPanelSource,
    }
  })
}

/** Validate the six payload fields. */
function validatePayload(input: Record<string, unknown>): LegacySpecPayload {
  return {
    title: text(input, 'title'),
    summary: text(input, 'summary'),
    background: text(input, 'background'),
    panels: panels(input),
    manual_logging: textList(input, 'manual_logging'),
    open_questions: textList(input, 'open_questions'),
  }
}

/** Re-validate a stored payload on the way out of the database. */
export function parseLegacySpecPayload(json: string): LegacySpecPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new SpecShapeError(`JSON parse error: ${message}`)
  }
  const input = asRecord(parsed, 'payload')
  return validatePayload(input)
}
