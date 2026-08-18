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

  // Fix round 1, Finding 1(a). A literal `{` inside a quoted attribute
  // selector is legal CSS and a plausible one in a generated mockup
  // (`[data-x="{"]`). Before the fix, the naive brace/paren scanner mistook
  // it for a rule's opening brace, desynced, and silently dropped every rule
  // after it — including this unrelated sibling. Both must now survive,
  // correctly scoped, with nothing vanishing.
  it('parses a `{` inside a quoted attribute selector without desyncing, and keeps the following sibling rule', () => {
    const fragments = new Map([
      ['morning', '<section><style>[data-x="{"] { color: red } .after { color: blue }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).toContain('#screen-morning [data-x="{"]')
    expect(html).toContain('#screen-morning .after')
  })

  // Fix round 1, Finding 1(b), the fallback for CSS this scanner genuinely
  // cannot parse (as opposed to (a)'s case, which it now parses correctly).
  // An unterminated quoted string inside a rule's body makes the rest of the
  // block unparseable. Before the fix, `matchingBrace` returning -1 there
  // caused the scanner to `break` and return whatever partial output it had
  // already built — which here would be nothing, since it desyncs on the
  // FIRST rule, but the failure mode this proves is real: no half-scoped
  // fragment of the block, and no unrelated sibling rule surviving unscoped
  // either, leaks into the composed document.
  it('drops the WHOLE style block, not a truncated prefix, when it cannot be parsed', () => {
    const fragments = new Map([
      ['morning', '<section><style>.a { content: "unterminated } .after { color: blue }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).not.toContain('unterminated')
    // Neither rule survives — not scoped, not unscoped, not truncated.
    expect(html).not.toMatch(/\.after\s*\{/)
    expect(html).not.toMatch(/#screen-morning[^{]*\.a\b/)
    // The rest of the fragment (the markup outside <style>) is untouched.
    expect(html).toContain('<div id="screen-morning">')
    expect(html).toContain('M</section>')
  })

  // Fix round 1, Finding 2. A naive `.split(',')` treats the comma inside
  // `:is(.a, .b)` as a group boundary, corrupting the selector into
  // "#screen-morning :is(.a, #screen-morning .b) > .c". The whole selector
  // must come out as ONE scoped unit instead.
  it('keeps commas inside :is()/:not() parens intact when splitting a selector group', () => {
    const fragments = new Map([
      ['morning', '<section><style>:is(.a, .b) > .c { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).toContain('#screen-morning :is(.a, .b) > .c')
    // The corrupted shape a naive comma-split would produce.
    expect(html).not.toContain('#screen-morning .b')
  })

  // Fix round 1, Finding 4. A comma inside a quoted attribute value is not a
  // group boundary either — same fix (splitSelectorsTopLevel), different
  // shape.
  it('keeps a comma inside a quoted attribute value intact', () => {
    const fragments = new Map([
      ['morning', '<section><style>[data-list="a,b"] { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).toContain('#screen-morning [data-list="a,b"]')
  })

  it('throws when a screen has no fragment rather than composing a gap', () => {
    expect(() => composeMockup(SCREENS, new Map([['morning', 'x']]))).toThrow(/money/)
  })

  it('carries the stylesheet, so fragments drawn in different versions match', () => {
    expect(composeMockup(SCREENS, FRAGMENTS)).toContain('.panel')
  })

  // Task 25's red test: the fixture Nico asked for — a fragment carrying an
  // external `url(...)` and an external `<img src>` in the same document.
  // This is the shape a route CSP header cannot reach, because
  // app/[user]/ChatPanel.tsx renders `Proposal.preview_html` (built by this
  // same composeMockup, via the `only` path) into an iframe with `srcDoc`,
  // not `src` — no HTTP response, no header. Deleting the
  // stripExternalReferences call in composeMockup (or the
  // stripExternalUrlDeclarations call inside scopeCss) turns this test red.
  describe('Task 25: stripping external references at compose time', () => {
    it('drops a declaration with an external url() from a <style> block, keeping a safe sibling declaration', () => {
      const fragments = new Map([
        [
          'morning',
          '<section><style>.tile { background: url(https://cdn.example.test/leak.png); color: red }</style>M</section>',
        ],
        ['money', '<section>£</section>'],
      ])
      const html = composeMockup(SCREENS, fragments)
      expect(html).not.toContain('cdn.example.test')
      expect(html).not.toContain('https:')
      // The rest of the same declaration block survives — dropping is
      // per-declaration, not per-rule or per-block.
      expect(html).toMatch(/#screen-morning[^{]*\.tile[^}]*color:\s*red/)
    })

    it('keeps an external url() call that is confined to a comment or unrelated text unaffected, but drops a real inline data: url() image unchanged', () => {
      const fragments = new Map([
        [
          'morning',
          '<section><style>.tile { background: url(data:image/png;base64,AAAA); color: red }</style>M</section>',
        ],
        ['money', '<section>£</section>'],
      ])
      const html = composeMockup(SCREENS, fragments)
      // A data: URL is exactly what img-src data: exists to allow — it must
      // survive, or this guard would break every legitimate inline image.
      expect(html).toContain('url(data:image/png;base64,AAAA)')
    })

    it('drops an external url() reached through an inline style="" attribute outside any <style> tag', () => {
      const fragments = new Map([
        [
          'morning',
          '<section style="background: url(https://cdn.example.test/leak.png); color: red">M</section>',
        ],
        ['money', '<section>£</section>'],
      ])
      const html = composeMockup(SCREENS, fragments)
      expect(html).not.toContain('cdn.example.test')
      // The safe sibling declaration in the same style="" attribute survives.
      expect(html).toContain('color: red')
    })

    it('strips an external <img src>, and a protocol-relative // src, entirely — not blanked to src=""', () => {
      const fragments = new Map([
        [
          'morning',
          '<section><img src="https://cdn.example.test/leak.png" alt="x"><img src="//cdn.example.test/leak2.png" alt="y">M</section>',
        ],
        ['money', '<section>£</section>'],
      ])
      const html = composeMockup(SCREENS, fragments)
      expect(html).not.toContain('cdn.example.test')
      // Removed outright, not left as an empty attribute — src="" would
      // re-request the current document on some elements.
      expect(html).not.toContain('src=""')
      expect(html).toContain('alt="x"')
      expect(html).toContain('alt="y"')
    })

    it('keeps a data: <img src>, and a same-document relative src, untouched', () => {
      const fragments = new Map([
        [
          'morning',
          '<section><img src="data:image/png;base64,AAAA" alt="ok"><a href="#section-2">jump</a>M</section>',
        ],
        ['money', '<section>£</section>'],
      ])
      const html = composeMockup(SCREENS, fragments)
      expect(html).toContain('src="data:image/png;base64,AAAA"')
      expect(html).toContain('href="#section-2"')
    })

    it('strips an external <link href> (a stylesheet or web font url a model was asked never to use, made a guarantee here)', () => {
      const fragments = new Map([
        [
          'morning',
          '<section><link rel="stylesheet" href="https://fonts.example.test/font.css">M</section>',
        ],
        ['money', '<section>£</section>'],
      ])
      const html = composeMockup(SCREENS, fragments)
      expect(html).not.toContain('fonts.example.test')
    })

    it('emits a document-level meta CSP with the same three fetch-blocking directives as the routes', () => {
      const html = composeMockup(SCREENS, FRAGMENTS)
      expect(html).toContain(
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">',
      )
      // sandbox/frame-ancestors are header-only and deliberately absent —
      // the meta tag cannot carry them, and the iframe's own sandbox="" does
      // that job already.
      expect(html).not.toContain('sandbox')
      expect(html).not.toContain('frame-ancestors')
    })

    // Fix round 1. The reviewer ran composeMockup for real and found four
    // shapes that beat the ORIGINAL blocklist-style regex: it string-matched
    // "does this look external", and each of these does not — until a
    // browser decodes it. isSafeReferenceValue is now an ALLOWLIST fed by
    // normalizeReferenceValue (decode entities, decode CSS escapes, strip URL
    // whitespace/control chars) — same four cases, now closed at the regex
    // layer too, on top of the meta CSP above which was already the primary
    // guarantee against exactly this kind of encoding trick.
    describe('fix round 1: encodings that defeated the original blocklist', () => {
      it('strips an HTML numeric-entity-encoded scheme (&#104;ttp://) from an <img src>', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><img src="&#104;ttp://cdn.example.test/leak.png" alt="x">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('cdn.example.test')
        expect(html).toContain('alt="x"')
      })

      it('strips a scheme with an ASCII tab spliced into it (ht<TAB>p://) — the URL parser strips it, so this IS http://', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><img src="ht\tp://cdn.example.test/leak.png" alt="x">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('cdn.example.test')
        expect(html).toContain('alt="x"')
      })

      it('strips a CSS backslash-escaped scheme (\\68ttp://) inside an unquoted url()', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><style>.tile { background: url(\\68ttp://cdn.example.test/leak.png); color: red }</style>M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('cdn.example.test')
        expect(html).toMatch(/#screen-morning[^{]*\.tile[^}]*color:\s*red/)
      })

      it('strips an UNQUOTED external src attribute — the old regex only matched quoted values', () => {
        const fragments = new Map([
          ['morning', '<section><img src=https://cdn.example.test/leak.png alt=x>M</section>'],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('cdn.example.test')
        // The following unquoted attribute is untouched — this is a targeted
        // strip of the offending attribute, not a fallback that drops the tag.
        expect(html).toContain('alt=x')
      })
    })

    // Fix round 2. Neither the meta CSP (fix round 1) nor an empty
    // sandbox="" reaches a meta-refresh redirect: it is a NAVIGATION, and
    // CSP's fetch directives govern fetches, not navigations, while empty
    // sandbox only blocks a sandboxed frame from navigating something ELSE
    // (the top browsing context) — navigating itself is untouched. This is
    // the channel closed by dropping the whole <meta http-equiv="refresh">
    // tag at compose time.
    describe('fix round 2: a <meta http-equiv="refresh"> redirect', () => {
      it('drops a meta refresh tag entirely, leaving the rest of the fragment intact', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><meta http-equiv="refresh" content="0;url=https://cdn.example.test/leak?data=x">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        // Not a bare `not.toContain('http-equiv')` — composeMockup's own
        // meta CSP tag legitimately carries `http-equiv="Content-Security-
        // Policy"` (fix round 1), so the assertion has to name the specific
        // thing that must be gone: the word "refresh" (case-insensitive
        // anywhere) and the URL it was smuggling.
        expect(html.toLowerCase()).not.toContain('refresh')
        expect(html).not.toContain('cdn.example.test')
        expect(html).toContain('M</section>')
      })

      it('matches case-insensitively and regardless of attribute order/whitespace/quoting', () => {
        const fragments = new Map([
          [
            'morning',
            "<section><META CONTENT='0;url=https://cdn.example.test/leak' HTTP-EQUIV = \"REFRESH\">M</section>",
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('cdn.example.test')
        expect(html).toContain('M</section>')
      })

      it('leaves an unrelated <meta> tag (e.g. viewport) alone — this is a targeted drop, not a sweep of every meta tag', () => {
        const fragments = new Map([
          ['morning', '<section><meta name="description" content="a panel">M</section>'],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).toContain('<meta name="description" content="a panel">')
      })
    })
  })
})
