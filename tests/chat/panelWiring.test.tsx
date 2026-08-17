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
    ops: null,
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

const PROPOSAL = {
  id: 7,
  version: 1,
  at: 1_000_000,
  spec: SPEC,
  mockup_html: '<p>x</p>',
  preview_html: '<p>x</p>',
  first: true,
}

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

  it('renders the card WHERE IT HAPPENED, not below the whole transcript', async () => {
    // onboarding ledger D5. The pure ordering is covered in
    // tests/chat/timeline.test.ts; this proves ChatPanel actually renders from
    // it — the plumbing, which a correct helper does not by itself guarantee.
    const { container, unmount } = await mount(
      <ChatPanel
        initial={[
          { role: 'user', body: 'BEFORE THE CARD', at: 100 },
          { role: 'user', body: 'AFTER THE CARD', at: 300 },
        ]}
        proposal={{ ...PROPOSAL, at: 200, confirmed: false }}
        first={true}
      />,
    )

    const text = container.textContent ?? ''
    expect(text.indexOf('BEFORE THE CARD')).toBeLessThan(text.indexOf('Added a streak panel.'))
    expect(text.indexOf('Added a streak panel.')).toBeLessThan(text.indexOf('AFTER THE CARD'))

    await unmount()
  })

  it('renders a confirmation as an event at the moment it was made', async () => {
    // D5a. The card stays where it was offered; the decision appears where it
    // was taken, and the two can be days apart.
    const { container, unmount } = await mount(
      <ChatPanel
        initial={[{ role: 'user', body: 'LATER MESSAGE', at: 400 }]}
        proposal={{ ...PROPOSAL, at: 100, confirmed: true }}
        confirmations={[{ version: 1, at: 800 }]}
        first={true}
      />,
    )

    const text = container.textContent ?? ''
    expect(container.querySelector('[data-confirmation="1"]')).not.toBeNull()
    expect(text.indexOf('LATER MESSAGE')).toBeLessThan(text.indexOf('Confirmed v1'))

    await unmount()
  })

  it('adds a confirmation event when one is confirmed in this session', async () => {
    vi.stubGlobal('fetch', fetchDouble(() => new Response(null, { status: 200 })))
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )

    expect(container.querySelector('[data-confirmation]')).toBeNull()
    await click(buttonLabelled(container, 'Build this'))
    await flush()
    expect(container.querySelector('[data-confirmation="1"]')).not.toBeNull()

    await unmount()
  })

  it('previews the mockup from the serving route, sealed off', async () => {
    // onboarding ledger D14. One route for the card and the dialog, so what a
    // friend inspects at full size is byte-identical to what they were shown.
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )

    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('/mockup/1')
    expect(frame.getAttribute('sandbox')).toBe('')

    await unmount()
  })

  it('keeps Details COLLAPSED until it is asked for', async () => {
    // "Collapsed by default because the visual carries the pitch, but always
    // present, because the mockup renders synthetic numbers and cannot
    // communicate behaviour." Both halves: present in the DOM, and hidden.
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )

    const details = container.querySelector('[data-slot="collapsible-content"]')
    expect(details).not.toBeNull()
    expect(details!.getAttribute('data-state')).toBe('closed')
    expect(details!.textContent).toContain('Streak')

    await click(buttonLabelled(container, 'Details'))
    expect(
      container.querySelector('[data-slot="collapsible-content"]')!.getAttribute('data-state'),
    ).toBe('open')

    await unmount()
  })

  it('opens the full-screen dialog onto the SAME document', async () => {
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )

    await click(buttonLabelled(container, 'View full screen'))

    // Radix portals dialog content onto document.body — see
    // tests/ui/primitives.test.tsx, where that fact is recorded.
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const frame = dialog!.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('/mockup/1')
    expect(frame.getAttribute('sandbox')).toBe('')

    await unmount()
  })

  it('shows no confirm control on a card that is already confirmed', async () => {
    // The spec's "no card state machine": what renders is a conditional over
    // spec-version data, not a stored per-card field.
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: true }} first={true} />,
    )

    expect(container.textContent).toContain('Building this one.')
    expect(buttonLabelled(container, 'Build this')).toBeUndefined()
    expect(buttonLabelled(container, 'Not quite yet')).toBeUndefined()

    await unmount()
  })

  it('shows a thinking indicator between send and the first token', async () => {
    // The gap this fills is real on a thinking model: several seconds in which
    // a friend has no evidence their message went anywhere. Driven through a
    // real render because the indicator is derived state, not a prop.
    let release: ((r: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { release = resolve })),
    )

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    await type(container.querySelector('textarea'), 'what should I track?')
    await click(container.querySelector('button[type="submit"]'))

    expect(container.querySelector('[data-role="thinking"]')).not.toBeNull()

    release!(ndjson([{ t: 'hi' }, { done: true }]))
    await flush()
    // Gone once the words are there — otherwise it pulses under a reply the
    // friend is already reading.
    expect(container.querySelector('[data-role="thinking"]')).toBeNull()
    expect(container.textContent).toContain('hi')

    await unmount()
  })

  it('anchors the newest item when a reply finishes, not only when it starts', async () => {
    // itemCount alone anchored the turn at its START and let the reply grow
    // past the fold as it streamed — the friend watched the answer they asked
    // for scroll out of view. jsdom reports 0 for every layout measurement, so
    // this stubs a real scrollHeight and asserts the effect ran against it.
    vi.stubGlobal('fetch', fetchDouble(() => ndjson([{ t: 'a long reply' }, { done: true }])))

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    const list = container.querySelector('ol')!
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })
    list.scrollTop = 0

    await type(container.querySelector('textarea'), 'hello')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    expect(list.scrollTop).toBe(900)

    await unmount()
  })

  it('advances the wait from writing to drawing as the stages arrive', async () => {
    // Held open on purpose. A stream that finishes resolves the wait, so the
    // only way to see the two stages is to observe them WHILE they are on
    // screen — which is the only state a friend ever sees them in.
    let push: (chunk: string) => void = () => {}
    let close: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        close = () => controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    await type(container.querySelector('textarea'), 'yes, that sounds right')
    await click(container.querySelector('button[type="submit"]'))

    push('{"authoring":true}\n')
    await flush()
    expect(container.textContent).toContain('Writing the spec')
    expect(container.textContent).not.toContain('Drawing the preview')

    // The real transition: the spec validated and the slow call started.
    push('{"stage":"mockup"}\n')
    await flush()
    expect(container.textContent).toContain('Drawing the preview')
    expect(container.textContent).not.toContain('Writing the spec')

    push('{"done":true}\n')
    close()
    await flush()
    // And it clears — a wait that outlived its turn would be worse than none.
    expect(container.textContent).not.toContain('Drawing the preview')

    await unmount()
  })

  it('anchors the reply when the authoring wait begins, not a minute later', async () => {
    // On a proposing turn `busy` stays true for the whole authoring minute, so
    // the "anchor when the message has arrived" pass never runs while the
    // friend is waiting. The first anchor fired while the assistant turn was
    // still empty, which parks the list on the friend's own message with the
    // reply below the fold — and that reply is the only thing to read for the
    // next minute.
    //
    // Held open, like the stage test above: the wait is a live state, and this
    // asserts what the scroll position is DURING it.
    let push: (chunk: string) => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    const list = container.querySelector('ol')!
    // jsdom reports 0 for every layout measurement, so the height is stubbed —
    // and it GROWS, which is the thing that puts the reply out of view.
    Object.defineProperty(list, 'scrollHeight', { value: 100, configurable: true })

    await type(container.querySelector('textarea'), 'yes, build it')
    await click(container.querySelector('button[type="submit"]'))
    await flush()
    expect(list.scrollTop).toBe(100) // anchored on the empty assistant turn

    push('{"t":"Here is what I am going to build."}\n')
    await flush()
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })
    // Deliberately no anchor per chunk — the reply is now below the fold.
    expect(list.scrollTop).toBe(100)

    push('{"authoring":true}\n')
    await flush()
    expect(list.scrollTop).toBe(900)

    // And the stage advancing does NOT re-anchor: a friend who scrolled up to
    // re-read during the slow half must not be yanked back down.
    list.scrollTop = 0
    push('{"stage":"mockup"}\n')
    await flush()
    expect(container.textContent).toContain('Drawing the preview')
    expect(list.scrollTop).toBe(0)

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
