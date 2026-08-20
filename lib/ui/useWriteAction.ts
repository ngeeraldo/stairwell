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
