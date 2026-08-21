// tests/ui/writeAction.test.tsx
// @vitest-environment jsdom
//
// The write control every dashboard uses. Pinned here, each one a sentence
// from the design doc or a ruling from the task-3 fix round:
//
//  - it renders a REAL form (design §3.1) — the no-JS path must still work,
//    so this is not decoration
//  - nothing on screen moves before the server answers (§2)
//  - controls sharing a route go pending together; a different route does not
//    (§3.3)
//  - a failed write leaves the screen unmoved and says so (§2)
//  - a fetch-initiated write carries the header that keeps the route from
//    answering with a 303 fetch would follow (fix round 1, CRITICAL 1 —
//    lib/http/redirect.ts's writeAnswer is the other half, pinned in
//    tests/http/redirect.test.ts and tests/routing/{pee,walk}Route.test.ts)
//  - a locked or expired session (401/403) refreshes instead of erroring
//    (fix round 1, IMPORTANT 2)
//  - the shared flag survives until refresh is called, not until the fetch
//    settles (fix round 1, IMPORTANT 4 — the property the useEffect at
//    useWriteAction.ts exists to protect)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { click, flush, mount } from '@/tests/support/dom'
import { __resetWriteActionStore, isWriteInFlight } from '@/lib/ui/writeActionStore'
import { assertHostRelativeAction, WRITE_FAILED } from '@/lib/ui/useWriteAction'
import { WriteAction } from '@/lib/ui/WriteAction'

const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}))

