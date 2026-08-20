# Client-Side Write Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every dashboard write control's full-page form POST with an in-place client-side update, and correct the documentation that produced the form POST in the first place.

**Architecture:** A shared client component in `lib/ui/` owns pending state, the `fetch` POST and `router.refresh()`. The write route keeps its four ordered auth checks and stays the only writable handle; dashboards stay server components with read-only handles. Nothing on screen moves until the refreshed server tree commits, so no optimistic state and no rollback path exist. Grouping of pending controls is keyed on the action URL, held in a module-level store, so no dashboard has to wrap anything in a provider.

**Tech Stack:** Next 15 App Router, React 19 (`useTransition`, `useSyncExternalStore`), vitest with per-file jsdom opt-in, `tests/support/dom.tsx` (no @testing-library).

**Spec:** `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md`

## Global Constraints

Copied from `CLAUDE.md` and the design doc. Every task's requirements implicitly include these.

- **Branch is `fix-dashboard-reload`.** Never commit to `main`. Check `git branch --show-current` before writing code.
- **No dashboard ever holds a writable handle.** Writes go to a platform route, which is the only place the four ordered auth checks live. This plan does not change any route's auth logic.
- **Metrics never carry user values.** The `trigger` value is a render cause (`'nav'` / `'refresh'`), never a panel id, screen id, day, count or merchant.
- **`metrics` is append-only and sacred.** No migration, no rewrite, no DELETE. The new field is a JSON key on new rows only.
- **Never open, read, or query any `*.db` other than `synthetic.db`.** The droplet's platform database is off-limits from the laptop; Task 1's production query is Nico's to run.
- **A dashboard never derives a day from a clock.** Unchanged here, but `tests/users/noLocalDay.test.ts` sweeps `users/*/dashboard.tsx` — do not introduce `Date.now()` or `new Date()` there.
- **Prompt files and `notes/v<n>.md` are added, never edited.** This plan writes neither.
- **No spec version, no `notes/v2.md`, no announcement, `current.md` untouched.** run9's surface does not change.
- **`components/ui/*` is vendored shadcn and is never hand-edited.** Anything we write goes in `lib/ui/`.
- **Test gates:** changes under `app/`/`lib/` need a test under `tests/`; changes under `users/<slug>/` need one in that folder. `npx tsc --noEmit` is Gate C. Gate E (`npx vitest run`) and Gate D (`npx next build`) run on push.
- **Error copy is one constant.** `WRITE_FAILED` is defined once in `lib/ui/useWriteAction.ts` and imported by tests — two copies of a promise are two things that can drift.

---

## File Structure

**Create:**
- `lib/ui/writeActionStore.ts` — which action URLs have a write in flight. Module-level, framework-free, no React import.
- `lib/ui/useWriteAction.ts` — the hook: POST, refresh, pending lifetime, error. The escape hatch for anything a labelled button cannot express.
- `lib/ui/WriteAction.tsx` — the component dashboards import. Renders a real `<form>`, intercepts submit.
- `lib/metrics/renderTrigger.ts` — reads the `rsc` request header, returns `'nav' | 'refresh'`.
- `platform/templates/route/route.ts.tmpl` — the write-route worked example, moved out of a friend-specific route.
- `tests/ui/writeActionStore.test.ts` — node environment.
- `tests/ui/writeAction.test.tsx` — jsdom.
- `tests/metrics/renderTrigger.test.ts` — node environment.

**Modify:**
- `app/[user]/page.tsx` — `renderDashboard` adds `trigger` to the `dashboard_open` payload.
- `tests/routing/dashboardRegion.test.ts` — two exact-shape assertions gain `trigger`, plus one new case.
- `users/run9/dashboard.tsx:126-176` — three `<form>` blocks become `<WriteAction>`.
- `users/devtwo/dashboard.tsx:35-40` — one `<form>` block becomes `<WriteAction>`.
- `users/run9/tests/dashboard.test.ts`, `users/devtwo/tests/dashboard.test.ts` — assertions that look for `<form>` markup.
- `platform/templates/dashboard/dashboard.tsx.tmpl` — commented `WriteAction` example.
- `CLAUDE.md`, `docs/dashboard-build-rules.md`, `docs/runbook-ai.md`, `docs/dashboard-ui-ux-guidelines.md`.
- `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md` — record the measured p95.

---

## Task 1: Verify the refresh signal and measure the baseline

The probe comes first because a p95 miss changes what gets built (design §8). Nothing else in this plan should start until the number exists.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md` (the `Measured p95` line)

**Interfaces:**
- Produces: a confirmed answer to "does `router.refresh()` send a header `app/[user]/page.tsx` can read", which Task 4 depends on, and a p95 number that decides whether the design ships as written.

- [ ] **Step 1: Confirm the header constant exists in the installed Next**

Run:
```bash
grep -n "RSC_HEADER = " node_modules/next/dist/client/components/app-router-headers.js
```
Expected: `83:const RSC_HEADER = 'rsc';`

If this line is absent or the constant differs, STOP and report — §7.3 of the design doc names this as the one unverified mechanism, and the fallback (read-time correlation with `dashboard_write` timestamps) is a different design.

- [ ] **Step 2: Confirm the header actually arrives on a refresh, in a real browser**

The constant existing is not proof the refresh path sends it. Verify live:

```bash
npm run dev
```

Add a temporary line at the top of `renderDashboard` in `app/[user]/page.tsx`:

```ts
console.log('[probe] rsc header =', (await (await import('next/headers')).headers()).get('rsc'))
```

Log in as a dev account (see `docs/local-dev.md`), open `/devtwo`, and press the walk button. Two lines appear in the dev server output: the first from the initial page load, the second from the redirect. Both should print `null` — this is today's behaviour, a document load, and it is the `'nav'` case.

Then, in the browser devtools console on `/devtwo`, force a refresh the way `WriteAction` will:

```js
// Next exposes no router handle on window; instead confirm via a raw RSC fetch,
// which is the same request shape router.refresh() issues.
await fetch(location.pathname, { headers: { RSC: '1' } })
```

Expected: a third line printing `[probe] rsc header = 1`.

**Remove the temporary `console.log` before continuing.** Record the result in the design doc §7.3, replacing "Unverified" with what you observed.

- [ ] **Step 3: Measure p95 on the droplet — NICO RUNS THIS**

This step needs the droplet and a real session cookie. The AI builder never reaches the droplet (`docs/runbook-ai.md` §1). Hand these commands to Nico:

```bash
# On the droplet, with SESSION set to an unlocked session cookie value for run9.
for i in $(seq 1 40); do
  curl -s -o /dev/null -H "Cookie: stairwell_session=$SESSION" \
    -H "RSC: 1" -w '%{time_total}\n' http://localhost:3000/run9
