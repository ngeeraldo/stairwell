// lib/spec/banner.ts
//
// The one thing that says a mockup is not a dashboard.
//
// WHY THIS IS A ROUTE'S JOB AND NOT A PROMPT'S. Mockups used to be honest by
// being ugly: every value was "£000.00" and "COFFEE PALACE TEST", so nobody
// could mistake a preview for their own money. That made previews read as
// broken rather than as a proposal, so the numbers are plausible now — which
// removes the only signal that they are invented. A banner replaces it.
//
// A banner the MODEL is asked to add is not a guarantee; it is a hope with
// good odds. This one is applied at the BOUNDARY, every time model-authored
// HTML reaches a screen: the session-authed /mockup/<version> route the
// full-screen dialog reads from, and — since the small preview card started
// showing a SCOPED document via `srcDoc` instead of that route
// (app/[user]/ChatPanel.tsx, Proposal.preview_html) — the render site that
// sets `srcDoc` too. Two call sites now, not one, and each is the honest
// place: the model cannot forget it, an older stored mockup cannot lack it,
// and a future prompt version cannot quietly drop it.
//
// INJECTED RATHER THAN REFUSED, deliberately. Refusing to serve a mockup with
// no banner would turn a model slip into a blank preview at the exact moment a
// friend is deciding whether to confirm — a broken screen in place of a
// working one with a label. Injection always leaves them something true.

/** The marker a document is checked for, and the thing a person reads. */
export const BANNER_TEXT = 'MOCKUP — sample numbers, not your data'

/** Machine-findable, so the check never depends on matching prose. */
export const BANNER_MARKER = 'data-stairwell-mockup-banner'

const BANNER_HTML =
  `<div ${BANNER_MARKER}="1" style="position:sticky;top:0;z-index:2147483647;` +
  `background:#1f2937;color:#fff;font:600 13px/1.4 system-ui,sans-serif;` +
  `padding:10px 16px;letter-spacing:.02em;text-align:center">` +
  `${BANNER_TEXT}</div>`

export function hasBanner(html: string): boolean {
  return html.includes(BANNER_MARKER)
}

/**
 * Return the document with exactly one banner at the top of the body.
 *
 * Idempotent: a document that already carries the marker is returned
 * unchanged, so a stored mockup cannot end up wearing two.
 *
 * Inserted after `<body …>` when there is one, and prepended otherwise —
 * model-authored HTML is not guaranteed to have the tag, and a mockup that
 * omits it must still be labelled rather than served bare.
 */
export function withBanner(html: string): string {
  if (hasBanner(html)) return html

  const bodyOpen = /<body\b[^>]*>/i.exec(html)
  if (!bodyOpen) return BANNER_HTML + html

  const at = bodyOpen.index + bodyOpen[0].length
  return html.slice(0, at) + BANNER_HTML + html.slice(at)
}

/**
 * Final review, Important 3. The same boundary argument as the banner above,
 * for the OTHER thing that must reach every document at the `srcDoc`
 * boundary: the fetch-blocking meta CSP (`default-src 'none'; style-src
 * 'unsafe-inline'; img-src data:`) Task 25 pinned. lib/spec/mockupCompose.ts
 * puts it into every document IT composes — but composeMockup only runs on
 * documents this branch built. Three fallbacks in app/[user]/page.tsx's
 * pageLoadPreview (a legacy row, a version with no stored fragments, or any
 * composition failure) and SpecCard's own `?? proposal.mockup_html` can all
 * hand this boundary a document that predates composeMockup entirely — one
 * drawn by mockup-v3.md, whose "no external anything" rule was prompt-only
 * and enforced by nothing. A friend loading their own page could fire a real
 * third-party request from a document composeMockup never touched.
 *
 * `CSP_META` is the exact literal lib/spec/mockupCompose.ts emits, imported
 * from here rather than written twice, so the route header, the composed
 * document, and this boundary can never disagree about the policy text.
 */
export const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'

export function hasCsp(html: string): boolean {
  return html.includes(CSP_META)
}

/**
 * Idempotent, same shape as withBanner: a document composeMockup already
 * built carries CSP_META verbatim, so it is returned unchanged rather than
 * gaining a second tag. Inserted right after `<head …>` when there is one —
 * where a meta CSP has to live to reliably govern the whole document — and
 * prepended otherwise, same "label it rather than serve it bare" fallback
 * withBanner uses for a missing `<body>`.
 */
export function withCsp(html: string): string {
  if (hasCsp(html)) return html

  const headOpen = /<head\b[^>]*>/i.exec(html)
  if (!headOpen) return CSP_META + html

  const at = headOpen.index + headOpen[0].length
  return html.slice(0, at) + CSP_META + html.slice(at)
}
