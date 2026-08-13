// app/admin/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'
import { readConversations } from '@/lib/db/appendOnly'
import { readSpecs } from '@/lib/db/specs'
import { parseSpecPayload, SpecShapeError, type SpecPayload } from '@/lib/spec/schema'

/**
 * Read-only transcript + spec pane. The admin portal is not a back door into
 * a dashboard (lib/auth/authorize.ts) — it reads the platform database only,
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

  const specs = readSpecs(getDb(), account.id)
  const conversations = readConversations(getDb(), account.id)

  return (
    <main>
      <h1>{user}</h1>
      <section aria-label="Proposed specs">
        <h2>Specs</h2>
        {specs.length === 0 ? (
          <p>No spec yet.</p>
        ) : (
          specs.map((spec) => {
            // specs is append-only — a row can never be edited or deleted,
            // so a payload that was malformed at write time (or corrupted
            // since) outlives every later fix forever. Degrade THIS card to
            // "unreadable" rather than let the throw become a 500 for the
            // whole admin pane. Anything other than the expected shape
            // error still escapes, because that's a bug this page has no
            // business hiding — same narrow rethrow as app/[user]/page.tsx,
            // which handles the identical hazard (Task 3 finding).
            let payload: SpecPayload | undefined
            try {
              payload = parseSpecPayload(spec.payload)
            } catch (error) {
              if (!(error instanceof SpecShapeError)) throw error
              payload = undefined
            }

            return (
              <article key={spec.id} data-spec-id={spec.id}>
                <h3>
                  v{spec.version} — {new Date(spec.at).toISOString()}
                  {spec.confirmed_at !== null ? ' — Confirmed' : ''}
                </h3>
                {payload === undefined ? (
                  <p>Unreadable proposal (corrupt payload).</p>
                ) : (
                  <>
                    {/* open_questions renders ABOVE the rest of the spec: it
                        is not part of the build description, it is the agent
                        saying it refused to promise something and handed the
                        question over. */}
                    {payload.open_questions.length > 0 && (
                      <>
                        <h4>Open questions</h4>
                        <ul>
                          {payload.open_questions.map((question) => (
                            <li key={question}>{question}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    <h4>{payload.title}</h4>
                    <p>{payload.summary}</p>
                    <p>{payload.background}</p>
                    <ul>
                      {payload.panels.map((panel) => (
                        <li key={panel.name}>
                          <strong>{panel.name}</strong> — {panel.shows} ({panel.why},{' '}
                          {panel.source})
                        </li>
                      ))}
                    </ul>
                    {payload.manual_logging.length > 0 && (
                      <>
                        <h4>Manual logging</h4>
                        <ul>
                          {payload.manual_logging.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {/* Sealed off exactly like the friend's own preview
                        (app/[user]/ChatPanel.tsx): an empty sandbox grants
                        nothing — no scripts, no same-origin, no forms, no
                        top-level navigation. The admin portal is not a
                        softer target than the chat surface it's reviewing.
                        tests/spec/sandbox.test.ts pins this. */}
                    <iframe
                      title={`Preview of ${payload.title}`}
                      srcDoc={spec.mockup_html}
                      sandbox=""
                    />
                  </>
                )}
              </article>
            )
          })
        )}
      </section>
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

      {/* Same reasoning as app/admin/page.tsx: an admin has no user space, so
          without this the only logout on this page is the browser's cookie
          jar. A POST form because /api/logout answers POST only. */}
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
