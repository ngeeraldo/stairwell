import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { appendMetric } from '@/lib/db/appendOnly'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  anthropicClient,
  type ChatClient,
} from '@/lib/chat/client'
import { contextFor } from '@/lib/chat/context'
import { AGENT_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import { runTurn } from '@/lib/chat/turn'
import { conversationAlerter } from '@/lib/alerts/ntfy'
import { authorSpec as authorSpecImpl } from '@/lib/spec/author'

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

  let payload: { body?: unknown }
  try {
    payload = (await request.json()) as { body?: unknown }
  } catch {
    return new Response(null, { status: 400 })
  }
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
      const outcome = await runTurn(
        {
          db,
          client: turnClient,
          now: Date.now,
          context,
          // Built per request, and NTFY_TOPIC read at call time rather than
          // at module scope — the same reason chatClient() is deferred: a
          // configuration problem should fail the request that needed it,
          // not the module import that also serves the 401 and 400 paths.
          alert: conversationAlerter({
            topic: process.env.NTFY_TOPIC,
            fetch: globalThis.fetch,
            db,
            now: Date.now,
          }),
          authorSpec: (proposeInput) =>
            authorSpecImpl({ db, client: turnClient, now: Date.now, context }, proposeInput),
        },
        {
          accountId: session.account_id,
          sessionId: sessionId!,
          body,
          signal: request.signal,
          onText: (text) => {
            // A client that has gone away makes enqueue throw. The turn's own
            // abort path has already decided what to persist; this just keeps
            // the rejection from surfacing as an unhandled error.
            if (!request.signal.aborted) controller.enqueue(line({ t: text }))
          },
        },
      )

      // The terminal line is what tells the browser the reply is complete and
      // therefore saved. Its ABSENCE is the interrupted case — see the panel.
      // Gated on 'completed' specifically, not on "not an error": 'empty' is
      // also a turn with no assistant row, so it must not emit this line
      // either. Any new outcome kind that does not append a row must stay
      // outside this branch.
      if (outcome.kind === 'completed' && !request.signal.aborted) {
        controller.enqueue(line({ done: true }))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
