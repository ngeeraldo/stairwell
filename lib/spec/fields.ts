// lib/spec/fields.ts
//
// How ONE spec field is validated. Extracted out of validate.ts to break a
// runtime import cycle: Task 11 has validate.ts import parseOp (a value)
// from patch.ts, while patch.ts imports parsePanel, parseScreen, and
// parseSpecDraft (values) from here. Import directions, one way only:
//
//   fields.ts   -> schema.ts
//   patch.ts    -> fields.ts, schema.ts
//   validate.ts -> fields.ts, patch.ts
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

function integer(src: Record<string, unknown>, key: string, at: string): number {
  const value = src[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SpecShapeError(`${at}.${key} is not an integer`)
  }
  return value
}

function oneOf<T extends string>(value: string, allowed: readonly T[], at: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SpecShapeError(`${at} is not one of ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * A list that may legitimately be empty — but must be PRESENT and must be an
 * array. Absent, null, and a bare string all throw.
 *
 * The alternative, `Array.isArray(x) ? x : []`, reads as tolerance and is
 * actually a silent claim: it turns "the model did not answer this" into "the
 * answer is none", in a build contract that `specs` will never let anyone
 * correct. `data_requirements` is the sharpest case — it is what tells the
 * builder which tables a version needs, so a laundered [] says "this dashboard
 * needs no tables". Every neighbouring field in this file throws; a last gate
 * that is strict about eleven fields and lenient about two is not a gate.
 */
function arrayField(src: Record<string, unknown>, key: string, at: string): unknown[] {
  const value = src[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${at}.${key} is not an array`)
  return value
}

function nonEmptyArray(src: Record<string, unknown>, key: string, at: string): unknown[] {
  const value = arrayField(src, key, at)
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
  if (!('annotates' in src)) {
    throw new SpecShapeError(`${at}.annotates is missing (use null if it does not apply)`)
  }
  const value = src.annotates
  if (value !== null && typeof value !== 'string') {
    throw new SpecShapeError(`${at}.annotates is neither a string nor null`)
  }
  return {
    description: text(src, 'description', at),
    fields: arrayField(src, 'fields', at).map((f, i) => entryField(f, `${at}.fields[${i}]`)),
    // A present-but-blank annotates is the same class of mistake as a blank
    // required string anywhere else in this file (see text()): it must
    // throw, not launder into null. Laundering it would make checkInvariants
    // skip the annotation check entirely (it treats null as "annotates
    // nothing"), letting junk through the last gate before an unrepairable row.
    annotates: value === null ? null : text(src, 'annotates', at),
  }
}

export function parsePanel(raw: unknown, at: string): Panel {
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

export function parseScreen(raw: unknown, at: string): Screen {
  const src = record(raw, at)
  const order = integer(src, 'order', at)
  return {
    id: id(src, at),
    title: text(src, 'title', at),
    order,
    panels: nonEmptyArray(src, 'panels', at).map((p, i) => parsePanel(p, `${at}.panels[${i}]`)),
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

export function draftFrom(src: Record<string, unknown>): SpecDraft {
  const parsed: SpecDraft = {
    title: text(src, 'title', 'spec'),
    summary: text(src, 'summary', 'spec'),
    background: text(src, 'background', 'spec'),
    change_summary: text(src, 'change_summary', 'spec'),
    screens: nonEmptyArray(src, 'screens', 'spec').map((s, i) => parseScreen(s, `screens[${i}]`)),
    data_requirements: arrayField(src, 'data_requirements', 'spec').map((r, i) =>
      requirement(r, `data_requirements[${i}]`),
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
  if ('ops' in src) {
    throw new SpecShapeError('ops is supplied by the server and must not be authored')
  }
  return draftFrom(src)
}

// Exported because validate.ts still needs them directly (record/text for
// parseMockupInput and parseSpecVersion's based_on_version check; draftFrom
// for re-validating a stored payload without re-checking based_on_version).
// textList and integer are exported for lib/spec/patch.ts, which reuses them
// for its own open_questions and update_screen.order fields rather than
// re-implementing the same rule a second time.
export { record, text, textList, integer }
