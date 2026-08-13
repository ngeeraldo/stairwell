// lib/spec/validate.ts
//
// A schema-constrained REQUEST is not a guarantee about the row that reaches
// an append-only table. This module is the last gate, and its error messages
// are fed back to the model on the retry attempt (lib/spec/author.ts) — so
// they name the exact path that failed, not just the fact of failure.
import {
  FIELD_TYPES,
  REQUIREMENT_STATUSES,
  SpecShapeError,
  VALUE_KINDS,
  type DataRequirement,
  type EntryField,
  type EntryWidget,
  type Panel,
  type Screen,
  type SpecDraft,
  type SpecVersion,
  type ValueSpec,
} from './schema'

/** Stable ids are the whole basis of diffing, so their shape is pinned. */
const ID = /^[a-z0-9]+(_[a-z0-9]+)*$/

function record(raw: unknown, at: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecShapeError(`${at} is not an object`)
  }
  return raw as Record<string, unknown>
}

function text(src: Record<string, unknown>, key: string, at: string): string {
  const value = src[key]
  if (typeof value !== 'string') throw new SpecShapeError(`${at}.${key} is not a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new SpecShapeError(`${at}.${key} is empty`)
  return trimmed
}

/** Required-and-nullable: the key must be present, the value may be null. */
function nullableText(src: Record<string, unknown>, key: string, at: string): string | null {
  if (!(key in src)) throw new SpecShapeError(`${at}.${key} is missing (use null if it does not apply)`)
  if (src[key] === null) return null
  return text(src, key, at)
}

function id(src: Record<string, unknown>, at: string): string {
  const value = text(src, 'id', at)
  if (!ID.test(value)) {
    throw new SpecShapeError(
      `${at}.id "${value}" is not a slug (lowercase letters, digits, single underscores)`,
    )
  }
  return value
}

function textList(src: Record<string, unknown>, key: string, at: string): string[] {
  const value = src[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${at}.${key} is not an array`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new SpecShapeError(`${at}.${key} contains a non-string entry`)
    const trimmed = entry.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

function oneOf<T extends string>(value: string, allowed: readonly T[], at: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SpecShapeError(`${at} is not one of ${allowed.join(', ')}`)
  }
  return value as T
}

function nonEmptyArray(src: Record<string, unknown>, key: string, at: string): unknown[] {
  const value = src[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${at}.${key} is not an array`)
  // Enforced HERE, not in SPEC_JSON_SCHEMA: minItems is outside the supported
  // structured-output subset and would be silently ignored there.
  if (value.length === 0) throw new SpecShapeError(`${at}.${key} is empty`)
  return value
}

function valueSpec(raw: unknown, at: string): ValueSpec {
  const src = record(raw, at)
  const kind = oneOf(text(src, 'kind', at), VALUE_KINDS, `${at}.kind`)
  const base = { id: id(src, at), description: text(src, 'description', at) }
  if (kind === 'synced') return { kind, ...base, module: text(src, 'module', at) }
  if (kind === 'entered') return { kind, ...base }
  return { kind, ...base, inputs: textList(src, 'inputs', at) }
}

function entryField(raw: unknown, at: string): EntryField {
  const src = record(raw, at)
  return {
    name: text(src, 'name', at),
    type: oneOf(text(src, 'type', at), FIELD_TYPES, `${at}.type`),
    choices: textList(src, 'choices', at),
  }
}

function entryWidget(raw: unknown, at: string): EntryWidget {
  const src = record(raw, at)
  const value = src.annotates
  if (!('annotates' in src)) {
    throw new SpecShapeError(`${at}.annotates is missing (use null if it does not apply)`)
  }
  if (value !== null && typeof value !== 'string') {
    throw new SpecShapeError(`${at}.annotates is neither a string nor null`)
  }
  return {
    description: text(src, 'description', at),
    fields: (Array.isArray(src.fields) ? src.fields : []).map((f, i) =>
      entryField(f, `${at}.fields[${i}]`),
    ),
    annotates: value === null ? null : value.trim() || null,
  }
}

function panel(raw: unknown, at: string): Panel {
  const src = record(raw, at)
  return {
    id: id(src, at),
    title: text(src, 'title', at),
    intent: text(src, 'intent', at),
    display: text(src, 'display', at),
    context_of_use: nullableText(src, 'context_of_use', at),
    values: nonEmptyArray(src, 'values', at).map((v, i) => valueSpec(v, `${at}.values[${i}]`)),
    // Presence is required, like context_of_use and annotates. A silently
    // absent `entry` reads as "no entry widget" — which is a panel that
    // quietly cannot be fed, on a dashboard whose whole point was logging.
    // An explicit null is a decision; a missing key is an accident.
    entry: entryOrNull(src, at),
  }
}

function entryOrNull(src: Record<string, unknown>, at: string): EntryWidget | null {
  if (!('entry' in src)) {
    throw new SpecShapeError(`${at}.entry is missing (use null if the panel takes no input)`)
  }
  return src.entry === null ? null : entryWidget(src.entry, `${at}.entry`)
}

function screen(raw: unknown, at: string): Screen {
  const src = record(raw, at)
  const order = src.order
  if (typeof order !== 'number' || !Number.isInteger(order)) {
    throw new SpecShapeError(`${at}.order is not an integer`)
  }
  return {
    id: id(src, at),
    title: text(src, 'title', at),
    order,
    panels: nonEmptyArray(src, 'panels', at).map((p, i) => panel(p, `${at}.panels[${i}]`)),
  }
}

function requirement(raw: unknown, at: string): DataRequirement {
  const src = record(raw, at)
  return {
    table: text(src, 'table', at),
    purpose: text(src, 'purpose', at),
    status: oneOf(text(src, 'status', at), REQUIREMENT_STATUSES, `${at}.status`),
  }
}

/**
 * Cross-field invariants (03-spec-schema.md > Rules). Shape validation cannot
 * express any of these, and every one of them protects the diff: a duplicate
 * id makes "panel X changed" ambiguous forever, in an append-only record.
 */
function checkInvariants(draft: SpecDraft): void {
  const screenIds = new Set<string>()
  const panelIds = new Set<string>()
  const values = new Map<string, ValueSpec>()

  for (const s of draft.screens) {
    if (screenIds.has(s.id)) throw new SpecShapeError(`duplicate screen id "${s.id}"`)
    screenIds.add(s.id)
    for (const p of s.panels) {
      if (panelIds.has(p.id)) throw new SpecShapeError(`duplicate panel id "${p.id}"`)
      panelIds.add(p.id)
      for (const v of p.values) {
        if (values.has(v.id)) throw new SpecShapeError(`duplicate value id "${v.id}"`)
        values.set(v.id, v)
      }
    }
  }

  for (const s of draft.screens) {
    for (const p of s.panels) {
      for (const v of p.values) {
        if (v.kind !== 'derived') continue
        for (const input of v.inputs) {
          if (!values.has(input)) {
            throw new SpecShapeError(
              `derived value "${v.id}" lists unknown value "${input}" as an input, which does not exist in this version`,
            )
          }
        }
      }
      const annotates = p.entry?.annotates
      if (annotates === undefined || annotates === null) continue
      const target = values.get(annotates)
      if (!target) {
        throw new SpecShapeError(`panel "${p.id}" annotates "${annotates}", which is not a value in this version`)
      }
      if (target.kind !== 'synced') {
        throw new SpecShapeError(
          `panel "${p.id}" annotates "${annotates}", which is ${target.kind}, not synced — ` +
            `annotation labels synced rows`,
        )
      }
    }
  }
}

function draftFrom(src: Record<string, unknown>): SpecDraft {
  const parsed: SpecDraft = {
    title: text(src, 'title', 'spec'),
    summary: text(src, 'summary', 'spec'),
    background: text(src, 'background', 'spec'),
    change_summary: text(src, 'change_summary', 'spec'),
    screens: nonEmptyArray(src, 'screens', 'spec').map((s, i) => screen(s, `screens[${i}]`)),
    data_requirements: (Array.isArray(src.data_requirements) ? src.data_requirements : []).map(
      (r, i) => requirement(r, `data_requirements[${i}]`),
    ),
    open_questions: textList(src, 'open_questions', 'spec'),
  }
  checkInvariants(parsed)
  return parsed
}

/** Validate MODEL output. Rejects a model-authored based_on_version outright. */
export function parseSpecDraft(raw: unknown): SpecDraft {
  const src = record(raw, 'spec')
  if ('based_on_version' in src) {
    throw new SpecShapeError('based_on_version is supplied by the server and must not be authored')
  }
  return draftFrom(src)
}

/** Attach the lineage pointer. The only place a SpecVersion is constructed. */
export function sealVersion(draft: SpecDraft, basedOnVersion: number | null): SpecVersion {
  return { ...draft, based_on_version: basedOnVersion }
}

/** Re-validate a stored payload on the way out of the database. */
export function parseSpecVersion(json: string): SpecVersion {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }
  const src = record(parsed, 'spec')
  const based = src.based_on_version
  if (based !== null && (typeof based !== 'number' || !Number.isInteger(based))) {
    throw new SpecShapeError('based_on_version is neither an integer nor null')
  }
  return { ...draftFrom(src), based_on_version: based }
}

export function parseMockupInput(raw: unknown): string {
  return text(record(raw, 'mockup'), 'mockup_html', 'mockup')
}