beforeEach(() => {
  vi.stubGlobal('React', React)
  // mockReset, not mockClear: a couple of tests below give refreshMock its
  // own mockImplementation, and a clear alone would leave that implementation
  // in place for the next test to trip over.
  refreshMock.mockReset()
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
 *
 * The mock's parameters are typed (`_input`, `_init`) rather than left `()`,
 * so `fetchMock.mock.calls[0]` types as `[string, RequestInit]` on its own —
 * no `as unknown as` cast needed to read it back, and the compiler still
 * checks that WriteAction calls fetch with a URL string and not something
 * else.
 */
function deferredFetch() {
  let release: (value: { ok: boolean; status?: number }) => void = () => {}
  const promise = new Promise<{ ok: boolean; status?: number }>((resolve) => {
    release = resolve
  })
  const fetchMock = vi.fn((_input: string, _init: RequestInit) => promise)
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

  it('POSTs the payload with the fetch header and refreshes in place, never navigating', async () => {
    const { fetchMock, release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/users/run9/pee')
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('action')).toBe('add')
    // The discriminator lib/http/redirect.ts's writeAnswer branches on: only
    // a fetch can set this, which is what lets the route tell a fetch-
    // initiated write from a native form post and answer 204 instead of a
    // 303 the browser would follow.
    expect((init.headers as Record<string, string>)['X-Stairwell-Write']).toBe('1')

    // Nothing moved yet — the whole point of the confirmed-not-optimistic
    // model (design §2).
    expect(refreshMock).not.toHaveBeenCalled()

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
    release({ ok: false, status: 500 })
    await flush()

    expect(container.querySelector('[role="alert"]')!.textContent).toBe(WRITE_FAILED)
    expect(refreshMock).not.toHaveBeenCalled()
    // Nothing moved: the control is pressable again, and no navigation happened.
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(false)

    await unmount()
  })

  it('refreshes instead of erroring on a 401 — a session with no key, not a failed write', async () => {
    // WRITE_FAILED would tell a friend to "try again" forever: the control
    // can never succeed again until they unlock, and an inline error has no
    // path to /unlock. router.refresh() re-runs the server component, whose
    // own session guard is what actually sends them there.
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))
    release({ ok: false, status: 401 })
    await flush()

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await unmount()
  })

  it('refreshes instead of erroring on a 403 too — the same locked-session case', async () => {
    // resolveState answers a locked or expired session with 403, not 401
    // (app/api/users/[user]/pee/route.ts's check 1) — both must be caught.
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))
    release({ ok: false, status: 403 })
    await flush()

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()

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

  it('shows the pending label and marks aria-busy while a write is in flight', async () => {
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }} pendingLabel="Saving…">
        Log one
      </WriteAction>,
    )

    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('Log one')
    expect(button.getAttribute('aria-busy')).toBe('false')

    await click(button)

    expect(button.textContent).toBe('Saving…')
    expect(button.getAttribute('aria-busy')).toBe('true')

    release({ ok: true })
    await flush()
    await unmount()
  })

  it('does not strand the shared flag when the control unmounts mid-flight', async () => {
    // A LIVE PATH, not a hypothetical. users/devtwo/dashboard.tsx renders
    // `{done ? <p>Marked for today.</p> : <WriteAction .../>}`, so on its
    // only happy path the successful write sets `done` and the refreshed
    // tree unmounts the very control that owns the in-flight flag — devtwo's
    // first tap of every day is this test. Without the unmount-cleanup
    // effect in useWriteAction.ts, every sibling control on that route stays
    // disabled forever — no error, no recovery short of a reload.
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(true)

    await unmount()

    expect(isWriteInFlight('/api/users/run9/pee')).toBe(false)

    // Let the now-orphaned promise settle so it does not leak into the next
    // test; nothing is listening for the result any more.
    release({ ok: true })
    await flush()
  })

  it('keeps the shared flag set until refresh is actually called — not until the fetch settles', async () => {
    // The exact property the comment at useWriteAction.ts's isPending effect
    // names: clearing the flag from the fetch's own `finally` would un-pend
    // the SIBLING controls a beat before the refreshed tree has anything new
    // to show. Recorded from inside router.refresh() itself — the one call
    // that must always see the flag still set — and asserted OUTSIDE that
    // mock implementation on purpose: fire()'s own try/catch would swallow an
    // expect() thrown from inside the mock (it becomes an ordinary caught
    // exception, converted straight into a WRITE_FAILED setError, and the
    // test would read green either way), so the value is captured into a
    // plain variable here and checked by the test's own top-level code.
    const { release } = deferredFetch()
    let flagDuringRefresh: boolean | undefined
    refreshMock.mockImplementation(() => {
      flagDuringRefresh = isWriteInFlight('/api/users/run9/pee')
    })
    const { container, unmount } = await mount(
      <WriteAction action="/api/users/run9/pee" payload={{ action: 'add' }}>
        Log one
      </WriteAction>,
    )

    await click(container.querySelector('button'))
    release({ ok: true })
    await flush()

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(flagDuringRefresh).toBe(true)

    await unmount()
  })
  describe('the host-relative action guard', () => {
    // WriteAction is the one sanctioned place a users/<slug>/dashboard.tsx can
    // cause a network request, against a standing repo rule that a dashboard
    // never knows a network exists. The guard bounds the URL it may name to
    // this origin, exactly as relativeRedirect (lib/http/redirect.ts) bounds a
    // Location — same two rejected shapes, same wording, and the same "defence
    // in depth for future callers, not a live hole" standing.
    it('rejects a protocol-relative or absolute action, and accepts a host-relative one', () => {
      // '//evil.test/...' is the one that matters: it is not a path at all, it
      // is another ORIGIN, and fetch would send the friend's payload there.
      expect(() => assertHostRelativeAction('//evil.test/api')).toThrow(/host-relative/)
      expect(() => assertHostRelativeAction('https://evil.test/api')).toThrow(/host-relative/)
      expect(() => assertHostRelativeAction('api/users/run9/pee')).toThrow(/host-relative/)
      expect(() => assertHostRelativeAction('')).toThrow(/host-relative/)
      expect(() => assertHostRelativeAction('/api/users/run9/pee')).not.toThrow()
    })

    it('throws from the render, so a bad action never reaches fetch or the no-JS form', async () => {
      // Wired, not merely defined. The hook calls the guard before any React
      // hook, so WriteAction throws while rendering — the <form action=...>
      // the no-JS path submits is never produced either. React logs the throw
      // on its way out; silenced so a deliberately-red render is not mistaken
      // for a broken suite.
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(
          mount(
            <WriteAction action="//evil.test/api" payload={{ action: 'add' }}>
              Log one
            </WriteAction>,
          ),
        ).rejects.toThrow(/host-relative/)
      } finally {
        consoleError.mockRestore()
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

describe('failedLabel — for the one route where "nothing was recorded" is false', () => {
  it('uses WRITE_FAILED by default, for every ordinary write', async () => {
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/x" payload={{}}>
        Tap
      </WriteAction>,
    )
    await click(container.querySelector('button'))
    release({ ok: false, status: 500 })
    await flush()

    expect(container.textContent).toContain(WRITE_FAILED)
    await unmount()
  })

  it('lets a caller replace it where the failure IS the thing recorded', async () => {
    // A failed Plaid refresh writes a plaid_refreshes row per product, which
    // the panel then displays. "Nothing was recorded" sat directly above five
    // recorded outcomes — one request, two contradictory statements.
    const { release } = deferredFetch()
    const { container, unmount } = await mount(
      <WriteAction action="/api/x" payload={{}} failedLabel="Recorded above.">
        Refresh
      </WriteAction>,
    )
    await click(container.querySelector('button'))
    release({ ok: false, status: 502 })
    await flush()

    expect(container.textContent).toContain('Recorded above.')
    expect(container.textContent).not.toContain(WRITE_FAILED)
    await unmount()
  })
})
