// tests/db/appendOnly.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'

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
    appendTranscript(db, { accountId: 1, role: 'user', body: 'hello', at: 100 })
    expect(readTranscript(db, 1)).toHaveLength(1)
  })

  it('refuses UPDATE on transcripts', () => {
    appendTranscript(db, { accountId: 1, role: 'user', body: 'hello', at: 100 })
    expect(() =>
      db.prepare("UPDATE transcripts SET body = 'edited'").run(),
    ).toThrow(/append-only/)
  })

  it('refuses DELETE on transcripts', () => {
    appendTranscript(db, { accountId: 1, role: 'user', body: 'hello', at: 100 })
    expect(() => db.prepare('DELETE FROM transcripts').run()).toThrow(
      /append-only/,
    )
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

  it('has no UPDATE or DELETE against those tables anywhere in lib/db', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk('lib/db')
    const offending = /(UPDATE|DELETE\s+FROM)\s+(transcripts|metrics)\b/i
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), `${f} mutates a sacred table`).not.toMatch(
        offending,
      )
    }
  })
})
