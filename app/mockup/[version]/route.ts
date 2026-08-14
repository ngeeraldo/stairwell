import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { isAdmin } from '@/lib/auth/authorize'
import { specByVersion } from '@/lib/db/specs'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'

/**
 * The friend's own mockup, served as a document.
 *
 * onboarding-ux-spec.md: "One serving route for both views: the mockup HTML is
 * served at a session-authed route, used as the iframe src by both the scaled
 * card preview and the full-screen dialog."
 *
 * A ROUTE HANDLER, not a page, and that is the point: no React, no layout, no
 * Tailwind, no chrome of ours reaches model-authored markup. What comes out is
 * exactly the bytes that were stored.
 *
 * IT AUTHORISES RATHER THAN TRUSTING THE URL. A version is a small integer and
 * therefore guessable, so `specByVersion(db, accountId, …)` scopes the lookup
 * to the caller's OWN account — there is no query here that could return
 * somebody else's row.
 *
 * A LOCKED session may read it, deliberately. The mockup is chat surface, not
 * data: it holds synthetic numbers a model invented, the spec flow lives
 * entirely inside the surface that keeps working when the key is gone
 * (architecture-overview.md line 59), and a friend must be able to confirm a
 * proposal after a deploy has re-locked them.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) === 'anonymous') {
    return new Response(null, { status: 401 })
  }
  const session = readSession(db, sessionId!)
  if (!session) return new Response(null, { status: 401 })

  // 404, not 403: an admin has no mockups of their own, and telling them the
  // difference between "you may not" and "there is nothing" is a distinction
  // this route has no reason to draw. Admins read a friend's mockup through
  // app/admin/mockup/[user]/[version], which is scoped and read-only.
  if (isAdmin(db, sessionId)) return new Response(null, { status: 404 })

  const version = Number(params ? (await params).version : NaN)
  if (!Number.isInteger(version) || version < 1) {
    return new Response(null, { status: 404 })
  }

  const spec = specByVersion(db, session.account_id, version)
  // 404 covers both "no such version" and "not yours", identically — the same
  // 404-never-403 rule canSeeUserSpace follows.
  if (!spec) return new Response(null, { status: 404 })

  return new Response(spec.mockup_html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // no-store because a mockup is per-account content behind a session, and
      // a shared cache holding one would be the worst kind of leak.
      'cache-control': 'no-store',
      // Belt and braces beside the iframe's own sandbox attribute. A friend
      // who opens this URL directly has no iframe around it, and this is the
      // only thing left standing between model-authored markup and a
      // same-origin document.
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    },
  })
}
