// tests/routing/layoutScript.test.tsx
//
// The inline script in app/layout.tsx, which is the ONLY thing that tells the
// server two facts the browser alone knows: what kind of screen this is, and
// what timezone the friend is in.
//
// This file exists because a drill found nothing guarding it. Deleting the
// timezone line from the layout reddened not one test — every other test mocks
// `next/headers` and sets the cookies directly, so the whole read path stayed
// green over a server that would never receive a zone again, and every tap
// would quietly go back to being filed on the droplet's day.
//
// WHAT THIS CAN AND CANNOT PROVE. It renders the layout and asserts the script
// is there and writes both cookies. It cannot prove a browser executes it —
// nothing in a node test can. The screenshot harness does that implicitly:
// every shot after the first request is taken by a real Chromium that has run
// this script, and `readTimeZone` reads what it wrote. Between the two, a
// deletion is caught here and a malfunction is caught there.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEVICE_CLASS_COOKIE, TIME_ZONE_COOKIE } from '@/lib/metrics/deviceClass'

beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function markup(): Promise<string> {
  const { default: RootLayout } = await import('@/app/layout')
  return renderToStaticMarkup(
    RootLayout({ children: React.createElement('div', null, 'x') }) as React.ReactElement,
  )
}

describe('the layout script', () => {
  it('writes the device class, using the names the server reads', async () => {
    const html = await markup()
    // Against the exported constants, not retyped strings: a rename on one
    // side and not the other is exactly the failure that would leave the
    // server reading a cookie nobody writes.
    expect(html).toContain(`${DEVICE_CLASS_COOKIE}=`)
  })

  it('writes the timezone, which decides what day a tap is filed under', async () => {
    const html = await markup()
    expect(html).toContain(`${TIME_ZONE_COOKIE}=`)
    expect(html).toContain('resolvedOptions().timeZone')
  })

  it('encodes the zone, because an IANA name contains a slash', async () => {
    // 'America/New_York' unencoded in a Set-Cookie value is legal but asking
    // for trouble; encodeURIComponent is what keeps the value the server reads
    // identical to the one the browser resolved.
    expect(await markup()).toContain('encodeURIComponent')
  })

  it('scopes both cookies to the whole site and keeps them a year', async () => {
    // path=/ because the walk route and the shell are different paths and both
    // read them; a year because re-detecting on every load is the point, and
    // the value is refreshed each time anyway.
    const html = await markup()
    expect(html.match(/path=\//g) ?? []).toHaveLength(2)
    expect(html.match(/max-age=31536000/g) ?? []).toHaveLength(2)
    expect(html.match(/samesite=lax/g) ?? []).toHaveLength(2)
  })

  it('is the only script the app ships', async () => {
    // An inline script on a page that makes a privacy promise is a thing to
    // keep countable. If a second one ever appears, someone should have to
    // come here and say so.
    const html = await markup()
    expect(html.match(/<script/g) ?? []).toHaveLength(1)
  })
})
