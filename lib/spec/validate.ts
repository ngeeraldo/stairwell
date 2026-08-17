// lib/spec/validate.ts
//
// A schema-constrained REQUEST is not a guarantee about the row that reaches
// an append-only table. This module is the last gate, and its error messages
// are fed back to the model on the retry attempt (lib/spec/author.ts) — so
// they name the exact path that failed, not just the fact of failure.
//
// Field-level validation lives in ./fields — this module validates a whole
// emitted or stored document.
import { SpecShapeError, type SpecDraft, type SpecVersion } from './schema'
import { draftFrom, record, text } from './fields'

export { parseSpecDraft } from './fields'

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
  return sealVersion(draftFrom(src), based)
}

export function parseMockupInput(raw: unknown): string {
  return text(record(raw, 'mockup'), 'mockup_html', 'mockup')
}
