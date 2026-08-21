// tests/ui/plaidOAuthReturn.test.tsx
// @vitest-environment jsdom
//
// The OAuth resume. This is the only code path in the app that runs on a COLD
// PAGE LOAD after a third party navigated the browser away and back, so almost
// every assumption the rest of the connect flow makes is unavailable here:
// no component state, no props, no server render carrying context.
//
// What is pinned:
//
//  - it resumes with the SAME token, and hands Plaid the return URL VERBATIM
//  - it takes NOTHING from the incoming URL's query string — a redirect that
//    arrived from a third party must never name which account gets written to
//  - a missing handoff says so plainly instead of spinning forever
//  - it opens Link exactly once, even though React mounts effects twice in
//    dev StrictMode
//  - the handoff is cleared whichever way the flow ends
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flush, mount } from '@/tests/support/dom'
import { PlaidOAuthReturn } from '@/lib/ui/PlaidOAuthReturn'

const STORAGE_KEY = 'stairwell.plaid.link'
const CONNECT = '/api/users/devtwo/plaid/connect'
const RETURN_TO = '/devtwo'

/** The URL an OAuth bank actually sends the friend back on. */
const RETURN_URL = 'http://localhost:3000/plaid/oauth?oauth_state_id=abc123'

let onSuccess: ((token: string) => void) | undefined
let onExit: ((error: unknown) => void) | undefined
const open = vi.fn()
const create = vi.fn((config: any) => {
  onSuccess = config.onSuccess
  onExit = config.onExit
  return { open, destroy: vi.fn() }
})

let assignedHref: string | undefined

beforeEach(() => {
  vi.stubGlobal('React', React)
  onSuccess = undefined
  onExit = undefined
  assignedHref = undefined
  open.mockClear()
  create.mockClear()
  ;(window as any).Plaid = { create }
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return RETURN_URL
      },
      set href(value: string) {
        assignedHref = value
      },
      reload: vi.fn(),
    },
  })
  sessionStorage.clear()
  sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ token: 'link-sandbox-1', connectAction: CONNECT, returnTo: RETURN_TO }),
  )
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
})

afterEach(() => {
  delete (window as any).Plaid
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('resuming after the bank sends the friend back', () => {
  it('reopens Link with the stored token and the URL they returned on', async () => {
    const { unmount } = await mount(<PlaidOAuthReturn />)
    await flush()

    expect(create).toHaveBeenCalledTimes(1)
    const config = create.mock.calls[0]![0]
    // The SAME token. A re-minted one would start a second flow rather than
    // resume this one.
    expect(config.token).toBe('link-sandbox-1')
    // Verbatim, and never parsed by us — Plaid reads the OAuth state out of it.
    expect(config.receivedRedirectUri).toBe(RETURN_URL)
    expect(open).toHaveBeenCalled()
    await unmount()
  })

  it('takes the account to write to from STORAGE, never from the returned URL', async () => {
    // The security property of this file. A redirect arriving from a third
    // party must not be able to name which friend's database gets written.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 't',
        connectAction: '/api/users/devtwo/plaid/connect',
        returnTo: '/devtwo',
      }),
    )
    const { unmount } = await mount(<PlaidOAuthReturn />)
    await flush()
    await act(async () => onSuccess!('public-sandbox-1'))
    await flush()

    const posted = (fetch as any).mock.calls[0]
    expect(posted[0]).toBe('/api/users/devtwo/plaid/connect')
    // 'abc123' is the only identifier in the returned URL. It must appear
    // nowhere in what we send.
    expect(posted[0]).not.toContain('abc123')
    await unmount()
  })

  it('sends the friend back to their dashboard when it succeeds', async () => {
    const { unmount } = await mount(<PlaidOAuthReturn />)
    await flush()
    await act(async () => onSuccess!('public-sandbox-1'))
    await flush()

    expect(assignedHref).toBe(RETURN_TO)
    // Nothing left behind on a shared computer.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    await unmount()
  })

  it('sends them back, without an error, if they cancel at the bank', async () => {
    const { unmount } = await mount(<PlaidOAuthReturn />)
    await flush()
    await act(async () => onExit!(null))
    await flush()

    expect(assignedHref).toBe(RETURN_TO)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    await unmount()
  })

  it('says nothing was saved when the exchange fails', async () => {
    const { container, unmount } = await mount(<PlaidOAuthReturn />)
    await flush()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })))
    await act(async () => onSuccess!('public-sandbox-1'))
    await flush()

    expect(container.textContent).toMatch(/nothing was saved/i)
    expect(assignedHref).toBeUndefined()
    await unmount()
  })
})

describe('when there is nothing to resume', () => {
  it('says so plainly instead of spinning forever', async () => {
    // The tab was closed, storage was cleared, or someone opened this URL
    // directly.
    sessionStorage.clear()
    const { container, unmount } = await mount(<PlaidOAuthReturn />)
    await flush()

    expect(create).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/can’t be finished/i)
    expect(container.textContent).toMatch(/nothing was saved/i)
    await unmount()
  })

  it('ignores a malformed handoff rather than trusting half of it', async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'only-a-token' }))
    const { container, unmount } = await mount(<PlaidOAuthReturn />)
    await flush()

    expect(create).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/can’t be finished/i)
    await unmount()
  })
})