done | sort -n | awk '{a[NR]=$1} END {printf "n=%d  p50=%.3fs  p95=%.3fs  max=%.3fs\n", NR, a[int(NR*0.50)], a[int(NR*0.95)], a[NR]}'
```

The `RSC: 1` header makes this the exact request `router.refresh()` will issue, so the number is the real refresh cost rather than a proxy for it.

- [ ] **Step 4: Apply the threshold**

**p95 < 300ms → proceed to Task 2.**

**p95 >= 300ms → STOP and report.** Do not start building. The design fixes two levers in advance, in order, neither built unless this fails:
1. Take the chat transcript read off the log-press refresh path.
2. Hold the unlocked database handle for the session instead of reopening per request.

Either is a change to this plan, not a step inside it.

- [ ] **Step 5: Record the number and commit**

Replace the placeholder line in the design doc:

```
Measured p95: *(pending — probe not yet run)*
```

with the actual figure, the date, and the sample size — for example:

```
Measured p95: 0.118s (n=40, droplet, 2026-08-20). Threshold 0.300s: cleared.
```

```bash
git add docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md
git commit -m "docs: record measured refresh p95 and confirm the RSC refresh signal"
```

---

## Task 2: The in-flight store

**Files:**
- Create: `lib/ui/writeActionStore.ts`
- Test: `tests/ui/writeActionStore.test.ts`

**Interfaces:**
- Produces: `beginWrite(action: string): void`, `endWrite(action: string): void`, `isWriteInFlight(action: string): boolean`, `subscribeToWrites(listener: () => void): () => void`, `__resetWriteActionStore(): void`. Task 3 consumes all five.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/writeActionStore.test.ts`:

```ts
// tests/ui/writeActionStore.test.ts
//
// The grouping rule, tested directly rather than through a component: two
// controls sharing a route must not both be pressable, and two controls on
// DIFFERENT routes must not affect each other (design §3.3).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWriteActionStore,
  beginWrite,
  endWrite,
  isWriteInFlight,
  subscribeToWrites,
} from '@/lib/ui/writeActionStore'

afterEach(() => {
  __resetWriteActionStore()
})

describe('writeActionStore', () => {
  it('reports nothing in flight before any write starts', () => {
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(false)
  })

  it('marks one action in flight and clears it again', () => {
    beginWrite('/api/users/run9/pee')
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(true)
    endWrite('/api/users/run9/pee')
    expect(isWriteInFlight('/api/users/run9/pee')).toBe(false)
  })

  it('KEYS ON THE ACTION URL: a different route is untouched', () => {
    // The whole point of the ruling. A friend with a habit panel and a weight
    // panel must not have weight lock while a habit tap is in flight.
    beginWrite('/api/users/run9/pee')
    expect(isWriteInFlight('/api/users/run9/weight')).toBe(false)
  })

  it('notifies subscribers on begin and on end', () => {
    const listener = vi.fn()
    subscribeToWrites(listener)
    beginWrite('/api/users/run9/pee')
    expect(listener).toHaveBeenCalledTimes(1)
    endWrite('/api/users/run9/pee')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToWrites(listener)
    unsubscribe()
    beginWrite('/api/users/run9/pee')
    expect(listener).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/writeActionStore.test.ts`
Expected: FAIL — cannot resolve `@/lib/ui/writeActionStore`.

- [ ] **Step 3: Write the implementation**

Create `lib/ui/writeActionStore.ts`:

```ts
// lib/ui/writeActionStore.ts
//
// Which write routes currently have a request in flight.
//
// KEYED ON THE ACTION URL, NEVER ON THE PAGE (Nico's ruling, 2026-08-20;
// design doc §3.3). Two controls posting to the same route must not both be
// pressable — run9's "Log one", "+1" and "−1" all write pee_logs, and a
// second press mid-flight queues a conflicting write. Two controls posting to
// DIFFERENT routes are unrelated, and freezing one for the other would be a
// page-wide lock wearing a correctness argument.
//
// A MODULE-LEVEL STORE RATHER THAN REACT CONTEXT, deliberately. A dashboard is
// a server component; a context provider would be one more client boundary a
// builder has to remember to wrap things in, and forgetting it would silently
// degrade to no grouping at all. The grouping is a property of the URL, not of
// the tree, so it does not need the tree.
//
// No React import here on purpose — this file is plain state, and its test
// runs in the node environment without a DOM.

const inFlight = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

export function beginWrite(action: string): void {
  inFlight.add(action)
  notify()
}

export function endWrite(action: string): void {
  inFlight.delete(action)
  notify()
}

export function isWriteInFlight(action: string): boolean {
  return inFlight.has(action)
}

export function subscribeToWrites(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * TEST ONLY — no production caller.
 *
 * Module state outlives a test file's cases, so one test leaving an action in
 * flight would make the next one pass or fail for reasons it never stated.
 */
export function __resetWriteActionStore(): void {
  inFlight.clear()
  listeners.clear()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ui/writeActionStore.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/ui/writeActionStore.ts tests/ui/writeActionStore.test.ts
git commit -m "feat(ui): add the in-flight write store, keyed on action URL"
```

