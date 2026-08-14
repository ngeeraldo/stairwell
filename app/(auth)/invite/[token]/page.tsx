// app/(auth)/invite/[token]/page.tsx
import { cookies } from 'next/headers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { appendMetric } from '@/lib/db/appendOnly'
import { getDb } from '@/lib/db/instance'
import { readInvite } from '@/lib/invite/tokens'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import {
  ACCEPT_BUTTON,
  DEAD_LINK,
  GREETING,
  PASSWORD_ERRORS,
  PASSWORD_WARNING,
  PROMISE_BLOCK,
} from '@/lib/copy/onboarding'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SetPasswordForm } from './SetPasswordForm'

/**
 * S0 and S1 — the dead link, and the deal.
 *
 * THE CONSENT SURFACE. onboarding-ux-spec.md: "the recruit message
 * deliberately did zero framing, so this page carries all of it." A person
 * arrives here having been told nothing, and leaves having accepted terms that
 * cannot later be renegotiated, because the encryption is real.
 *
 * Nothing here creates an account, derives a key, or touches a user database.
 * The only write is one metrics row.
 *
 * The token is in the PATH, not a query string, so it is never a value a form
 * carries around after the account exists.
 *
 * S2 lives in this same route, selected by `?step=password`, and arrives in
 * the next task. One route because they are one link: a friend who reloads,
 * comes back a day later, or hits back from the password screen has to land
 * somewhere that still works, and that is easier to be sure of when there is
 * one place to land.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ step?: string; error?: string }>
}) {
  const { token } = await params
  const { step, error } = await searchParams
  const invite = readInvite(getDb(), token)

  if (invite.kind === 'invalid') {
    // S0. One line, no branding effort, and NO explanation of which kind of
    // invalid this is — the spec forbids distinguishing used from unknown,
    // and lib/invite/tokens.ts makes that structural by never returning the
    // difference. This page could not tell you if it wanted to.
    //
    // Rendered as an ordinary page rather than a 404: a spent link should read
    // as a spent link, not as a broken site.
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <Card className="w-full max-w-[420px]">
          <CardContent className="pt-6">
            <p>{DEAD_LINK}</p>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (step === 'password') {
    // S2 — the single most consequential screen in the product.
    //
    // Reached only through a VALID invite: the arm above already returned the
    // dead-link card otherwise. A friend who accepted and then took a week may
    // find the link revoked in between, and must see that line rather than a
    // password form that cannot succeed.
    //
    // No metrics row here. invite_opened belongs to S1 and promise_accepted to
    // the accept POST; this screen's events (password_set, db_created) are
    // written by the registration route when it succeeds, because until then
    // nothing has happened worth recording.
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <Card className="w-full max-w-[420px]">
          <CardHeader>
            <CardTitle>Pick your password</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/*
              The destruction warning, verbatim, and visually distinct. The
              spec: "do not soften", and "the destruction warning gets the room
              to itself" — so it sits above the fields with nothing competing
              with it.

              `destructive`, not the blue accent. The design direction is
              explicit that destructive contexts keep the standard red/amber
              treatment and never take the accent, and this is the most
              destructive thing the product can do to someone.
            */}
            {/*
              The tint and the red border are added to the stock destructive
              variant, which in this preset is red text inside a NEUTRAL
              border on white. The spec asks for "visually distinct
              (bordered/tinted)", and the first screenshot review found the
              stock version read as ordinary prose that happened to be red —
              it did not announce itself as a warning before a word was read.
              Tinting raises the contrast rather than lowering it, so it is not
              the softening the spec forbids.
            */}
            <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
              <AlertTitle>{PASSWORD_WARNING.heading}</AlertTitle>
              <AlertDescription>{PASSWORD_WARNING.body}</AlertDescription>
            </Alert>

            <SetPasswordForm
              action={`/api/invite/register?token=${encodeURIComponent(token)}`}
              error={error === 'server' ? PASSWORD_ERRORS.server : undefined}
            />
          </CardContent>
        </Card>
      </main>
    )
  }

  // S1. Logged on RENDER, not on accept: this is the funnel's first step, and
  // the question it answers — how many people open the link at all — cannot be
  // asked of a row that only exists once they say yes.
  //
  // Deliberately NOT idempotent. A second open is a second row, because
  // "opened twice, thought about it" is a real thing that happened and the
  // retention curve is built out of exactly this kind of row.
  appendMetric(getDb(), {
    accountId: null,
    event: 'invite_opened',
    data: { slug: invite.slug, device_class: await readDeviceClass() },
    at: Date.now(),
  })

  // Read once and passed through the form, so the accept POST does not have to
  // re-derive which token it is acting on from a header or a referrer.
  await cookies()

  return (
    // 420px, from onboarding-ux-spec.md > Viewport rules: a prose-width cap on
    // a form is what good desktop looks like for that content type, not a
    // mobile compromise. One implementation, capped — never a breakpoint.
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>{GREETING}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/*
            The promise, rendered from the same constant the login page uses
            (lib/copy/onboarding.ts). Two copies of a promise are two things
            that can drift apart, and this is the copy a person reads BEFORE
            there is an account — so it is the one that has to be right.
          */}
          <div className="space-y-3 rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="font-medium">{PROMISE_BLOCK.heading}</p>
            {PROMISE_BLOCK.halves.map((half) => (
              <div key={half.label}>
                <p className="font-medium">{half.label}</p>
                <p className="text-muted-foreground">{half.body}</p>
              </div>
            ))}
          </div>

          {/*
            ONE button, and NO checkbox. The spec is explicit: "No checkbox —
            the button is the acceptance." A checkbox here would be ceremony
            that makes the promise feel like a licence agreement, which is the
            opposite of what it is.
          */}
          <form method="post" action={`/api/invite/accept?token=${encodeURIComponent(token)}`}>
            <Button type="submit" size="lg" className="w-full">
              {ACCEPT_BUTTON}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
