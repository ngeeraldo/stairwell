// app/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { requireState } from '@/lib/session/guard'
import { resolveState } from '@/lib/session/resolve'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { newestSpec } from '@/lib/db/specs'
import { parseSpecPayload, SpecShapeError } from '@/lib/spec/schema'
import type { Proposal } from '@/lib/spec/author'
import { openUserDb } from '@/lib/db/userDb'
import type { UserDb } from '@/lib/db/userDb'
import { encryptedUserDbExists, openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { getKey } from '@/lib/session/keymap'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import ChatPanel from './ChatPanel'

/**
 * The data region, for an owner whose session is already UNLOCKED.
 *
 * Called only from the unlocked branch below, so no database file is opened
 * for a locked session — in step 6 that read needs a key a locked session does
 * not have, and a page that opened first and hid the result afterwards would
 * pass today and be wrong then.
 *
 * The dashboard component is CALLED, not returned as <Dashboard />. Returning
 * an element would defer its execution to React's render, outside this
 * try/catch, and the whole point of the catch is that bespoke per-user code is
 * the least-reviewed code in the repo. The chat surface stays OUTSIDE this
 * function on purpose: it is the surface a friend uses to report that the
 * dashboard broke.
 */
async function dashboardRegion(slug: string, accountId: number, sessionId: string) {
  const loader = dashboardLoaderFor(slug)
  if (!loader) {
    return <p>Nothing here yet. Your dashboard gets built from your interview.</p>
  }

  // Real data wins when it exists. The encrypted file is created lazily on the
  // first write (design spec section 3), so a user who has logged nothing has
  // no real database and reads the loudly-fake one under a banner — which is
  // what keeps devone's reference dashboard working, since it is never written
  // to and so never acquires a real file.
  const key = getKey(sessionId)
  const useReal = key !== undefined && encryptedUserDbExists(slug)

  if (!useReal) {
    const data = openUserDb(slug)
    if (data.source === 'none') {
      return <p>Your dashboard is built, but its data has not been generated yet.</p>
    }
    return renderDashboard(loader, slug, data.db, accountId, 'synthetic')
  }

  const db = openEncryptedUserDb(slug, key!)
  try {
    return await renderDashboard(loader, slug, db, accountId, 'real')
  } finally {
    // Opened per request and closed here: a handle is scoped to one key, and a
    // key is scoped to one session. Caching it process-wide is exactly the bug
    // step 5's ledger (residual 4) warns against.
    db.close()
  }
}

async function renderDashboard(
  loader: () => Promise<{ default: (p: { slug: string; db: UserDb }) => unknown }>,
  slug: string,
  db: UserDb,
  accountId: number,
  source: 'synthetic' | 'real',
) {
  try {
    const { default: Dashboard } = await loader()
    // CALLED, not returned as <Dashboard />: an element would defer execution
    // to React's render, outside this try, and the catch is the whole point.
    const rendered = await Dashboard({ slug, db })
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_open',
      data: { slug, source },
      at: Date.now(),
    })
    return (
      <>
        {source === 'synthetic' && (
          <p role="status">SYNTHETIC DATA — every number below is fake.</p>
        )}
        {rendered}
      </>
    )
  } catch (error) {
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_error',
      data: {
        slug,
        message: error instanceof Error ? error.message : String(error),
      },
      at: Date.now(),
    })
    return <p>This dashboard failed to load.</p>
  }
}

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
        await dashboardRegion(user, accountId, sessionId!)
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