---

## Task 3: The hook and the component

**Files:**
- Create: `lib/ui/useWriteAction.ts`
- Create: `lib/ui/WriteAction.tsx`
- Test: `tests/ui/writeAction.test.tsx`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces:
  - `WRITE_FAILED: string` (from `lib/ui/useWriteAction.ts`)
  - `useWriteAction(action: string): { fire: (payload: Record<string, string>) => void; pending: boolean; error: string | null }`
  - `WriteAction` component, props: `{ action: string; payload: Record<string, string>; children: ReactNode; pendingLabel?: ReactNode; disabled?: boolean; className?: string; size?: ComponentProps<typeof Button>['size']; variant?: ComponentProps<typeof Button>['variant']; 'aria-label'?: string }`. Tasks 5, 6 and 7 consume `WriteAction`.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/writeAction.test.tsx`:

```tsx
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
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/writeAction.test.tsx`
Expected: FAIL — cannot resolve `@/lib/ui/WriteAction`.

**If, once the implementation exists, the click does not trigger `onSubmit`:** jsdom performs implicit form submission from a submit-button click, but if this harness does not, replace the `await click(container.querySelector('button'))` lines with a direct submit dispatch and note it in the file header:

```tsx
import { act } from 'react'
await act(async () => {
  container.querySelector('form')!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
})
```

- [ ] **Step 3: Write the hook**

Create `lib/ui/useWriteAction.ts`:

```ts
'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  beginWrite,
  endWrite,
  isWriteInFlight,
  subscribeToWrites,
} from './writeActionStore'

/**
 * The one copy of the failure sentence. Imported by the tests rather than
 * retyped there: two copies of a promise are two things that can drift apart.
 */
export const WRITE_FAILED = "Couldn't save that — nothing was recorded. Try again."

/**
 * The mechanics behind WriteAction: POST, refresh, pending, error.
 *
 * Exported as an escape hatch for anything a labelled button cannot express —
 * a form with fields, say. No such case exists today; WriteAction is the
 * expected entry point, and this exists so that the first dashboard needing
 * more does not reimplement the lifetime rule below.
 *
 * THE UPDATE MODEL (design §2, Nico's ruling 2026-08-20):
 *
 *   press → the controls sharing that route go pending → the server answers →
 *   every affected value patches in together, in place, no navigation.
 *
 * Nothing on screen moves before the server has answered. There is no
 * optimistic update and therefore no rollback path, because nothing was ever
 * shown that the database did not hold.
 */
export function useWriteAction(action: string): {
  fire: (payload: Record<string, string>) => void
  pending: boolean
  error: string | null
} {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Whether THIS hook instance is the one that started the in-flight write.
  // Only the initiator may clear the shared flag.
  const owns = useRef(false)

  const groupBusy = useSyncExternalStore(
    subscribeToWrites,
    () => isWriteInFlight(action),
    // Server snapshot: nothing is ever in flight during SSR. Without this,
    // useSyncExternalStore throws on the server render.
    () => false,
  )

  // THE PENDING STATE ENDS WHEN THE REFRESHED TREE COMMITS, NOT WHEN THE POST
  // RETURNS (design §2). `isPending` spans the whole transition — the fetch,
  // router.refresh(), and the commit of the new server render. Clearing the
  // shared flag from the fetch's own `finally` would un-pend the SIBLING
  // controls a beat early, while the numbers on screen were still stale, which
  // is the choppiness this whole change exists to remove, in a smaller form.
  useEffect(() => {
    if (!isPending && owns.current) {
      owns.current = false
      endWrite(action)
    }
  }, [isPending, action])

  const fire = useCallback(
    (payload: Record<string, string>) => {
      // Guard rather than assume: the button is disabled while busy, but a
      // keyboard submit or a second dispatch must not queue a second write.
      if (isWriteInFlight(action)) return
      setError(null)
      owns.current = true
      beginWrite(action)
      startTransition(async () => {
        try {
          const body = new FormData()
          for (const [key, value] of Object.entries(payload)) body.append(key, value)
          const response = await fetch(action, { method: 'POST', body })
          if (!response.ok) {
            // The route answers 400/403/404/500 with an empty body by design —
            // it never returns a message, so there is nothing to surface but
            // the fact of the failure.
            setError(WRITE_FAILED)
            return
          }
          router.refresh()
        } catch {
          // A network failure looks identical to the friend: nothing saved.
          setError(WRITE_FAILED)
        }
      })
    },
    [action, router],
  )

  return { fire, pending: groupBusy || isPending, error }
}
```

- [ ] **Step 4: Write the component**

Create `lib/ui/WriteAction.tsx`:

```tsx
'use client'

import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useWriteAction, WRITE_FAILED } from './useWriteAction'

/**
 * The default write control for every dashboard (design §5).
 *
 * A dashboard supplies an action URL, a payload and a label, and writes none
 * of the mechanics. This is arm 3 of the component rule — an interaction
 * control — and its guard is structural rather than a states check: it derives
 * nothing from user values, so it has no degenerate-input case a chart-style
 * guard would catch.
 *
 * IT RENDERS A REAL FORM, and that is not decoration. Without JavaScript the
 * submit is native: the browser POSTs, the route redirects, and the friend
 * gets exactly today's behaviour. The interception is the enhancement, not the
 * mechanism.
 *
 * It holds no writable database handle and knows no SQL. The route it posts to
 * is still the only thing that writes, and still the only place the four
 * ordered auth checks live.
 */
