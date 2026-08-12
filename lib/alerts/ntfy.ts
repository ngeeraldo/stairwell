// lib/alerts/ntfy.ts
//
// The only file that knows ntfy.sh exists.
//
// TWO PROPERTIES HOLD THIS FILE TOGETHER, and both are spec, not taste:
//
// 1. IT TAKES AN ACCOUNT ID AND NOTHING ELSE. Alerts are content-free
//    (design spec §2 item 2) — the third party learns that someone started
//    talking, never what was said. That is not enforced by discipline here;
//    there is simply no parameter through which message text could arrive.
//    Widening this signature is a spec change, and a visible one.
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

/** Distinguishes this alert from any later one sharing the same events. */
export const ALERT_KIND = 'conversation_started'

export type AlerterDeps = {
  topic: string | undefined
  /** Injected so no test ever reaches the network (CLAUDE.md > Testing). */
  fetch: typeof globalThis.fetch
  db: PlatformDb
  now: () => number
}

type Failure = 'http' | 'network' | 'timeout' | 'no_topic'

export function conversationAlerter(
  deps: AlerterDeps,
): (accountId: number) => Promise<void> {
  return async (accountId) => {
    try {
      const account = findAccountById(deps.db, accountId)

      // An admin is Nico, who is at the computer. Self-buzzing is how a tone
      // gets ignored (design spec §3 D2). Suppression records nothing: a
      // deliberate silence must not look like a broken alerter in the log
      // that exists to tell those two apart.
      if (!account || account.role === 'admin') return

      const topic = deps.topic?.trim()
      if (!topic) {
        // Belt to the deploy gate's braces: NTFY_TOPIC is REQUIRED, so
        // deploy/check-env.sh should have stopped this. If it somehow did
        // not, the log says so rather than the alert vanishing.
        record(deps, account.id, 'alert_failed', {
          reason: 'no_topic',
          status: null,
        })
        return
      }

      await send(
        deps,
        account.id,
        topic,
        `${account.slug} started a conversation`,
      )
    } catch {
      // Backstop for anything the paths above did not anticipate — a closed
      // database on the lookup, most plausibly. Property 2 above is absolute.
    }
  }
}

async function send(
  deps: AlerterDeps,
  accountId: number,
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
      record(deps, accountId, 'alert_sent', { status: response.status })
    } else {
      record(deps, accountId, 'alert_failed', {
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
    record(deps, accountId, 'alert_failed', { reason, status: null })
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
  event: 'alert_sent' | 'alert_failed',
  data: { reason?: Failure; status: number | null },
): void {
  try {
    appendMetric(deps.db, {
      accountId,
      event,
      at: deps.now(),
      // No text of any kind. account_id already says who.
      data: { kind: ALERT_KIND, ...data },
    })
  } catch {
    // Losing the metric is the cheapest possible failure here.
  }
}
