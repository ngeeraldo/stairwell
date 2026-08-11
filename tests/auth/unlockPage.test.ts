// tests/auth/unlockPage.test.ts
//
// app/(auth)/unlock/page.tsx had no page-level test before this file. It exists
// for step1a residual #7: an authenticated-but-locked session could not reach
// /login, because routeFor bounces an 'authenticated' state back to /unlock from
// every path except /unlock and /admin. A user who could not remember their
// password had no way out short of clearing the cookie by hand.
//
// The escape is a POST form to /api/logout, which IS reachable while locked:
// middleware.ts only bounces requests with no session cookie at all, and
// app/api/logout/route.ts deliberately does not call requireState.
//
// These assertions walk the returned element tree for real `form` nodes rather
// than substring-matching the serialised output. That distinction is
// load-bearing: /api/logout is POST-only, so a GET `<a href="/api/logout">`
// would 405 and leave the dead end in place while satisfying any assertion that
// merely looked for the string '/api/logout' somewhere in the render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'

// Same reason as tests/routing/userSpace.test.ts: tsconfig sets
// "jsx": "preserve" for Next's SWC compiler, so vitest's esbuild transform
// falls back to the classic transform and emits bare `React.createElement`
// calls with no import. Stubbed rather than assigned so it does not leak.
beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

type ElementLike = { type?: unknown; props?: Record<string, unknown> }

/** Every `form` element's props, depth-first, anywhere in the tree. */
function collectForms(
  node: unknown,
  out: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectForms(child, out)
    return out
  }
  const el = node as ElementLike
  if (el.type === 'form' && el.props) out.push(el.props)
  if (el.props && 'children' in el.props) collectForms(el.props.children, out)
  return out
}

async function renderUnlock(searchParams: { error?: string } = {}) {
  const { default: UnlockPage } = await import('@/app/(auth)/unlock/page')
  return UnlockPage({ searchParams: Promise.resolve(searchParams) })
}

describe('app/(auth)/unlock/page.tsx', () => {
  it('offers a sign-out escape from the locked dead end, as a POST form', async () => {
    const forms = collectForms(await renderUnlock())

    // Non-vacuity: a collectForms that silently matched nothing (e.g. after a
    // refactor to a different element shape) would make every .find() below
    // return undefined, and a bare toBeUndefined-free assertion set could pass
    // on an empty list. Pin the count first.
    expect(forms).toHaveLength(2)

    const logout = forms.find((f) => f.action === '/api/logout')
    expect(
      logout,
      'the locked user needs a way back to /login without clearing cookies',
    ).toBeDefined()
    // POST specifically: /api/logout exports only POST, so a GET link would
    // 405 and the dead end would remain.
    expect(String(logout!.method).toLowerCase()).toBe('post')
  })

  it('still offers the unlock form itself — the escape must not displace the primary path', async () => {
    const forms = collectForms(await renderUnlock())

    const unlock = forms.find((f) => f.action === '/api/unlock')
    expect(unlock).toBeDefined()
    expect(String(unlock!.method).toLowerCase()).toBe('post')
  })

  it('shows the retry message only when the error param is present', async () => {
    const withError = JSON.stringify(await renderUnlock({ error: '1' }))
    const without = JSON.stringify(await renderUnlock())

    expect(withError).toContain('That did not match')
    expect(without).not.toContain('That did not match')
  })
})
