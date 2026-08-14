// app/(auth)/forgot/page.tsx
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { appendMetric } from '@/lib/db/appendOnly'
import { getDb } from '@/lib/db/instance'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { FORGOT } from '@/lib/copy/onboarding'

/**
 * S5 — the honest dead end.
 *
 * onboarding-ux-spec.md: "Job: tell the truth, offer the only real path. No
 * form, no email field."
 *
 * THERE IS NOTHING TO BUILD HERE, and that is the whole design. Every other
 * product's version of this page collects an address and sends a link; this
 * one cannot, because the password is the key and nobody has a copy. A form
 * would be a lie with an input in it.
 *
 * The order of the paragraphs is the order a person needs them: what is true,
 * then the thing that usually actually helps (typos, caps lock, autocorrect),
 * then what to do if it really is gone.
 *
 * `forgot_password_viewed` is the early signal that a friend may be about to
 * lose their data. Log only — the spec is explicit that it does not push,
 * because a phone buzzing at Nico cannot help them remember.
 */
export default async function ForgotPage() {
  appendMetric(getDb(), {
    // Null: by definition, whoever is reading this could not get in. There is
    // no account id to attribute it to, and guessing one from a stale cookie
    // would be worse than not attributing it at all.
    accountId: null,
    event: 'forgot_password_viewed',
    data: { device_class: await readDeviceClass() },
    at: Date.now(),
  })

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-[520px]">
        <CardContent className="space-y-6 pt-6">
          <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
            <AlertTitle className="text-base">{FORGOT.heading}</AlertTitle>
          </Alert>

          <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
            {FORGOT.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>

          {/*
            The only control on the page, and it goes backwards. There is
            deliberately no "email me a link", no "contact support" form, and
            no third option that looks like a recovery path.
          */}
          <Button asChild variant="outline" size="lg" className="w-full">
            <a href="/login">{FORGOT.back}</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
