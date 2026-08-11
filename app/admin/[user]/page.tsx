// app/admin/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'
import { readConversations } from '@/lib/db/appendOnly'

/**
 * Read-only transcript pane. The admin portal is not a back door into a
 * dashboard (lib/auth/authorize.ts) — it reads the platform database only,
 * which is the visibility the onboarding promise already covers.
 */
export default async function TranscriptPane({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (!isAdmin(getDb(), sessionId)) notFound()

  const account = getDb()
    .prepare("SELECT id FROM accounts WHERE slug = ? AND role = 'user'")
    .get(user) as { id: number } | undefined
  if (!account) notFound()

  const conversations = readConversations(getDb(), account.id)

  return (
    <main>
      <h1>{user}</h1>
      {conversations.length === 0 ? (
        <p>No transcript yet.</p>
      ) : (
        conversations.map((conversation) => (
          <section key={conversation.id}>
            <h2>
              {/* readConversations only ever builds non-empty groups, so
                  rows[0] always exists; the `!` just satisfies
                  noUncheckedIndexedAccess. */}
              {new Date(conversation.rows[0]!.at).toISOString()} —{' '}
              {conversation.rows.length} messages
            </h2>
            <ol>
              {conversation.rows.map((row) => (
                <li key={row.id}>
                  <strong>{row.role}</strong>{' '}
                  <time dateTime={new Date(row.at).toISOString()}>
                    {new Date(row.at).toISOString()}
                  </time>{' '}
                  <code>{row.prompt_sha}</code>
                  <p>{row.body}</p>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </main>
  )
}
