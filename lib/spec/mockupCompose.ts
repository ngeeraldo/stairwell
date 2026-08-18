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
 * Which screens a patch changed, in `next`'s ARRAY order.
 *
 * CORRECTED 2026-08-17 (fix round 1, Finding 3): this used to claim "the NEXT
 * version's document order", which promises a sort by `.order` that this
 * function does not do — it walks `next` as given, and `applyPatch` pushes a
 * newly added screen onto the end of the array without re-sorting. No visible
 * defect today, because `composeMockup` re-sorts its input by `.order` before
 * rendering regardless of what order this function's caller passes as `only`
 * — but the comment was promising a guarantee the code did not keep, which is
 * exactly the kind of drift this codebase does not tolerate in a doc comment.
 * Softened rather than fixed by adding a sort: nothing downstream needs this
 * array itself to be canonically ordered, and sorting here would be a second
 * place that could disagree with composeMockup's own sort.
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
 * Find the index in `css`, at or after `start`, where the quoted string that
 * opens with `quote` at `start` closes. Honours `\`-escapes inside the
 * string. Returns -1 for an unterminated string — everything after an
 * unclosed quote is unparseable, so the caller must not guess where it would
 * have closed.
 */
function findStringEnd(css: string, start: number, quote: string): number {
  let i = start + 1
  while (i < css.length) {
    if (css[i] === '\\') {
      i += 2
      continue
    }
    if (css[i] === quote) return i
    i++
  }
  return -1
}

/**
 * Advance past whitespace and `/* … *\/` comments, both of which are
 * insignificant between rules. Returns `css.length` when nothing but
 * insignificant content remains, or -1 when a comment is left unterminated —
 * a distinct outcome from "nothing left", because the former means parsing
 * can stop cleanly and the latter means it cannot trust anything after it.
 */
function skipInsignificant(css: string, from: number): number {
  let i = from
  const n = css.length
  while (i < n) {
    if (/\s/.test(css[i]!)) {
      i++
      continue
    }
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 2
      continue
    }
    break
  }
  return i
}

/**
 * Find the next occurrence of `ch` in `css` at or after `from`, treating
 * quoted strings and `/* … *\/` comments as opaque spans that cannot contain
 * CSS structure. THIS IS THE FIX FOR FINDING 1: without it, the literal `{`
 * inside `[data-x="{"]` — a legal attribute selector — is mistaken for the
 * start of a rule body, which desyncs every brace count that follows it.
 * Returns -1 if `ch` never appears outside such spans, including when a
 * string or comment is left unterminated: nothing after an unclosed quote or
 * comment can be trusted to mean what it looks like.
 */
function indexOfOutsideStrings(css: string, ch: string, from: number): number {
  let i = from
  const n = css.length
  while (i < n) {
    const c = css[i]!
    if (c === '"' || c === "'") {
      const end = findStringEnd(css, i, c)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 2
      continue
    }
    if (c === ch) return i
    i++
  }
  return -1
}

/**
 * Find the index of the `}` that closes the `{` at `openIdx`, accounting for
 * nesting (an `@media` block's own rules) AND for quoted strings / comments,
 * which may contain `{`/`}` characters that are not structural (the same
 * fix as indexOfOutsideStrings, applied to brace counting). Returns -1 on
 * input this cannot make sense of — an unterminated string/comment, or
 * brace depth that never returns to zero — which the caller treats as "this
 * whole block failed to parse", not "guess where it would have ended".
 */
