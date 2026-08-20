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
