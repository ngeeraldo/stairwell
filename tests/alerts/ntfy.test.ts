// tests/alerts/ntfy.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { conversationAlerter, NTFY_ORIGIN } from '@/lib/alerts/ntfy'

let dir: string
let db: PlatformDb
let userId: number
let adminId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-ntfy-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  userId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'pw',
  })
  adminId = await createAccount(db, {
    slug: 'nico',
    role: 'admin',
    password: 'pw',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

type Call = { url: string; init: RequestInit | undefined }

/** A fetch that records what it was asked to do and answers as told. */
function fakeFetch(calls: Call[], answer: () => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return answer()
  }) as unknown as typeof globalThis.fetch
}

const ok = () => new Response('1', { status: 200 })

function metrics() {
  return db
    .prepare('SELECT account_id, event, data FROM metrics ORDER BY id')
    .all() as { account_id: number | null; event: string; data: string }[]
}

function alerter(over: Partial<Parameters<typeof conversationAlerter>[0]> = {}) {
  return conversationAlerter({
    topic: 'topic-abc',
    fetch: fakeFetch([], ok),
    db,
    now: () => 1_000,
    ...over,
  })
}

describe('conversationAlerter', () => {
  it('posts the slug line to the topic and records alert_sent', async () => {
    const calls: Call[] = []
    await alerter({ fetch: fakeFetch(calls, ok) })(userId)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${NTFY_ORIGIN}/topic-abc`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe('devtwo started a conversation')
    // A send with no timeout holds a socket for the life of the process, and
    // nothing awaits this call, so nobody would ever notice.
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)

    expect(metrics()).toHaveLength(1)
    expect(metrics()[0]!.event).toBe('alert_sent')
    expect(metrics()[0]!.account_id).toBe(userId)
    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      status: 200,
    })
  })

  it('sends nothing and records nothing for an admin account', async () => {
    const calls: Call[] = []
    await alerter({ fetch: fakeFetch(calls, ok) })(adminId)

    expect(calls).toHaveLength(0)
    // Suppression is not a failure. A metric here would make a deliberate
    // silence look like a broken alerter in the very log that exists to tell
    // those two apart.
    expect(metrics()).toHaveLength(0)
  })

  it('sends nothing for an account id that does not exist', async () => {
    const calls: Call[] = []
    await alerter({ fetch: fakeFetch(calls, ok) })(9_999)

    expect(calls).toHaveLength(0)
    expect(metrics()).toHaveLength(0)
  })

  it('records no_topic without attempting a request when the topic is unset', async () => {
    const calls: Call[] = []
    await alerter({ topic: undefined, fetch: fakeFetch(calls, ok) })(userId)

    expect(calls).toHaveLength(0)
    expect(metrics()).toHaveLength(1)
    expect(metrics()[0]!.event).toBe('alert_failed')
    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'no_topic',
      status: null,
    })
  })

  it('treats a whitespace-only topic as unset', async () => {
    const calls: Call[] = []
    await alerter({ topic: '   ', fetch: fakeFetch(calls, ok) })(userId)

    expect(calls).toHaveLength(0)
    expect(JSON.parse(metrics()[0]!.data).reason).toBe('no_topic')
  })

  it('records http with the status on a non-2xx response', async () => {
    await alerter({
      fetch: fakeFetch([], () => new Response('nope', { status: 429 })),
    })(userId)

    expect(metrics()).toHaveLength(1)
    expect(metrics()[0]!.event).toBe('alert_failed')
    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'http',
      status: 429,
    })
  })

  it('records network when fetch rejects', async () => {
    await alerter({
      fetch: fakeFetch([], () => {
        throw new Error('getaddrinfo ENOTFOUND ntfy.sh')
      }),
    })(userId)

    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'network',
      status: null,
    })
  })

  it('records timeout separately from network', async () => {
    // What AbortSignal.timeout actually raises. Kept distinct because "ntfy.sh
    // is slow" and "the droplet has no egress" are different problems with
    // different fixes (design spec §4.4).
    await alerter({
      fetch: fakeFetch([], () => {
        throw new DOMException('timed out', 'TimeoutError')
      }),
    })(userId)

    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'timeout',
      status: null,
    })
  })

  it('confines a failing metric write to the metric, and still resolves', async () => {
    // A rejection from here is an unhandled rejection: nothing awaits the
    // alerter. Node's default for that is a process-level event, which is the
    // one thing an alert must never cause (design spec §4.3).
    //
    // The `resolves` half alone would pass even with every inner guard
    // deleted, because the outer backstop catches everything — so it is not
    // on its own evidence of anything. The load-bearing assertion is that the
    // SEND still happened: a broken metrics table costs the metric and
    // nothing else.
    const calls: Call[] = []
    const brokenDb = {
      prepare(sql: string) {
        if (sql.startsWith('INSERT INTO metrics')) {
          return {
            run() {
              throw new Error('database is locked')
            },
          }
        }
        return db.prepare(sql)
      },
    } as unknown as PlatformDb

    const send = conversationAlerter({
      topic: 'topic-abc',
      fetch: fakeFetch(calls, ok),
      db: brokenDb,
      now: () => 1_000,
    })
    await expect(send(userId)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.body).toBe('devtwo started a conversation')
  })

  it('never rejects when the account lookup itself fails', async () => {
    const closed = openPlatformDb(join(dir, 'closed.db'))
    closed.close()
    const send = conversationAlerter({
      topic: 'topic-abc',
      fetch: fakeFetch([], ok),
      db: closed,
      now: () => 1_000,
    })
    await expect(send(userId)).resolves.toBeUndefined()
  })

  it('percent-encodes a topic so it cannot escape its path segment', async () => {
    const calls: Call[] = []
    await alerter({ topic: 'a/b', fetch: fakeFetch(calls, ok) })(userId)
    expect(calls[0]!.url).toBe(`${NTFY_ORIGIN}/a%2Fb`)
  })
})
