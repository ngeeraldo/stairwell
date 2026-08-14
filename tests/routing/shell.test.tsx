// tests/routing/shell.test.tsx
// @vitest-environment jsdom
//
// S3 — the only screen after login, and the one composed screen in the
// product. What is testable without a browser is the COMPOSITION: that both
// regions exist at once, that the arrangement is expressed in class names
// rather than in JavaScript, and that the toggle keeps nothing.
//
// What is NOT testable here is whether any of it looks right at 375px or
// 1440px. That is the screenshot review's job (onboarding ledger D16), and
// pretending otherwise is how a suite ends up green about a broken layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { click, mount } from '@/tests/support/dom'
import { Shell } from '@/app/[user]/Shell'

beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const CHAT = React.createElement('div', null, 'CHAT SURFACE TEST')
const CONTENT = React.createElement('div', null, 'CONTENT AREA TEST')

function shell(chatOpenByDefault: boolean) {
  return React.createElement(Shell, { chat: CHAT, content: CONTENT, chatOpenByDefault })
}

describe('composition', () => {
  it('renders both regions at once, from ONE chat surface', async () => {
    // The surfaces rule: "The chat is one surface in both compositions — same
    // component, same transcript." Two copies (one for wide, one for narrow,
    // hidden by CSS) would satisfy a screenshot and break the transcript.
    const { container, unmount } = await mount(shell(true))

    expect(container.textContent).toContain('CHAT SURFACE TEST')
    expect(container.textContent).toContain('CONTENT AREA TEST')
    expect(container.querySelectorAll('[aria-label="Chat"]')).toHaveLength(1)

    await unmount()
  })

  it('expresses BOTH arrangements in class names, with no JS measuring anything', async () => {
    // onboarding ledger D6. The sheet classes and the panel classes are on the
    // same element: below md it is `fixed inset-0`, at md and up it is a
    // static 400px column with a right border. If the arrangement were chosen
    // in JavaScript, only one set would ever be present — and the server and
    // the client would disagree for a frame.
    const { container, unmount } = await mount(shell(true))
    const classes = container.querySelector('[aria-label="Chat"]')!.className

    expect(classes).toContain('fixed')
    expect(classes).toContain('inset-0')
    expect(classes).toContain('md:static')
    expect(classes).toContain('md:w-[400px]')

    await unmount()
  })

  it('never consults matchMedia', async () => {
    // The mechanical version of "breakpoints are CSS". A component that asked
    // the viewport its width would be the two-implementations bug wearing one
    // name, and it would pass every other test in this file.
    const matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    vi.stubGlobal('matchMedia', matchMedia)

    const { unmount } = await mount(shell(true))
    expect(matchMedia).not.toHaveBeenCalled()

    await unmount()
  })
})

describe('the one boolean', () => {
  it('opens the chat when no dashboard is deployed', async () => {
    const { container, unmount } = await mount(shell(true))
    expect(container.querySelector('[data-chat="open"]')).not.toBeNull()
    expect(container.textContent).toContain('CHAT SURFACE TEST')
    await unmount()
  })

  it('collapses the chat to a toggle once one is', async () => {
    // The morning glance is dashboard-first; the chat stays one tap away.
    const { container, unmount } = await mount(shell(false))
    expect(container.querySelector('[data-chat="closed"]')).not.toBeNull()
    expect(container.textContent).not.toContain('CHAT SURFACE TEST')
    expect(container.textContent).toContain('Show chat')
    await unmount()
  })

  it('toggles both ways within the session', async () => {
    const { container, unmount } = await mount(shell(false))

    await click(container.querySelector('button'))
    expect(container.querySelector('[data-chat="open"]')).not.toBeNull()

    await click(container.querySelector('button'))
    expect(container.querySelector('[data-chat="closed"]')).not.toBeNull()

    await unmount()
  })

  it('persists NOTHING across sessions', async () => {
    // onboarding ledger D7. ChatPanel used to keep this in localStorage under
    // 'stairwell:chat-open'; the spec lists persistence of panel state as a
    // non-goal, and keeping it would mean a friend who collapsed the chat once
    // during their interview never saw it open on the morning their dashboard
    // landed. Asserted on the WHOLE store, so a differently-named key does not
    // slip through.
    const { container, unmount } = await mount(shell(true))
    await click(container.querySelector('button'))

    expect(window.localStorage.length).toBe(0)

    await unmount()
  })

  it('keeps the content area mounted in both states', async () => {
    // Collapsing the chat must not unmount the dashboard — the content area is
    // the point of the screen, and re-mounting it would re-run every query.
    const { container, unmount } = await mount(shell(true))
    expect(container.textContent).toContain('CONTENT AREA TEST')
    await click(container.querySelector('button'))
    expect(container.textContent).toContain('CONTENT AREA TEST')
    await unmount()
  })
})
