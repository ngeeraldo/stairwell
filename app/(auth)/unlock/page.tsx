import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>Unlock your data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Your password unlocks your data. It is not stored anywhere.
          </p>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              That did not match. Try again.
            </p>
          ) : null}

          <form method="post" action="/api/unlock" className="space-y-4">
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
              Unlock
            </Button>
          </form>

          {/*
            Without this, a locked session is a dead end. routeFor sends an
            'authenticated' state back here for a deeper path within a user
            space (e.g. /devone/settings) and for anything else that isn't
            /unlock, /admin, or the user's own space page — and the user's own
            space page, while reachable, still withholds its data region until
            unlock. Either way, a user who cannot remember their password has no
            way to reach /login short of clearing the cookie by hand.

            This works while locked because /api/logout is reachable in that
            state: middleware.ts only bounces requests with NO session cookie,
            and app/api/logout/route.ts deliberately does not call requireState.
            It must stay a POST form rather than a link — the handler is
            POST-only, so a GET <a> would 405.
          */}
          <div className="space-y-3 border-t pt-6">
            <p className="text-sm text-muted-foreground">
              Cannot remember it? Sign out and start over.
            </p>
            <form method="post" action="/api/logout">
              <Button type="submit" variant="outline" size="lg" className="w-full">
                Sign out
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
