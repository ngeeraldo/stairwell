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
            <li key={u.slug}>{u.slug}</li>
          ))}
        </ul>
      )}
    </main>
  )
}
