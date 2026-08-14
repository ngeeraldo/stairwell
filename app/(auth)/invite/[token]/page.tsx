// app/(auth)/invite/[token]/page.tsx
import { cookies } from 'next/headers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { appendMetric } from '@/lib/db/appendOnly'
import { getDb } from '@/lib/db/instance'
import { readInvite } from '@/lib/invite/tokens'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { ACCEPT_BUTTON, DEAD_LINK, GREETING, PROMISE_BLOCK } from '@/lib/copy/onboarding'

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
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
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
            {PROMISE_BLOCK.paragraphs.map((paragraph) => (
              <p key={paragraph} className="text-muted-foreground">
                {paragraph}
              </p>
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
