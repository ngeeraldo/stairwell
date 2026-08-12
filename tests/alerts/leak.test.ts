// tests/alerts/leak.test.ts
//
// The one test that would catch message text reaching ntfy.sh.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { conversationAlerter } from '@/lib/alerts/ntfy'
import { CHAT_MODEL, type ChatClient } from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

/** Loudly fake, and unlike anything the alert legitimately sends. */
const SENTINEL = 'PINEAPPLE-CANARY-TEST-9471'

let dir: string
let db: PlatformDb
let accountId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-leak-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  accountId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'pw',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('no message text reaches ntfy.sh', () => {
  it('sends only the slug line, for a turn whose text is a sentinel', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return new Response('1', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const send = conversationAlerter({
      topic: 'topic-abc',
      fetch,
      db,
      now: () => 1_000,
    })

    // The alerter is fire-and-forget, so runTurn will not await it. Holding
    // the promise here is the only way this test can assert on a settled
    // send rather than on a race.
    const pending: Promise<void>[] = []

    const client: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        onUsage({ input: 1, cache_read: 0, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText(`reply mentioning ${SENTINEL}`)
        onUsage({ output: 1 })
        return {
          usage: { input: 1, output: 1, cache_read: 0, cache_creation: 0 },
          stop_reason: 'end_turn',
          served: { model_served: CHAT_MODEL, fallback_fired: false },
        }
      },
    }

    await runTurn(
      {
        db,
        client,
        now: () => 1_000,
        context: 'interview',
        alert: (id) => {
          pending.push(send(id))
        },
      },
      {
        accountId,
        sessionId: 'sess-1',
        body: `please remember ${SENTINEL}`,
        signal: new AbortController().signal,
        onText: () => {},
      },
    )
    await Promise.all(pending)

    // BOTH halves are required. Asserting only "the sentinel is absent" would
    // pass in a world where nothing was sent at all — a test that cannot
    // fail, which this project has shipped once already.
    expect(seen).toHaveLength(1)

    const wire = JSON.stringify({
      url: seen[0]!.url,
      body: seen[0]!.init?.body,
      headers: seen[0]!.init?.headers ?? null,
      method: seen[0]!.init?.method,
    })
    expect(wire).not.toContain(SENTINEL)
    expect(seen[0]!.init?.body).toBe('devtwo started a conversation')

    // The sentinel really was in play — otherwise the assertion above is
    // vacuous for a second reason: a turn that never carried it.
    const bodies = (
      db
        .prepare('SELECT body FROM transcripts ORDER BY id')
        .all() as { body: string }[]
    ).map((r) => r.body)
    expect(bodies.join('\n')).toContain(SENTINEL)
  })
})
