// app/admin/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'
import { lastActivityAt } from '@/lib/db/appendOnly'

/**
 * The portal index.
 *
 * onboarding-ux-spec.md > Admin portal: "user list down the left (name +
 * last-activity timestamp)". Sorted by that timestamp, newest first, because
 * the question Nico opens this to answer is "who has been using it" — an
 * alphabetical list answers a question nobody has.
 *
 * MANUAL REFRESH ONLY. No polling, no websockets, no live updates: ntfy is the
 * real-time channel and this is for reading. Everything here is one render.
 */
export default async function AdminPortal() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (!isAdmin(getDb(), sessionId)) notFound()

  const users = (
    getDb()
      .prepare("SELECT id, slug FROM accounts WHERE role = 'user' ORDER BY slug")
      .all() as { id: number; slug: string }[]
  )
    .map((u) => ({ ...u, at: lastActivityAt(getDb(), u.id) }))
    // Newest first; anyone who has never done anything sinks to the bottom,
    // which is also where they belong in a list you read top-down.
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

  return (
    <main className="mx-auto max-w-[680px] p-4 md:p-8">
      <Card>
        <CardHeader>
          <CardTitle>Admin</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users yet.</p>
          ) : (
            <ul className="divide-y">
              {users.map((u) => (
                <li key={u.slug} className="flex items-baseline justify-between py-2">
                  <a href={`/admin/${u.slug}`} className="font-medium underline underline-offset-4">
                    {u.slug}
                  </a>
                  {/*
                    "no activity yet", never a 1970 date. This is the line Nico
                    reads to decide whether to worry about someone, and an
                    epoch timestamp there would read as a bug rather than as
                    silence.
                  */}
                  <span className="text-xs text-muted-foreground">
                    {u.at === undefined ? 'no activity yet' : new Date(u.at).toISOString()}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            The admin account's ONLY way out.

            Step 4 gave admin accounts no user space at all — /nico 404s via
            canSeeUserSpace — and app/[user]/page.tsx was where the logout control
            lived. That change silently left an admin with no reachable logout,
            which is how it was found: from the browser, mid-checkpoint, with no
            way to end the session short of clearing the cookie by hand.

            A POST form rather than a link, for the same reason /unlock's is:
            app/api/logout/route.ts only answers POST, and a GET link would 405.
            It deliberately does not call requireState, so it answers for an admin
            session exactly as it does for a friend's.
          */}
          <form method="post" action="/api/logout" className="border-t pt-4">
            <Button type="submit" variant="outline" size="sm">
              Log out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
