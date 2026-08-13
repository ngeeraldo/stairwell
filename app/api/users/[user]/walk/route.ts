import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { openEncryptedUserDb } from '@/lib/db/encryptedUserDb'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { relativeRedirect } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'
// dayKey lives in lib/time, not here. A route module may export only Next's
// own route fields — anything else fails `next build` with "is not a valid
// Route export field", which is exactly what an exported-for-testability
// dayKey did on this branch. See lib/time/dayKey.ts.
import { dayKey } from '@/lib/time/dayKey'

/**
 * Mark today walked. The order of the checks below is the security property.
 *
 * 1. unlocked — not merely authenticated. A locked session has no key, so it
 *    must be refused before anything reaches for one or opens a file.
 * 2. ownership — 404, never 403, so the response cannot confirm that another
 *    account exists.
 * 3. a registered dashboard — otherwise any authenticated slug could cause an
 *    encrypted file to be created for a user who has no dashboard at all.
 * 4. only then: key, open, write, close.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    return new Response(null, { status: 403 })
  }
  if (!canSeeUserSpace(db, sessionId, user)) {
    return new Response(null, { status: 404 })
  }
  if (!dashboardLoaderFor(user)) {
    return new Response(null, { status: 404 })
  }

  const accountId = accountIdFor(db, sessionId)
  const key = getKey(sessionId!)
  // resolveState already proved a live key existed; this closes the window
  // where it expired between the two reads rather than throwing on undefined.
  if (accountId === undefined || !key) {
    return new Response(null, { status: 403 })
  }

  let userDb
  try {
    userDb = openEncryptedUserDb(user, key)
  } catch {
    // WrongKeyError (or a corrupt file) must not become a bare 500 with a
    // stack: a metric is recorded first so the failure is visible at all,
    // then a bodyless 500. Slug and panel only, per the permanent metrics
    // policy below — never the error message, which could carry what was
    // being logged.
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel: 'walked_today' },
      at: Date.now(),
    })
    return new Response(null, { status: 500 })
  }
  try {
    // Idempotent by primary key, not by a read-then-write: a double tap is a
    // no-op with no race between the check and the insert.
    userDb
      .prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)')
      .run(dayKey(Date.now()), Date.now())
  } finally {
    userDb.close()
  }

  // Permanent policy: a slug and a panel, never a value. For this dashboard
  // "they tapped" and "they walked the dog" are the same fact, and metrics is
  // the unencrypted platform database. This row is what makes the login page's
  // "I can see when you use it ... but not what you log" true.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel: 'walked_today' },
    at: Date.now(),
  })

  return relativeRedirect(`/${user}`)
}