export function WriteAction({
  action,
  payload,
  children,
  pendingLabel,
  disabled,
  className,
  size,
  variant,
  'aria-label': ariaLabel,
}: {
  action: string
  payload: Record<string, string>
  children: ReactNode
  /** Shown in place of `children` while the write is in flight. */
  pendingLabel?: ReactNode
  /** The dashboard's own affordance (run9's −1 at zero). The route still enforces the rule. */
  disabled?: boolean
  className?: string
  size?: ComponentProps<typeof Button>['size']
  variant?: ComponentProps<typeof Button>['variant']
  'aria-label'?: string
}) {
  const { fire, pending, error } = useWriteAction(action)
  return (
    <form
      method="post"
      action={action}
      onSubmit={(event) => {
        event.preventDefault()
        fire(payload)
      }}
    >
      {Object.entries(payload).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button
        type="submit"
        disabled={disabled === true || pending}
        aria-busy={pending}
        aria-label={ariaLabel}
        className={className}
        size={size}
        variant={variant}
      >
        {pending && pendingLabel !== undefined ? pendingLabel : children}
      </Button>
      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

export { WRITE_FAILED }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ui/writeAction.test.tsx tests/ui/writeActionStore.test.ts`
Expected: PASS, 11 tests total.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add lib/ui/useWriteAction.ts lib/ui/WriteAction.tsx tests/ui/writeAction.test.tsx
git commit -m "feat(ui): add WriteAction, the default in-place dashboard write control"
```

---

## Task 4: The `trigger` field on `dashboard_open`

**Files:**
- Create: `lib/metrics/renderTrigger.ts`
- Create: `tests/metrics/renderTrigger.test.ts`
- Modify: `app/[user]/page.tsx` (`renderDashboard`, around the `appendMetric` call at :211-234)
- Modify: `tests/routing/dashboardRegion.test.ts` (the two exact-shape assertions, and one new case)

**Interfaces:**
- Produces: `readRenderTrigger(): Promise<'nav' | 'refresh'>` and the type `RenderTrigger`.

- [ ] **Step 1: Write the failing test for the reader**

Create `tests/metrics/renderTrigger.test.ts`:

```ts
// tests/metrics/renderTrigger.test.ts
//
// Why a render happened. See the design doc §7.3 for the coupling this
// depends on: every navigation in this app is a plain document load (the tab
// strip is bare `<a href="?screen=">` anchors), so an `rsc` header means a
// router.refresh() and nothing else.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const headerSlot: { value: string | null } = { value: null }
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'rsc' ? headerSlot.value : null) }),
}))

beforeEach(() => {
  headerSlot.value = null
})

describe('readRenderTrigger', () => {
  it('reads a plain document load as nav', async () => {
    const { readRenderTrigger } = await import('@/lib/metrics/renderTrigger')
    expect(await readRenderTrigger()).toBe('nav')
  })

  it('reads an RSC request as refresh', async () => {
    headerSlot.value = '1'
    const { readRenderTrigger } = await import('@/lib/metrics/renderTrigger')
    expect(await readRenderTrigger()).toBe('refresh')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/metrics/renderTrigger.test.ts`
Expected: FAIL — cannot resolve `@/lib/metrics/renderTrigger`.

- [ ] **Step 3: Write the reader**

Create `lib/metrics/renderTrigger.ts`:

```ts
import { headers } from 'next/headers'

/**
 * Why a render happened. A render cause, never a user value — see below.
 */
export type RenderTrigger = 'nav' | 'refresh'

/**
 * Distinguish a document load from a router.refresh().
 *
 * WHY THIS EXISTS. `dashboard_open` is written once per render, every render,
 * with no write-path dedup — Nico's ruling: "an open" is a definition applied
 * when the log is READ, never at write time. A tap has ALWAYS produced an
 * open, because the write route answers with a redirect and the browser loads
 * the page again; measured 2026-08-20 against platform/dev/synthetic.db, 38 of
 * 39 dashboard_write rows are followed by a dashboard_open within 3 seconds.
 * Moving to router.refresh() is therefore metric-neutral. This field does not
 * prevent an inflation — it makes an inflation that already exists readable.
 *
 * IT NAMES NO USER VALUE. `nav` and `refresh` are causes of a render, not a
 * panel id, a screen id, a day, a count or a merchant, so CLAUDE.md's metrics
 * bound permits it in this unencrypted table.
 *
 * ADDITIVE BY CONSTRUCTION. `metrics.data` is JSON text, not per-event
 * columns, so this is a key rather than an ALTER TABLE. Rows written before
 * the deploy that introduced it simply lack it, and decode as `nav` by deploy
 * timeline.
 *
 * THE COUPLING, STATED SO IT IS CAUGHT WHERE IT BREAKS. The `rsc` header
 * (Next's own RSC_HEADER, node_modules/next/dist/client/components/app-router-headers.js)
 * rides every app-router client fetch. It means "refresh" HERE only because
 * this app has no client-side navigation at all: the tab strip in
 * app/[user]/page.tsx is deliberately plain `<a href="?screen=">` anchors, no
 * <Link>, no client router. **Introducing a client-side <Link> anywhere under
 * app/[user]/ makes this reader wrong**, and the fallback is read-time
 * correlation with dashboard_write timestamps, which already resolves 38/39.
 */
export async function readRenderTrigger(): Promise<RenderTrigger> {
  return (await headers()).get('rsc') !== null ? 'refresh' : 'nav'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/metrics/renderTrigger.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing red test in the page's own suite**

This is the red test the design requires: a refresh-triggered render that writes a row without `trigger` fails.

`tests/routing/dashboardRegion.test.ts` stubs `next/headers` with a fixed
`emptyHeaders` object, so the `rsc` header cannot be set. Make it settable
first. Replace:

```ts
const emptyHeaders = { get: () => null }

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => emptyHeaders,
}))
```

with:

```ts
/**
 * Still the honest empty fixture for everything except `rsc`: a request with
 * neither the stairwell_dc cookie nor a User-Agent, which resolves to
 * 'desktop' (onboarding ledger D4) — which is what the device_class
 * assertions below expect. `rsc` is settable because it is the one header
 * whose ABSENCE is also meaningful: absent is a document load, present is a
 * router.refresh() (lib/metrics/renderTrigger.ts).
 */
