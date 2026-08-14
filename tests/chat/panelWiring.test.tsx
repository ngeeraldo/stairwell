// tests/chat/panelWiring.test.tsx
// @vitest-environment jsdom
//
// Step-4 ledger residual 1: "Nine call-site mutations survive the full suite,
// including proposals={[]} — which disconnects the entire proposal card
// region, so the product silently does nothing while the suite stays green."
//
// tests/chat/panel.test.ts drives the pure reducers directly and is excellent
// at it. What it cannot reach is the WIRING: which state each render prop is
// given, whether send() writes the body the route expects, whether onConfirm
// reaches attemptConfirm. That is this file's entire job, and every assertion
// below corresponds to one of the surviving mutations — see the drill table in
// the onboarding plan, Task 1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { mount, click, type, flush } from '@/tests/support/dom'
import ChatPanel from '@/app/[user]/ChatPanel'

// tsconfig's "jsx": "preserve" plus vitest's esbuild transform means the JSX
// here compiles to React.createElement against a global `React` — same idiom
// as tests/routing/userSpace.test.ts.
beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** An NDJSON body, exactly as app/api/chat/route.ts writes it. */
function ndjson(lines: unknown[]): Response {
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
  return new Response(new TextEncoder().encode(text), { status: 200 })
}

/**
 * A fetch double whose PARAMETERS are declared.
 *
 * `vi.fn(async () => …)` types `mock.calls` as `[]`, so `calls[0]![1]` is a
 * compile error rather than the request init — and the whole point of these
 * tests is asserting on what was sent. Declaring the parameters is what makes
 * the assertion typecheck instead of being cast into silence.
 */
function fetchDouble(respond: () => Response) {
  return vi.fn(async (_url: string, _init?: RequestInit) => respond())
}

const SPEC = {
  kind: 'version' as const,
  version: {
    title: 'Morning',
    summary: 'Your morning surface.',
    change_summary: 'Added a streak panel.',
    background: '',
    based_on_version: null,
    open_questions: [],
    data_requirements: [],
    screens: [
      {
        id: 'home',
        title: 'Home',
        order: 1,
        panels: [
          {
            id: 'streak',
            title: 'Streak',
            display: 'Days in a row',
            intent: 'so they can see it',
            context_of_use: null,
            values: [],
            entry: null,
          },
        ],
      },
    ],
  },
}

const PROPOSAL = { id: 7, version: 1, spec: SPEC, mockup_html: '<p>x</p>', first: true }

function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
}

describe('ChatPanel wiring', () => {
  it('renders the proposal it was handed at page load — the proposals={[]} mutation', async () => {
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )

    expect(container.querySelector('[data-spec-id="7"]')).not.toBeNull()
    expect(container.textContent).toContain('Added a streak panel.')

    await unmount()
  })

  it('POSTs the typed message to /api/chat and streams the reply into the transcript', async () => {
    const fetchMock = fetchDouble(() => ndjson([{ t: 'hello ' }, { t: 'there' }, { done: true }]))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    await type(container.querySelector('textarea'), 'what can you do?')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/chat')
    expect(JSON.parse(init!.body as string)).toEqual({
      body: 'what can you do?',
    })
    expect(container.textContent).toContain('what can you do?')
    expect(container.textContent).toContain('hello there')

    await unmount()
  })

  it('a proposal arriving mid-stream renders as a card without a reload', async () => {
    vi.stubGlobal(
      'fetch',
      fetchDouble(() => ndjson([{ t: 'ok' }, { authoring: true }, { proposal: PROPOSAL }, { done: true }])),
    )

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    await type(container.querySelector('textarea'), 'build it')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    expect(container.querySelector('[data-spec-id="7"]')).not.toBeNull()

    await unmount()
  })

  it("'Build this' POSTs the card's own spec id to /api/spec/confirm", async () => {
    const fetchMock = fetchDouble(() => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )
    await click(buttonLabelled(container, 'Build this'))
    await flush()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spec/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ specId: 7 }),
      }),
    )
    expect(container.textContent).toContain('Building this one.')

    await unmount()
  })

  it('a failed confirm says so on the card rather than silently re-enabling', async () => {
    vi.stubGlobal('fetch', fetchDouble(() => new Response(null, { status: 409 })))

    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )
    await click(buttonLabelled(container, 'Build this'))
    await flush()

    expect(container.textContent).toContain("That didn't go through")

    await unmount()
  })

  it('the retry button re-sends ITS OWN message, not the newest one', async () => {
    // Two interrupted turns on screen. Step 4 moved `source` onto the Turn for
    // exactly this: with one component-level ref, the OLDER button re-sent the
    // NEWER message, writing a permanent transcript row nobody asked to send.
    const fetchMock = fetchDouble(() => ndjson([{ t: 'partial' }])) // no {done:true}
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)

    await type(container.querySelector('textarea'), 'first message')
    await click(container.querySelector('button[type="submit"]'))
    await flush()
    await type(container.querySelector('textarea'), 'second message')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    fetchMock.mockClear()
    const retries = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === 'retry',
    )
    expect(retries).toHaveLength(2)

    await click(retries[0])
    await flush()

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      body: 'first message',
    })

    await unmount()
  })
})
