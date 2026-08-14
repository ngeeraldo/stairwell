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
  hasBanner,
  withBanner,
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
