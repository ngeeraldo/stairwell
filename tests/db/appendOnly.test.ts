// tests/db/appendOnly.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { openPlatformDb } from '@/lib/db/platform'
import {
  appendMetric,
  appendTranscript,
  lastTranscriptRow,
  readTranscript,
} from '@/lib/db/appendOnly'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('append-only tables', () => {
  it('accepts appends and reads them back', () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
    expect(readTranscript(db, 1)).toHaveLength(1)
  })

  it('refuses UPDATE on transcripts', () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
    expect(() =>
      db.prepare("UPDATE transcripts SET body = 'edited'").run(),
    ).toThrow(/append-only/)
  })

  it('refuses DELETE on transcripts', () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
    expect(() => db.prepare('DELETE FROM transcripts').run()).toThrow(
      /append-only/,
    )
  })

  it('round-trips every transcript column', () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
    const [row] = readTranscript(db, 1)
    expect(row).toMatchObject({
      account_id: 1,
      session_id: 'sess-1',
      conversation_id: 'conv-1',
      prompt_sha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
  })

  it('lastTranscriptRow returns the newest row for the account, and only that account', () => {
    const base = { sessionId: 's', conversationId: 'c', promptSha: 'p', role: 'user' }
    appendTranscript(db, { ...base, accountId: 1, body: 'older', at: 100 })
    appendTranscript(db, { ...base, accountId: 1, body: 'newer', at: 200 })
    appendTranscript(db, { ...base, accountId: 2, body: 'other account', at: 300 })
    expect(lastTranscriptRow(db, 1)?.body).toBe('newer')
    expect(lastTranscriptRow(db, 99)).toBeUndefined()
  })

  it('appendMetric writes account_id, event, and at to the correct columns', () => {
    appendMetric(db, { accountId: 7, event: 'session_open', at: 12345 })
    const rows = db
      .prepare('SELECT account_id, event, at FROM metrics')
      .all() as { account_id: number; event: string; at: number }[]
    expect(rows).toEqual([{ account_id: 7, event: 'session_open', at: 12345 }])
  })

  it('appendMetric stores data as JSON and reads back as null when omitted', () => {
    appendMetric(db, {
      accountId: 7,
      event: 'chat_turn',
      at: 1,
      data: { input: 10, output: 20 },
    })
    appendMetric(db, { accountId: 7, event: 'session_open', at: 2 })
    const rows = db
      .prepare('SELECT event, data FROM metrics ORDER BY at')
      .all() as { event: string; data: string | null }[]
    expect(JSON.parse(rows[0]!.data!)).toEqual({ input: 10, output: 20 })
    expect(rows[1]!.data).toBeNull()
  })

  it('refuses UPDATE on metrics', () => {
    db.prepare(
      "INSERT INTO metrics (account_id, event, at) VALUES (1, 'open', 100)",
    ).run()
    expect(() =>
      db.prepare("UPDATE metrics SET event = 'edited'").run(),
    ).toThrow(/append-only/)
  })

  it('refuses DELETE on metrics', () => {
    db.prepare(
      "INSERT INTO metrics (account_id, event, at) VALUES (1, 'open', 100)",
    ).run()
    expect(() => db.prepare('DELETE FROM metrics').run()).toThrow(/append-only/)
  })

  it('has no UPDATE, DELETE, or DROP against those tables anywhere in lib/db', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk('lib/db')
    expect(files.length).toBeGreaterThan(0)

    // reshape.ts is the ONE deliberate exception: it drops a sacred table,
    // but only after proving it holds zero rows, and tests/db/reshape.test.ts
    // pins that it throws rather than drops when rows exist. Carved out by
    // name so the exception is visible here rather than being a hole in the
    // pattern nobody notices.
    const exempt = join('lib', 'db', 'reshape.ts')
    const offending =
      /(UPDATE|DELETE\s+FROM|DROP\s+TABLE)\s+(transcripts|metrics)\b/i
    for (const f of files) {
      if (f === exempt) continue
      expect(readFileSync(f, 'utf8'), `${f} mutates a sacred table`).not.toMatch(
        offending,
      )
    }
    // And the carve-out must not be silently unreachable: if reshape.ts is
    // renamed or removed, this fails rather than quietly exempting nothing.
    expect(files).toContain(exempt)
  })
})
