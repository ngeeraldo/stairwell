import { describe, expect, it } from 'vitest'
import { applyPatch, SpecPatchError } from '@/lib/spec/patch'
import type { SpecVersion } from '@/lib/spec/schema'

const panel = (id: string, title = id) => ({
  id, title, intent: 'i', display: 'd', context_of_use: null,
  values: [{ kind: 'entered' as const, id: `${id}_v`, description: 'x' }],
  entry: null,
})

const BASE: SpecVersion = {
  title: 'Sam', summary: 'S', background: 'B', change_summary: 'first',
  screens: [
    { id: 'morning', title: 'Morning', order: 1, panels: [panel('eating_out'), panel('walks')] },
    { id: 'money', title: 'Money', order: 2, panels: [panel('balance')] },
  ],
  // NOTE: `ops` is not on SpecVersion yet — that lands in Task 11. Task 9's
  // "Interfaces from Task 9" note flags this explicitly: adding it here would
  // be a spread of scope this task should not take. The brief's BASE literal
  // included `ops: null`, which does not typecheck against the current
  // SpecVersion type; that field is omitted here rather than guessed at.
  data_requirements: [], open_questions: [], based_on_version: null,
}

const patch = (ops: unknown[]) => ({
  change_summary: 'c', data_requirements: [], open_questions: [], ops,
}) as never

