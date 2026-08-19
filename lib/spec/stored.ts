// lib/spec/stored.ts
//
// The ONE place anything discriminates between the three payload shapes
// `specs` holds. `specs` rejects UPDATE, so no row can ever be rewritten into
// a newer shape — a pre-unification row is read as legacy forever, and a
// whole-surface row as a version forever (unified-loop ledger, D4). Every
// consumer needs all three arms; each re-implementing the dispatch is three
// chances to get an arm wrong.
import { SpecShapeError, type SpecVersion } from './schema'
import { parseLegacySpecPayload, type LegacySpecPayload } from './legacy'
import { CHANGE_SHAPE, parseStoredChange, type SpecChange } from './change'
import { parseSpecVersion } from './validate'

export type StoredSpec =
  | { kind: 'change'; change: SpecChange }
  | { kind: 'version'; version: SpecVersion }
  | { kind: 'legacy'; payload: LegacySpecPayload }

export function readStoredSpec(json: string): StoredSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }

  const src = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}

  // THE TAG IS CHECKED FIRST, and it is unambiguous in both directions: no
  // row written before change-only specs carries `shape`, no row written
  // after carries `screens`, and neither set can ever move. Checking the tag
  // ahead of the screens array means a payload that somehow carried both is
  // read as what it explicitly claims to be, rather than by inference.
  //
  // Then discriminate on `screens`, then commit. A row that clearly meant to
  // be one shape must report THAT shape's error rather than falling through
  // to the next parser — a reader chasing the wrong schema for a row nobody
  // can fix is worse than a precise failure.
  if (src.shape === CHANGE_SHAPE) return { kind: 'change', change: parseStoredChange(json) }
  if (Array.isArray(src.screens)) return { kind: 'version', version: parseSpecVersion(json) }
  return { kind: 'legacy', payload: parseLegacySpecPayload(json) }
}
