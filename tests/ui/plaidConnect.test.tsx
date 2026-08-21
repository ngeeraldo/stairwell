// tests/ui/plaidConnect.test.tsx
// @vitest-environment jsdom
//
// The one control in this app that loads a third party's script into a page we
// serve.
//
// Uses tests/support/dom.tsx, not @testing-library/react: that file is
// explicit that the standing bar on new test dependencies applies here
// (onboarding ledger D9), and react-dom/client plus React's own `act` is
// enough for everything below.
//
// What is pinned, and why each one matters:
//
//  - the script comes from Plaid's CDN and from nowhere else, ONCE per page
//  - nothing about the friend crosses to Plaid from the browser
//  - the two long waits are named out loud, because a spinner that vanishes
//    into an empty dashboard reads as a broken product (plan F1/F3: ~10s to
//    create the item, then 2-6s before the first sync has anything)
//  - cancelling is not an error
//  - the action URLs are bounded to this origin, as WriteAction's are
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { click, flush, mount } from '@/tests/support/dom'
import { PlaidConnect } from '@/lib/ui/PlaidConnect'

const LINK = '/api/users/devtwo/plaid/link-token'
const CONNECT = '/api/users/devtwo/plaid/connect'
const RETURN_TO = '/devtwo'

let onSuccess: ((token: string) => void) | undefined
let onExit: ((error: unknown) => void) | undefined
const open = vi.fn()
const destroy = vi.fn()
const create = vi.fn((config: any) => {
  onSuccess = config.onSuccess
  onExit = config.onExit
  return { open, destroy }
})

/** The page reloads on success; jsdom's own reload would tear the test down. */
const reload = vi.fn()

beforeEach(() => {
  vi.stubGlobal('React', React)
  onSuccess = undefined
  onExit = undefined
  for (const spy of [open, destroy, create, reload]) spy.mockClear()
  ;(window as any).Plaid = { create }
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { reload, href: 'http://localhost/devtwo' },
  })
  document.head.innerHTML = ''
  sessionStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === LINK
        ? new Response(JSON.stringify({ link_token: 'link-sandbox-1', mode: 'new' }), {
            status: 200,
          })
        : new Response(null, { status: 204 }),
    ),
  )
})

afterEach(() => {
  delete (window as any).Plaid
  vi.unstubAllGlobals()
})

const button = (c: HTMLElement) => c.querySelector('button')

/**
 * Fire one of Plaid's callbacks and let the resulting state settle.
 *
 * Wrapped in act() because these are the ONLY state updates in this suite that
 * do not come from a click — Plaid's script calls them from outside React.
 * tests/support/dom.tsx treats an unwrapped-update warning as a defect rather
 * than noise, since without act's guarantee an assertion can read pre-update
 * DOM and pass for the wrong reason.
 */
async function fromPlaid(fire: () => void): Promise<void> {
  await act(async () => {
    fire()
  })
}

