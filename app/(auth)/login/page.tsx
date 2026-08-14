import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { requireState } from '@/lib/session/guard'

// A session that is authenticated or unlocked must not be able to
// re-submit the login form: routeFor sends authenticated sessions to
// /unlock and unlocked sessions to '/' (which itself resolves onward to
// the account's own slug — see app/page.tsx). Without this, an unlocked
// user visiting /login directly (not just via '/') could start a second,
// independent session while the first stayed alive (fix wave, item 5).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireState('/login')

  const { error } = await searchParams
  return (
    // 420px, from onboarding-ux-spec.md > Viewport rules: a prose-width cap on
    // a form is "what good desktop looks like for that content type, not a
    // mobile compromise". One implementation, capped — never a breakpoint.
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>Stairwell</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              That did not match. Try again.
            </p>
          ) : null}

          <form method="post" action="/api/login" className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="slug">Who are you?</Label>
              <Input id="slug" name="slug" autoComplete="username" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <Button type="submit" size="lg" className="w-full">
              Log in
            </Button>
          </form>

          {/*
            The onboarding promise. architecture-overview.md section 4 requires it
            to be written down where they can see it, and this is that place.

            Pinned sentence-by-sentence in tests/routing/loginPage.test.ts. That is
            not ceremony: this is a promise made to a friend, and it should not be
            able to drift through an unrelated edit without someone deciding to
            change it. If a sentence here stops being true, the test failing is the
            point.

            The last two sentences were added in step 6a, when real per-user data
            became a thing that could exist. The first is the honest residue of
            recording engagement at all — dashboard_write carries a slug and a panel
            and never a value, so "when you use it" is exactly what is knowable. The
            second is the consequence of deriving the key from the password and
            storing it nowhere, stated bluntly on purpose: it is not a caveat, it is
            the deal.
          */}
          <div className="space-y-3 border-t pt-6 text-sm text-muted-foreground">
            <p>
              My tools run on fake data. I&apos;ll see what you tell the agent and
              what you ask for. I won&apos;t open your transactions. I&apos;d have
              to deliberately modify the system to see anything, and I won&apos;t.
              Everything&apos;s deleted when the pilot ends.
            </p>
            <p>
              I can see when you use it — which days you open it and log things —
              but not what you log.
            </p>
            <p>
              If you forget your password, your logged data is gone forever — I
              can&apos;t recover it, on purpose, because I can&apos;t read it
              either.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
