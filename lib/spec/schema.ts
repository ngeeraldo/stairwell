// lib/spec/schema.ts
//
// The six fields are FROZEN. specs is append-only and is deliberately outside
// lib/db/reshape.ts, so a field added later is missing from every spec written
// before it — permanently. Design spec sections 2.4 and 3.

export const PANEL_SOURCES = ['plaid', 'manual', 'derived'] as const
export type PanelSource = (typeof PANEL_SOURCES)[number]

export type Panel = {
  name: string
  shows: string
  why: string
  source: PanelSource
}

export type SpecPayload = {
  title: string
  summary: string
  background: string
  panels: Panel[]
  manual_logging: string[]
  open_questions: string[]
}

/** What the record stores: the payload, and the mockup in its own column. */
export type SpecInput = { payload: SpecPayload; mockupHtml: string }

export class SpecShapeError extends Error {
  constructor(message: string) {
    super(`spec payload: ${message}`)
    this.name = 'SpecShapeError'
  }
}

/**
 * The shape handed to the API as output_config.format.
 *
 * Constraining the response is what makes a well-formed proposal guaranteed
 * rather than hoped for. It does NOT remove the need for parseSpecInput
 * below: the schema is a request parameter and the validator is what stands
 * between the model and an append-only table.
 */
export const SPEC_JSON_SCHEMA = {
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
          source: { type: 'string', enum: PANEL_SOURCES },
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

function panels(source: Record<string, unknown>): Panel[] {
  const value = source.panels
  if (!Array.isArray(value)) throw new SpecShapeError('panels is not an array')
  // Zero panels is not a dashboard. Rejecting here means a degenerate
  // proposal fails loudly at authoring time rather than becoming a permanent
  // row that renders as an empty card.
  if (value.length === 0) throw new SpecShapeError('panels is empty')
  return value.map((entry, index) => {
    const panel = asRecord(entry, `panels[${index}]`)
    const source_ = text(panel, 'source')
    if (!(PANEL_SOURCES as readonly string[]).includes(source_)) {
      throw new SpecShapeError(`panels[${index}].source is not one of ${PANEL_SOURCES.join(', ')}`)
    }
    return {
      name: text(panel, 'name'),
      shows: text(panel, 'shows'),
      why: text(panel, 'why'),
      source: source_ as PanelSource,
    }
  })
}

/**
 * Validate the six payload fields. Used by both parseSpecInput and
 * parseSpecPayload so they share the same validation logic.
 */
function validatePayload(input: Record<string, unknown>): SpecPayload {
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
export function parseSpecInput(raw: unknown): SpecInput {
  const input = asRecord(raw, 'input')
  return {
    payload: validatePayload(input),
    mockupHtml: text(input, 'mockup_html'),
  }
}

/** Re-validate a stored payload on the way out of the database. */
export function parseSpecPayload(json: string): SpecPayload {
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
