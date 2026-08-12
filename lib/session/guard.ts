import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from './store'
import { redirectTargetFor } from './resolve'

/**
 * Server-side state guard for protected pages.
 *
 * middleware.ts cannot do this job: the edge runtime cannot open SQLite, so
 * it can only check that a cookie exists. This still enforces the anonymous
 * case (no session -> /login) and admin/deeper-path cases, but it is no
 * longer where the two-tier lock lives for user-space pages: an
 * authenticated-but-locked session now reaches its own space here, and the
 * page itself withholds the data region until unlock (see
 * app/[user]/page.tsx and tests/routing/userSpace.test.ts's locked-owner
 * test and its unlocked-owner companion).
 *
 * A thin adapter by design; the decision it delegates to is tested in
 * tests/routing/middleware.test.ts.
 */
export async function requireState(pathname: string): Promise<void> {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  const target = redirectTargetFor(getDb(), sessionId, pathname)
  if (target) redirect(target)
}