function matchingBrace(css: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  const n = css.length
  while (i < n) {
    const c = css[i]!
    if (c === '"' || c === "'") {
      const end = findStringEnd(css, i, c)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 2
      continue
    }
    if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/**
 * Split a selector prelude on top-level commas only — commas inside `(...)`
 * (e.g. `:is(.a, .b)`) or inside a quoted attribute value (e.g.
 * `[data-list="a,b"]`) do not start a new selector. FIX FOR FINDINGS 2 AND 4:
 * a naive `.split(',')` corrupts both shapes by treating an inner comma as a
 * group boundary.
 */
function splitSelectorsTopLevel(prelude: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let i = 0
  const n = prelude.length
  while (i < n) {
    const c = prelude[i]!
    if (c === '"' || c === "'") {
      const end = findStringEnd(prelude, i, c)
      const stop = end === -1 ? n - 1 : end
      current += prelude.slice(i, stop + 1)
      i = stop + 1
      continue
    }
    if (c === '(') {
      depth++
      current += c
      i++
      continue
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1)
      current += c
      i++
      continue
    }
    if (c === ',' && depth === 0) {
      parts.push(current)
      current = ''
      i++
      continue
    }
    current += c
    i++
  }
  parts.push(current)
  return parts
}

/**
 * Task 25, fix round 1. Decode the numeric HTML character references
 * (`&#104;`, `&#x68;`) a browser would decode before ever looking at an
 * attribute value as a URL. Named references (`&amp;`) are deliberately NOT
 * handled — this exists to see past one specific trick (spelling a scheme so
 * it does not read as one until decoded), not to be a general entity table.
 */
function decodeNumericEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_full, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);?/g, (_full, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

/**
 * Task 25, fix round 1. Decode CSS escape sequences (`\68` → `h`, consuming
 * one trailing whitespace per the CSS spec; `\(` → `(` for a non-hex escaped
 * character) — the mechanism a `url(...)` argument can use to spell a scheme
 * that does not read as one until a CSS parser decodes it. Applied uniformly
 * to every value this file checks, not only ones found inside a `<style>`
 * block: running it over an HTML attribute value that happens to contain no
 * backslash is a no-op, and running it is cheaper than reasoning about
 * exactly which of the two decodings a given call site needs.
 */
function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_full, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/\\(.)/g, (_full, ch: string) => ch)
}

/**
 * Task 25, fix round 1. Remove the ASCII tab, newline and carriage return
 * (and, belt and braces, every other C0 control character) that the URL
 * spec itself strips before parsing — `ht<TAB>p://` is `http://` to a
 * browser's URL parser, so it must be to this check too.
 */
function stripUrlWhitespace(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching C0 controls
  return value.replace(/[\x00-\x1F\x7F]/g, '')
}

/**
 * Task 25, fix round 1: what a raw attribute/declaration value looks like
 * once decoded and cleaned the way a browser would see it, before this file
 * judges whether it is safe. Order matters: entities first (an HTML
 * attribute value is entity-decoded before anything downstream reads it as
 * CSS or a URL), then CSS escapes (relevant when the value came from inside
 * a `url(...)` token, harmless no-op otherwise), then whitespace/control
 * stripping (the URL parser's own last step).
 */
function normalizeReferenceValue(raw: string): string {
  return stripUrlWhitespace(decodeCssEscapes(decodeNumericEntities(raw))).trim()
}

/**
 * Task 25, fix round 1: INVERTED from the original "does this look
 * external?" check, per the reviewer's ruling — a blocklist loses to the
 * next encoding nobody thought of, and this repo's own `scopeCss` already
 * establishes the right default for a safety net: drop what cannot be
 * PROVEN safe, rather than pass through what does not match a known-bad
 * pattern.
 *
 * A normalized value (normalizeReferenceValue) survives only as one of:
 * a `data:` URI, a pure `#fragment`, an empty value, or a relative path with
 * no scheme and no leading `//`. Everything else — a bare scheme regardless
 * of how it was spelled before decoding, a protocol-relative `//host`, or
 * anything this function does not recognize — is unsafe. A privacy-promise
 * guard, not a styling rule: any external fetch is a channel that can leak
 * transcript-derived mockup content to a third party when a friend opens
 * their own preview, so an unrecognized shape fails closed rather than
 * being given the benefit of the doubt.
 */
