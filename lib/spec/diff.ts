// lib/spec/diff.ts
//
// The structural diff between two consecutive CONFIRMED spec versions is the
// canonical record of what a user's request was. It replaces classifying
// free-text chat after the fact, and it is what will eventually settle
// whether a request was "expressible as config" or "needed custom code". So
// this diff is data, not a display convenience — every judgment call below
// favors determinism and stability over cleverness: compare by stable id
// (never by position), normalise away incidental serialisation noise, and
// sort every output array.
import type { Panel, Screen, SpecVersion } from './schema'

export type SpecDiff = {
  screens: { added: string[]; removed: string[]; changed: string[] }
  panels: { added: string[]; removed: string[]; changed: string[] }
}

/**
 * Sorts object keys recursively before stringifying. A round trip through
 * the database (TEXT column, not a key-ordered structure) is not guaranteed
 * to preserve the key order a payload was written with. Comparing raw
 * JSON.stringify output would then read "every panel changed" on essentially
 * every version — a payload that is byte-identical in content but arrived
 * with keys in a different order — which drowns the real signal in reorder
 * noise. Array order is left alone: it is meaningful (screen/panel sequence,
 * list contents), unlike object key order, which was never meaningful.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) sorted[key] = sortKeys(src[key])
    return sorted
  }
  return value
}

type PanelEntry = { screenId: string; panel: Panel }

/** Indexes every panel across all screens by its stable id. Ids are unique
 * across the whole version (enforced at validation time), so a flat map is
 * safe — no screen-scoping needed on the key. */
function indexPanels(screens: Screen[]): Map<string, PanelEntry> {
  const out = new Map<string, PanelEntry>()
  for (const screen of screens) {
    for (const panel of screen.panels) out.set(panel.id, { screenId: screen.id, panel })
  }
  return out
}

/**
 * A panel's canonical form includes the id of its containing screen. Without
 * that, dragging a panel to a different screen with no other edit would
 * canonicalise identically before and after — the panel object itself did
 * not change — and the move (which the user did in fact ask for) would
 * silently disappear from the record instead of registering as "changed".
 */
function canonicalPanel(entry: PanelEntry): string {
  return canonical({ screenId: entry.screenId, panel: entry.panel })
}

/**
 * Screens compare on their own fields plus the SET of panel ids they
 * contain — never on the panels' own content. If a screen's canonical form
 * embedded its panels wholesale, editing a single panel's title would also
 * flip that panel's containing screen to "changed", double-counting one edit
 * as two and inflating every screen-level count.
 */
function canonicalScreen(screen: Screen): string {
  const panelIds = screen.panels.map((p) => p.id).sort()
  return canonical({ id: screen.id, title: screen.title, order: screen.order, panelIds })
}

function diffIds<T>(
  prevMap: Map<string, T>,
  nextMap: Map<string, T>,
  canonicalOf: (value: T) => string,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const id of nextMap.keys()) {
    if (!prevMap.has(id)) added.push(id)
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) removed.push(id)
  }
  for (const [id, prevValue] of prevMap) {
    const nextValue = nextMap.get(id)
    if (nextValue === undefined) continue // handled as `removed` above
    if (canonicalOf(prevValue) !== canonicalOf(nextValue)) changed.push(id)
  }

  // Sorted because this feeds an append-only metrics row: an ordering that
  // varies with Map iteration (insertion order) would be a permanent,
  // meaningless inconsistency between otherwise-identical diffs.
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

export function diffVersions(prev: SpecVersion | null, next: SpecVersion): SpecDiff {
  const prevScreens = prev?.screens ?? []
  const nextScreens = next.screens

  const prevScreenMap = new Map(prevScreens.map((s) => [s.id, s] as const))
  const nextScreenMap = new Map(nextScreens.map((s) => [s.id, s] as const))

  return {
    screens: diffIds(prevScreenMap, nextScreenMap, canonicalScreen),
    panels: diffIds(indexPanels(prevScreens), indexPanels(nextScreens), canonicalPanel),
  }
}

export function diffCounts(diff: SpecDiff): {
  screens_added: number
  screens_removed: number
  screens_changed: number
  panels_added: number
  panels_removed: number
  panels_changed: number
} {
  return {
    screens_added: diff.screens.added.length,
    screens_removed: diff.screens.removed.length,
    screens_changed: diff.screens.changed.length,
    panels_added: diff.panels.added.length,
    panels_removed: diff.panels.removed.length,
    panels_changed: diff.panels.changed.length,
  }
}
