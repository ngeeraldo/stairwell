'use client'

import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * A password input with a show-password toggle.
 *
 * The toggle is not a nicety. onboarding-ux-spec.md §"Why this flow is shaped
 * the way it is" makes it one of two anti-typo measures on the single most
 * consequential screen in the product — "a typo'd password at setup is
 * catastrophic" — and S5 points at it by name: "Try again slowly with the
 * show-password toggle on."
 *
 * It swaps `type` and nothing else: same input, same name, same value, so a
 * half-typed password survives the toggle. A second, parallel text input would
 * be the obvious wrong implementation.
 *
 * Composed from shadcn primitives rather than being one — it is ours, so it
 * lives in lib/ui/ and components/ui/ stays exactly what the CLI wrote
 * (onboarding ledger D1).
 */
export function PasswordField({
  name,
  label,
  hint,
  autoComplete,
  error,
  onValueChange,
}: {
  name: string
  label: string
  hint?: string
  autoComplete: 'new-password' | 'current-password'
  error?: string
  /** S2 gates its submit button on length and match, so it needs the value. */
  onValueChange?: (value: string) => void
}) {
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          aria-invalid={error ? true : undefined}
          onChange={(event) => onValueChange?.(event.target.value)}
          className="pr-16"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={shown}
          onClick={() => setShown((wasShown) => !wasShown)}
          className="absolute inset-y-0 right-0 my-auto mr-1"
        >
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
