'use client'

import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
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
 *
 * `action` is checked host-relative before anything renders —
 * `assertHostRelativeAction` in useWriteAction.ts, which the hook call below
 * runs first. This is the one sanctioned place a dashboard can cause a network
 * request, so the URL it can name is bounded to this origin, mirroring
 * `relativeRedirect`'s guard on a Location.
 */
export function WriteAction({
  action,
  payload,
  children,
  pendingLabel,
  failedLabel,
  disabled,
  className,
  size,
  variant,
  confirm,
  'aria-label': ariaLabel,
}: {
  action: string
  payload: Record<string, string>
  children: ReactNode
  /** Shown in place of `children` while the write is in flight. */
  pendingLabel?: ReactNode
  /**
   * Overrides WRITE_FAILED for a route where "nothing was recorded" is FALSE.
   *
   * The default sentence is right for every ordinary write — a friend taps,
   * the route refuses, and nothing happened. It is wrong for a Plaid refresh,
   * where a total failure still writes a plaid_refreshes row per product: that
   * row is the entire reason the table exists, and it is what lets the panel
   * say "couldn't reach your bank" instead of showing stale numbers as
   * current. Leaving the default there put "nothing was recorded" directly
   * above five recorded outcomes — two statements from one request that
   * contradicted each other.
   *
   * Deliberately an override rather than an edit to WRITE_FAILED, which is
   * "the one copy of the failure sentence" for everyone else.
   */
  failedLabel?: string
  /**
   * Make this control ask before it fires. The label shown while it is armed.
   *
   * A DELIBERATELY PLAIN two-press, not a modal: the first press arms the
   * button and changes what it says, the second does the thing. It is for the
   * controls that stop or destroy something a friend cannot get back — nobody,
   * including Nico, can restore a deleted history, because nobody can read the
   * database.
   *
   * It disarms itself after a few seconds, so a button left armed and forgotten
   * cannot be fired by a stray later click.
   *
   * WITH JAVASCRIPT OFF there is no confirmation: the form submits natively on
   * the first press, exactly as it does today. That is the same degradation
   * every other control here makes — the real form is the mechanism and the
   * interception is the enhancement — and a confirmation that only exists in
   * the enhanced path is still worth having.
   */
  confirm?: string
  /** The dashboard's own affordance (run9's −1 at zero). The route still enforces the rule. */
  disabled?: boolean
  className?: string
  size?: ComponentProps<typeof Button>['size']
  variant?: ComponentProps<typeof Button>['variant']
  'aria-label'?: string
}) {
  const { fire, pending, error } = useWriteAction(action)
  const [armed, setArmed] = useState(false)

  // A control left armed and forgotten must not be fireable by a stray click a
  // minute later. Responds to the friend's own press, and stops on its own.
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 5_000)
    return () => clearTimeout(timer)
  }, [armed])

  return (
    <form
      method="post"
      action={action}
      onSubmit={(event) => {
        event.preventDefault()
        if (confirm !== undefined && !armed) {
          setArmed(true)
          return
        }
        setArmed(false)
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
        className={armed ? undefined : className}
        size={size}
        // Armed, it stops looking like the quiet control it was. The friend is
        // one press from something irreversible and the button should say so.
        variant={armed ? 'destructive' : variant}
      >
        {pending && pendingLabel !== undefined ? pendingLabel : armed ? confirm : children}
      </Button>
      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {/*
            The hook's own message is used unless the caller supplied one —
            and only for the generic failure, so a session-expired refresh or
            any other specific message the hook produces still wins.
          */}
          {error === WRITE_FAILED && failedLabel !== undefined ? failedLabel : error}
        </p>
      )}
    </form>
  )
}

export { WRITE_FAILED }
