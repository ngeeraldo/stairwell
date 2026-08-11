// tests/chat/turn.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { readTranscript } from '@/lib/db/appendOnly'
import type { ChatClient } from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-turn-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A client that replies with fixed chunks and reports usage as it goes. */
function fakeClient(chunks: string[]): ChatClient {
  return {
    async stream({ onText, onUsage }) {
      onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
      for (const c of chunks) {
        onText(c)
        onUsage({ output: 7 })
      }
      return { input: 100, output: 7, cache_read: 40, cache_creation: 0 }
    },
  }
}

/** A client that streams one chunk, then the caller aborts. */
function abortingClient(controller: AbortController): ChatClient {
  return {
    async stream({ onText, onUsage, signal }) {
      onUsage({ input: 100, cache_read: 0, cache_creation: 0 })
      onText('half a rep')
      onUsage({ output: 3 })
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      // `signal` is deliberately unused here; runTurn reads signal.aborted.
      void signal
    },
  }
}

function failingClient(): ChatClient {
  return {
    async stream() {
      throw new Error('rate limited')
    },
  }
}

function metrics() {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string | null
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data ?? 'null') }))
}

const input = (over: Partial<Parameters<typeof runTurn>[1]> = {}) => ({
  accountId: 1,
  sessionId: 'sess-1',
  body: 'what should I watch?',
  signal: new AbortController().signal,
  onText: () => {},
  ...over,
})

describe('runTurn — completion', () => {
  it('appends the user turn and then the assistant turn', async () => {
    const deps = { db, client: fakeClient(['Keep an ', 'eye on rent.']), now: () => 1_000 }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('completed')
    const rows = readTranscript(db, 1)
    expect(rows.map((r) => [r.role, r.body])).toEqual([
      ['user', 'what should I watch?'],
      ['assistant', 'Keep an eye on rent.'],
    ])
  })

  it('stamps both rows with the same conversation_id and the prompt sha', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000 }
    await runTurn(deps, input())

    const rows = readTranscript(db, 1)
    expect(rows[0]!.conversation_id).toBe(rows[1]!.conversation_id)
    expect(rows[0]!.session_id).toBe('sess-1')
    expect(rows[0]!.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
    expect(rows[1]!.prompt_sha).toBe(rows[0]!.prompt_sha)
  })

  it('logs one chat_turn metric carrying all four counters', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000 }
    await runTurn(deps, input())

    expect(metrics()).toHaveLength(1)
    const [m] = metrics()
    expect(m!.event).toBe('chat_turn')
    expect(m!.data).toMatchObject({
      input: 100,
      output: 7,
      cache_read: 40,
      cache_creation: 0,
      model: 'claude-opus-5',
      effort: 'medium',
      context: 'interview',
    })
    expect(m!.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('streams text to the caller as it arrives', async () => {
    const seen: string[] = []
    const deps = { db, client: fakeClient(['a', 'b']), now: () => 1_000 }
    await runTurn(deps, input({ onText: (t: string) => seen.push(t) }))
    expect(seen).toEqual(['a', 'b'])
  })

  it('starts a new conversation after the gap and keeps one inside it', async () => {
    const client = fakeClient(['ok'])
    await runTurn({ db, client, now: () => 0 }, input())
    await runTurn({ db, client, now: () => 60_000 }, input())
    await runTurn({ db, client, now: () => 60_000 + 31 * 60 * 1000 }, input())

    const ids = readTranscript(db, 1).map((r) => r.conversation_id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(ids[3]) // first exchange and second exchange
    expect(ids[4]).not.toBe(ids[0]) // third, past the gap
  })
})

describe('runTurn — abort', () => {
  it('appends NO assistant row', async () => {
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000 }
    const outcome = await runTurn(deps, input({ signal: controller.signal }))

    expect(outcome.kind).toBe('aborted')
    const rows = readTranscript(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('user')
  })

  it('logs stream_aborted with the counters known so far, not zeros', async () => {
    // The whole reason usage is reported during the stream rather than only at
    // the end: an aborted turn still cost input tokens, and a cost log that
    // records zero for it is fiction.
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000 }
    await runTurn(deps, input({ signal: controller.signal }))

    const [m] = metrics()
    expect(m!.event).toBe('stream_aborted')
    expect(m!.data).toMatchObject({ input: 100, output: 3, context: 'interview' })
    expect(m!.data.delivered_chars).toBe('half a rep'.length)
  })
})

describe('runTurn — API error', () => {
  it('appends no assistant row and logs chat_error, not stream_aborted', async () => {
    const deps = { db, client: failingClient(), now: () => 1_000 }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('error')
    expect(readTranscript(db, 1)).toHaveLength(1)
    const [m] = metrics()
    expect(m!.event).toBe('chat_error')
    expect(m!.data).toMatchObject({ kind: 'Error', context: 'interview' })
  })
})
