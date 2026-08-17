// tests/spec/mockupCompose.test.ts
//
// affectedScreens and composeMockup are both PURE — no database, no clock, no
// model — so every fixture here is hand-built rather than seeded.
import { describe, expect, it } from 'vitest'
import { affectedScreens, composeMockup } from '@/lib/spec/mockupCompose'
import type { Panel, Screen } from '@/lib/spec/schema'

function panel(id: string): Panel {
  return {
    id,
    title: id,
    intent: 'Why this panel exists.',
    display: 'How it is drawn.',
    context_of_use: null,
    values: [],
    entry: null,
  }
}

const SCREENS: Screen[] = [
  { id: 'morning', title: 'Morning', order: 1, panels: [panel('eating_out'), panel('walks')] },
  { id: 'money', title: 'Money', order: 2, panels: [panel('rent')] },
]

/** Mirrors applyPatch's move_panel: spliced out, pushed to the end of the target. */
function movePanel(screens: Screen[], panelId: string, toScreenId: string): Screen[] {
  const next = structuredClone(screens)
  let moved: Panel | undefined
  for (const s of next) {
    const index = s.panels.findIndex((p) => p.id === panelId)
    if (index !== -1) {
      ;[moved] = s.panels.splice(index, 1)
    }
  }
  const target = next.find((s) => s.id === toScreenId)
  if (moved && target) target.panels.push(moved)
  return next
}

function removePanel(screens: Screen[], panelId: string): Screen[] {
  const next = structuredClone(screens)
  for (const s of next) {
    s.panels = s.panels.filter((p) => p.id !== panelId)
  }
  return next
}

const FRAGMENTS = new Map([
  ['morning', '<section>M</section>'],
  ['money', '<section>£</section>'],
])

describe('affectedScreens', () => {
  it('returns every screen id when ops is null — a whole-surface version', () => {
    expect(affectedScreens(null, SCREENS, null)).toEqual(['morning', 'money'])
  })

  it('names the screen a replaced panel lives on', () => {
    expect(affectedScreens(SCREENS, SCREENS, [{ op: 'replace_panel', panel: panel('eating_out') }]))
      .toEqual(['morning'])
  })

  // BOTH ends. The destination is where it now is; the source is where it was,
  // and that screen has to be redrawn without it.
  it('names both ends of a move', () => {
    const next = movePanel(SCREENS, 'eating_out', 'money')
    expect(affectedScreens(SCREENS, next, [
      { op: 'move_panel', panel_id: 'eating_out', screen_id: 'money' },
    ])).toEqual(['morning', 'money'])
  })

  // The panel is gone from `next`, so only `base` knows which screen lost it.
  it('names the screen a removed panel used to live on', () => {
    const next = removePanel(SCREENS, 'eating_out')
    expect(affectedScreens(SCREENS, next, [{ op: 'remove_panel', id: 'eating_out' }]))
      .toEqual(['morning'])
  })

  it('names an added screen', () => {
    expect(affectedScreens(SCREENS, SCREENS, [{ op: 'add_screen', screen: SCREENS[1]! }]))
      .toContain('money')
  })

  it('never names a screen that no longer exists', () => {
    expect(affectedScreens(SCREENS, SCREENS, [{ op: 'remove_screen', id: 'gone' }])).toEqual([])
  })

  // The shell renders no meta, so nothing is redrawn. Task 18 skips the call.
  it('names no screen for set_meta', () => {
    expect(affectedScreens(SCREENS, SCREENS, [
      { op: 'set_meta', title: 'X', summary: null, background: null },
    ])).toEqual([])
  })

  it('deduplicates and returns screens in document order', () => {
    const ops = [
      { op: 'replace_panel' as const, panel: panel('walks') },
      { op: 'replace_panel' as const, panel: panel('eating_out') },
    ]
    expect(affectedScreens(SCREENS, SCREENS, ops)).toEqual(['morning'])
  })
})

