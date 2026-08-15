// lib/alerts/ntfy.ts
//
// The only file that knows ntfy.sh exists.
//
// TWO PROPERTIES HOLD THIS FILE TOGETHER, and both are spec, not taste:
//
// 1. NO EXPORTED FUNCTION HAS A PATH THROUGH WHICH CALLER-SUPPLIED TEXT COULD
//    REACH ntfy.sh. Alerts are content-free (design spec §2 item 2) — the
//    third party learns that someone did something, never what was said.
//    This used to be the shape of ONE function (conversationAlerter took an
//    account id and nothing else). It is now a property of the FILE: the
//    alerter takes a KIND, and the kind indexes a fixed table below. Adding a
//    third kind means adding a table entry, not a new place the guarantee can
//    be forgotten.
//
// 2. IT NEVER THROWS AND NEVER REJECTS. Nothing awaits it, so a rejection is
//    an unhandled rejection — a process-level event, over a push
//    notification. A friend's chat turn must never fail because a phone did
//    not buzz (design spec §2 item 3).
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric } from '@/lib/db/appendOnly'
import { findAccountById } from '@/lib/auth/accounts'

export const NTFY_ORIGIN = 'https://ntfy.sh'

/**
 * A hung ntfy.sh with no timeout holds a socket for the life of the process,
 * and since nothing awaits the send, nobody would ever notice. The exact
 * number is not load-bearing: well under any human patience for the signal,
 * well over ntfy.sh's normal response.
 */
export const ALERT_TIMEOUT_MS = 5_000

/**
 * Every alert body this module can ever send.
 *
 * Step-3 residual 5: content-freeness used to be guaranteed by the SHAPE OF
 * ONE FUNCTION — conversationAlerter had no parameter through which message
 * text could arrive. Nothing extended that to a second alert type.
 *
 * It is now a property of the FILE. The alerter takes a kind, the kind indexes
 * this table, and there is no exported function on this module through which
 * text could reach ntfy.sh. Adding a third kind cannot weaken it by accident.
 */
export const ALERT_TEXT = {
  conversation_started: 'started a conversation',
  spec_confirmed: 'confirmed a spec',
  migration_failed: 'could not log in — migration failed',
} as const

export type AlertKind = keyof typeof ALERT_TEXT

export type AlerterDeps = {
  topic: string | undefined
  /** Injected so no test ever reaches the network (CLAUDE.md > Testing). */
  fetch: typeof globalThis.fetch
  db: PlatformDb
  now: () => number
}

type Failure = 'http' | 'network' | 'timeout' | 'no_topic'

export function alerter(
  deps: AlerterDeps,
): (kind: AlertKind, accountId: number) => Promise<void> {
  return async (kind, accountId) => {
    try {
      const account = findAccountById(deps.db, accountId)

      // BELT AND BRACES, not the primary control anymore. app/api/chat/route.ts
      // and app/api/spec/confirm/route.ts now reject an admin with 403 before
      // writing anything, which makes an admin account unreachable through
      // this alerter today — canSeeUserSpace's 404 closes the third path.
      // Left in rather than deleted: if that upstream rule ever regresses,
      // the worst case here should be a missing push notification, not
      // ntfy.sh being told that a friend confirmed a spec. An admin is Nico,
      // who is at the computer anyway (design spec §3 D2). Suppression
      // records nothing: a deliberate silence must not look like a broken
      // alerter in the log that exists to tell those two apart.
      if (!account || account.role === 'admin') return

      const topic = deps.topic?.trim()
      if (!topic) {
        // Belt to the deploy gate's braces: NTFY_TOPIC is REQUIRED, so
        // deploy/check-env.sh should have stopped this. If it somehow did
        // not, the log says so rather than the alert vanishing.
        record(deps, account.id, kind, 'alert_failed', {
          reason: 'no_topic',
          status: null,
        })
        return
      }

      await send(
        deps,
        account.id,
        kind,
        topic,
        `${account.slug} ${ALERT_TEXT[kind]}`,
      )
    } catch {
      // Backstop for anything the paths above did not anticipate — a closed
      // database on the lookup, most plausibly. Property 2 above is absolute.
    }
  }
}