describe('opening a bank connection', () => {
  it('mints a token server-side and hands Plaid that, and nothing else', async () => {
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    expect(create).toHaveBeenCalled()
    const config = create.mock.calls[0]![0]
    expect(config.token).toBe('link-sandbox-1')
    // Nothing about the friend crosses to Plaid from the browser. The slug is
    // in the URL we POST to; it is not in what Plaid is handed.
    expect(JSON.stringify(config.token)).not.toContain('devtwo')
    expect(open).toHaveBeenCalled()
    await unmount()
  })

  it('exchanges the public token against our own route, never Plaid', async () => {
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    await fromPlaid(() => onSuccess!('public-sandbox-1'))
    await flush()

    const posted = (fetch as any).mock.calls.find((c: any[]) => c[0] === CONNECT)
    expect(posted).toBeDefined()
    expect(posted[1].body.get('public_token')).toBe('public-sandbox-1')
    // Without this header lib/http/redirect.ts answers 303 instead of 204,
    // fetch follows it, and the dashboard renders a second time — landing a
    // spurious dashboard_open row in an append-only table.
    expect(posted[1].headers).toEqual({ 'X-Stairwell-Write': '1' })
    // No optimistic state: the page reloads so what the friend sees next is
    // what the database actually holds.
    expect(reload).toHaveBeenCalled()
    await unmount()
  })

  it('says out loud that finishing takes a few seconds', async () => {
    const slow = new Promise<Response>(() => {})
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    // Hold the exchange open so the waiting copy is observable — this is the
    // ~10s window a friend actually sits through.
    vi.stubGlobal('fetch', vi.fn(() => slow))
    await fromPlaid(() => onSuccess!('public-sandbox-1'))

    expect(container.textContent).toMatch(/takes a few seconds/i)
    expect(container.textContent).toMatch(/can take a minute to appear/i)
    await unmount()
  })

  it('returns to rest when the friend closes Plaid without connecting', async () => {
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    await fromPlaid(() => onExit!(null))

    // Cancelling is not an error. Nothing was saved and nothing is wrong.
    expect(container.textContent).not.toMatch(/couldn’t connect/i)
    expect((button(container) as HTMLButtonElement).disabled).toBe(false)
    await unmount()
  })

  it('says nothing was saved when the exchange fails', async () => {
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })))
    await fromPlaid(() => onSuccess!('public-sandbox-1'))
    await flush()

    expect(container.textContent).toMatch(/nothing was saved/i)
    expect(reload).not.toHaveBeenCalled()
    await unmount()
  })
})

describe('the third-party script', () => {
  it('is loaded from Plaid’s CDN and only from there', async () => {
    delete (window as any).Plaid
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    const scripts = Array.from(document.head.querySelectorAll('script'))
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.src).toBe('https://cdn.plaid.com/link/v2/stable/link-initialize.js')
    await unmount()
  })

  it('is not injected twice when two controls share a page', async () => {
    // Two copies of link-initialize.js on one page is the kind of bug that
    // only appears on a dashboard with two of these, and is never tested.
    delete (window as any).Plaid
    const { container, unmount } = await mount(
      <>
        <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />
        <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />
      </>,
    )
    for (const b of Array.from(container.querySelectorAll('button'))) await click(b)
    await flush()

    expect(document.head.querySelectorAll('script')).toHaveLength(1)
    await unmount()
  })
})

describe('the action URLs are bounded to this origin', () => {
  it('refuses an off-origin action, as WriteAction does', async () => {
    // This is a sanctioned place a dashboard causes a network request, so the
    // URL it can name is not open-ended.
    await expect(
      mount(<PlaidConnect linkTokenAction="https://evil.example/steal" connectAction={CONNECT} returnTo={RETURN_TO} />),
    ).rejects.toThrow()
  })
})

describe('preparing for an OAuth bank it cannot predict', () => {
  it('stores what a resume needs BEFORE opening Link', async () => {
    // Which kind of institution the friend picks is decided inside Plaid's UI,
    // after this component has finished running. An OAuth bank navigates the
    // browser away and every component unmounts — so the handoff is written
    // unconditionally, before open(), or it can never be written at all.
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    const stored = JSON.parse(sessionStorage.getItem('stairwell.plaid.link') ?? 'null')
    expect(stored).toEqual({
      token: 'link-sandbox-1',
      connectAction: CONNECT,
      returnTo: RETURN_TO,
    })
    await unmount()
  })

  it('stores no access token — the browser never sees one', async () => {
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()

    // A link token is single-use, expires in minutes and can read no account.
    // The access token, which CAN, is created server-side and written straight
    // into the friend's encrypted database.
    const raw = sessionStorage.getItem('stairwell.plaid.link') ?? ''
    expect(raw).not.toContain('access-')
    await unmount()
  })

  it('clears the handoff when the friend cancels', async () => {
    const { container, unmount } = await mount(
      <PlaidConnect linkTokenAction={LINK} connectAction={CONNECT} returnTo={RETURN_TO} />,
    )
    await click(button(container))
    await flush()
    await fromPlaid(() => onExit!(null))

    // An abandoned connection must leave nothing behind on a shared computer.
    expect(sessionStorage.getItem('stairwell.plaid.link')).toBeNull()
    await unmount()
  })
})