describe('composeMockup', () => {
  it('emits one document in screen order', () => {
    const html = composeMockup(SCREENS, new Map([['morning', '<section>M</section>'], ['money', '<section>£</section>']]))
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html.indexOf('<section>M')).toBeLessThan(html.indexOf('<section>£'))
  })

  it('orders by screen.order, not by array position', () => {
    const reordered = [{ ...SCREENS[1]!, order: 1 }, { ...SCREENS[0]!, order: 2 }]
    const html = composeMockup(reordered, FRAGMENTS)
    expect(html.indexOf('<section>£')).toBeLessThan(html.indexOf('<section>M'))
  })

  // The test above places money at array index 0 with order 1 and morning at
  // index 1 with order 2 — position and `.order` happen to agree, so it would
  // also pass an implementation that just walked the array. Here they
  // actively DISAGREE: morning stays at index 0 but gets the LATER order;
  // money stays at index 1 but gets the EARLIER one. Only a real sort by
  // `.order` puts £ first.
  it('sorts strictly by screen.order even when array position disagrees with it', () => {
    const inverted = [{ ...SCREENS[0]!, order: 2 }, { ...SCREENS[1]!, order: 1 }]
    const html = composeMockup(inverted, FRAGMENTS)
    expect(html.indexOf('<section>£')).toBeLessThan(html.indexOf('<section>M'))
  })

  it('composes only the named screens when `only` is given', () => {
    const html = composeMockup(SCREENS, FRAGMENTS, ['morning'])
    expect(html).toContain('<section>M')
    expect(html).not.toContain('<section>£')
  })

  // The case a friend hits when one request touches two screens at once — a
  // panel moved between them, or two panels edited on different screens. Both
  // must appear, in order, and an untouched third must not.
  it('composes EVERY named screen when several are affected, in order', () => {
    const three = [...SCREENS, { ...SCREENS[0]!, id: 'gym', title: 'Gym', order: 3 }]
    const fragments = new Map([...FRAGMENTS, ['gym', '<section>G</section>']])
    const html = composeMockup(three, fragments, ['morning', 'money'])
    expect(html).toContain('<section>M')
    expect(html).toContain('<section>£')
    expect(html).not.toContain('<section>G')
    expect(html.indexOf('<section>M')).toBeLessThan(html.indexOf('<section>£'))
  })

  it('scopes a fragment\'s own <style> to its screen, so it cannot reach a neighbour', () => {
    const fragments = new Map([
      ['morning', '<section><style>.tile { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    // Prefixed, not passed through: an unscoped .tile would restyle `money`
    // too — and `money` may have been drawn weeks earlier by another call.
    expect(html).not.toMatch(/(^|\})\s*\.tile\s*\{/)
    expect(html).toMatch(/#screen-morning[^{]*\.tile\s*\{/)
  })

  it('scopes every selector in a comma-separated group, not just the first', () => {
    const fragments = new Map([
      ['morning', '<section><style>.a, .b { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).toMatch(/#screen-morning[^{]*\.a/)
    expect(html).toMatch(/#screen-morning[^{]*\.b/)
  })

  it('scopes selectors inside an @media block, keeping the media wrapper', () => {
    const fragments = new Map([
      ['morning', '<section><style>@media (min-width: 40rem) { .tile { color: red } }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).toMatch(/@media[^{]*\{[^}]*#screen-morning[^{]*\.tile/)
  })

  it('drops a bare body/html/:root rule rather than scope it — the frame owns those', () => {
    const fragments = new Map([
      ['morning', '<section><style>body { background: red } .tile { color: blue }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).not.toMatch(/body\s*\{\s*background:\s*red/)
    // The safe sibling rule in the same <style> block still makes it through.
    expect(html).toMatch(/#screen-morning[^{]*\.tile/)
  })

  it('drops an @import rather than let it reach outside the fragment', () => {
    const fragments = new Map([
      ['morning', '<section><style>@import url(evil.css); .tile { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).not.toContain('@import')
    expect(html).toMatch(/#screen-morning[^{]*\.tile/)
  })

  it('throws when a screen has no fragment rather than composing a gap', () => {
    expect(() => composeMockup(SCREENS, new Map([['morning', 'x']]))).toThrow(/money/)
  })

  it('carries the stylesheet, so fragments drawn in different versions match', () => {
    expect(composeMockup(SCREENS, FRAGMENTS)).toContain('.panel')
  })
})