/**
 * The conversation-start alerter, kind-bound.
 *
 * Kept so lib/chat/turn.ts's `alert: (accountId: number) => void` dependency
 * type is unchanged — that type is what stops a future edit from awaiting a
 * push notification on the critical path of a friend's chat turn.
 */
export function conversationAlerter(
  deps: AlerterDeps,
): (accountId: number) => Promise<void> {
  const send = alerter(deps)
  return (accountId) => send('conversation_started', accountId)
}

/**
 * The refused-session alerter.
 *
 * Takes a migration NUMBER and a driver CODE alongside the account, because
 * the operator's two questions are "when did it break" and "why" — and a
 * notification that says only "a migration failed" answers the first at the
 * cost of an ssh to answer the second.
 *
 * THE NO-FREE-TEXT INVARIANT IS INTACT. This does not accept a message: it
 * accepts an integer and a code, and assembles the body here from ALERT_TEXT
 * exactly as `alerter` does. There is still no exported function on this
 * module through which arbitrary text can reach ntfy.sh, which is what keeps
 * a friend's data off a third-party server by construction rather than by
 * everyone remembering.
 */
export function migrationAlerter(
  deps: AlerterDeps,
): (input: { accountId: number; migrationNumber: number; code: string }) => Promise<void> {
  return async ({ accountId, migrationNumber, code }) => {
    try {
      const account = findAccountById(deps.db, accountId)
      if (!account || account.role === 'admin') return

      const topic = deps.topic?.trim()
      if (!topic) {
        record(deps, account.id, 'migration_failed', 'alert_failed', {
          reason: 'no_topic',
          status: null,
        })
        return
      }

      await send(
        deps,
        account.id,
        'migration_failed',
        topic,
        `${account.slug} ${ALERT_TEXT.migration_failed} (migration ${migrationNumber}, ${code})`,
      )
    } catch {
      // Same backstop as `alerter`: a push notification must never become the
      // caller's problem, and this caller is a session being refused.
    }
  }
}

async function send(
  deps: AlerterDeps,
  accountId: number,
  kind: AlertKind,
  topic: string,
  body: string,
): Promise<void> {
  try {
    const response = await deps.fetch(
      // Encoded so a topic containing '/' cannot reach a different path.
      `${NTFY_ORIGIN}/${encodeURIComponent(topic)}`,
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      },
    )
    if (response.ok) {
      record(deps, accountId, kind, 'alert_sent', { status: response.status })
    } else {
      record(deps, accountId, kind, 'alert_failed', {
        reason: 'http',
        status: response.status,
      })
    }
  } catch (error) {
    // Both arrive as a rejection from fetch. AbortSignal.timeout raises a
    // TimeoutError specifically, which is the only thing separating "ntfy.sh
    // is slow" from "this host has no egress".
    const reason: Failure =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : 'network'
    record(deps, accountId, kind, 'alert_failed', { reason, status: null })
  }
}

/**
 * Both outcomes are recorded, not only failures.
 *
 * Failure-only leaves silence ambiguous: no rows could mean nobody chatted, or
 * it could mean alerting is dead. With alert_sent, conversation starts —
 * derivable from `transcripts` — diff against alerts sent, so a stoppage is a
 * visible gap rather than an absence of evidence (design spec §4.4).
 *
 * Never throws: the write failing must not become the caller's problem, and
 * the caller here is a promise nobody holds.
 */
function record(
  deps: AlerterDeps,
  accountId: number,
  kind: AlertKind,
  event: 'alert_sent' | 'alert_failed',
  data: { reason?: Failure; status: number | null },
): void {
  try {
    appendMetric(deps.db, {
      accountId,
      event,
      at: deps.now(),
      // No text of any kind. account_id already says who.
      data: { kind, ...data },
    })
  } catch {
    // Losing the metric is the cheapest possible failure here.
  }
}
