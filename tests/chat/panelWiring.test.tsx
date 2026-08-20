// tests/chat/panelWiring.test.tsx
// @vitest-environment jsdom
//
// Step-4 ledger residual 1: "Nine call-site mutations survive the full suite
// [when nothing drives ChatPanel through a real render]." tests/chat/panel.test.ts
// drives the pure reducers directly and is excellent at it. What it cannot
// reach is the WIRING: whether send() writes the body the route expects,
// whether a real render anchors the scroll, whether the thinking indicator
// actually appears and disappears. That is this file's entire job.
//
// This file used to also cover the proposal card's wiring — proposals={[]}
// disconnecting the card region, the confirm button posting to
// /api/spec/confirm, the scoped preview iframe. All of that tested behaviour
// that no longer exists: ChatPanel has no card, no confirm button, and no
// authoring wait any more (the agent says in words that it has what it
// needs, and the build lands without anyone confirming anything).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
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

describe('ChatPanel wiring', () => {
  it('POSTs the typed message to /api/chat and streams the reply into the transcript', async () => {
    const fetchMock = fetchDouble(() => ndjson([{ t: 'hello ' }, { t: 'there' }, { done: true }]))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(<ChatPanel initial={[]} />)
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

  it('shows a thinking indicator between send and the first token', async () => {
    // The gap this fills is real on a thinking model: several seconds in which
    // a friend has no evidence their message went anywhere. Driven through a
    // real render because the indicator is derived state, not a prop.
    let release: ((r: Response) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { release = resolve })),
    )

    const { container, unmount } = await mount(<ChatPanel initial={[]} />)
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

    const { container, unmount } = await mount(<ChatPanel initial={[]} />)
    const list = container.querySelector('ol')!
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })
    list.scrollTop = 0

    await type(container.querySelector('textarea'), 'hello')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    expect(list.scrollTop).toBe(900)

    await unmount()
  })

  it('follows the reply as it streams, before the turn is anywhere near done', async () => {
    // THE PROPOSE-TURN BUG. `{done:true}` only arrives after authoring, which
    // is 47-97 seconds of model calls (lib/chat/turn.ts, authoringSignal) — so
    // a panel that re-anchored only when `busy` flipped false left the agent's
    // "here's what I'm having built" message below the fold for the whole of
    // it. The friend confirmed, and the screen appeared not to answer.
    //
    // A hand-driven ReadableStream rather than a complete body: the point is
    // that the scroll moves while the stream is still OPEN. A body containing
    // {done:true} would flip `busy` in the same flush and pass even against
    // the old effect.
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const { container, unmount } = await mount(<ChatPanel initial={[]} />)
    const list = container.querySelector('ol')!
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })

    await type(container.querySelector('textarea'), "that's everything")
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    list.scrollTop = 0
    controller.enqueue(
      new TextEncoder().encode(`${JSON.stringify({ t: 'Getting that built now.' })}\n`),
    )
    await flush()

    // Still mid-turn: the stream is open and Send is disabled.
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(list.scrollTop).toBe(900)

    controller.close()
    await flush()
    await unmount()
  })

  it('leaves the scrollbar alone once the friend has scrolled up', async () => {
    // The objection that kept per-chunk anchoring out: following token by token
    // would drag someone back down the moment they scrolled up to re-read
    // something mid-reply. jsdom reports 0 for clientHeight, so scrolling to 0
    // against a 900px scrollHeight is unambiguously "scrolled up" — and the
    // scroll event is what the panel listens to, exactly as a browser fires it.
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    const { container, unmount } = await mount(<ChatPanel initial={[]} />)
    const list = container.querySelector('ol')!
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })

    await type(container.querySelector('textarea'), 'tell me a long story')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    list.scrollTop = 0
    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ t: 'once upon a time' })}\n`))
    await flush()

    expect(list.scrollTop).toBe(0)

    controller.close()
    await flush()
    await unmount()
  })

  it('the retry button re-sends ITS OWN message, not the newest one', async () => {
    // Two interrupted turns on screen. Step 4 moved `source` onto the Turn for
    // exactly this: with one component-level ref, the OLDER button re-sent the
    // NEWER message, writing a permanent transcript row nobody asked to send.
    const fetchMock = fetchDouble(() => ndjson([{ t: 'partial' }])) // no {done:true}
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(<ChatPanel initial={[]} />)

    await type(container.querySelector('textarea'), 'first message')
    await click(container.querySelector('button[type="submit"]'))
    await flush()
    await type(container.querySelector('textarea'), 'second message')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    fetchMock.mockClear()
    const retries = Array.from(container.querySelectorAll('button')).filter(
      // 'Retry' capitalised, matching every other button in the app ('Send').
      // It stopped being lowercase inline text when it stopped LOOKING like
      // inline text.
      (b) => b.textContent === 'Retry',
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
