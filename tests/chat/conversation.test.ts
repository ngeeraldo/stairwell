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
    const id = conversationIdFor(db, 1, 1_000)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('reuses the last id inside the gap', () => {
    write(1, 'conv-a', 1_000)
    expect(conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS)).toBe('conv-a')
  })

  it('mints a fresh id past the gap', () => {
    write(1, 'conv-a', 1_000)
    const id = conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS + 1)
    expect(id).not.toBe('conv-a')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('treats exactly the gap as still the same conversation', () => {
    // The boundary is "> 30 minutes", so 30:00.000 exactly stays. Pinned
    // because an off-by-one here silently re-cuts every conversation in the
    // retention analysis, and the rows are not rewritable afterwards.
    write(1, 'conv-a', 0)
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS)).toBe('conv-a')
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS + 1)).not.toBe('conv-a')
  })

  it('does not borrow another account\'s conversation', () => {
    write(2, 'conv-other', 1_000)
    expect(conversationIdFor(db, 1, 1_100)).not.toBe('conv-other')
  })

  it('is 30 minutes, matching the step-3 alert boundary', () => {
    expect(CONVERSATION_GAP_MS).toBe(30 * 60 * 1000)
  })
})
