// app/api/spec/confirm/route.ts
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { appendMetric } from '@/lib/db/appendOnly'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import { confirmSpec, newestSpec, readSpecs } from '@/lib/db/specs'
import { alerter } from '@/lib/alerts/ntfy'
import { isAdmin } from '@/lib/auth/authorize'

/**
 * The only thing that turns a proposal into a promise.
 *
 * Deliberately accepts a LOCKED session: the chat surface keeps working when
 * the key is gone (architecture-overview.md line 59), the spec flow lives
 * entirely inside that surface, and confirming touches no user data. Same
 * resolveState call, and the same reasoning, as /api/chat.
 */
export async function POST(request: Request) {
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) === 'anonymous') {
    return new Response(null, { status: 401 })
  }
  const session = readSession(db, sessionId!)
  if (!session) return new Response(null, { status: 401 })

  // 403, not 404: unlike the 404 below (which hides whether a spec row
  // exists), there is nothing to hide here — the caller is asking about
  // their own account and already knows their own role. Placed before any
  // body parsing or spec lookup, so an admin's request confirms nothing and
  // writes no metrics row.
  if (isAdmin(db, sessionId)) {
    return new Response(null, { status: 403 })
  }

  let payload: { specId?: unknown }
  try {
    payload = (await request.json()) as { specId?: unknown }
  } catch {
    return new Response(null, { status: 400 })
  }
  const specId = payload.specId
  if (typeof specId !== 'number' || !Number.isInteger(specId)) {
    return new Response(null, { status: 400 })
  }

  const mine = readSpecs(db, session.account_id)
  const spec = mine.find((s) => s.id === specId)
  // 404, never 403: a 403 would confirm the row exists. Same rule as
  // canSeeUserSpace, and it covers "not found" and "not yours" identically.
  if (!spec) return new Response(null, { status: 404 })

  // Only the newest proposal is confirmable. The panel renders older cards
  // inert, but a stale tab is not bound by what the current page rendered.
  if (newestSpec(db, session.account_id)?.id !== spec.id) {
    return new Response(null, { status: 409 })
  }

  // Append-only makes a duplicate confirmation harmless but permanent, and
  // "confirmed twice" is not a fact about anything. No-op, not an error:
  // a double-click is not a mistake the friend needs to hear about.
  if (spec.confirmed_at !== null) {
    return Response.json({ ok: true })
  }

  const at = Date.now()
  try {
    confirmSpec(db, { specId: spec.id, accountId: session.account_id, at })
  } catch {
    // confirmSpec (lib/db/specs.ts) throws only when the spec does not
    // belong to this account — a state the 404 check above should already
    // have ruled out. But this route must not assume confirmSpec is
    // infallible: an unhandled throw here is a 500 to the friend at the
    // exact moment they press "Build this". Treat it the same as "not
    // found," which is what the mismatch actually means.
    return new Response(null, { status: 404 })
  }
  appendMetric(db, {
    accountId: session.account_id,
    event: 'spec_confirmed',
    at,
    // Not a model call: no counters, no model. Giving it zeroed counters
    // would put four rows of fiction in the cost log per confirmation.
    data: { spec_id: spec.id, version: spec.version },
  })

  // Fire-and-forget, exactly like the conversation alert: a friend's
  // confirmation must never fail because a phone did not buzz.
  void alerter({
    topic: process.env.NTFY_TOPIC,
    fetch: globalThis.fetch,
    db,
    now: Date.now,
  })('spec_confirmed', session.account_id)

  return Response.json({ ok: true })
}
