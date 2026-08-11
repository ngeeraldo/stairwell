import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from './store'
import { redirectTargetFor } from './resolve'

/**
 * Server-side state guard for protected pages.
 *
 * middleware.ts cannot do this job: the edge runtime cannot open SQLite, so
 * it can only check that a cookie exists. This is where the two-tier lock is
 * actually enforced — an authenticated-but-locked session gets sent to
 * /unlock rather than reaching a dashboard.
 *
 * A thin adapter by design; the decision it delegates to is tested in
 * tests/routing/middleware.test.ts.
 */
export async function requireState(pathname: string): Promise<void> {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  const target = redirectTargetFor(getDb(), sessionId, pathname)
  if (target) redirect(target)
}