const headerSlot: { rsc: string | null } = { rsc: null }
const requestHeaders = {
  get: (name: string) => (name.toLowerCase() === 'rsc' ? headerSlot.rsc : null),
}

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => requestHeaders,
}))
```

Add the reset to the existing `beforeEach` that already stubs `React`:

```ts
  headerSlot.rsc = null
```

Now add `trigger: 'nav'` to the two existing exact-shape assertions. The first
(around :396, the case with no declared screens) becomes:

```ts
    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
      device_class: 'desktop',
      trigger: 'nav',
    })
```

The second (around :526, `records screen_order — the position, never the
screen id`) becomes:

```ts
    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
      device_class: 'desktop',
      screen_order: 2,
      trigger: 'nav',
    })
```

Both are deliberately exact rather than subset matches — the comment above the
first one says why, and it is the reason this task has to touch them: an added
field is meant to be a decision somebody came here and made.

Then add the new case immediately after the `screen_order` test:

```ts
  it('records trigger: refresh when the render came from a router.refresh()', async () => {
    // THE RED TEST (design doc §7.2). A refresh-triggered render that writes a
    // dashboard_open row without `trigger` is exactly the failure this pins:
    // the field is only readable if it is present on EVERY row written after
    // the deploy that introduced it, so a missing key must be a test failure
    // rather than something that decodes as 'nav' and quietly lies.
    headerSlot.rsc = '1'
    loaderSlot.value = screenEchoingLoader(TWO_SCREENS)
    const UserSpace = await arrange()
    await UserSpace({
      params: Promise.resolve({ user: SLUG }),
      searchParams: Promise.resolve({ screen: 'money' }),
    })

    expect(metricData('dashboard_open')).toEqual({
      slug: SLUG,
      source: 'synthetic',
      device_class: 'desktop',
      screen_order: 2,
      trigger: 'refresh',
    })
  })
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/routing/dashboardRegion.test.ts`
Expected: FAIL — the three assertions report a missing `trigger` key.

- [ ] **Step 7: Add the field to the metric**

In `app/[user]/page.tsx`, add the import:

```ts
import { readRenderTrigger } from '@/lib/metrics/renderTrigger'
```

Inside `renderDashboard`, after the `Dashboard({...})` call and before `appendMetric`, add:

```ts
    const trigger = await readRenderTrigger()
```

Then add `trigger` to the `data` object of the `dashboard_open` metric, after the `screen_order` spread:

```ts
      data: {
        slug,
        source,
        device_class,
        ...(active !== undefined ? { screen_order: active.order } : {}),
        trigger,
      },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/routing/dashboardRegion.test.ts tests/metrics/renderTrigger.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/metrics/renderTrigger.ts tests/metrics/renderTrigger.test.ts app/\[user\]/page.tsx tests/routing/dashboardRegion.test.ts
git commit -m "feat(metrics): record why a dashboard_open render happened"
```

---

## Task 5: Convert run9's three controls

**Files:**
- Modify: `users/run9/dashboard.tsx:118-180`
- Test: `users/run9/tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `WriteAction` from Task 3.

- [ ] **Step 1: Check the existing tests for form-shape assertions**

Run:
```bash
grep -n "form\|method=\|action=" users/run9/tests/*.ts
```

Any assertion matching on `<form` or `method="post"` in the rendered markup must be updated in Step 4 — `WriteAction` still renders a form, but it is now a client component and `renderToStaticMarkup` will render its form and button, not the previous bare markup.

- [ ] **Step 2: Replace the log button**

In `users/run9/dashboard.tsx`, replace the block at :126-143 (the comment plus the `<form>` holding the "Log one" button) with:

```tsx
          {/*
            THE DEFAULT WRITE CONTROL (lib/ui/WriteAction.tsx). It still POSTs
            to the platform route — the route is still the only writable handle
            and still the only place the four ordered auth checks live — but it
            patches the page in place rather than navigating: press, the
            controls sharing this route go pending, and when the server answers
            the count, the trend and the average update together.

            It renders a real form underneath, so this still works with
            JavaScript off; that path is the original redirect, unchanged.
          */}
          <WriteAction
            action={`/api/users/${slug}/pee`}
            payload={{ action: 'add' }}
            size="lg"
            // Deliberately taller than any stock size: the spec asks for a
            // button "comfortable to hit on a phone one-handed", and shadcn's
            // tallest default is 36px, under the 44px touch-target floor.
            className="h-16 w-full text-base"
            pendingLabel="Logging…"
          >
            Log one
          </WriteAction>
```

- [ ] **Step 3: Replace the two correction controls**

Replace the two `<form>` blocks at :155-176 with:

```tsx
            <WriteAction
              action={`/api/users/${slug}/pee`}
              payload={{ action: 'remove' }}
              variant="outline"
              size="sm"
              // DISABLED AT ZERO, which is the spec's "should not be able to
              // take the count below zero" said in the UI. The route enforces
              // it too — this is the affordance, not the rule.
              disabled={count === 0}
              aria-label="Remove one from today"
            >
              −1
            </WriteAction>
            <WriteAction
              action={`/api/users/${slug}/pee`}
              payload={{ action: 'add' }}
              variant="outline"
              size="sm"
              aria-label="Add one to today"
            >
              +1
            </WriteAction>
```

- [ ] **Step 4: Fix the imports and the file header**

Replace the `Button` import with the new one (nothing in this file uses `Button` directly any more — confirm with `grep -n "<Button" users/run9/dashboard.tsx` before removing it):

