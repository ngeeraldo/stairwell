// tests/ui/writeAction.test.tsx
// @vitest-environment jsdom
//
// The write control every dashboard uses. Four things are pinned here, and
// each one is a sentence from the design doc:
//
//  - it renders a REAL form (design §3.1) — the no-JS path must still work,
//    so this is not decoration
//  - nothing on screen moves before the server answers (§2)
//  - controls sharing a route go pending together; a different route does not
//    (§3.3)
//  - a failed write leaves the screen unmoved and says so (§2)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { click, flush, mount } from '@/tests/support/dom'
import { __resetWriteActionStore } from '@/lib/ui/writeActionStore'
import { WRITE_FAILED } from '@/lib/ui/useWriteAction'
import { WriteAction } from '@/lib/ui/WriteAction'

const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}))

beforeEach(() => {
  vi.stubGlobal('React', React)
  refreshMock.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetWriteActionStore()
})

/**
 * A fetch whose resolution the test controls, so "in flight" is observable.
 *
 * `release` only settles the promise — it does NOT flush React. Every caller
 * must `await flush()` afterwards, or the assertion reads pre-update DOM and
 * passes for the wrong reason (tests/support/dom.tsx says the same thing about
 * forgetting an await).
 */
function deferredFetch() {
  let release: (value: { ok: boolean }) => void = () => {}
  const promise = new Promise<{ ok: boolean }>((resolve) => {
    release = resolve
  })
  const fetchMock = vi.fn(() => promise)
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, release }
}

describe('WriteAction', () => {
  it('renders a real form POST, so the control still works with JS off', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    const form = container.querySelector('form')!
    expect(form.getAttribute('method')).toBe('post')
    expect(form.getAttribute('action')).toBe('/api/users/run9/pee')
    const hidden = container.querySelector('input[type="hidden"]') as HTMLInputElement
    expect(hidden.name).toBe('action')
    expect(hidden.value).toBe('add')

    await unmount()
  })

  it('POSTs the payload and refreshes in place, never navigating', async () => {
    const { fetchMock, release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/users/run9/pee')
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('action')).toBe('add')

    release({ ok: true })
    await flush()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await unmount()
  })

  it('disables a sibling control sharing the same route while a write is in flight', async () => {
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <>
        <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
          Log one
        </WriteAction>
        <WriteAction action="/api/users/run9/pee" payload={{ action: 'remove' }}>
          Minus one
        </WriteAction>
      </>,
    )

    const [log, minus] = Array.from(container.querySelectorAll('button'))
    await click(log)

    expect((minus as HTMLButtonElement).disabled).toBe(true)

    release({ ok: true })
    await flush()
    await unmount()
  })

  it('leaves a control on a DIFFERENT route enabled — the group is the URL, not the page', async () => {
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <>
        <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
          Log one
        </WriteAction>
        <WriteAction action="/api/users/run9/weight" payload={{ action: 'add' }}>
          Log weight
        </WriteAction>
      </>,
    )

    const [pee, weight] = Array.from(container.querySelectorAll('button'))
    await click(pee)

    expect((weight as HTMLButtonElement).disabled).toBe(false)

    release({ ok: true })
    await flush()
    await unmount()
  })

  it('says so and refreshes nothing when the write fails', async () => {
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))
    release({ ok: false })
    await flush()

    expect(container.querySelector('[role="alert"]')!.textContent).toBe(WRITE_FAILED)
    expect(refreshMock).not.toHaveBeenCalled()
    // Nothing moved: the control is pressable again, and no navigation happened.
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(false)

    await unmount()
  })

  it('honours an explicit disabled prop — the affordance, not the rule', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'remove' }} disabled>
        Minus one
      </WriteAction>,
    )

    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true)

    await unmount()
  })
})
