import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { appendMetric } from '@/lib/db/appendOnly'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import { isAdmin } from '@/lib/auth/authorize'
import { findAccountById } from '@/lib/auth/accounts'
import { readCurrentState } from '@/lib/build/currentState'
import { logDbFailure } from '@/lib/db/failureLog'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  anthropicClient,
  type ChatClient,
} from '@/lib/chat/client'
import { contextFor } from '@/lib/chat/context'
import { AGENT_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import { runTurn } from '@/lib/chat/turn'
import { alerter, conversationAlerter } from '@/lib/alerts/ntfy'
import { authorSpec as authorSpecImpl } from '@/lib/spec/author'
import { HEARTBEAT_LINE, startHeartbeat } from '@/lib/chat/heartbeat'

const encoder = new TextEncoder()
const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)

/**
 * One client, not one per request — the SDK owns a connection pool, and
 * rebuilding it per request throws that away. Memoized lazily rather than
 * built at module scope so a missing credential fails the request that asked
 * for it, not the module import (which would take the whole route down,
 * including the 401 and 400 paths that never touch the API). A failed
 * construction is not cached, so the next request retries.
 */
let client: ChatClient | undefined
function chatClient(): ChatClient {
  return (client ??= anthropicClient())
}

/**
 * The chat endpoint.
 *
 * Deliberately does NOT use requireState: that returns redirect targets, which
 * would hand a JSON caller a 307 to a page. And deliberately accepts a locked
 * session — architecture-overview.md line 59 makes the chat surface the thing
 * that keeps working when the key is gone.
 */
