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

/** What the record stores: the payload, and the mockup in its own column. */
export type LegacySpecInput = { payload: LegacySpecPayload; mockupHtml: string }

/**
 * The shape handed to the API as output_config.format.
 *
 * Constraining the response is what makes a well-formed proposal guaranteed
 * rather than hoped for. It does NOT remove the need for parseLegacySpecInput
 * below: the schema is a request parameter and the validator is what stands
 * between the model and an append-only table.
 */
export const LEGACY_SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    background: { type: 'string' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          shows: { type: 'string' },
          why: { type: 'string' },
          source: { type: 'string', enum: LEGACY_PANEL_SOURCES },
        },
        required: ['name', 'shows', 'why', 'source'],
      },
    },
    manual_logging: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    mockup_html: { type: 'string' },
  },
  required: [
    'title',
    'summary',
    'background',
    'panels',
    'manual_logging',
    'open_questions',
    'mockup_html',
  ],
} as const

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

/**
 * Validate the six payload fields. Used by both parseLegacySpecInput and
 * parseLegacySpecPayload so they share the same validation logic.
 */
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

/** Validate a model-authored object, and split the mockup from the payload. */
export function parseLegacySpecInput(raw: unknown): LegacySpecInput {
  const input = asRecord(raw, 'input')
  return {
    payload: validatePayload(input),
    mockupHtml: text(input, 'mockup_html'),
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
