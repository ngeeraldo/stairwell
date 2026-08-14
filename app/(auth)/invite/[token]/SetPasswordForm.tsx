'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { PasswordField } from '@/lib/ui/PasswordField'
import {
  NO_RESET_ACK,
  PASSWORD_ERRORS,
  PASSWORD_HINT,
  PASSWORD_MIN_LENGTH,
} from '@/lib/copy/onboarding'

/**
 * S2's fields, and the three conditions that unlock its button.
 *
 * Client-side because the button's disabled state depends on what has been
 * typed. That is the ONLY reason: every rule enforced here is enforced again
 * in lib/invite/register.ts, which is the actual gate. onboarding-ux-spec.md
 * calls this screen "engineered against typos", and a disabled button is one
 * of the three measures — the confirm field and the show-password toggle are
 * the others.
 *
 * TWO independent PasswordFields, each with its own toggle. The spec says a
 * "show-password toggle applying to both fields"; per-field is the reading
 * that actually helps, because a friend who is unsure about one of them can
 * reveal that one without putting the other on screen. One toggle governing
 * both is a lifted boolean if Nico prefers it.
 *
 * The mismatch message is shown INLINE as they type, rather than only after a
 * round trip: a typo caught here costs a keystroke, and the same typo caught
 * after submit costs a password they cannot recover.
 */
export function SetPasswordForm({ action, error }: { action: string; error?: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const longEnough = password.length >= PASSWORD_MIN_LENGTH
  const matches = password === confirm
  const ready = longEnough && matches && confirm.length > 0 && acknowledged

  // Only once they have typed something into it — an unmatched empty confirm
  // field is not a mistake yet, and telling someone they are wrong before they
  // have finished is how a form feels hostile.
  const liveMismatch = confirm.length > 0 && !matches ? PASSWORD_ERRORS.mismatch : undefined

  return (
    <form method="post" action={action} className="space-y-5">
      <PasswordField
        name="password"
        label="Password"
        hint={PASSWORD_HINT}
        autoComplete="new-password"
        onValueChange={setPassword}
        error={password.length > 0 && !longEnough ? PASSWORD_ERRORS.tooShort : undefined}
      />

      <PasswordField
        name="confirm"
        label="Confirm password"
        autoComplete="new-password"
        onValueChange={setConfirm}
        error={liveMismatch ?? error}
      />

      <div className="flex items-start gap-3">
        <Checkbox
          id="ack"
          checked={acknowledged}
          onCheckedChange={(value) => setAcknowledged(value === true)}
          className="mt-0.5"
        />
        <Label htmlFor="ack" className="text-sm leading-snug font-normal">
          {NO_RESET_ACK}
        </Label>
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={!ready}>
        Create my account
      </Button>
    </form>
  )
}
