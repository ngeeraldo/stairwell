// lib/spec/mockupCompose.ts
//
// The document half of the mockup. The MODEL draws one <section> per screen;
// this file owns everything around them.
//
// THE STYLESHEET LIVES HERE, NOT IN THE MODEL'S OUTPUT, and that is what makes
// fragment reuse possible at all: a document composed from sections drawn
// weeks apart, by separate calls, would otherwise carry two stylesheets that
// disagree, and the unchanged screens would visibly shift every time a
// neighbour was edited.
//
// lib/spec/banner.ts still injects the SYNTHETIC banner into the composed
// document at serve time and is untouched by any of this.
import type { Screen } from './schema'
import type { SpecPatchOp } from './patch'

/**
 * The classes the frame styles for you. A NUDGE, not a vocabulary — a model may
 * use them, extend them, or ignore them entirely and bring its own `<style>`.
 * Kept beside the stylesheet that defines them so the prompt and the CSS cannot
 * drift. Each friend's dashboard is a bespoke personal app; confining every one
 * of them to six class names would make them all look the same.
 */
export const MOCKUP_SHELL_CLASSES = ['screen', 'screen-title', 'panel', 'panel-title', 'figure', 'note'] as const

/**
 * Which screens a patch changed, in the NEXT version's document order.
 *
 * `ops === null` means the version was authored whole-surface, so everything is
 * affected — v1, and the one-time legacy fallback. `base` is null there too.
 *
 * TWO SIDES, TWO SOURCES OF TRUTH, and this is the whole subtlety. A panel that
 * was removed is gone from `next`, and a panel that was moved is already at its
 * destination — so `next` cannot say which screen either one LEFT. That screen
 * has to be redrawn without it, or it keeps a carried-forward fragment showing a
 * panel that is no longer there, both on the friend's card and in the stored
 * build contract. Sources therefore resolve against `base`; destinations
 * against `next` and the op itself.
 *
 * A screen named by an op but absent from `next` is DROPPED rather than
 * returned: a removed screen has no fragment to draw and nothing to preview.
 */
export function affectedScreens(
  base: Screen[] | null,
  next: Screen[],
  ops: SpecPatchOp[] | null,
): string[] {
  const order = next.map((s) => s.id)
  if (ops === null) return order

  const touched = new Set<string>()
  const screenIn = (screens: Screen[], panelId: string): string | undefined =>
    screens.find((s) => s.panels.some((p) => p.id === panelId))?.id
  const was = (panelId: string) => (base ? screenIn(base, panelId) : undefined)

  for (const op of ops) {
    switch (op.op) {
      // NOTHING. The composed shell renders no title, summary or background, so
      // a meta-only change alters no pixel — and redrawing every screen for it
      // would be the whole cost this branch exists to avoid. An empty result is
      // legitimate; lib/spec/author.ts skips the mockup call on it.
      case 'set_meta':
        break
      case 'add_screen':
        touched.add(op.screen.id)
        break
      case 'update_screen':
        touched.add(op.id)
        break
      case 'remove_screen':
        break // nothing left to draw
      case 'add_panel':
        touched.add(op.screen_id)
        break
      case 'replace_panel': {
        // Still present in `next`, and it cannot have moved — replace keeps a
        // panel's position — so either side answers. `next` is the honest one.
        const id = screenIn(next, op.panel.id)
        if (id) touched.add(id)
        break
      }
      case 'remove_panel': {
        // Only `base` remembers where it was.
        const from = was(op.id)
        if (from) touched.add(from)
        break
      }
      case 'move_panel': {
        touched.add(op.screen_id)
        const from = was(op.panel_id)
        if (from) touched.add(from)
        break
      }
    }
  }
  return order.filter((id) => touched.has(id))
}

/**
 * The frame, in two halves, and the split is the design.
 *
 * FRAME owns only what must be shared for fragments drawn at different times to
 * sit in one document without fighting: the reset, the page background and type
 * that match the app chrome, and the container width. Nothing here decides how
 * a panel looks.
 *
 * NUDGE is the published default styling for MOCKUP_SHELL_CLASSES. It is a
 * starting point, deliberately plain, and a fragment is free to override any of
 * it or ignore it entirely — which is why it is defined BEFORE any fragment's
 * own scoped rules are appended, so a fragment always wins on specificity.
 */
const FRAME = `
  *, *::before, *::after { box-sizing: border-box; }
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  .frame { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem; }
`

const NUDGE = `
  .screen-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 1rem; opacity: 0.7; }
  .panel { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
           border-radius: 0.75rem; padding: 1rem; margin: 0 0 1rem; }
  .panel-title { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.5rem; }
  .figure { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
  .note { font-size: 0.85rem; opacity: 0.65; }
`

/** Selectors the frame owns outright — bare, they are dropped rather than scoped. */
const FRAME_OWNED = new Set(['html', 'body', ':root'])

/**
 * Find the index of the `}` that closes the `{` at `openIdx`, accounting for
 * nesting (an `@media` block's own rules). Returns -1 on unbalanced input,
 * which the caller treats as "nothing more to safely parse" rather than a
 * crash — malformed CSS from a model is an input to survive, not throw on.
 */
