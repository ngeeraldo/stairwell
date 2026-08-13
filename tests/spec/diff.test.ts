import { describe, expect, it } from 'vitest'
import type { Panel, Screen, SpecVersion } from '@/lib/spec/schema'
import { parseSpecDraft, sealVersion } from '@/lib/spec/validate'
import { diffCounts, diffVersions } from '@/lib/spec/diff'

// Copied from tests/spec/validate.test.ts, per the brief, so this file's
// fixtures don't drift if that file's shapes change later.
function panel(over: Partial<Panel> = {}): Panel {
  return {
    id: 'walked_today',
    title: 'Walked today?',
    intent: 'Did I walk the dog today?',
    display: 'A big yes/no with a tap-to-mark control.',
    context_of_use: 'Phone, in bed, before getting up.',
    values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
    entry: {
      description: 'One tap.',
      fields: [{ name: 'walked', type: 'boolean', choices: [] }],
      annotates: null,
    },
    ...over,
  }
}

function draft(over: Record<string, unknown> = {}): unknown {
  return {
    title: 'Did I walk the dog today?',
    summary: 'A one-tap daily tracker.',
    background: 'Pivoted from a weather idea.',
    change_summary: 'The whole dashboard: one tap, a streak, a 30-day rate.',
    screens: [{ id: 'today', title: 'Today', order: 1, panels: [panel()] }],
    data_requirements: [{ table: 'walks', purpose: 'One row per day walked.', status: 'new' }],
    open_questions: [],
    ...over,
  }
}

// Goes through the real validator/sealer rather than being cast, so v1 is a
// genuine SpecVersion and not just an object that happens to typecheck as one.
const v1: SpecVersion = sealVersion(parseSpecDraft(draft()), null)

/** Renames one panel's title in place. Everything else — id, screen, values,
 * entry — is untouched, isolating "title changed" as the only edit. */
function withPanelTitle(v: SpecVersion, panelId: string, title: string): SpecVersion {
  return {
    ...v,
    screens: v.screens.map((s) => ({
      ...s,
      panels: s.panels.map((p) => (p.id === panelId ? { ...p, title } : p)),
    })),
  }
}

/** Appends a brand-new panel (reusing the shared panel() shape under a new
 * id) to the first screen, leaving existing panels byte-for-byte alone. */
function withExtraPanel(v: SpecVersion, panelId: string): SpecVersion {
  const [first, ...rest] = v.screens
  if (!first) throw new Error('withExtraPanel: version has no screens')
  return {
    ...v,
    screens: [{ ...first, panels: [...first.panels, panel({ id: panelId })] }, ...rest],
  }
}

/** Relocates an existing panel into a brand-new second screen, with the
 * panel's own content untouched — isolating "moved" from "edited". */
function movedToNewScreen(v: SpecVersion, panelId: string): SpecVersion {
  let moved: Panel | undefined
  const screens: Screen[] = v.screens.map((s) => ({
    ...s,
    panels: s.panels.filter((p) => {
      if (p.id !== panelId) return true
      moved = p
      return false
    }),
  }))
  if (!moved) throw new Error(`movedToNewScreen: no panel "${panelId}" found`)
  return {
    ...v,
    screens: [...screens, { id: 'elsewhere', title: 'Elsewhere', order: screens.length + 1, panels: [moved] }],
  }
}

/** Deep-clones a version with every object's keys rebuilt in reverse order,
 * then round-trips it through JSON — simulating a payload that came back
 * from storage with keys in a different order than it was written. This is
 * exactly the case a raw JSON.stringify comparison gets wrong. */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).reverse()) out[key] = reorderKeys(src[key])
    return out
  }
  return value
}

function reserialize(v: SpecVersion): SpecVersion {
  return JSON.parse(JSON.stringify(reorderKeys(v))) as SpecVersion
}

describe('diffVersions', () => {
  it('reports every panel as added when there is no prior version', () => {
    expect(diffVersions(null, v1).panels.added).toEqual(['walked_today'])
    expect(diffVersions(null, v1).panels.removed).toEqual([])
  })

  it('reports a renamed title as changed, not as added-and-removed', () => {
    // This is the whole point of stable ids. A title is display text and may
    // change freely; the id is what says "this is the same panel".
    const renamed = withPanelTitle(v1, 'walked_today', 'Did you walk?')
    expect(diffVersions(v1, renamed).panels).toEqual({ added: [], removed: [], changed: ['walked_today'] })
  })

  it('reports a new panel as added and leaves the untouched one out of changed', () => {
    const grown = withExtraPanel(v1, 'streak')
    expect(diffVersions(v1, grown).panels.added).toEqual(['streak'])
    expect(diffVersions(v1, grown).panels.changed).toEqual([])
  })

  it('reports a dropped panel as removed', () => {
    expect(diffVersions(withExtraPanel(v1, 'streak'), v1).panels.removed).toEqual(['streak'])
  })

  it('reports a panel moved between screens as changed, not moved', () => {
    // A move is not its own category for the pilot; the panel's containing
    // screen is part of what changed about it.
    expect(diffVersions(v1, movedToNewScreen(v1, 'walked_today')).panels.changed).toEqual(['walked_today'])
  })

  it('ignores key order and whitespace when deciding "changed"', () => {
    expect(diffVersions(v1, reserialize(v1)).panels.changed).toEqual([])
  })

  it('counts what it found', () => {
    expect(diffCounts(diffVersions(null, v1))).toMatchObject({ panels_added: 1, panels_removed: 0 })
  })
})
