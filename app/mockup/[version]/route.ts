import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { isAdmin } from '@/lib/auth/authorize'
import { specByVersion } from '@/lib/db/specs'
import { withBanner } from '@/lib/spec/banner'
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

  // The banner is applied HERE, not trusted to the generator. Since mockups
  // carry plausible numbers now, it is the only thing distinguishing a preview
  // from a real dashboard — so it gets the same treatment as every other
  // honesty guard in this codebase: enforced at the boundary, on every
  // document, including ones stored before the rule existed.
  return new Response(withBanner(spec.mockup_html), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // no-store because a mockup is per-account content behind a session, and
      // a shared cache holding one would be the worst kind of leak.
      'cache-control': 'no-store',
      // Belt and braces beside the iframe's own sandbox attribute. A friend
      // who opens this URL directly has no iframe around it, and this is the
      // only thing left standing between model-authored markup and a
      // same-origin document.
      //
      // Task 25: `sandbox` restricts scripts/forms/navigation; it says
      // nothing about a passive GET a browser makes on its own (an <img src>,
      // a <link href>, a CSS url()). The three directives appended after it
      // are Nico's pinned policy for that: `default-src 'none'` closes every
      // fetch category by default, `style-src 'unsafe-inline'` re-opens only
      // the inline <style> a mockup document is built from
      // (lib/spec/mockupCompose.ts), and `img-src data:` re-opens only inline
      // image data — no font-src, because mockups match the app chrome, which
      // is the system font stack (FRAME in mockupCompose.ts), so nothing
      // legitimate ever needs a font URL. This is a privacy-promise guard —
      // any external fetch is a channel that could leak transcript-derived
      // mockup content to a third party — not a styling rule, which is why it
      // does not get to be "a rule the model follows" (mockup-v4.md already
      // asks for exactly this and a model can forget). The STRONGER half of
      // this guard is at compose time (stripExternalReferences in
      // mockupCompose.ts): this header protects a friend who opens this URL
      // directly, but ChatPanel.tsx's srcDoc card is never served by this
      // route and gets no header at all — only the compose-time strip reaches
      // that surface.
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'x-content-type-options': 'nosniff',
    },
  })
}
