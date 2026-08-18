// tests/spec/banner.test.ts
//
// The banner is the ONLY thing separating a mockup from a real dashboard now
// that previews carry plausible numbers instead of "£000.00". That makes it an
// honesty guard, and honesty guards in this codebase are enforced at a
// boundary rather than requested from a model — "the model always complies" is
// not a guarantee, a route is.
//
// The fixture-stripping case below is the point of this file: take a document
// that has no banner, serve it, and assert one comes out anyway.
import { describe, expect, it } from 'vitest'
import {
  BANNER_MARKER,
  BANNER_TEXT,
  CSP_META,
  hasBanner,
  hasCsp,
  withBanner,
  withCsp,
} from '@/lib/spec/banner'

const BARE = '<!doctype html><html><body><h1>Walk tracker</h1></body></html>'

describe('the mockup banner', () => {
  it('injects one into a document that has none', () => {
    // The model omitting it is the case this exists for.
    expect(hasBanner(BARE)).toBe(false)
    const served = withBanner(BARE)
    expect(hasBanner(served)).toBe(true)
    expect(served).toContain(BANNER_TEXT)
  })

  it('puts it at the top of the body, not after the content', () => {
    const served = withBanner(BARE)
    expect(served.indexOf(BANNER_MARKER)).toBeLessThan(
      served.indexOf('Walk tracker'),
    )
  })

  it('never adds a second one', () => {
    // Idempotent, so a stored mockup cannot end up wearing two banners — and
    // so a future prompt version that DOES emit one is not punished for it.
    const once = withBanner(BARE)
    const twice = withBanner(once)
    expect(twice).toBe(once)
    expect(twice.split(BANNER_MARKER)).toHaveLength(2)
  })

  it('labels a document with no <body> tag at all', () => {
    // Model-authored HTML is not guaranteed to be well formed. A malformed
    // mockup must still be labelled rather than served bare — unlabelled is
    // the one outcome this module exists to prevent.
    const served = withBanner('<h1>Just a fragment</h1>')
    expect(hasBanner(served)).toBe(true)
    expect(served.indexOf(BANNER_MARKER)).toBeLessThan(
      served.indexOf('Just a fragment'),
    )
  })

  it('keeps the original document intact', () => {
    // The route's whole contract is "exactly the bytes that were stored" plus
    // this label. Losing content to the injection would be a worse bug than
    // the one it fixes.
    expect(withBanner(BARE)).toContain('<h1>Walk tracker</h1>')
  })

  it('survives body tags with attributes', () => {
    const html = '<html><body class="p-4" data-x="1"><p>hi</p></body></html>'
    const served = withBanner(html)
    expect(hasBanner(served)).toBe(true)
    expect(served.indexOf(BANNER_MARKER)).toBeLessThan(served.indexOf('<p>hi'))
  })
})

// Final review, Important 3. lib/spec/mockupCompose.ts's own meta CSP only
// reaches documents THAT function composes. A version confirmed before this
// branch existed stores raw model output from mockup-v3.md instead — whose
// "no external anything" instruction was prompt-only, enforced by nothing —
// and app/[user]/page.tsx's pageLoadPreview and SpecCard's own fallback can
// both hand that document straight to the srcDoc boundary. This is the
// fixture Nico asked for: a pre-branch document with a real external <img
// src>, proving the boundary now blocks it rather than trusting the model.
describe('the mockup meta CSP boundary', () => {
  const PRE_BRANCH_DOCUMENT =
    '<!doctype html><html><head><title>Old mockup</title></head>' +
    '<body><img src="https://evil.example.test/pixel.png"></body></html>'

  it('injects the meta CSP into a pre-branch document that has none', () => {
    expect(hasCsp(PRE_BRANCH_DOCUMENT)).toBe(false)
    const served = withCsp(PRE_BRANCH_DOCUMENT)
    expect(hasCsp(served)).toBe(true)
    expect(served).toContain(CSP_META)
    // The external reference itself is NOT stripped by this boundary — that
    // is stripExternalReferences' job at compose time, and a pre-branch
    // document never went through it. The meta CSP is what stops the browser
    // from actually fetching it, which is the whole point of testing this
    // exact fixture: the <img> stays in the markup, but the policy that
    // blocks it loading is now present too.
    expect(served).toContain('evil.example.test')
  })

  it('puts the CSP inside <head>, before any content', () => {
    const served = withCsp(PRE_BRANCH_DOCUMENT)
    expect(served.indexOf(CSP_META)).toBeLessThan(served.indexOf('<img'))
  })

  it('never adds a second one — a document composeMockup already built is untouched', () => {
    const composed =
      '<!doctype html><html><head>' + CSP_META + '</head><body>hi</body></html>'
    const served = withCsp(composed)
    expect(served).toBe(composed)
    expect(served.split(CSP_META)).toHaveLength(2)
  })

  it('labels a document with no <head> tag at all', () => {
    const served = withCsp('<h1>Just a fragment</h1>')
    expect(hasCsp(served)).toBe(true)
    expect(served.indexOf(CSP_META)).toBeLessThan(served.indexOf('Just a fragment'))
  })

  it('keeps the original document intact', () => {
    expect(withCsp(PRE_BRANCH_DOCUMENT)).toContain('<title>Old mockup</title>')
  })
})
