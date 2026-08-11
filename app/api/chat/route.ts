import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import { anthropicClient } from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

const encoder = new TextEncoder()
const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)

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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const outcome = await runTurn(
        { db, client: anthropicClient(), now: Date.now },
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
