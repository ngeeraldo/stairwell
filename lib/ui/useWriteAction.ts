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
 * The action URL must be host-relative, exactly as `relativeRedirect`
 * (lib/http/redirect.ts) requires of a Location.
 *
 * Same rejection, same two shapes, and the same reasoning transplanted one
 * layer out: a value starting `//` is protocol-relative and resolves to a
 * DIFFERENT ORIGIN, and anything not starting `/` is resolved against the
 * current page. Either would make this hook fetch a third party — carrying a
 * friend's payload and their cookies — from inside a dashboard.
 *
 * That matters here specifically because WriteAction is now the one sanctioned
 * place a `users/<slug>/dashboard.tsx` can cause a network request at all,
 * against a standing repo rule that a dashboard never knows a network exists.
 * Every action in the repo today is a template literal ending in a fixed verb,
 * so this is defence in depth for future callers rather than a live hole —
 * which is precisely what `relativeRedirect` says about its own guard.
 *
 * It THROWS rather than rendering a disabled control: a bad action is a
 * builder's typo in a source literal, not a runtime condition a friend can
 * reach. Silently refusing would ship a dead button nobody notices.
 *
 * WHAT ACTUALLY CATCHES IT is `npm run dev` — the first render of the page —
 * and the `npm run shots` screenshot gate, which boots the app and captures
 * every live screen, so the client component's body really runs there.
 * NOT the dashboard's own tests, and an earlier version of this comment
 * wrongly said otherwise. `users/run9/tests/dashboard.test.ts` and
 * `users/devtwo/tests/dashboard.test.ts` assert over
 * `JSON.stringify(Dashboard({...}))` — they inspect the returned ELEMENT TREE
 * and never render it with react-dom, so a client component's body never
 * executes and this function is never reached from any per-dashboard test.
 * A builder relying on `npx vitest run users/<slug>` alone would see green.
 */
export function assertHostRelativeAction(action: string): void {
  if (!action.startsWith('/') || action.startsWith('//')) {
    throw new Error(
      `useWriteAction: action must be host-relative and not protocol-relative, got '${action}'`,
    )
  }
}

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
  // BEFORE any hook, so the throw is unconditional and cannot depend on state.
  // WriteAction calls this at the top of its own body, so an unguarded action
  // never reaches the `<form action=...>` it renders for the no-JS path either.
  assertHostRelativeAction(action)
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
  //
  // THIS RESTS ON TWO NEXT INTERNALS, not on anything React's public contract
  // promises, so name them: `router.refresh()` dispatches its own state update
  // inside the transition passed to `startTransition`, and that update is a
  // thenable Next entangles into React's async-action lane — which is what
  // keeps `isPending` true from the fetch through the refreshed render's
  // commit rather than only through the fetch. A Next upgrade that stopped
  // doing either would make `isPending` resolve as soon as the fetch settles,
  // which is exactly the choppiness this comment is warning the next reader
  // about — check this behaviour again after any Next major bump.
  useEffect(() => {
    if (!isPending && owns.current) {
      owns.current = false
      endWrite(action)
    }
  }, [isPending, action])

  // UNMOUNT CLEANUP, separate from the effect above, and NOT defence in depth
  // — users/devtwo/dashboard.tsx runs through it on its only happy path.
  // devtwo renders `{done ? <p>Marked for today.</p> : <WriteAction .../>}`,
  // so the successful write that sets `done` is exactly the refresh that
  // unmounts the control which owns the in-flight flag — devtwo's first tap of
  // any day runs through it. (run9's three controls all render
  // unconditionally, the -1 disabled rather than removed, so run9 does not
  // reach this. One live case is enough to keep the effect.)
  //
  // Without this, a control that unmounts mid-flight never runs the effect
  // above again (there is no later commit with isPending false to trigger
  // it), so `owns.current` and the shared flag are stranded true forever:
  // every sibling on that route stays disabled with no error and no way to
  // recover short of a reload. Do not delete this as speculative. Also covers
  // `action` changing mid-flight, which would otherwise clear the NEW url's
  // owns ref while leaving the OLD url's shared flag set.
  useEffect(() => {
    return () => {
      if (owns.current) {
        owns.current = false
        endWrite(action)
      }
    }
  }, [action])

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
          // The header is what tells the route this is a fetch, not a native
          // form post — see lib/http/redirect.ts's writeAnswer. A native post
          // cannot set a header, so its absence is the honest signal for "let
          // the 303 through": fetch defaults to redirect:'follow', so a 303
          // here would make the browser render the whole dashboard a second
          // time and append a second dashboard_open row to an append-only
          // table before router.refresh() below adds a third.
          const response = await fetch(action, {
            method: 'POST',
            body,
            headers: { 'X-Stairwell-Write': '1' },
          })
          if (response.status === 401 || response.status === 403) {
            // A locked or expired session, not a failed write: the keymap has
            // a 4h idle TTL and every deploy restart wipes it, so a friend
            // with the tab open across either loses their key mid-session.
            // WRITE_FAILED would tell them to "try again" forever — the
            // control can never succeed until they unlock again, with no path
            // back to /unlock from an inline error. router.refresh() re-runs
            // the server component instead, whose own session guard is what
            // actually sends them there.
            router.refresh()
            return
          }
          if (!response.ok) {
            // The route answers 400/404/500 with an empty body by design — it
            // never returns a message, so there is nothing to surface but the
            // fact of the failure.
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
