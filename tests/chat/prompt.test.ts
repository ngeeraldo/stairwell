import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_PROMPT,
  SPEC_PROMPT,
  loadPrompt,
  promptPath,
} from '@/lib/chat/prompt'

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

  it('loads a shipped prompt by bare name and it is not empty', () => {
    for (const name of [AGENT_PROMPT, SPEC_PROMPT, 'agent-v2.md']) {
      const { text, sha } = loadPrompt(name)
      expect(text.trim().length, name).toBeGreaterThan(0)
      expect(sha, name).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it('defaults to the agent prompt when given no name', () => {
    expect(loadPrompt().sha).toBe(loadPrompt(AGENT_PROMPT).sha)
  })

  it('gives every shipped prompt a distinct sha', () => {
    // The whole point of a per-file content hash: two prompts that share a
    // sha would be indistinguishable in the transcript and metrics rows.
    const shas = [AGENT_PROMPT, 'agent-v2.md', SPEC_PROMPT].map(
      (n) => loadPrompt(n).sha,
    )
    expect(new Set(shas).size).toBe(3)
  })

  it('does not promise Plaid products that are not enabled, in ANY prompt', () => {
    // architecture-overview.md section 3: Investments and Liabilities are NOT
    // enabled, and line 98 requires checking before promising a panel. This
    // now covers spec-v1.md too, which is the call that actually writes the
    // panels — a panel naming an un-enabled product is a promise to a friend
    // that step 6 cannot keep.
    for (const name of [AGENT_PROMPT, 'agent-v2.md', SPEC_PROMPT]) {
      const { text } = loadPrompt(name)
      for (const forbidden of FORBIDDEN_TERMS) {
        expect(text, `${name} matched ${forbidden}`).not.toMatch(forbidden)
      }
    }
  })

  it('resolves a bare name under platform/prompts', () => {
    expect(promptPath('agent-v1.md')).toMatch(
      /platform[/\\]prompts[/\\]agent-v1\.md$/,
    )
  })

  it('prevents path traversal escapes to sensitive files', () => {
    // This project denies reading .env files at the tool layer. A path
    // traversal here would be a way around that boundary. Assert that
    // promptPath throws on traversing names, using ../.env as a test case
    // that would access the project root .env if the guard were deleted.
    expect(() => promptPath('../../.env')).toThrow(/Path traversal not allowed/)
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
