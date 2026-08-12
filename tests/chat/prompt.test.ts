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

/**
 * Plaid products/synonyms this project does not enable (architecture-overview.md
 * section 3). Named once so the "does it flag a rewrite" test below cannot drift
 * from the list the real assertion uses.
 *
 * The 401(k) pattern: `[-(]` is a character class matching either a literal
 * hyphen or a literal `(` — neither needs escaping inside `[...]`. `\b` sits
 * right after `k`, before the optional trailing `\)?`, because a `\b` placed
 * after an already-consumed `)` fails: `)` is a non-word char, so if the
 * following character is also non-word (space, end of string), there is no
 * word/non-word transition for `\b` to match. Checking the boundary at `k`
 * itself, then optionally swallowing a trailing `)`, sidesteps that.
 */
const FORBIDDEN_TERMS = [
  /\binvestments?\b/i,
  /\bliabilit(y|ies)\b/i,
  /\bbrokerages?\b/i,
  /\bportfolios?\b/i,
  /\b401\s?[-(]?\s?k\b\)?/i,
  /\bmortgages?\b/i,
  /\bloans?\b/i,
]

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
    //
    // The synonyms matter as much as the product names. This test exists to
    // survive a substantive rewrite of agent-v1.md, and a rewrite that says
    // "brokerage" or "mortgage" instead of "investments" or "liabilities"
    // makes exactly the same promise while passing a two-word check.
    const { text } = loadPrompt(PROMPT_PATH)
    for (const forbidden of FORBIDDEN_TERMS) {
      expect(text).not.toMatch(forbidden)
    }
  })

  it('flags 401(k) — the parenthesised form a rewrite is most likely to use', () => {
    // Ledger item 11: the old pattern (/\b401\s?-?\s?k\b/i) matched "401k",
    // "401-k", and "401 k" but not "401(k)", which is how the term is almost
    // always written. Proving the widened pattern matches directly, rather
    // than trusting that the real prompt still passes (it contains none of
    // these terms today, so it would pass either way and prove nothing).
    const sample = 'We can help you track your 401(k) balance.'
    const matched = FORBIDDEN_TERMS.some((pattern) => pattern.test(sample))
    expect(matched).toBe(true)
  })
})
