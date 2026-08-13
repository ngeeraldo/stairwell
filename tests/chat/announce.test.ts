// tests/chat/announce.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { readTranscript } from '@/lib/db/appendOnly'
import { announce } from '@/lib/chat/announce'

let dir: string
let db: PlatformDb
let accountId: number

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-announce-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  accountId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'TEST-DEV-TWO',
  })
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('announce', () => {
  it('appends an assistant row the friend sees next time they open the page', () => {
    announce(db, { accountId, body: 'Your streak panel is live TEST.', at: 1 })
    expect(readTranscript(db, accountId).at(-1)).toMatchObject({
      role: 'assistant',
      body: 'Your streak panel is live TEST.',
    })
  })

  it('stamps prompt_sha "operator", so a human message is never mistaken for model output', () => {
    // Every other transcript row's prompt_sha is a content hash of the prompt
    // that produced it. This row had no prompt: a person typed it. The log of
    // record has to be able to tell those apart, permanently.
    //
    // Pinned against the LITERAL string, not the imported OPERATOR_SHA
    // constant — comparing against the constant would make this assertion a
    // tautology that passes no matter what value the constant holds. The
    // exact spelling is the thing every other consumer (and a human reading
    // the row later) relies on.
    announce(db, { accountId, body: 'x', at: 2 })
    expect(readTranscript(db, accountId).at(-1)!.prompt_sha).toBe('operator')
  })

  it('refuses an empty body', () => {
    // An empty body breaks every later turn for that account, forever
    // (lib/chat/history.ts). transcripts cannot be corrected.
    const before = readTranscript(db, accountId).length
    expect(() => announce(db, { accountId, body: '   ', at: 3 })).toThrow()
    expect(readTranscript(db, accountId)).toHaveLength(before)
  })

  it('joins the conversation rather than starting a stray one', () => {
    const existingConversationId = readTranscript(db, accountId).at(-1)!.conversation_id
    announce(db, { accountId, body: 'Still the same conversation TEST.', at: 4 })
    expect(readTranscript(db, accountId).at(-1)!.conversation_id).toBe(existingConversationId)
  })
})
