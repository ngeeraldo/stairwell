// lib/spec/stored.ts
//
// The ONE place anything discriminates a pre-unification row from a current
// one. `specs` rejects UPDATE, so rows written before the unified loop can
// never be rewritten into the current shape — they are read as legacy
// forever (unified-loop ledger, D4). Four consumers need that fallback; each
// re-implementing the try/catch is four chances to get the arm wrong.
import { SpecShapeError, type SpecVersion } from './schema'
import { parseLegacySpecPayload, type LegacySpecPayload } from './legacy'
import { parseSpecVersion } from './validate'

export type StoredSpec =
  | { kind: 'version'; version: SpecVersion }
  | { kind: 'legacy'; payload: LegacySpecPayload }

export function readStoredSpec(json: string): StoredSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new SpecShapeError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Discriminate on `screens`, then commit. A current-shaped row that fails
  // validation must report the CURRENT-shape error, not fall through and
  // report a legacy one — a reader chasing the wrong schema for a row that
  // can never be edited is worse than a precise failure.
  const hasScreens =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { screens?: unknown }).screens)

  if (hasScreens) return { kind: 'version', version: parseSpecVersion(json) }
  return { kind: 'legacy', payload: parseLegacySpecPayload(json) }
}
