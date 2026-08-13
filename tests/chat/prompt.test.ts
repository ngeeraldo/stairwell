import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_PROMPT,
  MOCKUP_PROMPT,
  SPEC_PROMPT,
  loadPrompt,
  loadPromptAtPath,
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
    // loadPromptAtPath, not loadPrompt: loadPrompt only ever resolves a bare
    // name under platform/prompts (via promptPath's traversal guard) — it
    // does not accept an absolute path. loadPromptAtPath is the tests' own
    // entry point for hashing an arbitrary temp file.
    const p = join(dir, 'p.md')
    writeFileSync(p, 'hello prompt')
    const { text, sha } = loadPromptAtPath(p)
    expect(text).toBe('hello prompt')
    expect(sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('gives the same sha for the same bytes', () => {
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeFileSync(a, 'identical')
    writeFileSync(b, 'identical')
    expect(loadPromptAtPath(a).sha).toBe(loadPromptAtPath(b).sha)
  })

  it('changes the sha when a single byte changes', () => {
    // The point of a content hash over a version label: a quiet edit cannot
    // pass itself off as the version that came before it.
    const p = join(dir, 'p.md')
    writeFileSync(p, 'version one')
    const before = loadPromptAtPath(p).sha
    writeFileSync(p, 'version onE')
    expect(loadPromptAtPath(p).sha).not.toBe(before)
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
    //
    // Named literally rather than via AGENT_PROMPT: AGENT_PROMPT now points
    // at agent-v2.md (this is the commit that flips it), so comparing
    // AGENT_PROMPT against a separate 'agent-v2.md' literal would compare a
    // file against itself and assert nothing about agent-v1.md.
    const shas = ['agent-v1.md', 'agent-v2.md', SPEC_PROMPT].map(
      (n) => loadPrompt(n).sha,
    )
    expect(new Set(shas).size).toBe(3)
  })

  it('never mentions an un-enabled Plaid product without disclaiming it, in ANY prompt', () => {
    // architecture-overview.md section 3: Investments and Liabilities are NOT
    // enabled, and line 98 requires checking before promising a panel. This
    // covers spec-v1.md/spec-v2.md too, which is the call that actually
    // writes the panels — a panel naming an un-enabled product is a promise
    // to a friend that step 6 cannot keep.
    //
    // v2/v3 changed strategy from v1: instead of staying silent about
    // investments/liabilities, agent-v3.md and spec-v2.md name them
    // explicitly so the model knows the boundary rather than guessing at it
    // ("Investments and liabilities are not connected — ... an open_question,
    // not a panel"). A bare word-forbid can no longer tell that apart from
    // an actual promise, so this checks every match has a nearby "not" —
    // disclaiming, not promising. A term named without one still fails.
    for (const name of [AGENT_PROMPT, 'agent-v2.md', SPEC_PROMPT]) {
      const { text } = loadPrompt(name)
      for (const forbidden of FORBIDDEN_TERMS) {
        const global = new RegExp(forbidden.source, forbidden.flags.includes('g') ? forbidden.flags : `${forbidden.flags}g`)
        for (const match of text.matchAll(global)) {
          const start = Math.max(0, (match.index ?? 0) - 80)
          const end = (match.index ?? 0) + match[0].length + 80
          const window = text.slice(start, end)
          expect(window, `${name}: "${match[0]}" appears without a nearby disclaimer`).toMatch(/\bnot\b/i)
        }
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

  it('refuses an absolute path too — the guard has no bypass', () => {
    // loadPrompt used to accept an absolute path as-is (`isAbsolute(name) ?
    // name : promptPath(name)`), which meant promptPath's containment check
    // never ran for one. That escape hatch existed only so tests could hash
    // temp files, but every production call site passes a module constant —
    // an absolute path reaching loadPrompt is never legitimate input, only
    // ever a bug or an attacker-controlled value. A file outside
    // platform/prompts, addressed absolutely, must still be refused.
    const outside = join(dir, 'outside-prompts.md')
    writeFileSync(outside, 'should never be readable via loadPrompt')
    expect(() => loadPrompt(outside)).toThrow(/Path traversal not allowed/)
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

  it('names prompt files that exist on disk', () => {
    for (const name of [AGENT_PROMPT, SPEC_PROMPT, MOCKUP_PROMPT]) {
      expect(existsSync(promptPath(name))).toBe(true)
    }
  })

  it('keeps superseded prompts on disk, because rows point at their hashes', () => {
    // prompt_sha is a content hash stamped on every transcript and spec row.
    // Deleting a superseded prompt orphans every row that names it.
    for (const name of ['agent-v2.md', 'spec-v1.md']) {
      expect(existsSync(promptPath(name))).toBe(true)
    }
  })
})
