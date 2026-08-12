import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript } from '@/lib/db/appendOnly'
import { CONVERSATION_GAP_MS, conversationIdFor } from '@/lib/chat/conversation'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-conv-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function write(accountId: number, conversationId: string, at: number) {
  appendTranscript(db, {
    accountId,
    sessionId: 'sess',
    conversationId,
    promptSha: 'sha',
    role: 'user',
    body: 'hi',
    at,
  })
}

describe('conversationIdFor', () => {
  it('mints a fresh id for an account with no history', () => {
    const ref = conversationIdFor(db, 1, 1_000)
    expect(ref.id).toMatch(/^[0-9a-f]{32}$/)
    expect(ref.started).toBe(true)
  })

  it('reuses the last id inside the gap', () => {
    write(1, 'conv-a', 1_000)
    const ref = conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS)
    expect(ref.id).toBe('conv-a')
    expect(ref.started).toBe(false)
  })

  it('mints a fresh id past the gap', () => {
    write(1, 'conv-a', 1_000)
    const ref = conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS + 1)
    expect(ref.id).not.toBe('conv-a')
    expect(ref.id).toMatch(/^[0-9a-f]{32}$/)
    expect(ref.started).toBe(true)
  })

  it('treats exactly the gap as still the same conversation', () => {
    // The boundary is "> 30 minutes", so 30:00.000 exactly stays. Pinned
    // because an off-by-one here silently re-cuts every conversation in the
    // retention analysis, and the rows are not rewritable afterwards. Now
    // also the boundary the step-3 alert fires on, so an off-by-one is a
    // phone that buzzes at the wrong moment as well.
    write(1, 'conv-a', 0)
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS).id).toBe('conv-a')
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS).started).toBe(false)
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS + 1).id).not.toBe('conv-a')
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS + 1).started).toBe(true)
  })

  it('does not borrow another account\'s conversation', () => {
    write(2, 'conv-other', 1_000)
    const ref = conversationIdFor(db, 1, 1_100)
    expect(ref.id).not.toBe('conv-other')
    // Account 1 has never written, so this is a start even though account 2
    // is mid-conversation. Two friends chatting at once must alert twice.
    expect(ref.started).toBe(true)
  })

  it('is 30 minutes, matching the step-3 alert boundary', () => {
    expect(CONVERSATION_GAP_MS).toBe(30 * 60 * 1000)
  })
})
