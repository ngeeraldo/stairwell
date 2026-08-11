import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { canSeeUserSpace } from '@/lib/auth/authorize'
import { requireState } from '@/lib/session/guard'

export default async function UserSpace({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params

  // Enforce the two-tier lock first: a locked session goes to /unlock rather
  // than reaching a dashboard. middleware.ts cannot do this — the edge
  // runtime cannot open SQLite.
  await requireState(`/${user}`)

  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  // 404, never 403: a 403 would confirm that the other dev user exists.
  if (!canSeeUserSpace(getDb(), sessionId, user)) notFound()

  return (
    <main>
      <h1>{user}</h1>
      <p>Nothing here yet. Your dashboard gets built from your interview.</p>
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