export async function POST(request: Request) {
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) === 'anonymous') {
    return new Response(null, { status: 401 })
  }
  const session = readSession(db, sessionId!)
  if (!session) return new Response(null, { status: 401 })

  // 403, not 404: unlike app/[user]/page.tsx's canSeeUserSpace check, there
  // is nothing to hide here — the caller is asking about their own account
  // and already knows their own role. Placed before any body parsing, the
  // chatClient() construction, and the ReadableStream: an admin's request
  // must write no transcript row, no metrics row, and trigger no model call.
  if (isAdmin(db, sessionId)) {
    return new Response(null, { status: 403 })
  }

  let payload: { body?: unknown }
  try {
    payload = (await request.json()) as { body?: unknown }
  } catch {
    return new Response(null, { status: 400 })
  }
  // No `trigger` field any more. This endpoint used to also accept
  // `{trigger: 'confirmation'}` — a body-less, product-initiated turn sent
  // right after pressing "Build this", so runTurn's promised acknowledgment
  // arrived immediately instead of waiting for the friend's next message.
  // Nothing confirms any more (lib/db/specs.ts's confirmSpec is gone, and so
  // is the button that sent this), so accepting it left an authenticated
  // friend able to spend a model call on a `body: null` turn nobody could
  // otherwise produce. TurnInput.body stays `string | null` in
  // lib/chat/turn.ts — that shape is real, tested infrastructure independent
  // of this route — but this route now only ever passes a string.
  const body = typeof payload.body === 'string' ? payload.body.trim() : ''
  if (!body) return new Response(null, { status: 400 })

  // Resolved BEFORE the ReadableStream. Inside start() a construction failure
  // would land after the 200 and its headers had already gone out, and before
  // runTurn had written anything — so a total chat outage would produce zero
  // transcript rows, zero metrics rows, and a browser that saw a successful
  // response with an errored body. The metrics log is this project's ground
  // truth; an outage has to be visible in it.
  let turnClient: ChatClient
  try {
    turnClient = chatClient()
  } catch {
    // Aligned to the chat_error shape documented in the step-2 design spec
    // section 2.5 (step-2 ledger residual 8). It used to carry six fields
    // where every other chat_error carries fourteen, so anyone grouping
    // chat_error rows by prompt_sha silently dropped these. metrics is
    // append-only, so this only gets more expensive with every row.
    appendMetric(db, {
      accountId: session.account_id,
      event: 'chat_error',
      at: Date.now(),
      data: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
        model: CHAT_MODEL,
        effort: CHAT_EFFORT,
        prompt_sha: loadPrompt(AGENT_PROMPT).sha,
        context: contextFor(db, session.account_id),
        model_served: CHAT_MODEL,
        fallback_fired: false,
        kind: 'no_api_key',
        status: null,
        type: null,
        delivered_chars: 0,
      },
    })
    return new Response(null, { status: 503 })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Computed once, here: both runTurn's own metrics and the authoring
      // call's metrics should reflect the same "kind of run" for this
      // request, not two reads of a value that could change between them.
      const context = contextFor(db, session.account_id)

      // The account row is looked up fresh rather than trusted from the
      // session, and its absence is handled rather than thrown: a slug that
      // has gone missing must not take down a chat request, and reads the
      // same as an account with no built dashboard.
      const slug = findAccountById(db, session.account_id)?.slug

      // WRAPPED, same reasoning as app/[user]/page.tsx's ensureOpeningMessage
      // wrap. readCurrentState throws when current.md EXISTS but fails to
      // parse — correct as a builder-facing signal (the folder sweep wants
      // that loud: tests/users/conventions.test.ts's "has a current.md that
      // parses" check) but wrong here: this route's own header comment
      // promises the chat surface "keeps working when the
      // key is gone," and a malformed file the builder wrote must not take
      // the whole chat request down with it — no reply, no assistant row, no
      // chat_error metric. Degrading to null is exactly the graceful
      // degradation this surface promises: the agent talks as if no
      // dashboard were described yet, the same as the ordinary "not built
      // yet" case. Not silent — logDbFailure records it so an operator can
      // tell a malformed current.md apart from an absent one.
      let currentState: string | null = null
      if (slug) {
        try {
          currentState = readCurrentState(slug)?.body ?? null
        } catch (error) {
          logDbFailure('current_state_failed', slug, error)
        }
      }

      // NOTHING GOES DOWN THIS CONNECTION WHILE THE SLOW WORK RUNS.
      //
      // Between the reply finishing and the authored proposal coming back, the
      // server sends no bytes for 47-97 seconds, and 5 of the platform's 12
      // authoring attempts have died in that window with the client's
      // connection torn down (unified-loop ledger D13). This keeps a byte on
      // the wire throughout.
      //
      // Started HERE rather than inside the authorSpec callback below, which is
      // where the authoring wait actually begins: the gap before the model's
      // first token is the same hazard on a smaller scale, and one timer
      // spanning the whole request covers both without a second mechanism.
      // Heartbeats interleaving with `{t:...}` chunks is harmless — the panel
      // ignores a line carrying no field it dispatches on.
      const stopHeartbeat = startHeartbeat({
        beat: () => controller.enqueue(line(HEARTBEAT_LINE)),
        stopped: () => request.signal.aborted,
      })

      // A SIGNAL THAT IS NEVER ABORTED, handed to the authoring call only.
      //
      // The friend's connection dying must not destroy a proposal. 6 of 16
      // authoring attempts died that way before this existed — Chrome
      // reporting ERR_NETWORK_CHANGED as a laptop moved between wifi
      // access points or a VPN re-established, at a random point inside a
      // 47-97 second window. See RunTurnInput.authoringSignal.
      //
      // Bounded, despite never aborting: lib/chat/client.ts caps each
      // authoring call at SPEC_TIMEOUT_MS, so an abandoned request cannot
      // run forever.
      const authoringSignal = new AbortController().signal

      // Shared by both alerters below: NTFY_TOPIC read at call time rather
      // than at module scope — the same reason chatClient() is deferred — a
      // configuration problem should fail the request that needed it, not
      // the module import that also serves the 401 and 400 paths.
      const alertDeps = {
        topic: process.env.NTFY_TOPIC,
        fetch: globalThis.fetch,
        db,
        now: Date.now,
      }
      // The general, kind-based sender — used below for the two outcomes
      // authoring can produce. conversationAlerter (passed into runTurn as
      // `alert`) is a second, separately bound instance of the same
      // function; kept as its own call so TurnDeps.alert's `(accountId) =>
      // void` type is unchanged, which is what stops a future edit from
      // awaiting a push notification on the critical path of a friend's chat
      // turn.
      const sendAlert = alerter(alertDeps)

      const outcome = await runTurn(
        {
          db,
          client: turnClient,
          now: Date.now,
          context,
          alert: conversationAlerter(alertDeps),
          authorSpec: (proposeInput) =>
            authorSpecImpl({ db, client: turnClient, now: Date.now, context }, proposeInput),
        },
        {
          accountId: session.account_id,
          sessionId: sessionId!,
          currentState,
          body,
          // The exchange is committed. Sent before authoring begins, so a
          // connection that dies while a spec is being authored still leaves
          // the browser knowing the reply was saved — which is the
          // difference between "your message is safe, the build is still
          // coming" and "nothing happened". Guarded like every other enqueue
          // on this stream.
          onSaved: () => {
            if (!request.signal.aborted) controller.enqueue(line({ saved: true }))
          },
          signal: request.signal,
          authoringSignal,
          onText: (text) => {
            // A client that has gone away makes enqueue throw. The turn's own
            // abort path has already decided what to persist; this just keeps
            // the rejection from surfacing as an unhandled error.
            if (!request.signal.aborted) controller.enqueue(line({ t: text }))
          },
        },
      ).finally(stopHeartbeat)

      // TWO SIGNALS THE CONFIRMATION CARD USED TO CARRY, replaced here at the
      // point that already knows the outcome — see lib/alerts/ntfy.ts's
      // ALERT_TEXT for why each exists. Deliberately NOT awaited: the
      // alerter's own contract (lib/alerts/ntfy.ts) is to never throw and
      // never reject, and a push notification must never delay or fail the
      // friend's reply — same reasoning as the conversation-start alert
      // above, which the route has never awaited either. Silent when the
      // tool was never called: `outcome.proposal` and `outcome.proposalFailed`
      // are both absent/false on an ordinary turn, so no build signal fires
      // for something nobody asked for.
      if (outcome.proposal) {
        void sendAlert('spec_authored', session.account_id)
      } else if (outcome.proposalFailed) {
        void sendAlert('spec_failed', session.account_id)
      }

      // THE TURN ITSELF FAILED, upstream, and the friend needs to be told which
      // kind of nothing they got. Without this line the panel could only fall
      // back to "interrupted — not saved", which points at the connection —
      // so on 2026-08-18, when Anthropic returned Overloaded three times in a
      // row, a friend read three connection errors for an outage that had
      // nothing to do with their network.
      if (outcome.kind === 'error' && !request.signal.aborted) {
        controller.enqueue(line({ turn_failed: true }))
      }

      // The terminal line is what tells the browser the reply is complete and
      // therefore saved. Its ABSENCE is the interrupted case — see the panel.
      // Gated on 'completed' specifically, not on "not an error": 'empty' is
      // also a turn with no assistant row, so it must not emit this line
      // either. Any new outcome kind that does not append a row must stay
      // outside this branch. NOT suppressed by a failed proposal: a completed
      // chat turn whose spec authoring failed is still a completed chat turn
      // — the assistant row for it exists and the friend really did receive
      // that reply.
      if (outcome.kind === 'completed' && !request.signal.aborted) {
        controller.enqueue(line({ done: true }))
      }
      // Guarded: a client that went away mid-authoring leaves this stream
      // already cancelled, and close() on a cancelled controller throws —
      // which, inside start(), surfaces as an unhandled rejection rather than
      // a failed request. Much likelier now that authoring outlives the
      // connection instead of dying with it.
      try {
        controller.close()
      } catch {
        // Nothing to tell anyone: the reader is gone, and everything worth
        // persisting was written before we got here.
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
