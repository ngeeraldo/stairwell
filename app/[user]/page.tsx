// app/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { requireState } from '@/lib/session/guard'
import { resolveState } from '@/lib/session/resolve'
import { readTranscript } from '@/lib/db/appendOnly'
import { newestSpec } from '@/lib/db/specs'
import { parseSpecPayload, SpecShapeError } from '@/lib/spec/schema'
import type { Proposal } from '@/lib/spec/author'
import ChatPanel from './ChatPanel'

export default async function UserSpace({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params

  // Still enforced: anonymous goes to /login. A locked session now passes
  // through to the page — the lock is applied to the data region below.
  await requireState(`/${user}`)

  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  // 404, never 403: a 403 would confirm that the other dev user exists.
  if (!canSeeUserSpace(getDb(), sessionId, user)) notFound()

  // canSeeUserSpace has already proven a session exists, so this is only
  // undefined if the session vanished between the two reads.
  const accountId = accountIdFor(getDb(), sessionId)
  if (accountId === undefined) notFound()

  const unlocked = resolveState(getDb(), sessionId) === 'unlocked'

  const newest = newestSpec(getDb(), accountId)
  // Rendered from the record on load, so a friend who closes the tab
  // mid-decision comes back to the same card, still confirmable.
  let proposal: (Proposal & { confirmed: boolean }) | undefined
  if (newest) {
    try {
      proposal = {
        id: newest.id,
        version: newest.version,
        payload: parseSpecPayload(newest.payload),
        mockup_html: newest.mockup_html,
        confirmed: newest.confirmed_at !== null,
      }
    } catch (error) {
      // specs is append-only, so a corrupt row can never be deleted to make
      // this go away. Degrade to no card rather than let the throw become a
      // 500 for the friend — anything OTHER than the expected shape error
      // still escapes, because that's a bug this page has no business
      // hiding.
      if (!(error instanceof SpecShapeError)) throw error
      proposal = undefined
    }
  }

  return (
    <main>
      <h1>{user}</h1>
      <ChatPanel
        initial={readTranscript(getDb(), accountId).map((row) => ({
          role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          body: row.body,
        }))}
        proposal={proposal}
      />
      {unlocked ? (
        <p>Nothing here yet. Your dashboard gets built from your interview.</p>
      ) : (
        <p>
          Locked. <a href="/unlock">Unlock</a> to see your data.
        </p>
      )}
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