```tsx
import { WriteAction } from '@/lib/ui/WriteAction'
```

In the file's COMPOSITION header comment (:14-21), the sentence describing Nico's 2026-08-19 ruling now needs the third arm. Replace the paragraph beginning "Nico's ruling of 2026-08-19 splits imported components in two" with:

```
// COMPOSITION. docs/dashboard-build-rules.md states the component rule in
// three arms: presentational components (shadcn's Card, Button) are trusted;
// data-computing ones (Recharts) are sanctioned and guarded by the states rule;
// interaction controls (lib/ui/WriteAction.tsx) are sanctioned and are the
// default for every write. `chartable` below is the states guard, and it is
// why the empty-database first render shows an empty state rather than a
// chart. The accepted residual for all three is a throw on well-formed props
// landing outside app/[user]/page.tsx's try/catch. See ./TrendChart.tsx.
```

- [ ] **Step 5: Update the tests and run them**

Update any assertion Step 1 found. Then:

Run: `npx vitest run users/run9`
Expected: PASS. If a test asserted on exact form markup, fix the assertion to match what `WriteAction` renders — do not weaken it to a substring match on a class name.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add users/run9/dashboard.tsx users/run9/tests/
git commit -m "feat(run9): log and correct in place instead of reloading the page"
```

---

## Task 6: Convert devtwo's control

**Files:**
- Modify: `users/devtwo/dashboard.tsx:35-40`
- Test: `users/devtwo/tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `WriteAction` from Task 3.

**Note the visual change:** devtwo's dashboard is deliberately unstyled — bare `<h2>`, `<p>`, `<button>`, no shadcn anywhere. `WriteAction` renders a shadcn `Button`, so devtwo's tap control gains styling the rest of that dashboard does not have. This is accepted: devtwo is a dev account, and the alternative (an unstyled variant of the primitive) is a second code path to maintain for a dashboard nobody uses. Task 9's screenshot review covers it.

- [ ] **Step 1: Check the existing tests**

Run:
```bash
grep -n "form\|method=\|Tap to mark" users/devtwo/tests/*.ts
```

- [ ] **Step 2: Replace the form**

In `users/devtwo/dashboard.tsx`, replace the block at :35-40:

```tsx
          // The default write control (lib/ui/WriteAction.tsx): still a POST to
          // the platform route, but it patches this page in place rather than
          // navigating. A real form underneath, so it still works with JS off.
          <WriteAction action={`/api/users/${slug}/walk`} payload={{}} pendingLabel="Marking…">
            Tap to mark walked
          </WriteAction>
```

The walk route takes no `action` field — check it before assuming:

```bash
grep -n "formData\|get('action')" app/api/users/\[user\]/walk/route.ts
```

If it reads no form field, `payload={{}}` is correct and renders no hidden inputs. If it does read one, pass it.

- [ ] **Step 3: Fix the import and the header comment**

Add:

```tsx
import { WriteAction } from '@/lib/ui/WriteAction'
```

Replace the file-header paragraph beginning "ONE component with plain helpers, deliberately" with:

```
// ONE component with plain helpers, plus the platform's write control. The
// page calls this function directly inside a try/catch. docs/dashboard-build-rules.md
// states the component rule in three arms; WriteAction is arm 3, an
// interaction control, sanctioned and the default for every write.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run users/devtwo`
Expected: PASS, with any form-markup assertion updated.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add users/devtwo/dashboard.tsx users/devtwo/tests/
git commit -m "feat(devtwo): mark walked in place instead of reloading the page"
```

---

## Task 7: The templates

**Files:**
- Create: `platform/templates/route/route.ts.tmpl`
- Modify: `platform/templates/dashboard/dashboard.tsx.tmpl`

**Interfaces:**
- Produces: the two paths the docs in Task 8 point at.

- [ ] **Step 1: Create the write-route template**

```bash
mkdir -p platform/templates/route
cp app/api/users/\[user\]/pee/route.ts platform/templates/route/route.ts.tmpl
```

Then edit `platform/templates/route/route.ts.tmpl`:

1. Replace the docblock at the top (the one beginning "run9's write path") with:

```
/**
 * THE WRITE-ROUTE WORKED EXAMPLE. Copy this file to
 * app/api/users/[user]/<verb>/route.ts and adapt it. It is an example, not a
 * base class — do not refactor these checks into something shared. The four
 * checks below ARE the security property, and they are cheaper to read twice
 * than to trace through an abstraction.
 *
 * It lives under platform/ rather than pointing at a live friend's route
 * because everything under users/ is deleted at pilot end, and a doc pointing
 * into a folder that no longer exists goes dead on the day nobody wants to be
 * fixing docs.
 *
 * The order of the checks IS the property:
 *
 * 1. unlocked — not merely authenticated. A locked session has no key, so it
 *    must be refused before anything reaches for one or opens a file.
 * 2. ownership — 404, never 403, so the response cannot confirm that another
 *    account exists.
 * 3. a registered dashboard — otherwise any authenticated slug could cause an
 *    encrypted file to be created for a user who has no dashboard at all.
 * 4. only then: key, open, write, close.
 *
 * The dashboard control that posts here is lib/ui/WriteAction.tsx, which
 * expects an ordinary 2xx or a redirect; it never reads a response body, so
 * an empty-bodied error status is the right answer to every failure.
 */
