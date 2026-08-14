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
// good odds. This one is applied at serve time, to every mockup, on the single
// route both the card preview and the full-screen view read from. The model
// cannot forget it, an older stored mockup cannot lack it, and a future prompt
// version cannot quietly drop it.
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
