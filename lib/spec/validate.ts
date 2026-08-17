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
import { arrayField, draftFrom, record, text } from './fields'
import { parseOp, type SpecPatchOp } from './patch'
import type { ScreenFragment } from '@/lib/db/screenMockups'

export { parseSpecDraft } from './fields'

/** Attach the lineage pointer and the ops that produced this version. The
 * only place a SpecVersion is constructed. */
export function sealVersion(
  draft: SpecDraft,
  basedOnVersion: number | null,
  ops: SpecPatchOp[] | null,
): SpecVersion {
  return { ...draft, based_on_version: basedOnVersion, ops }
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
  const rawOps = src.ops
  // Absent reads as null, not as an error: every spec row written before this
  // existed has no `ops` key, and `specs` rejects UPDATE so none can ever
  // gain one.
  let ops: SpecPatchOp[] | null = null
  if (rawOps !== undefined && rawOps !== null) {
    if (!Array.isArray(rawOps)) throw new SpecShapeError('ops is neither an array nor null')
    ops = rawOps.map((o, i) => parseOp(o, `ops[${i}]`))
  }
  return sealVersion(draftFrom(src), based, ops)
}

export function parseMockupInput(raw: unknown): string {
  return text(record(raw, 'mockup'), 'mockup_html', 'mockup')
}

/**
 * Validate the per-screen mockup reply.
 *
 * Every requested screen must come back, and nothing else may. A silently
 * missing screen would compose into a document with a hole in it, and an extra
 * one would be a screen the spec does not contain — the same "a promise made
 * on the friend's behalf" that ledger D7 split the mockup call to prevent.
 */
export function parseScreenMockups(raw: unknown, requested: string[]): ScreenFragment[] {
  const src = record(raw, 'mockup')
  const screens = arrayField(src, 'screens', 'mockup')
  const out = screens.map((s, i) => {
    const entry = record(s, `mockup.screens[${i}]`)
    return {
      screenId: text(entry, 'id', `mockup.screens[${i}]`),
      html: text(entry, 'html', `mockup.screens[${i}]`),
    }
  })

  const got = new Set(out.map((f) => f.screenId))
  for (const id of requested) {
    if (!got.has(id)) throw new SpecShapeError(`mockup is missing screen "${id}"`)
  }
  for (const f of out) {
    if (!requested.includes(f.screenId)) {
      throw new SpecShapeError(`mockup returned screen "${f.screenId}", which was not requested`)
    }
  }
  return out
}