function isSafeReferenceValue(raw: string): boolean {
  const v = normalizeReferenceValue(raw)
  if (v === '') return true
  if (/^data:/i.test(v)) return true
  if (v.startsWith('#')) return true
  if (/^\/\//.test(v)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false
  return true
}

/**
 * Split a declaration list on top-level `;` only — a `;` inside a quoted
 * string, or inside the parens of a `url(...)` or `var(...)`, does not end a
 * declaration. Mirrors splitSelectorsTopLevel's bound exactly, applied to `;`
 * instead of `,`: textual, not a real CSS value parser.
 */
function splitDeclarationsTopLevel(body: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let i = 0
  const n = body.length
  while (i < n) {
    const c = body[i]!
    if (c === '"' || c === "'") {
      const end = findStringEnd(body, i, c)
      const stop = end === -1 ? n - 1 : end
      current += body.slice(i, stop + 1)
      i = stop + 1
      continue
    }
    if (c === '(') {
      depth++
      current += c
      i++
      continue
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1)
      current += c
      i++
      continue
    }
    if (c === ';' && depth === 0) {
      parts.push(current)
      current = ''
      i++
      continue
    }
    current += c
    i++
  }
  parts.push(current)
  return parts
}

/**
 * Whether every `url(...)` argument in a declaration's text is provably safe
 * (isSafeReferenceValue). Task 25 fix round 1: inverted from "has an
 * external url()" — a declaration with a `url(...)` this regex cannot make
 * sense of (no closing paren found, say) is not "safe" merely because no
 * external URL was matched, so this checks every match found and requires
 * each to pass, rather than requiring one bad match to fail.
 */
function declarationIsSafe(decl: string): boolean {
  const re = /url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(decl)) !== null) {
    if (!isSafeReferenceValue(m[2] ?? '')) return false
  }
  return true
}

/**
 * Drop any declaration in a rule body that references a `url(...)` which is
 * not provably safe — `background(-image)`, `mask-image`, `cursor`,
 * `list-style-image`, any property a model might reach for — rather than
 * rewrite the URL: an unscopable rule is exactly the one that would leak, and
 * this file drops what it cannot make safe (scopeCss's own rule, applied one
 * level deeper).
 *
 * THE BOUND: textual, per declarationIsSafe above. A url() reached
 * indirectly through a CSS custom property (`--bg: url(http://evil); ...:
 * var(--bg)`) is not traced — that would need real value resolution this file
 * does not do. (After fix round 1, this residual gap is also covered by the
 * document-level meta CSP composeMockup now emits — see its own comment —
 * which is enforced against what the browser actually resolves regardless of
 * how a value got there.)
 */
