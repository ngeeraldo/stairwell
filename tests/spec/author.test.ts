// tests/spec/author.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { readSpecs } from '@/lib/db/specs'
import { CHAT_MODEL, ChatStreamError, type ChatClient } from '@/lib/chat/client'
import { authorSpec } from '@/lib/spec/author'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-author-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const GOOD = {
  title: 'Eating out and the car fund',
  summary: 'So mornings stop being a surprise.',
  background: 'Checks the banking app most days.',
  panels: [{ name: 'Eating out', shows: 'This month', why: 'Said so', source: 'plaid' }],
  manual_logging: [],
  open_questions: [],
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

const USAGE = { input: 50, output: 900, cache_read: 0, cache_creation: 0 }
const SERVED = { model_served: CHAT_MODEL, fallback_fired: false }

function client(over: Partial<ChatClient> = {}): ChatClient {
  return {
    async stream() {
      throw new Error('unused')
    },
    async propose() {
      return { input: GOOD, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
    },
    ...over,
  } as ChatClient
}

const INPUT = {
  accountId: 1,
  conversationId: 'conv-1',
  signal: new AbortController().signal,
}

const deps = (c: ChatClient) => ({
  db,
  client: c,
  now: () => 5_000,
  context: 'interview' as const,
})

function metrics(): { event: string; data: Record<string, unknown> }[] {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data) }))
}

describe('authorSpec', () => {
  it('inserts one spec and records spec_proposed', async () => {
    const proposal = await authorSpec(deps(client()), INPUT)

    expect(proposal!.version).toBe(1)
    expect(proposal!.payload.title).toBe('Eating out and the car fund')
    expect(proposal!.mockup_html).toContain('COFFEE PALACE TEST')

    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conversation_id).toBe('conv-1')

    const [row] = metrics()
    expect(row!.event).toBe('spec_proposed')
    expect(row!.data.spec_id).toBe(proposal!.id)
    expect(row!.data.version).toBe(1)
    expect(row!.data.output).toBe(900)
    expect(row!.data.context).toBe('interview')
    // The authoring prompt's sha, NOT the interview prompt's.
    expect(row!.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('writes NO spec and records spec_error when the call fails', async () => {
    const failing = client({
      async propose() {
        throw new ChatStreamError(
          { kind: 'rate_limit', status: 429, type: 'rate_limit_error' },
          'slow down',
        )
      },
    })
    expect(await authorSpec(deps(failing), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('rate_limit')
    expect(row!.data.status).toBe(429)
  })

  it('writes NO spec and records spec_error when the payload is malformed', async () => {
    // A schema-valid REQUEST does not guarantee a schema-valid RESPONSE
    // reaching an append-only table. The validator is the last gate.
    const bad = client({
      async propose() {
        return {
          input: { ...GOOD, panels: [] },
          usage: USAGE,
          stop_reason: 'end_turn',
          served: SERVED,
        }
      },
    })
    expect(await authorSpec(deps(bad), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    expect(metrics()[0]!.event).toBe('spec_error')
  })

  it('writes NO spec and records spec_aborted when the friend walks away', async () => {
    const controller = new AbortController()
    const aborting = client({
      async propose() {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })
    const outcome = await authorSpec(deps(aborting), {
      ...INPUT,
      signal: controller.signal,
    })
    expect(outcome).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    expect(metrics()[0]!.event).toBe('spec_aborted')
  })

  it('numbers a second proposal v2 and leaves the first in the record', async () => {
    await authorSpec(deps(client()), INPUT)
    const second = await authorSpec(deps(client()), INPUT)
    expect(second!.version).toBe(2)
    expect(readSpecs(db, 1)).toHaveLength(2)
  })

  it('never writes the synthetic authoring message to transcripts', async () => {
    // "Write the spec now." is a call-time construct, not a thing the friend
    // said. Anything reading the transcript must see only what happened.
    await authorSpec(deps(client()), INPUT)
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({
      n: 0,
    })
  })
})
