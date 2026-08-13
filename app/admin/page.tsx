// app/admin/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'

export default async function AdminPortal() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (!isAdmin(getDb(), sessionId)) notFound()

  const users = getDb()
    .prepare("SELECT slug FROM accounts WHERE role = 'user' ORDER BY slug")
    .all() as { slug: string }[]

  return (
    <main>
      <h1>Admin</h1>
      {users.length === 0 ? (
        <p>No users yet.</p>
      ) : (
        <ul>
          {users.map((u) => (
            <li key={u.slug}>
              <a href={`/admin/${u.slug}`}>{u.slug}</a>
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
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
