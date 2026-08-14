import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { isAdmin } from '@/lib/auth/authorize'
import { specByVersion } from '@/lib/db/specs'
import { withBanner } from '@/lib/spec/banner'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * A friend's mockup, for Nico, read-only.
 *
 * onboarding-ux-spec.md > Admin portal: the Mockup tab shows "the confirmed
 * mockup in an iframe with the same `View full screen` dialog affordance users
 * get (same component, same serving route) — Nico reviews it the way the user
 * saw it." Same component (MockupDialog); this is the admin's serving route.
 *
 * SEPARATE from /mockup/<version> rather than a flag on it, and deliberately.
 * That route scopes every lookup to the CALLER's own account, which is the one
 * sentence that makes it safe to expose a guessable integer. Teaching it to
 * sometimes mean somebody else's account would put "whose row is this" behind
 * a condition, in the place where it currently cannot be wrong.
 *
 * Read-only by the standing rule (lib/auth/authorize.ts): the admin portal is
 * not a back door into a dashboard. This serves model-authored preview markup
 * from the platform database and touches no user data.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ user: string; version: string }> },
) {
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  // 404 rather than 401/403, matching every other admin surface: a non-admin
  // learns nothing about whether this route exists.
  if (!isAdmin(db, sessionId)) return new Response(null, { status: 404 })

  const { user, version: raw } = await params
  const version = Number(raw)
  if (!Number.isInteger(version) || version < 1) {
    return new Response(null, { status: 404 })
  }

  const account = db
    .prepare("SELECT id FROM accounts WHERE slug = ? AND role = 'user'")
    .get(user) as { id: number } | undefined
  if (!account) return new Response(null, { status: 404 })

  const spec = specByVersion(db, account.id, version)
  if (!spec) return new Response(null, { status: 404 })

  // Same guard as the friend's route. Nico reading a mockup should see the
  // same label the friend sees — a preview that looks like a dashboard is
  // exactly as misleading in the admin portal.
  return new Response(withBanner(spec.mockup_html), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The same seal as the friend's own route: an admin opening this URL
      // directly has no iframe around it either.
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    },
  })
}
