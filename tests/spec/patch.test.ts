import { describe, expect, it } from 'vitest'
import { parseOp, SpecPatchError } from '@/lib/spec/patch'

// parsePatch, applyPatch and PATCH_JSON_SCHEMA are gone with the whole-surface
// authoring path (lib/spec/change.ts owns what is written now). parseOp
// survives as a READER: parseSpecVersion reads the `ops` key on every stored
// whole-surface row through it, and `specs` rejects UPDATE, so those rows can
// never be rewritten. These tests were rewritten to exercise it directly
// rather than through the parser that used to wrap it.

const PANEL = {
  id: 'takeaway',
  title: 'Takeaway',
  intent: 'What am I spending on takeaway?',
  display: 'A weekly total.',
  context_of_use: null,
  values: [{ kind: 'synced', id: 'takeaway_spend', module: 'plaid', description: 'x' }],
  entry: null,
}

describe('parseOp', () => {
  it('rejects an unknown op', () => {
    expect(() => parseOp({ op: 'delete_everything' }, 'ops[0]')).toThrow(/delete_everything/)
  })

  it('rejects a non-object op', () => {
    expect(() => parseOp('replace_panel', 'ops[0]')).toThrow(SpecPatchError)
  })

  it('validates a panel inside an op with the whole-surface validator', () => {
    const bad = { ...PANEL, values: [] }
    expect(() => parseOp({ op: 'replace_panel', panel: bad }, 'ops[0]')).toThrow(/values is empty/)
  })

  it('rejects a set_meta op whose three fields are all null — it changes nothing', () => {
    expect(() =>
      parseOp({ op: 'set_meta', title: null, summary: null, background: null }, 'ops[0]'),
    ).toThrow(/set_meta/)
  })

  it('accepts a set_meta op that sets only one field', () => {
    expect(
      parseOp({ op: 'set_meta', title: 'New title', summary: null, background: null }, 'ops[0]'),
    ).toMatchObject({ op: 'set_meta', title: 'New title', summary: null, background: null })
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
    const parsed = ops.map((o, i) => parseOp(o, `ops[${i}]`))
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
