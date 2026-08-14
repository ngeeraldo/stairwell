import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PROMISE_BLOCK } from '@/lib/copy/onboarding'
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

            RENDERED FROM lib/copy/onboarding.ts, not typed here, because the
            invite page (S1) shows the same three paragraphs to the same person
            before their account exists. Two copies of a promise are two things
            that can drift apart, and the one that drifts is the one nobody is
            looking at.

            Pinned sentence-by-sentence in tests/routing/loginPage.test.ts. That is
            not ceremony: this is a promise made to a friend, and it should not be
            able to drift through an unrelated edit without someone deciding to
            change it. If a sentence here stops being true, the test failing is the
            point.

            The wording changed with the onboarding build — the spec supersedes
            what step 6a wrote, folding the engagement-visibility sentence into
            the first paragraph rather than leaving it standing alone. What it
            says is unchanged in substance: dashboard_write carries a slug and a
            panel and never a value, so "when you open the app" is exactly what
            is knowable, and the key is derived from the password and stored
            nowhere, so there is no recovery.
          */}
          <div className="space-y-3 border-t pt-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{PROMISE_BLOCK.heading}</p>
            {PROMISE_BLOCK.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