function stripExternalUrlDeclarations(body: string): string {
  return splitDeclarationsTopLevel(body)
    .filter((decl) => declarationIsSafe(decl))
    .join(';')
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
 * Scope every selector in a comma-separated group, splitting on top-level
 * commas only (splitSelectorsTopLevel — Findings 2 and 4). A group survives
 * with only its scopable members if at least one exists; a group that is
 * ENTIRELY frame-owned selectors (e.g. `html, body { ... }`) drops the whole
 * rule, since there is nothing left to say.
 */
function scopeSelectorGroup(prelude: string, scope: string): string | null {
  const scoped = splitSelectorsTopLevel(prelude)
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
 *
 * Returns null — rather than whatever it managed to accumulate — when it hits
 * input it cannot make structural sense of (an unterminated string or
 * comment, or brace nesting that never balances). FIX FOR FINDING 1, PART B:
 * this used to `break` at the desync point and return the partial `out`
 * accumulated so far, silently dropping every rule after it — legal CSS
 * (`[data-x="{"] { color: red } .after { color: blue }`) could wipe an
 * unrelated sibling rule with no signal to anyone. Failure is now
 * ALL-OR-NOTHING per block: if this function cannot fully parse a `<style>`
 * block's contents, scopeFragmentStyles drops the whole block rather than
 * emit an arbitrary, unpredictable prefix of it. This degrades gracefully
 * BECAUSE the frame publishes default styles (MOCKUP_SHELL_CLASSES / NUDGE):
 * a fragment that loses its bespoke CSS to a parse failure still renders
 * plain-but-presentable, not broken — the nudge is a floor, not just a
 * suggestion.
 *
 * A rule dropped by explicit design (an unhandled at-rule, a frame-owned bare
 * selector) is NOT a parse failure and does not trigger this — this function
 * understood that rule's boundaries and chose not to emit it. Only a genuine
 * "I cannot tell where this ends" is.
 *
 * Task 25: a surviving rule's body also has any declaration carrying an
 * external `url(...)` dropped (stripExternalUrlDeclarations) before it is
 * emitted — the CSS half of hardening the mockup surfaces against external
 * fetches. That is a value-level drop, unrelated to whether the rule parsed;
 * it happens after this function has already decided the rule is real.
 */
function scopeCss(css: string, scope: string): string | null {
  let out = ''
  let i = 0
  const n = css.length

  for (;;) {
    const start = skipInsignificant(css, i)
    if (start === -1) return null // unterminated trailing comment
    if (start >= n) break
    i = start

    if (css.slice(i, i + 7).toLowerCase() === '@import') {
      const semi = indexOfOutsideStrings(css, ';', i)
      if (semi === -1) return null // unterminated @import statement
      i = semi + 1
      continue
    }

    const braceIdx = indexOfOutsideStrings(css, '{', i)
    if (braceIdx === -1) return null // no rule body follows — can't parse the rest
    const prelude = css.slice(i, braceIdx).trim()
    const closeIdx = matchingBrace(css, braceIdx)
    if (closeIdx === -1) return null // desynced — do not guess, do not emit a prefix
    const body = css.slice(braceIdx + 1, closeIdx)

    if (prelude.toLowerCase().startsWith('@media')) {
      const scopedBody = scopeCss(body, scope)
      if (scopedBody === null) return null // a nested block that can't parse fails the whole block
      out += `${prelude} { ${scopedBody} }\n`
    } else if (!prelude.startsWith('@')) {
      const scopedSelector = scopeSelectorGroup(prelude, scope)
      if (scopedSelector) {
        // Task 25: a declaration referencing an external url() is dropped
        // here too, same pass, same all-or-nothing-per-declaration posture —
        // see stripExternalUrlDeclarations.
        out += `${scopedSelector} { ${stripExternalUrlDeclarations(body)} }\n`
      }
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
 * selectors, comma-separated groups (including commas nested inside `(...)`
 * or a quoted attribute value), and `@media` blocks — and DROPS anything it
 * cannot scope safely: `@import`, bare `html`/`body`/`:root` selectors (the
 * frame's to own), and a `<style>` block it cannot fully parse (an
 * unterminated string/comment, or unbalanced braces) — dropped WHOLE, per
 * scopeCss's contract, rather than truncated. Dropping beats passing through
 * or truncating: an unscopable rule is exactly the one that would leak, and a
 * silent partial block is exactly the one that would look complete while
 * missing content. It does NOT handle `@keyframes`, `@font-face`,
 * `@supports`, or CSS nesting (`&`) — those are dropped too, silently, which
 * is the same bound applied uniformly rather than special-cased.
 */
function scopeFragmentStyles(html: string, screenId: string): string {
  const scope = `#screen-${screenId}`
  return html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_full, css: string) => {
    const scoped = scopeCss(css, scope)
    return `<style>${scoped ?? ''}</style>`
  })
}

/**
 * Task 25, fix round 4. Find the closing quote for an HTML attribute value
 * that opens with `quote` at `start` (pointing AT the opening quote).
 *
 * DELIBERATELY NOT findStringEnd, and this separation is itself the fix for a
 * Critical the reviewer found in round 3. findStringEnd implements the CSS
 * <string-token> rule: a backslash escapes the character after it, so `\"`
 * does not close the string. HTML ATTRIBUTE VALUES HAVE NO ESCAPE MECHANISM
 * AT ALL — a real browser's tokenizer closes a double-quoted value at the
 * very next literal `"`, full stop, and a backslash inside one is just a
 * character like any other. Round 3 reused findStringEnd for HTML tag
 * scanning anyway (on this task's own coordinator's suggestion, unchecked
 * against the HTML spec), so `<meta content="0;url=http://evil\"
 * http-equiv="refresh">` — where a browser closes `content`'s value at the
 * `\"` and then reads a clean, separate `http-equiv="refresh"` right after —
 * instead made the CSS-rule scanner treat `\"` as an escaped quote, run past
 * the tag's real end, hit the unterminated-tag fallback, and (under round
 * 3's fail-open behavior) leak the rest of the fragment verbatim. DO NOT
 * MERGE THIS BACK WITH findStringEnd: the two functions encode different,
 * incompatible grammars that happen to both use quote characters, and
 * sharing a scanner between them is exactly what produced this bug.
 *
 * Returns -1 if `quote` never recurs — an unterminated attribute value.
 */
function findHtmlAttrValueEnd(html: string, start: number, quote: string): number {
  return html.indexOf(quote, start + 1)
}

/**
 * Find the `>` that actually closes a tag opened at `start` (which must
 * point at its `<`), treating a quoted attribute value as an opaque span so a
 * `>` inside `content="0;url=http://evil>x"` is read as DATA, not the tag's
 * end — round 3's fix for the first version of this bug (a naive `[^>]*}`
 * regex that stopped at the first `>` regardless of quoting).
 *
 * Uses findHtmlAttrValueEnd (round 4), NOT findStringEnd — see that
 * function's comment for why sharing a CSS-rule scanner here was itself a
 * bug, not just a style choice.
 *
 * Also deliberately does NOT reuse indexOfOutsideStrings, which solves the
 * identical shape of problem for CSS: that function additionally treats
 * `/* … *\/` as an opaque comment span, a CSS rule with no HTML analogue,
 * and importing it here would risk swallowing real tag content after an
 * unrelated `/` immediately followed by `*` inside an unquoted attribute
 * value.
 *
 * Returns -1 if the tag never closes (an unterminated attribute value) — the
 * caller does not guess where it would have ended.
 */
function findTagEnd(html: string, start: number): number {
  let i = start
  const n = html.length
  while (i < n) {
    const c = html[i]!
    if (c === '"' || c === "'") {
      const end = findHtmlAttrValueEnd(html, i, c)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === '>') return i
    i++
  }
  return -1
}

/**
 * Task 25, fix round 5: drop EVERY `<meta ...>` tag from a fragment,
 * unconditionally — not just an `http-equiv="refresh"` one. Renamed from
 * `stripMetaRefresh` because that name promised a DISCRIMINATION (drop the
 * dangerous kind, keep the rest) this function no longer makes.
 *
 * WHY THE WHOLE CLASS, NOT JUST THE DANGEROUS MEMBER — three consecutive
 * rounds tried to answer "which meta tag is a refresh" by parsing attributes
 * out of text, and each attempt shipped a working bypass, because each
 * required deciding correctly and each decision was defeated by a
 * differently-shaped decoy:
 *   - Round 2: a `[^>]*` tag-boundary regex stopped at the first `>`,
 *     including one inside a quoted attribute value, so a crafted `content=`
 *     hid `http-equiv="refresh"` outside the matched substring entirely.
 *   - Round 3 fixed the boundary (findTagEnd) but reused the CSS
 *     backslash-escape rule (findStringEnd) to find a quote's close — HTML
 *     attribute values have no escape mechanism, so `content="...\"
 *     http-equiv="refresh">` read as one unterminated value instead of two
 *     clean attributes, and round 3's fail-open fallback leaked the tag AND
 *     everything after it.
 *   - Round 4 fixed BOTH the boundary and the escape rule
 *     (findHtmlAttrValueEnd) and changed the fallback to fail closed — and
 *     the reviewer still found a live exploit, this time not in the tag
 *     boundary at all: the `http-equiv` VALUE-EXTRACTION regex re-scanned
 *     the correctly-bounded tag's raw text for the first textual
 *     `http-equiv=`, and `<meta data-note='http-equiv="x"' http-equiv=
 *     "refresh" content="...">` put a decoy `http-equiv="x"` inside an
 *     UNRELATED attribute's quoted value, ahead of the real one, so the
 *     regex matched the decoy, read "x", decided "not refresh," and shipped
 *     the real redirect untouched.
 *
 * Three rounds, three holes, one root cause: matching text without
 * attribute-boundary context, where "which attribute is this text actually
 * inside of" is exactly the question a regex re-scan cannot answer and a
 * real tokenizer would have to. REMOVING THE DECISION REMOVES THE BUG CLASS.
 * This is the same reasoning `scopeCss` already follows for a `<style>`
 * block it cannot fully parse — dropped whole rather than trusted with a
 * partial understanding of it — applied here to an entire ELEMENT TYPE
 * rather than a parse failure: a fragment (a `<section>` destined for the
 * document `<body>`) has NO legitimate use for ANY `<meta>` tag. The
 * document's charset, viewport, and CSP are supplied once by the frame in
 * `composeMockup`, never by a fragment. A non-refresh `<meta>` inside a body
 * section is invalid HTML a browser silently ignores anyway, so dropping one
 * costs nothing real — the one exception that would matter
 * (`http-equiv="refresh"`) is exactly the shape being removed. STATED
 * PLAINLY SO NOBODY REINTRODUCES THE DISCRIMINATION AS AN OPTIMISATION: do
 * not resurrect an `http-equiv` check here. The lesson of three rounds is
 * that the check is the bug.
 *
 * Reuses findTagEnd (round 4, now well-tested) to find each tag's real
 * boundary — that part of round 3/4's work was correct and stays. What is
 * GONE is the `http-equiv` value-extraction regex entirely: there is nothing
 * left for it to decide.
 *
 * FAILS CLOSED on a tag findTagEnd cannot bound (round 4's reasoning stands
 * unchanged: an unterminated attribute quote has no well-defined boundary to
 * recover, and the cost of failing open — leaking the rest of the fragment —
 * is worse than the cost of failing closed — losing an already-malformed
 * fragment's tail).
 */
function stripMetaTags(html: string): string {
  let out = ''
  let i = 0
  const n = html.length
  const openTag = /<meta\b/gi

  while (i < n) {
    openTag.lastIndex = i
    const open = openTag.exec(html)
    if (!open) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, open.index)

    const closeIdx = findTagEnd(html, open.index)
    if (closeIdx === -1) {
      // Fails closed — see the doc comment above and round 4's report for
      // the full reasoning. Nothing from this <meta onward is emitted.
      break
    }

    // No inspection of the tag's contents at all — that inspection is the
    // bug three rounds kept re-discovering a new shape of. Every <meta> tag
    // this scanner bounds is simply omitted from the output.
    i = closeIdx + 1
  }

  return out
}

/**
 * Task 25: strip external references from the fragment's own markup — the
 * `<style>` half of the guard lives in scopeCss/stripExternalUrlDeclarations
 * above; this is the rest of the document. `default-src 'none'` on the two
 * serving routes (app/mockup/[version]/route.ts,
 * app/admin/mockup/[user]/[version]/route.ts) is a header, and a header
 * cannot reach the ONE surface that matters most: app/[user]/ChatPanel.tsx
 * renders the friend's own scoped preview with `srcDoc`, not `src`, which is
 * never served by either route and therefore carries no header at all. This
 * runs at compose time instead, so the guarantee travels WITH the document —
 * the route, the srcDoc card, and the admin pane all get it from one place,
 * the same posture lib/spec/banner.ts takes for the SYNTHETIC banner.
 *
 * Three passes, in order:
 *  1. An inline `style="..."` attribute is a fragment's only way to carry CSS
 *     OUTSIDE a `<style>` tag, so its declarations get the exact same
 *     not-provably-safe url() drop as a `<style>` block's
 *     (stripExternalUrlDeclarations) — this is not "the CSS guard" and "the
 *     HTML guard", it is one guard reached from two syntactic positions.
 *  2. Every `src=`/`href=` attribute whose value is not provably safe
 *     (isSafeReferenceValue) — double-quoted, single-quoted, OR unquoted, all
 *     three HTML attribute-value forms — is removed entirely, not blanked to
 *     `src=""`: an empty value on some elements re-requests the CURRENT
 *     document, which would defeat the point.
 *  3. Fix round 2 (broadened to every `<meta>` tag in round 5): any `<meta>`
 *     tag is dropped whole (stripMetaTags) — closes a navigation channel the
 *     meta CSP does not reach (CSP's fetch directives do not govern
 *     navigations), stripped at the source rather than relied on a sandbox
 *     attribute to block. Round 5 stopped trying to identify WHICH meta tag
 *     is the dangerous one after three straight rounds of that decision
 *     itself shipping a bypass; see that function's own comment for why the
 *     whole element type goes rather than just `http-equiv="refresh"`.
 *
 * DEFENCE IN DEPTH, NOT THE ONLY LAYER. Fix round 1 (reviewer-found): a
 * string-match blocklist here lost to four encodings that spell a scheme
 * without LOOKING like one until decoded — an HTML numeric entity
 * (`&#104;ttp://`), a tab inside the scheme (a browser's URL parser strips
 * it, so `ht<TAB>p://` IS `http://` to the browser), a CSS backslash escape
 * (`\68ttp://`), and an unquoted attribute value, which the old regex never
 * matched at all. This function now normalizes (decode entities, decode CSS
 * escapes, strip URL whitespace/control chars — normalizeReferenceValue)
 * before judging, closing those four; but the REAL fix for "the next
 * encoding nobody thought of" is composeMockup's document-level `<meta
 * http-equiv="Content-Security-Policy">` (see its own comment), which the
 * browser enforces against the value it actually resolves, after every
 * decoding step, regardless of which one a future trick uses. This function
 * is the layer that keeps the SOURCE clean; the meta CSP is the layer that
 * cannot be tricked by a source it never fully understood.
 *
 * THE BOUND, STATED PLAINLY. This strips `src=`, `href=`, and `url(...)`
 * inside `style="..."`. It does NOT strip: `xlink:href` (SVG's own reference
 * attribute), `<object data=…>`, `<video poster=…>`, `srcset`, or a CSS
 * custom-property indirection. These shapes are not in the vocabulary
 * mockup-v4.md asks the model to draw (`<section>`/`<div>`/`<img>`/inline
 * `<style>`), and adding cases nothing produces would be exactly the
 * unbounded, ever-growing parser scopeCss's own doc comment already declines
 * to become. BUT — and this is the materially different claim fix round 1
 * makes true — a fragment that DOES reach for one of them is no longer the
 * same kind of gap it was before composeMockup's meta CSP existed. `xlink:href`
 * (as an image fetch), `object`/`embed` `data=`, `<video poster=>`, and
 * `srcset` are all subresource fetches the meta CSP's `img-src`/`default-src
 * 'none'` fallback blocks regardless of which HTML attribute requested them
 * — unstripped here, they still fail to load, so the outcome is a BROKEN
 * IMAGE, not a leak. Ditto a CSS custom-property indirection: the CSP is
 * enforced against the resolved fetch, not the source text, so `--bg:
 * url(http://evil); background: var(--bg)` is blocked exactly like a direct
 * `url(http://evil)` would be.
 *
 * FIX ROUND 2: a `<meta http-equiv="refresh" content="…url=…">` redirect used
 * to be listed here as the one shape the meta CSP could NOT close, and that
 * was correct — it is a NAVIGATION, and CSP's fetch directives (`default-src`,
 * `img-src`, …) genuinely do not govern navigations. Do not assume the meta
 * CSP is doing this job; it is not, by design of the CSP spec, not by an
 * oversight in this file. What closes it is stripMetaTags (pass 3, above):
 * EVERY `<meta>` tag is dropped at compose time, unconditionally — as of
 * round 5, not just an `http-equiv="refresh"` one — rather than validated.
 * Three straight rounds tried validating instead (deciding which meta tag
 * was dangerous) and each shipped a bypass; see stripMetaTags's own comment
 * for the full history. Dropping the whole element type is the same "drop
 * what cannot be made safe" posture as everything else in this file, applied
 * to a class instead of a parse failure.
 */
function stripExternalReferences(html: string): string {
  const stylesSanitized = html.replace(
    /(\sstyle\s*=\s*)(['"])([\s\S]*?)\2/gi,
    (_full, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${stripExternalUrlDeclarations(value)}${quote}`,
  )
  // Task 25, fix round 1: three alternatives for the three HTML attribute-value
  // forms — double-quoted, single-quoted, unquoted (a run with no whitespace
  // and none of the characters HTML forbids unquoted:
  // `"'=<>` and backtick). The old version matched only the first two, so
  // `<img src=https://evil.example/x.png>` sailed straight through.
  const attrsSanitized = stylesSanitized.replace(
    /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (full: string, dq: string | undefined, sq: string | undefined, uq: string | undefined) => {
      const value = dq ?? sq ?? uq ?? ''
      return isSafeReferenceValue(value) ? full : ''
    },
  )
  // Task 25, fix round 2 (broadened in round 5): the navigation channel
  // neither the attribute pass above nor the meta CSP reaches — see
  // stripMetaTags's own comment.
  return stripMetaTags(attrsSanitized)
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
 *
 * Task 25: every fragment also passes through stripExternalReferences here,
 * after scoping — see that function's doc comment for exactly which
 * reference shapes are stripped and which are not. This runs for BOTH the
 * whole-surface document (`specs.mockup_html`, what the two routes serve and
 * what MockupDialog's iframe loads by `src`) and the scoped `only` document
 * (`Proposal.preview_html`, what ChatPanel's card renders by `srcDoc`) —
 * composeMockup is the one place both are built, so it is the one place this
 * guard needs to live to cover both.
 *
 * Task 25, fix round 1: the emitted `<head>` also carries a `<meta
 * http-equiv="Content-Security-Policy">` with the same three fetch-blocking
 * directives Nico pinned for the two routes' headers (`default-src 'none';
 * style-src 'unsafe-inline'; img-src data:`) — ONE policy in two places,
 * rather than a route policy and a separate document policy that could
 * drift. THIS IS THE STRUCTURAL GUARANTEE, not the regex stripping above:
 * stripExternalReferences reads the SOURCE text and can be beaten by an
 * encoding it does not decode; the meta CSP is enforced by the browser
 * against the URL it actually resolves, after every decoding step a browser
 * performs, so it cannot be tricked by a source it never fully understood —
 * the reason the reviewer ranked it as the fix that matters most. Verified
 * empirically (not assumed) that a `<meta>` CSP inside a `srcDoc`-loaded,
 * `sandbox=""` iframe is enforced: a data: image loads, an external image
 * fires a real network request that fails with a CSP console violation and
 * never paints. `sandbox` and `frame-ancestors` are deliberately absent from
 * this policy — they are HEADER-only concepts (a `<meta>` CSP cannot set
 * them; the HTML spec ignores a sandbox directive there), and the job they
 * would do is already done by the `sandbox=""` attribute every iframe that
 * renders this document already carries.
 *
 * NOT COVERED BY THIS META CSP: a navigation. `default-src`/`img-src` are
 * fetch directives; a `<meta http-equiv="refresh">` redirect is closed
 * separately, by stripMetaTags (fix rounds 2–5) dropping every `<meta>` tag
 * outright — see its own comment for why this policy cannot be the thing
 * doing that job, and for why the strip does not try to identify just the
 * refresh one.
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
      const scoped = scopeFragmentStyles(html, screen.id)
      return `<div id="screen-${screen.id}">${stripExternalReferences(scoped)}</div>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>${FRAME}${NUDGE}</style>
</head>
<body>
<div class="frame">
${body}
</div>
</body>
</html>`
}
