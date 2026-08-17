import { describe, expect, it } from 'vitest'
import { parsePatch, SpecPatchError, PATCH_JSON_SCHEMA } from '@/lib/spec/patch'

const PANEL = {
  id: 'takeaway',
  title: 'Takeaway',
  intent: 'What am I spending on takeaway?',
  display: 'A weekly total.',
  context_of_use: null,
  values: [{ kind: 'synced', id: 'takeaway_spend', module: 'plaid', description: 'x' }],
  entry: null,
}

const MINIMAL = {
  change_summary: 'Renamed the eating-out panel.',
  data_requirements: [],
  open_questions: [],
  ops: [{ op: 'replace_panel', panel: PANEL }],
}

describe('parsePatch', () => {
  it('accepts a minimal patch', () => {
    expect(parsePatch(MINIMAL).ops).toHaveLength(1)
  })

  it('requires change_summary — it is the friend-facing line', () => {
    expect(() => parsePatch({ ...MINIMAL, change_summary: '' })).toThrow(SpecPatchError)
  })

  it('rejects an empty ops list — a patch that changes nothing is not a proposal', () => {
    expect(() => parsePatch({ ...MINIMAL, ops: [] })).toThrow(/ops is empty/)
  })

  it('rejects an unknown op', () => {
    expect(() => parsePatch({ ...MINIMAL, ops: [{ op: 'delete_everything' }] })).toThrow(
      /delete_everything/,
    )
  })

  it('validates a panel inside an op with the whole-surface validator', () => {
    const bad = { ...PANEL, values: [] }
    expect(() => parsePatch({ ...MINIMAL, ops: [{ op: 'replace_panel', panel: bad }] })).toThrow(
      /values is empty/,
    )
  })

  it('rejects a model-authored based_on_version', () => {
    expect(() => parsePatch({ ...MINIMAL, based_on_version: 3 })).toThrow(/based_on_version/)
  })

  it('rejects a non-string open_questions entry rather than silently dropping it', () => {
    // A hand-rolled filter would drop 42 and let this pass — that is the same
    // "answer became none" laundering arrayField's comment warns against.
    expect(() => parsePatch({ ...MINIMAL, open_questions: ['keep', 42] })).toThrow(/open_questions/)
  })

  it('rejects a set_meta op whose three fields are all null — it changes nothing', () => {
    const ops = [{ op: 'set_meta', title: null, summary: null, background: null }]
    expect(() => parsePatch({ ...MINIMAL, ops })).toThrow(/set_meta/)
  })

  it('accepts a set_meta op that sets only one field', () => {
    const ops = [{ op: 'set_meta', title: 'New title', summary: null, background: null }]
    expect(parsePatch({ ...MINIMAL, ops }).ops).toHaveLength(1)
  })

  it('parses every op kind', () => {
    const ops = [
      { op: 'set_meta', title: 'T', summary: 'S', background: 'B' },
      { op: 'add_screen', screen: { id: 's2', title: 'S2', order: 2, panels: [PANEL] } },
      { op: 'update_screen', id: 's1', title: 'New', order: 1 },
      { op: 'remove_screen', id: 's3' },
      { op: 'add_panel', screen_id: 's1', panel: PANEL },
      { op: 'replace_panel', panel: PANEL },
      { op: 'move_panel', panel_id: 'takeaway', screen_id: 's2' },
      { op: 'remove_panel', id: 'old' },
    ]
    const parsed = parsePatch({ ...MINIMAL, ops }).ops
    expect(parsed).toHaveLength(8)

    // Distinguishable field values so a slot mix-up (panel_id <-> screen_id,
    // order coerced from the wrong field) fails loudly instead of passing by
    // coincidence.
    const move = parsed.find((o) => o.op === 'move_panel')
    expect(move).toMatchObject({ op: 'move_panel', panel_id: 'takeaway', screen_id: 's2' })

    const update = parsed.find((o) => o.op === 'update_screen')
    expect(update).toMatchObject({ op: 'update_screen', id: 's1', title: 'New', order: 1 })
  })
})

describe('PATCH_JSON_SCHEMA', () => {
  it('does not ask the model for based_on_version or ops_count', () => {
    const json = JSON.stringify(PATCH_JSON_SCHEMA)
    expect(json).not.toContain('based_on_version')
    expect(json).not.toContain('ops_count')
  })

  // minItems is outside the supported structured-output subset and would be
  // silently ignored — the real bound lives in parsePatch.
  it('uses no minItems', () => {
    expect(JSON.stringify(PATCH_JSON_SCHEMA)).not.toContain('minItems')
  })
})
