// tests/spec/mockupCompose.test.ts
//
// affectedScreens and composeMockup are both PURE — no database, no clock, no
// model — so every fixture here is hand-built rather than seeded.
import { describe, expect, it } from 'vitest'
import { affectedScreens, composeMockup } from '@/lib/spec/mockupCompose'
import { SpecShapeError, type Panel, type Screen } from '@/lib/spec/schema'

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

  // Final review, Critical 1: this must be a SpecShapeError, not a plain
  // Error — lib/spec/author.ts's metricMessage redacts quoted strings ONLY
  // for SpecShapeError, and a plain Error's message (a friend-derived screen
  // id, quoted) would reach the append-only `metrics` table verbatim.
  it('throws a SpecShapeError, so its quoted screen id can be redacted before it reaches metrics', () => {
    try {
      composeMockup(SCREENS, new Map([['morning', 'x']]))
      throw new Error('expected composeMockup to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SpecShapeError)
    }
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

    // Final review, Minor 6. Two false claims the reviewer probed: that CSS
    // nesting (`&`) is dropped like an unhandled at-rule (it is not — it is
    // preserved, inheriting the parent's now-scoped selector for free), and
    // that the url()-stripping guarantee is unconditionally "all or nothing
    // per block" (splitDeclarationsTopLevel used to split INSIDE a nested
    // rule's own braces, since it tracked paren depth but not brace depth).
    describe('CSS nesting (final review, Minor 6)', () => {
      it('preserves a safe nested rule, scoped by inheriting its parent selector', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><style>.panel { color: red; &:hover { color: blue; } }</style>M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        // Not dropped: the nested selector text survives, nested inside the
        // ALREADY-scoped parent rule — `&` resolves against
        // `#screen-morning .panel`, not against `.panel` unscoped.
        expect(html).toContain('#screen-morning .panel')
        expect(html).toContain('&:hover')
        expect(html).toContain('color: blue')
      })

      // The failure mode the fix closes: an unsafe url() as the LAST
      // declaration in a nested rule (no trailing `;` before the nested
      // rule's own closing brace) put the brace on the DROPPED side and the
      // opening brace on the KEPT side — orphaning an open brace that a real
      // CSS parser then closes against whatever `}` it finds NEXT, consuming
      // every rule in between (here, the `.after` sibling) as garbage inside
      // the still-open `.panel` rule. Brace-depth tracking in
      // splitDeclarationsTopLevel means the whole nested rule can now only be
      // kept or dropped WHOLE, so this can no longer happen.
      it('drops a nested rule whole when it carries an unsafe url(), without unbalancing what follows', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><style>' +
              '.panel { &:hover { color: blue; background: url(https://cdn.example.test/leak.png) } }' +
              '.after { color: green }' +
              '</style>M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)

        // No leak: the unsafe host never reaches the output.
        expect(html).not.toContain('cdn.example.test')

        // The sibling rule survives as a REAL top-level rule, not text
        // swallowed into an unclosed `.panel` block — the direct symptom of
        // the bug this fix closes.
        expect(html).toContain('#screen-morning .after')
        expect(html).toContain('color: green')

        // The strongest check: every emitted <style> block is brace-balanced
        // on its own — the document has TWO (the head's FRAME/NUDGE chrome,
        // always well-formed, and the fragment's own scoped one) and this
        // checks both rather than assuming which is which. An unbalanced
        // block is exactly what let the sibling rule above get silently
        // absorbed, with every substring-based assertion above still
        // passing — brace counting is the one check that would have caught
        // it even if the assertions above did not.
        const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!)
        expect(styleBlocks.length).toBeGreaterThan(0)
        for (const block of styleBlocks) {
          const opens = (block.match(/\{/g) ?? []).length
          const closes = (block.match(/\}/g) ?? []).length
          expect(opens).toBe(closes)
        }
      })
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

      // CHANGED in fix round 5. This used to assert a non-refresh <meta> was
      // left alone — a TARGETED drop, deciding which meta tag was dangerous
      // by inspecting its http-equiv value. Round 5 deleted that decision
      // entirely (see stripMetaTags's doc comment: three straight rounds of
      // "which meta tag is dangerous" each shipped a bypass), so every
      // <meta> tag in a fragment is now dropped unconditionally, this one
      // included. Dropping it is harmless, not merely accepted collateral: a
      // fragment is a <section> destined for the document <body>, and a
      // <meta> tag has no valid effect there at all — a browser ignores a
      // body-level <meta name="description"> outright, so removing it changes
      // nothing about what a friend sees. The document's real <meta
      // charset>/<meta viewport>/<meta CSP> are supplied once, by the frame
      // in composeMockup, never by a fragment.
      it('also drops an unrelated, non-refresh <meta> tag (e.g. a body-level "description") — harmless, since a browser ignores one there anyway', () => {
        const fragments = new Map([
          ['morning', '<section><meta name="description" content="a panel">M</section>'],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('<meta name="description"')
        expect(html).toContain('M</section>')
      })

      // Fix round 3 (reviewer-found). A `>` INSIDE a quoted attribute value is
      // legal HTML and does not end the tag — `content="0;url=http://evil>x"`
      // is one attribute value, not a value followed by stray text. The round
      // 2 implementation used `/<meta\b[^>]*>/gi`, which stops at the FIRST
      // `>` regardless of quoting, so it matched only
      // `<meta content="0;url=http://evil>` — never saw `http-equiv` at all
      // (it comes after) — and left the entire real tag, including its
      // http-equiv="refresh", completely untouched.
      it('strips a meta refresh whose content= value carries a literal ">" before the real tag close', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><meta content="0;url=http://cdn.example.test/leak>x" http-equiv="refresh">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html.toLowerCase()).not.toContain('refresh')
        expect(html).not.toContain('cdn.example.test')
        expect(html).toContain('M</section>')
      })

      // Fix round 4 (reviewer-found, on a bug the COORDINATOR's own round-3
      // instruction introduced): round 3's findTagEnd reused findStringEnd,
      // which implements the CSS rule that a backslash escapes the next
      // character. HTML attribute values have NO escape mechanism — a
      // browser closes a double-quoted value at the very next literal `"`,
      // full stop, and a backslash inside one is just a character. These
      // three cases all depend on that HTML rule being followed correctly.
      describe('fix round 4: HTML attribute values have no backslash-escaping (unlike CSS)', () => {
        it('closes content= at a literal backslash-quote, content before http-equiv — a browser sees TWO clean attributes here, not one unterminated one', () => {
          const fragments = new Map([
            [
              'morning',
              '<section><meta content="0;url=http://cdn.example.test/leak\\" http-equiv="refresh">M</section>',
            ],
            ['money', '<section>£</section>'],
          ])
          const html = composeMockup(SCREENS, fragments)
          expect(html.toLowerCase()).not.toContain('refresh')
          expect(html).not.toContain('cdn.example.test')
          // The strongest signal this parsed CORRECTLY rather than merely
          // "not leaking": under the CSS-escape bug, findTagEnd ran off the
          // end of the fragment looking for a quote that (per the wrong
          // rule) hadn't closed yet, triggering the unterminated fallback —
          // which round 3 answered by emitting everything verbatim
          // (`refresh` and the domain would BOTH survive) and round 4
          // answers by dropping everything including this M — so seeing M
          // survive here proves the tag was bounded correctly, not that a
          // fallback happened to be conservative in the right direction.
          expect(html).toContain('M</section>')
        })

        it('closes content= at a literal backslash-quote, http-equiv before content — reviewer reproduced the bug in both attribute orders', () => {
          const fragments = new Map([
            [
              'morning',
              '<section><meta http-equiv="refresh" content="0;url=http://cdn.example.test/leak\\">M</section>',
            ],
            ['money', '<section>£</section>'],
          ])
          const html = composeMockup(SCREENS, fragments)
          expect(html.toLowerCase()).not.toContain('refresh')
          expect(html).not.toContain('cdn.example.test')
          expect(html).toContain('M</section>')
        })

        it('treats a backslash in the middle of a value as an ordinary character, not an escape', () => {
          const fragments = new Map([
            [
              'morning',
              '<section><meta http-equiv="refresh" content="0;url=http://cdn.example.test/le\\ak">M</section>',
            ],
            ['money', '<section>£</section>'],
          ])
          const html = composeMockup(SCREENS, fragments)
          expect(html.toLowerCase()).not.toContain('refresh')
          expect(html).not.toContain('cdn.example.test')
          expect(html).toContain('M</section>')
        })
      })

      // Fix round 4: the fallback for a tag findTagEnd genuinely cannot
      // bound (a real unterminated attribute quote — no closing quote
      // anywhere in the fragment) changed from fail-OPEN (round 3: emit the
      // unparseable remainder verbatim) to fail-CLOSED (round 4: drop
      // everything from the malformed <meta to the end of the fragment).
      // This is what stops a future boundary bug from becoming a full leak
      // again on its own, rather than depending on findTagEnd being perfect.
      it('fails CLOSED on a genuinely unterminated attribute quote — drops from the malformed tag to the end of the fragment rather than guessing', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><meta http-equiv="refresh" content="0;url=http://cdn.example.test/leakM</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).not.toContain('cdn.example.test')
        // The otherwise-legitimate tail (M</section>) is ALSO gone — the
        // accepted cost of failing closed on a fragment that is already
        // malformed HTML with no well-defined boundary.
        expect(html).not.toContain('M</section>')
      })
    })

    // Fix round 5 (reviewer-found, on round 4's own fix). Rounds 2–4 each
    // tried to identify WHICH <meta> tag was dangerous by scanning the
    // bounded tag's text for `http-equiv=`. Round 4 correctly bounded the
    // tag and correctly parsed attribute VALUES — but the regex that found
    // `http-equiv` in the first place still just re-scanned raw text with no
    // idea which ATTRIBUTE that text was actually inside. A decoy attribute
    // (`data-note='http-equiv="x"'`) carrying the literal string
    // `http-equiv="x"` inside its own quoted value, positioned before the
    // real `http-equiv="refresh"`, made the regex match the decoy, decide
    // "not refresh," and ship the real redirect completely untouched.
    //
    // Round 5's answer is not a fourth attempt at the same kind of decision:
    // stripMetaTags no longer inspects a tag's attributes AT ALL. Every
    // <meta> tag findTagEnd can bound is dropped, full stop, so there is no
    // `http-equiv` regex left for a decoy to fool.
    describe('fix round 5: stop discriminating which <meta> tag is dangerous — strip every one', () => {
      it("strips the reviewer's exact decoy shape — a fake http-equiv=\"x\" hidden inside an unrelated attribute's quoted value, ahead of the real one", () => {
        const fragments = new Map([
          [
            'morning',
            '<section><meta data-note=\'http-equiv="x"\' http-equiv="refresh" content="0;url=http://cdn.example.test/leak">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html.toLowerCase()).not.toContain('refresh')
        expect(html).not.toContain('cdn.example.test')
        expect(html).not.toContain('data-note')
        expect(html).toContain('M</section>')
      })

      it('strips a ">" hidden inside a SINGLE-quoted attribute value, not just a double-quoted one', () => {
        const fragments = new Map([
          [
            'morning',
            "<section><meta content='0;url=http://cdn.example.test/leak>x' http-equiv=\"refresh\">M</section>",
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html.toLowerCase()).not.toContain('refresh')
        expect(html).not.toContain('cdn.example.test')
        expect(html).toContain('M</section>')
      })

      it('strips two <meta> tags in the same fragment, in one pass, leaving the surrounding markup intact', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><meta http-equiv="refresh" content="0;url=http://cdn.example.test/leak"><p>hi</p><meta name="description" content="a panel">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html.toLowerCase()).not.toContain('refresh')
        expect(html).not.toContain('cdn.example.test')
        expect(html).not.toContain('data-note')
        expect(html).not.toContain('<meta name="description"')
        // Everything that was never inside a <meta> tag survives untouched.
        expect(html).toContain('<p>hi</p>')
        expect(html).toContain('M</section>')
      })

      // Confirms this scanner only ever touches a <meta ...> tag's own
      // span — ordinary fragment text carrying the exact punctuation the
      // tag scanner cares about (>, ", ', \) must survive byte-for-byte when
      // it is not part of any <meta> tag at all.
      it('leaves ordinary text containing >, ", \', and \\ — none of it inside a <meta> tag — completely untouched', () => {
        const text = `<p>Say "hi" &amp; 'bye' — 3 &gt; 2, and C:\\path\\here</p>`
        const fragments = new Map([
          ['morning', `<section>${text}M</section>`],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).toContain(text)
      })

      // The other half of the guarantee: the frame's OWN meta CSP (emitted
      // once, in <head>, by composeMockup itself — see its doc comment) is
      // completely unaffected by stripMetaTags, which only ever runs on
      // FRAGMENT text. If it did not survive, hardening the fragments would
      // have quietly disabled the stronger of the two guards.
      it('still emits the document-level meta CSP even when a fragment is full of stripped <meta> tags', () => {
        const fragments = new Map([
          [
            'morning',
            '<section><meta http-equiv="refresh" content="0;url=http://cdn.example.test/leak">M</section>',
          ],
          ['money', '<section>£</section>'],
        ])
        const html = composeMockup(SCREENS, fragments)
        expect(html).toContain(
          '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">',
        )
      })
    })
  })
})