```

2. Replace every `pee_logs` reference with `<TABLE>` and every `pee_log` / `pee_correction` panel constant with `'<panel_name>'`, keeping the surrounding comments — including the "NO `OR IGNORE`" note, which explains a real choice a copier must make.

3. Leave the four checks, both catch blocks, the `logDbFailure` calls, the one-clock-read comment and the `dayKey` import comment exactly as they are.

- [ ] **Step 2: Add the WriteAction example to the dashboard scaffold**

Append to `platform/templates/dashboard/dashboard.tsx.tmpl`, after the existing screens example comment and before `export const screens`:

```
// A WRITE CONTROL, if the spec asks for one. This is the DEFAULT — a write
// control patches the page in place and never navigates. lib/ui/WriteAction.tsx
// owns the pending state, the POST and the refresh; you write none of it.
//
//   import { WriteAction } from '@/lib/ui/WriteAction'
//
//   <WriteAction
//     action={`/api/users/${slug}/<verb>`}
//     payload={{ action: 'add' }}
//     pendingLabel="Saving…"
//   >
//     Log one
//   </WriteAction>
//
// The route it posts to is yours to write — copy
// platform/templates/route/route.ts.tmpl, which carries the four ordered auth
// checks. A dashboard with an entry widget is TWO pieces of work; budget for
// the route while you are reading the spec.
```

- [ ] **Step 3: Verify the conventions sweep still passes**

The scaffold templates are swept for shape by the conventions test.

Run: `npx vitest run tests/users/conventions.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add platform/templates/
git commit -m "docs(templates): add the write-route example and scaffold the default write control"
```

---

## Task 8: The documentation

This is the task the whole change exists for. Two rules are being corrected, not just extended: one that the code already violates, and one that contradicts another doc.

**Files:**
- Modify: `CLAUDE.md`, `docs/dashboard-build-rules.md`, `docs/runbook-ai.md`, `docs/dashboard-ui-ux-guidelines.md`

- [ ] **Step 1: Replace the absolute host-elements rule in the build rules**

In `docs/dashboard-build-rules.md`, replace the bullet at :175-178 ("Compose only host elements…") with:

```markdown
- **The component rule, in three arms** — Nico's ruling of 2026-08-19, extended
  2026-08-20. A dashboard composes host elements plus components from these
  three classes, and nothing else:
  1. **Presentational** — shadcn's `Card`, `Button`, anything that renders
     props as markup without deriving values from them. **Trusted.** This has
     always been true in the code: every dashboard already nests `<Card>` and
     `<Button>`.
  2. **Data-computing** — Recharts, and anything deriving scales, layout or
     geometry from values. **Sanctioned, guarded by the states rule:**
     degenerate data (empty, single-point, all-identical, NaN) renders the
     panel's empty state as host elements and never mounts the component. The
     empty-database first render must show empty states, not charts.
  3. **Interaction controls** — a component whose job is to accept a press and
     post it. **Sanctioned, and the default for every write** (see §4). Its
     guard is structural: it derives nothing from user values, so it has no
     degenerate-input case a states check would catch.
  **The residual, for all three:** they render outside `app/[user]/page.tsx`'s
  try/catch, because a nested function component's body is deferred to React's
  render pass and a throw there 500s the page after `dashboard_open` is already
  written. For arm 3 that residual sits on the happy path, which is why the
  mechanism is platform code in `lib/ui/` tested once, not per-user code —
  the catch exists because bespoke per-user code is the least-reviewed code in
  the repo, and a shared primitive is not that —
  `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md` §4.
