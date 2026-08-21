'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { assertHostRelativeAction } from './useWriteAction'
import {
  exchangeAtConnectRoute,
  forgetLinkSession,
  loadPlaidScript,
  rememberLinkSession,
  type PlaidHandler,
} from './plaidLink'

/**
 * CONNECT A BANK. The one control in this app that loads a third party's
 * script into a page we serve.
 *
 * A dashboard renders this the way it renders lib/ui/WriteAction.tsx — shared
 * mechanics, the dashboard decides placement. It is not platform chrome (the
 * tab strip is drawn for everyone; only some friends have a bank), and it
 * holds no database handle and knows no SQL. The routes it posts to are still
 * the only things that write, and still the only place the four ordered auth
 * checks live.
 *
 * ── WHY A THIRD-PARTY SCRIPT IS NOT A COMPROMISE HERE ───────────────────────
 *
 * Nothing else in this app loads one. The reason this does is the reason Plaid
 * Link exists: the friend's bank username and password are typed into PLAID'S
 * OWN UI, and never touch this server, this repository, or any log we keep.
 * Hosting that form ourselves would be strictly worse for them.
 *
 * ── IT IS HONEST ABOUT WAITING, BECAUSE THE WAIT IS LONG ────────────────────
 *
 * Measured against Sandbox: creating the item takes about ten seconds after
 * the friend finishes at their bank, and the first transaction sync returns
 * nothing for another two to six after that. A spinner that vanished into an
 * empty dashboard would read as a broken product.
 *
 * ── IT PREPARES FOR A TRIP IT MAY NOT TAKE ──────────────────────────────────
 *
 * An OAuth bank navigates the browser away to the bank's own site. This
 * component cannot know in advance whether the friend will pick one — the
 * choice happens inside Plaid's UI, after this code has finished running — so
 * it stores what a resume would need BEFORE opening Link, every time. If the
 * bank turns out to be non-OAuth the stored entry is simply cleared on
 * success. See lib/ui/plaidLink.ts and lib/ui/PlaidOAuthReturn.tsx.
 *
 * ── NO OPTIMISTIC STATE ─────────────────────────────────────────────────────
 *
 * Nothing on screen claims a connection exists until the server has one. The
 * page reloads when the exchange succeeds, so what the friend sees afterwards
 * is what the database actually holds — the same rule WriteAction follows, and
 * the reason neither has a rollback path.
 */

type Phase = 'idle' | 'minting' | 'linking' | 'exchanging' | 'failed'

/** What the friend reads while each phase is in flight. */
const LABEL: Record<Phase, string> = {
  idle: '',
  minting: 'Opening your bank…',
  linking: 'Waiting for your bank…',
  // The honest one. This is the ~10s window, and saying "finishing up" while
  // nothing visible happens is what stops it reading as a hang.
  exchanging: 'Finishing up — this takes a few seconds…',
  failed: '',
}

export function PlaidConnect({
  linkTokenAction,
  connectAction,
  returnTo,
  children,
  reconnect,
}: {
  /** POSTs here to mint a link token. Host-relative. */
  linkTokenAction: string
  /** POSTs the public token here to finish. Host-relative. */
  connectAction: string
  /** Where an OAuth resume sends the friend afterwards. Host-relative. */
  returnTo: string
  children?: React.ReactNode
  /** Copy-only: the routes decide new-vs-update by reading the database. */
  reconnect?: boolean
}) {
  // Bounded to this origin before anything renders, exactly as WriteAction
  // bounds its own action — this is a sanctioned place a dashboard causes a
  // network request, so the URL it can name is not open-ended.
  assertHostRelativeAction(linkTokenAction)
  assertHostRelativeAction(connectAction)
  assertHostRelativeAction(returnTo)

  const [phase, setPhase] = useState<Phase>('idle')
  const [handler, setHandler] = useState<PlaidHandler | null>(null)

  // Plaid's handler holds an iframe and listeners; leaving one behind when the
  // panel unmounts leaks both.
  useEffect(() => () => handler?.destroy(), [handler])

  const exchange = useCallback(
    async (publicToken: string) => {
      setPhase('exchanging')
      if (!(await exchangeAtConnectRoute(connectAction, publicToken))) {
        setPhase('failed')
        return
      }
      // The trip is over, whether or not one was taken.
      forgetLinkSession()
      // Reload rather than patch state in: what the friend sees next is what
      // the database actually holds.
      window.location.reload()
    },
    [connectAction],
  )

  const start = useCallback(async () => {
    setPhase('minting')
    try {
      const response = await fetch(linkTokenAction, { method: 'POST' })
      if (!response.ok) {
        setPhase('failed')
        console.error('[plaid connect] link-token failed with status', response.status)
        return
      }
      const { link_token: token } = (await response.json()) as { link_token?: string }
      if (!token) {
        setPhase('failed')
        return
      }

      await loadPlaidScript()
      if (!window.Plaid) {
        setPhase('failed')
        return
      }

      // BEFORE open(), because open() may navigate away and never come back
      // to this component. Whether it does is decided inside Plaid's UI, which
      // has not run yet.
      rememberLinkSession({ token, connectAction, returnTo })

      const created = window.Plaid.create({
        token,
        onSuccess: (publicToken) => void exchange(publicToken),
        // Covers cancel AND failure alike: from here the friend has no
        // connection either way, and the control returning to its resting
        // state is the honest thing to show.
        onExit: () => {
          forgetLinkSession()
          setPhase('idle')
        },
      })
      setHandler(created)
      setPhase('linking')
      created.open()
    } catch (error) {
      setPhase('failed')
      console.error('[plaid connect] threw before Link opened', error)
    }
  }, [linkTokenAction, connectAction, returnTo, exchange])

  const busy = phase === 'minting' || phase === 'linking' || phase === 'exchanging'

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={() => void start()} disabled={busy}>
        {busy ? LABEL[phase] : (children ?? (reconnect ? 'Reconnect your bank' : 'Connect a bank'))}
      </Button>
      {phase === 'exchanging' && (
        <p className="text-sm text-muted-foreground">
          Your accounts are connecting. Transactions can take a minute to appear — press
          Refresh if they are not there yet.
        </p>
      )}
      {phase === 'failed' && (
        <p className="text-sm text-destructive">
          Couldn’t connect your bank. Nothing was saved — try again.
        </p>
      )}
    </div>
  )
}
