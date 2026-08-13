import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import { isAdmin, slugFor } from '@/lib/auth/authorize'

/**
 * '/' has no content of its own — it only dispatches by session state. It
 * used to redirect unconditionally to /login, which meant an already
 * -unlocked user visiting '/' saw the login form again and could start a
 * second session while the first stayed alive for up to 30 days (fix wave,
 * item 5). routeFor('unlocked', '/login') already sends /login back to '/'
 * for the same reason; the slug lookup that terminates that hop lives here,
 * since routeFor only knows AuthState, not which account a session belongs
 * to.
 */
export default async function Home() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  const state = resolveState(getDb(), sessionId)

  if (state === 'anonymous') redirect('/login')
  if (state === 'authenticated') redirect('/unlock')

  // An admin account has no user space — it lands on the read-only admin
  // portal instead of /<slug>, which would now 404 (canSeeUserSpace excludes
  // admins even for their own slug; see lib/auth/authorize.ts).
  if (isAdmin(getDb(), sessionId)) redirect('/admin')

  const slug = slugFor(getDb(), sessionId)
  // Defensive only: resolveState returning 'unlocked' means readSession()
  // found a live session row, so its account should always exist. Fall
  // back to /login rather than redirect to '/undefined' if that invariant
  // is ever violated.
  redirect(slug ? `/${slug}` : '/login')
}