```

- [ ] **Step 2: Replace the same rule in the AI runbook**

In `docs/runbook-ai.md`, replace the bullet at :218-222 ("**Compose only host elements**…") with:

```markdown
- **The component rule has three arms**, and only the first is unconditional.
  **Presentational** components (shadcn's `Card`, `Button`) are trusted.
  **Data-computing** ones (Recharts) are sanctioned but must be guarded by the
  states rule — degenerate data renders the empty state as host elements and
  never mounts the component. **Interaction controls** (`lib/ui/WriteAction.tsx`)
  are sanctioned and are the DEFAULT for every write. Everything else is host
  elements. All three render outside `app/[user]/page.tsx`'s try/catch, so a
  throw in one 500s the page after the `dashboard_open` row is written — which
  is why arm 3 is platform code you import rather than code you write.
  Build-rules §3 has the full statement.
```

- [ ] **Step 3: Rewrite the writes section of the build rules**

In `docs/dashboard-build-rules.md` §4, replace the first bullet (":244-246", beginning "A dashboard may **render** an entry widget") with:

```markdown
- A dashboard may **render** an entry widget, but the widget POSTs to a platform
  route. No dashboard component ever holds a writable handle, only a route does
  — CLAUDE.md.
- **The write updates the page IN PLACE. It never navigates** — Nico's ruling,
  2026-08-20. Use `lib/ui/WriteAction.tsx`; it is the default and you write none
  of the mechanics. The contract it implements:
  > press → the controls sharing that route go pending → the server answers →
  > every affected value patches in together, in place, no navigation.
  Nothing on screen moves before the server answers, so there is no optimistic
  state and no rollback path. The pending state ends when the refreshed tree
  COMMITS, not when the POST returns — otherwise the count and the chart update
  a frame apart. Pending is grouped by ACTION URL, never by page: two controls
  writing the same route lock together, two controls writing different routes
  do not. `WriteAction` renders a real form, so the no-JS path is the original
  redirect, unchanged —
  `docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md` §2-3.
```

- [ ] **Step 4: Re-point the five friend-folder examples**

Everything under `users/` is deleted at pilot end, so no doc may cite it as an example. Make these five edits:

| File:line | Currently names | Replace with |
|---|---|---|
| `CLAUDE.md:471` | `users/devtwo/tests/write.test.ts` | `platform/templates/dashboard/tests/dashboard.test.ts.tmpl` |
| `docs/dashboard-build-rules.md:262` | `users/devtwo/tests/write.test.ts` | same |
| `docs/runbook-ai.md:259` | `users/devtwo/tests/write.test.ts` | same |
| `docs/dashboard-build-rules.md:257` | `app/api/users/[user]/walk/route.ts` | `platform/templates/route/route.ts.tmpl` |
| `CLAUDE.md:465` | "the walk route above" | "the write-route template above" |

Keep each sentence's meaning — in particular build-rules:257's "the worked
example, not a thing to refactor into a shared one" survives verbatim, because
that phrasing is the whole point of the citation.

**Do not touch the six factual devtwo mentions:** `CLAUDE.md:183`, `:288`,
`:322`, `docs/dashboard-build-rules.md:99`, `:335`, `:336`. Those name legacy
accounts with no `account_keys` row, `version: 0` predating the spec loop, and
the `screenshots/screens.ts` empty-state pin. They are facts about the system,
not examples to copy.

- [ ] **Step 5: Reconcile the UI guidelines**

In `docs/dashboard-ui-ux-guidelines.md`, in the `## Delight / Animation`
section, after the paragraph beginning "**Animation responds to the user…**",
insert:

```markdown
**A write control shows its own progress; the value lands when it is true.**
Pressing a control that writes puts it — and every control writing the same
route — into a visible pending state immediately. The number itself moves when
the server confirms, not before, and every value affected by that write moves
together. This is the counter example below, resolved: the press feedback is
the control responding, not the count running ahead of the database. A
dashboard never reloads the page to show a write; `lib/ui/WriteAction.tsx` is
the default and does this for you.
```

Then, in the counter-app example at the end of that section, change the last
"Good" bullet from

```
 - The number pops — a quick scale up/down — when the user changes it.
```

to

```
 - The button shows it is working the moment it is pressed.
 - The number pops — a quick scale up/down — when the write lands, which is
   when the server has confirmed it. Never before: an optimistic number is a
   number that can be wrong.
```

- [ ] **Step 6: Record the rule and the default in CLAUDE.md**

In `CLAUDE.md`, in the "Dashboard folder conventions" section, immediately
after the bullet beginning "A dashboard may **render** an entry widget", add:

```markdown
- **A dashboard write updates the page in place and NEVER navigates** (Nico's
  ruling, 2026-08-20). `lib/ui/WriteAction.tsx` is the default control and
  owns the mechanics: press → the controls sharing that route go pending →
  the server answers → every affected value patches in together. No optimistic
  state, so no rollback path and nothing on screen can disagree with the
  database. Pending is grouped by ACTION URL, never by page. It renders a real
  form, so the no-JS path is the original redirect. The route is unchanged and
  is still the only writable handle. The **component rule** this depends on has
  three arms — presentational (trusted), data-computing (sanctioned, guarded by
  the states rule), interaction controls (sanctioned, the default) — stated in
  full in docs/dashboard-build-rules.md §3, with the try/catch residual that
  applies to all three. Design:
  docs/superpowers/specs/2026-08-20-client-side-write-actions-design.md.
- **`dashboard_open` carries `trigger`** — `'nav'` or `'refresh'`, a render
  cause and never a user value. Rows predating the 2026-08-20 deploy have no
  such key and decode as `nav`. It exists because a tap has ALWAYS written an
  open (the route redirects and the page reloads), so this makes an existing
  ambiguity readable rather than preventing a new one. It reads Next's `rsc`
  header, which means "refresh" only because this app has NO client-side
  navigation — the tab strip is deliberately plain anchors. A client-side
  `<Link>` under `app/[user]/` breaks it; see `lib/metrics/renderTrigger.ts`.
```

- [ ] **Step 7: Verify no doc still points into a friend's folder for an example**

Run:
```bash
grep -rn "worked example" CLAUDE.md docs/dashboard-build-rules.md docs/runbook-ai.md
```
Expected: every hit names a path under `platform/` or `lib/`. No hit names a path under `users/`.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md docs/dashboard-build-rules.md docs/runbook-ai.md docs/dashboard-ui-ux-guidelines.md
git commit -m "docs: state the component rule in three arms and make in-place writes the default"
```

---

## Task 9: Verification

**Files:** none created; this task proves the work.

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, no skips other than the ones already expected on this branch.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Build**

Run: `npx next build`
Expected: success. This is Gate D and it is the only thing that catches an import that typechecks but does not bundle — a client component imported into a server component is exactly the shape that has broken this build before.

- [ ] **Step 4: Look at it in a browser**

```bash
npm run dev
```

Log in as a dev account, open `/devtwo` and `/run9`, and press each control. Confirm, by eye:
- no white flash, no scroll jump, no focus loss
- the control shows pending immediately
- the count, the chart and the average all change at the same moment
- pressing "Log one" also disables −1 and +1 while it is in flight
- the −1 control is still disabled at a count of zero

**Never run `npm start`** — it sets `NODE_ENV=production` and a local login under it creates a real database under `users/`, which Gate F then blocks every commit on.

- [ ] **Step 5: Screenshot review**

Run: `npm run shots`

Every screen is reviewed as a picture before the task is committed. Check `screenshots/screens.ts` for what each is meant to look like. This is the only gate that can tell whether the pending state reads as responsive or as stuck, and whether devtwo's newly-styled button looks wrong beside its unstyled siblings.

- [ ] **Step 6: Confirm no real database was created**

Run:
```bash
find users -name '*.db' -not -name 'synthetic.db'
```
Expected: no output. Any hit blocks every commit (Gate F) and must be deleted.

- [ ] **Step 7: Final commit and hand back**

```bash
git status
git log --oneline main..HEAD
```

Report to Nico: the branch, the commits, the measured p95 from Task 1, and anything in the design doc that did not land. Do not merge and do not deploy — `deploy/deploy.sh` pulls `main`, and this branch is not there yet.

---

## Notes for the executor

**Out of scope, found while designing this (design §10).** Do not fix these here; report them:
- `app/api/users/[user]/count/route.ts` has a full test suite and no dashboard posts to it.
- `CLAUDE.md` refers to "four dashboards" in two places. There are three.

**If the probe in Task 1 fails the threshold, stop.** The levers are named in the design doc and each is a change to this plan, not a step inside it.
