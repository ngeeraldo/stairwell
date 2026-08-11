import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROMPT_PATH, loadPrompt } from '@/lib/chat/prompt'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-prompt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadPrompt', () => {
  it('returns the file text and a 12-hex-char sha', () => {
    const p = join(dir, 'p.md')
    writeFileSync(p, 'hello prompt')
    const { text, sha } = loadPrompt(p)
    expect(text).toBe('hello prompt')
    expect(sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('gives the same sha for the same bytes', () => {
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeFileSync(a, 'identical')
    writeFileSync(b, 'identical')
    expect(loadPrompt(a).sha).toBe(loadPrompt(b).sha)
  })

  it('changes the sha when a single byte changes', () => {
    // The point of a content hash over a version label: a quiet edit cannot
    // pass itself off as the version that came before it.
    const p = join(dir, 'p.md')
    writeFileSync(p, 'version one')
    const before = loadPrompt(p).sha
    writeFileSync(p, 'version onE')
    expect(loadPrompt(p).sha).not.toBe(before)
  })

  it('loads the real shipped prompt and it is not empty', () => {
    const { text, sha } = loadPrompt(PROMPT_PATH)
    expect(text.trim().length).toBeGreaterThan(0)
    expect(sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('does not promise Plaid products that are not enabled', () => {
    // architecture-overview.md section 3: Investments and Liabilities are NOT
    // enabled, and line 98 requires checking before promising a panel. A
    // prompt that mentions them will make promises the product cannot keep,
    // to a real friend, in the first conversation.
    const { text } = loadPrompt(PROMPT_PATH)
    expect(text).not.toMatch(/\binvestments?\b/i)
    expect(text).not.toMatch(/\bliabilit(y|ies)\b/i)
  })
})