describe('applyPatch', () => {
  it('copies untouched panels byte for byte — the drift fix', () => {
    const next = applyPatch(BASE, patch([{ op: 'replace_panel', panel: panel('eating_out', 'Takeaway') }]))
    expect(next.screens[0]!.panels[1]).toEqual(BASE.screens[0]!.panels[1])
    expect(next.screens[1]).toEqual(BASE.screens[1])
  })

  it('replaces a panel in place, keeping its position', () => {
    const next = applyPatch(BASE, patch([{ op: 'replace_panel', panel: panel('eating_out', 'Takeaway') }]))
    expect(next.screens[0]!.panels[0]!.title).toBe('Takeaway')
    expect(next.screens[0]!.panels.map((p) => p.id)).toEqual(['eating_out', 'walks'])
  })

  it('carries change_summary from the patch, not the base', () => {
    const next = applyPatch(BASE, patch([{ op: 'remove_panel', id: 'walks' }]))
    expect(next.change_summary).toBe('c')
  })

  it('never leaks based_on_version or ops into the draft', () => {
    const next = applyPatch(BASE, patch([{ op: 'remove_panel', id: 'walks' }]))
    expect('based_on_version' in next).toBe(false)
    expect('ops' in next).toBe(false)
  })

  it('does not mutate the base', () => {
    const before = JSON.stringify(BASE)
    applyPatch(BASE, patch([{ op: 'remove_panel', id: 'walks' }]))
    expect(JSON.stringify(BASE)).toBe(before)
  })

  it('applies ops in order, so one may depend on an earlier one', () => {
    const next = applyPatch(BASE, patch([
      { op: 'add_screen', screen: { id: 'gym', title: 'Gym', order: 3, panels: [panel('reps')] } },
      { op: 'move_panel', panel_id: 'walks', screen_id: 'gym' },
    ]))
    expect(next.screens.find((s) => s.id === 'gym')!.panels.map((p) => p.id)).toEqual(['reps', 'walks'])
    expect(next.screens[0]!.panels.map((p) => p.id)).toEqual(['eating_out'])
  })

  it('sets only the meta fields the op names', () => {
    const next = applyPatch(BASE, patch([
      { op: 'set_meta', title: 'New title', summary: null, background: null },
      { op: 'remove_panel', id: 'walks' },
    ]))
    expect(next.title).toBe('New title')
    expect(next.summary).toBe('S')
  })

  it('throws when an op names a panel that does not exist', () => {
    expect(() => applyPatch(BASE, patch([{ op: 'remove_panel', id: 'ghost' }]))).toThrow(
      /"ghost"/,
    )
  })

  it('throws when add_panel reuses an existing id', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'add_panel', screen_id: 'money', panel: panel('walks') }])),
    ).toThrow(SpecPatchError)
  })

  it('throws when add_screen reuses an existing id', () => {
    expect(() =>
      applyPatch(BASE, patch([
        { op: 'add_screen', screen: { id: 'money', title: 'X', order: 9, panels: [panel('p')] } },
      ])),
    ).toThrow(SpecPatchError)
  })

  it('throws when move_panel targets a screen that does not exist', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'move_panel', panel_id: 'walks', screen_id: 'ghost' }])),
    ).toThrow(/"ghost"/)
  })

  it('throws when move_panel names a panel that does not exist', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'move_panel', panel_id: 'ghost', screen_id: 'money' }])),
    ).toThrow(/"ghost"/)
  })

  it('move_panel to the screen a panel is already on reorders it to the end — defined behaviour', () => {
    // 'eating_out' starts at index 0 of 'morning'; moving it to 'morning'
    // (its own screen) is the only way to express a reorder, and should
    // push it to the end rather than being a no-op.
    const next = applyPatch(BASE, patch([{ op: 'move_panel', panel_id: 'eating_out', screen_id: 'morning' }]))
    expect(next.screens[0]!.panels.map((p) => p.id)).toEqual(['walks', 'eating_out'])
  })

  it('update_screen changes title and order, leaving its panels untouched', () => {
    const next = applyPatch(BASE, patch([{ op: 'update_screen', id: 'money', title: 'Finances', order: 9 }]))
    const screen = next.screens.find((s) => s.id === 'money')!
    expect(screen.title).toBe('Finances')
    expect(screen.order).toBe(9)
    expect(screen.panels.map((p) => p.id)).toEqual(['balance'])
    // The other screen is untouched.
    expect(next.screens.find((s) => s.id === 'morning')!.title).toBe('Morning')
  })

  it('throws when update_screen names a screen that does not exist', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'update_screen', id: 'ghost', title: 'X', order: 1 }])),
    ).toThrow(/"ghost"/)
  })

  it('remove_screen removes the screen and every panel that lived on it', () => {
    const next = applyPatch(BASE, patch([{ op: 'remove_screen', id: 'morning' }]))
    expect(next.screens.map((s) => s.id)).toEqual(['money'])
    // Not just "the screen is gone" — its panels must be gone from the
    // WHOLE version, not merely absent from a screen that still lists them.
    const allPanelIds = next.screens.flatMap((s) => s.panels.map((p) => p.id))
    expect(allPanelIds).not.toContain('eating_out')
    expect(allPanelIds).not.toContain('walks')
    expect(allPanelIds).toEqual(['balance'])
  })

  it('throws when remove_screen names a screen that does not exist', () => {
    expect(() => applyPatch(BASE, patch([{ op: 'remove_screen', id: 'ghost' }]))).toThrow(/"ghost"/)
  })

  it('throws when add_panel targets a screen that does not exist', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'add_panel', screen_id: 'ghost', panel: panel('new_thing') }])),
    ).toThrow(/"ghost"/)
  })

  // Emptying a screen is caught by the WHOLE-SURFACE validator, not by a
  // special case here — and its message is already good retry feedback.
  it('rejects a patch that empties a screen, via the existing validator', () => {
    expect(() => applyPatch(BASE, patch([{ op: 'remove_panel', id: 'balance' }]))).toThrow(
      /panels is empty/,
    )
  })

  // The cross-field invariants are the whole-surface validator's too.
  it('rejects a patch that orphans a derived input', () => {
    const derived = {
      ...panel('total'),
      values: [{ kind: 'derived' as const, id: 'total_v', description: 'x', inputs: ['walks_v'] }],
    }
    expect(() =>
      applyPatch(BASE, patch([
        { op: 'add_panel', screen_id: 'money', panel: derived },
        { op: 'remove_panel', id: 'walks' },
      ])),
    ).toThrow(/unknown value/)
  })
})