function matchingBrace(css: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Scope one selector to `scope`. Returns null for a selector this function
 * will not touch: a bare `html`, `body`, or `:root` (compared case-
 * insensitively, whitespace-trimmed) is the frame's alone to own — a fragment
 * that redefines page-level chrome is exactly the leak scoping exists to stop,
 * and prefixing it (`#screen-x body`) would silently make it inert rather than
 * honestly reject it.
 */
function scopeSelector(selector: string, scope: string): string | null {
  const trimmed = selector.trim()
  if (FRAME_OWNED.has(trimmed.toLowerCase())) return null
  return `${scope} ${trimmed}`
}

/**
 * Scope every selector in a comma-separated group. A group survives with only
 * its scopable members if at least one exists; a group that is ENTIRELY
 * frame-owned selectors (e.g. `html, body { ... }`) drops the whole rule,
 * since there is nothing left to say.
 */
function scopeSelectorGroup(prelude: string, scope: string): string | null {
  const scoped = prelude
    .split(',')
    .map((s) => scopeSelector(s, scope))
    .filter((s): s is string => s !== null)
  return scoped.length > 0 ? scoped.join(', ') : null
}

/**
 * The recursive core: walk top-level rules in `css`, scoping plain rules and
 * descending into `@media` blocks (the only nested at-rule a preview fragment
 * plausibly needs). Every other at-rule — `@import`, `@font-face`,
 * `@keyframes`, `@supports`, anything else — is DROPPED rather than passed
 * through unscoped: this function's job is a safety net, and a rule it does
 * not understand is exactly the one it must not guess about.
 */
function scopeCss(css: string, scope: string): string {
  let out = ''
  let i = 0
  const n = css.length

  while (i < n) {
    while (i < n && /\s/.test(css[i]!)) i++
    if (i >= n) break

    if (css.slice(i, i + 7).toLowerCase() === '@import') {
      const semi = css.indexOf(';', i)
      i = semi === -1 ? n : semi + 1
      continue
    }

    const braceIdx = css.indexOf('{', i)
    if (braceIdx === -1) break // trailing junk after the last rule — drop it
    const prelude = css.slice(i, braceIdx).trim()
    const closeIdx = matchingBrace(css, braceIdx)
    if (closeIdx === -1) break // unbalanced — drop the remainder rather than guess
    const body = css.slice(braceIdx + 1, closeIdx)

    if (prelude.toLowerCase().startsWith('@media')) {
      out += `${prelude} { ${scopeCss(body, scope)} }\n`
    } else if (!prelude.startsWith('@')) {
      const scopedSelector = scopeSelectorGroup(prelude, scope)
      if (scopedSelector) out += `${scopedSelector} { ${body} }\n`
      // else: every selector in the group was frame-owned — drop the rule.
    }
    // else: an at-rule this function does not handle (@font-face, @keyframes,
    // @supports, …) — dropped rather than passed through unscoped.

    i = closeIdx + 1
  }

  return out
}

/**
 * Lift a fragment's own `<style>` out and rewrite every selector under
 * `#screen-<id>`, so bespoke styling cannot escape the screen that authored it.
 *
 * Done HERE rather than asked of the model, for the reason lib/spec/banner.ts
 * gives (ledger D19): a composed document holds fragments drawn weeks apart by
 * separate calls, and one unscoped `.panel { }` would restyle a screen nobody
 * touched. A rule the model must remember is a rule that eventually is not.
 *
 * Bounded on purpose. It handles the shapes a preview actually uses — plain
 * selectors, comma-separated groups, and `@media` blocks — and DROPS anything
 * it cannot scope safely (`@import`, and bare `html`/`body`/`:root` selectors,
 * which are the frame's to own). Dropping beats passing through: an unscopable
 * rule is exactly the one that would leak. It does NOT handle `@keyframes`,
 * `@font-face`, `@supports`, CSS nesting, or malformed/unbalanced CSS beyond
 * surviving it without throwing — those are dropped too, silently, which is
 * the same bound applied uniformly rather than special-cased.
 */
function scopeFragmentStyles(html: string, screenId: string): string {
  const scope = `#screen-${screenId}`
  return html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_full, css: string) => {
    return `<style>${scopeCss(css, scope)}</style>`
  })
}

/**
 * One document from per-screen fragments.
 *
 * `only` scopes it to the screens a patch touched — the friend's preview card.
 * Omitted, it composes the whole dashboard, which is what `specs.mockup_html`
 * stores and what the builder builds toward.
 *
 * A MISSING FRAGMENT THROWS. Composing around a gap would produce a document
 * that looks complete and is silently missing a screen — and for
 * `specs.mockup_html` that document is the build contract.
 */
export function composeMockup(
  screens: Screen[],
  fragments: Map<string, string>,
  only?: string[],
): string {
  const wanted = only ? screens.filter((s) => only.includes(s.id)) : screens
  const ordered = [...wanted].sort((a, b) => a.order - b.order)

  // Each fragment goes inside its own #screen-<id> wrapper, which is both the
  // scoping anchor for its styles and the boundary that keeps two screens'
  // markup from running together.
  const body = ordered
    .map((screen) => {
      const html = fragments.get(screen.id)
      if (html === undefined) {
        throw new Error(`composeMockup: no fragment for screen "${screen.id}"`)
      }
      return `<div id="screen-${screen.id}">${scopeFragmentStyles(html, screen.id)}</div>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${FRAME}${NUDGE}</style>
</head>
<body>
<div class="frame">
${body}
</div>
</body>
</html>`
}
