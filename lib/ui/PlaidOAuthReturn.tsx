'use client'

import { useEffect, useRef, useState } from 'react'
import {
  exchangeAtConnectRoute,
  forgetLinkSession,
  loadPlaidScript,
  recallLinkSession,
} from './plaidLink'

/**
 * RESUME a connection after an OAuth bank sent the friend to their bank's own
 * website and back.
 *
 * ── WHY THIS PAGE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * A non-OAuth bank runs entirely inside an iframe on the dashboard: the friend
 * never leaves, React state survives, and lib/ui/PlaidConnect.tsx handles the
 * whole thing. An OAuth bank — which is most real banks; Chase, Wells Fargo
 * and Capital One are all OAuth — NAVIGATES THE BROWSER AWAY. The tab is torn
 * down, every component unmounts, and the friend returns to a cold page load
 * at /plaid/oauth carrying nothing but a URL.
 *
 * Resuming means re-opening Link with the SAME link token that started the
 * flow, plus the exact URL they came back on. Plaid matches the two; a
 * re-minted token would not resume anything, it would start a second flow.
 *
 * ── WHAT IT TRUSTS, AND WHAT IT DOES NOT ────────────────────────────────────
 *
 * The token, the route to POST to, and where to send the friend afterwards all
 * come from sessionStorage — written by PlaidConnect before it opened Link.
 * NOTHING is read out of the incoming URL's query string except by Plaid
 * itself: `receivedRedirectUri` is handed to Plaid's script verbatim and never
 * parsed here. A redirect arriving from a third party is the last thing that
 * should be allowed to name which account we write to.
 *
 * ── IT OPENS IMMEDIATELY, WITH NO BUTTON ────────────────────────────────────
 *
 * The friend already pressed Connect, already chose their bank and already
 * logged in. A second button here would read as a failure — as though
 * something had not worked — at the exact moment everything HAS worked. So the
 * page shows one line of text and reopens Link on its own.
 */

type Phase = 'resuming' | 'exchanging' | 'lost' | 'failed'

export function PlaidOAuthReturn() {
  const [phase, setPhase] = useState<Phase>('resuming')
  // React 18+ mounts effects twice in dev StrictMode. Opening Plaid Link twice
  // would put two handlers on one page and is exactly the sort of thing that
  // only misbehaves in the browser, so the resume is fired once per page load.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const session = recallLinkSession()
    if (!session) {
      // The tab was closed, storage was cleared, or the friend arrived here
      // directly. Nothing was saved, and saying so plainly beats a spinner
      // that never resolves.
      setPhase('lost')
      return
    }

    void (async () => {
      try {
        await loadPlaidScript()
        if (!window.Plaid) {
          setPhase('failed')
          return
        }

        const handler = window.Plaid.create({
          token: session.token,
          // THE WHOLE POINT OF THIS FILE. Plaid reads the OAuth state out of
          // the URL the bank returned on; it is passed verbatim and is never
          // parsed by us.
          receivedRedirectUri: window.location.href,
          onSuccess: (publicToken) => {
            void (async () => {
              setPhase('exchanging')
              const ok = await exchangeAtConnectRoute(session.connectAction, publicToken)
              forgetLinkSession()
              if (!ok) {
                setPhase('failed')
                return
              }
              // A full navigation, not a router push: the dashboard must
              // re-render from the database, and this page has nothing left
              // to show.
              window.location.href = session.returnTo
            })()
          },
          onExit: () => {
            // Cancelling at the bank is not an error. Send them back to their
            // dashboard, which will honestly say no bank is connected.
            forgetLinkSession()
            window.location.href = session.returnTo
          },
        })
        handler.open()
      } catch (error) {
        setPhase('failed')
        console.error('[plaid oauth] could not resume', error)
      }
    })()
  }, [])

  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-8">
      {phase === 'resuming' && (
        <p className="text-sm text-muted-foreground">Finishing up with your bank…</p>
      )}
      {phase === 'exchanging' && (
        <p className="text-sm text-muted-foreground">
          Connecting your accounts — this takes a few seconds…
        </p>
      )}
      {phase === 'lost' && (
        <p className="text-sm">
          This connection can’t be finished — it may have been started in another tab.
          Nothing was saved. Go back to your dashboard and try again.
        </p>
      )}
      {phase === 'failed' && (
        <p className="text-sm text-destructive">
          Couldn’t finish connecting your bank. Nothing was saved — try again from your
          dashboard.
        </p>
      )}
    </main>
  )
}
