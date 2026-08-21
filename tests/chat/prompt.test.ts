import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AGENT_PROMPT,
  ANNOUNCE_PROMPT,
  MOCKUP_PROMPT,
  MOCKUP_SCREENS_PROMPT,
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
 * Every shipped prompt, discovered from disk rather than enumerated by name.
 * Enumeration is what let a fifth prompt (announce-v1.md) go unchecked by the
 * Plaid-terms sweep below — a name added to lib/chat/prompt.ts is not
 * necessarily added to every test that lists prompts by name. Discovery
 * closes that genus permanently: any prompt that exists gets swept, whether
 * or not a test author remembered to list it.
 */
const PROMPT_DIR = resolve(process.cwd(), 'platform/prompts')
const ALL_SHIPPED_PROMPTS = readdirSync(PROMPT_DIR).filter((f) => f.endsWith('.md'))

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
  /\bliabilit(y|ies)\b/i,
  /\bmortgages?\b/i,
  /\bloans?\b/i,
]

/**
 * WHAT LEFT THIS LIST, AND WHY IT IS NOT A WEAKENING.
 *
 * `investments`, `brokerages`, `portfolios` and `401k` were here because the
 * Investments product was not enabled on the Plaid account. It was enabled on
 * 2026-08-21 and verified against a real item — 13 holdings, 13 securities,
 * and 1171 investment transactions — so a prompt naming them is now telling a
 * friend the truth. Requiring a disclaimer would have forced agent-v10.md to
 * deny a feature that works.
 *
 * The list is not "finance words". It is "products this account cannot serve",
 * and the only ones left are Liabilities — loan and credit-line detail — which
 * is still not enabled. When that changes, these come off too and this comment
 * is what says so.
 *
 * The rule this enforces is unchanged and is the reason the list exists at
 * all: a prompt must never promise a friend something the account cannot
 * deliver. architecture-overview.md §3 and docs/dashboard-build-rules.md §9
 * are the sources of what is enabled.
 */

/**
 * Global-flag twins of FORBIDDEN_TERMS, precomputed once rather than rebuilt
 * per name/per-term inside the nested loop below.
 */
const FORBIDDEN_TERMS_GLOBAL = FORBIDDEN_TERMS.map(
  (p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`),
)

/**
 * What "disclaiming" actually looks like in this project's prompts: "not"
 * (optionally "not yet") immediately followed — allowing only non-letter
 * filler (markdown `**`, spaces, a line-wrap newline+indent) — by a word
 * this project actually uses to say a product is unavailable. A bare `not`
 * is not enough: "investment tracking is not experimental anymore" contains
 * a "not" nowhere near a real disclaimer and must still fail.
 *
 * `[^A-Za-z]{0,20}` rather than `.{0,20}}` is the load-bearing choice: it
 * lets whitespace, punctuation, and newlines through but stops dead at the
 * next real word, so an unrelated clause after "not" can never bridge to a
 * disclaiming verb it doesn't contain.
 */
const DISCLAIM_NEARBY =
  /\bnot\b[^A-Za-z]{0,20}(?:yet\b[^A-Za-z]{0,20})?\b(?:connected|enabled|supported|automatic(?:ally)?|available)\b/i

/** Does a disclaiming phrase sit within `radius` characters of a match? */
function hasNearbyDisclaimer(text: string, index: number, matchLength: number, radius = 80): boolean {
  const start = Math.max(0, index - radius)
  const end = index + matchLength + radius
  return DISCLAIM_NEARBY.test(text.slice(start, end))
}

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

  it('loads the announce prompt and hashes it', () => {
    const loaded = loadPrompt(ANNOUNCE_PROMPT)
    expect(loaded.text).toContain('Saying nothing extra is a complete answer')
    expect(loaded.sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('loads the retired patch prompt and hashes it — spec-v3.md stays on disk', () => {
    // SPEC_PATCH_PROMPT (the exported constant) is gone: there is one
    // authoring path now. spec-v3.md itself is not deleted — prompt_sha on
    // existing spec rows points at it — so it is addressed by literal name
    // here, the same pattern the ANNOUNCE_PROMPT tests below use for
    // announce-v1.md and announce-v2.md.
    const loaded = loadPrompt('spec-v3.md')
    expect(loaded.text).toContain('A PATCH: only what changes')
    expect(loaded.sha).not.toBe(loadPrompt(SPEC_PROMPT).sha)
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

  // A discovery-based sweep has a failure mode enumeration doesn't: it can
  // find nothing and still pass. If PROMPT_DIR pointed at the wrong
  // directory, the .md filter were tightened, or the files moved, the loop
  // in the sweep below would simply not execute — a green suite that checked
  // nothing. tests/users/conventions.test.ts hit this same genus for its own
  // directory sweep ('finds at least one user folder to check' /
  // 'sweeps at least one BUILT dashboard, not only pulled-but-unbuilt
  // folders') and this pair follows that precedent rather than inventing a
  // second pattern for the same problem.
  it('finds at least one prompt file to sweep', () => {
    expect(ALL_SHIPPED_PROMPTS.length).toBeGreaterThan(0)
  })

  // Non-empty alone is not enough: PROMPT_DIR could point at some OTHER
  // directory that happens to contain .md files and this assertion would
  // still pass. Requiring every exported prompt constant to appear in the
  // discovered list proves the sweep found the actual platform/prompts
  // directory and the files that actually ship, not merely some files.
  it('discovers every exported prompt constant, not just some files', () => {
    for (const name of [
      AGENT_PROMPT,
      SPEC_PROMPT,
      MOCKUP_PROMPT,
      MOCKUP_SCREENS_PROMPT,
      ANNOUNCE_PROMPT,
    ]) {
      expect(ALL_SHIPPED_PROMPTS, name).toContain(name)
    }
  })

  it('never mentions an un-enabled Plaid product without disclaiming it, in ANY prompt', () => {
    // architecture-overview.md section 3: Investments and Liabilities are NOT
    // enabled, and line 98 requires checking before promising a panel. "in ANY
    // prompt" means every prompt shipped on disk (ALL_SHIPPED_PROMPTS, above)
    // rather than a hand-maintained list — a fifth prompt (announce-v1.md) was
    // added to lib/chat/prompt.ts without being added to this sweep's old
    // enumerated list, which is exactly the gap discovery closes: the sweep
    // now needs no edit when a new prompt file ships. This also newly covers
    // agent-v1.md/agent-v3.md/agent-v4.md/mockup-v1.md/mockup-v2.md/spec-v1.md,
    // which the old enumerated list never checked.
    //
    // v2/v3 changed strategy from v1: instead of staying silent about
    // investments/liabilities, agent-v3.md and spec-v2.md name them
    // explicitly so the model knows the boundary rather than guessing at it
    // ("Investments and liabilities are not connected — ... an open_question,
    // not a panel"). A bare "is there a not nearby" check cannot tell that
    // apart from an actual promise ("investment tracking is not experimental
    // anymore" would pass it) — see the counter-example test below — so this
    // requires DISCLAIM_NEARBY: "not" anchored to a real disclaiming verb
    // this project actually uses, not any "not" in the neighbourhood.
    for (const name of ALL_SHIPPED_PROMPTS) {
      const { text } = loadPrompt(name)
      for (const global of FORBIDDEN_TERMS_GLOBAL) {
        for (const match of text.matchAll(global)) {
          expect(
            hasNearbyDisclaimer(text, match.index ?? 0, match[0].length),
            `${name}: "${match[0]}" appears without a nearby disclaimer`,
          ).toBe(true)
        }
      }
    }
  })

  it('rejects a false promise a bare "not"-nearby check would have missed', () => {
    // Counter-example from code review: a "not" that has nothing to do with
    // the forbidden term sailing through a check that only asked "is there
    // a not within N characters". This is a live false promise of an
    // un-enabled product — the guard above must treat it as undisclaimed.
    const counterExample =
      'Great news: investment tracking is not experimental anymore, it just went live for everyone.'
    const match = /\binvestments?\b/i.exec(counterExample)
    expect(match).not.toBeNull()
    expect(hasNearbyDisclaimer(counterExample, match!.index, match![0].length)).toBe(false)
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

  it('flags the inflected forms a rewrite is most likely to use', () => {
    // Ledger item 11's lesson, repointed. The original case was 401(k): the
    // old pattern matched "401k", "401-k" and "401 k" but not "401(k)", which
    // is how the term is almost always written — so the sweep looked like it
    // was working while missing the only spelling anyone uses.
    //
    // 401(k) left FORBIDDEN_TERMS when Investments was enabled on 2026-08-21,
    // but the failure mode did not: a term is written in whatever form reads
    // naturally, and a pattern that only matches one of them protects nothing.
    // Asserted directly rather than by trusting a real prompt to contain the
    // word, which would prove nothing on the day it stops containing it.
    for (const sample of [
      'Loan detail is not connected.',
      'Loans are not connected.',
      'Liability data is not connected.',
      'Liabilities are not connected.',
      'Your mortgage is not connected.',
      'Mortgages are not connected.',
    ]) {
      expect(
        FORBIDDEN_TERMS.some((pattern) => pattern.test(sample)),
        sample,
      ).toBe(true)
    }
  })

  it('does NOT flag a product that is now enabled', () => {
    // The other half, and the one that would silently over-fire: requiring a
    // disclaimer for investments would force the live prompt to deny a feature
    // that demonstrably works — 13 holdings and 1171 investment transactions
    // against a real Sandbox item.
    for (const sample of [
      'I can show your investment holdings and trades.',
      'Your 401(k) balance can be on the dashboard.',
      'Your portfolio is included.',
    ]) {
      expect(
        FORBIDDEN_TERMS.some((pattern) => pattern.test(sample)),
        sample,
      ).toBe(false)
    }
  })

  it('names prompt files that exist on disk', () => {
    for (const name of [
      AGENT_PROMPT,
      SPEC_PROMPT,
      MOCKUP_PROMPT,
      MOCKUP_SCREENS_PROMPT,
      ANNOUNCE_PROMPT,
    ]) {
      expect(existsSync(promptPath(name))).toBe(true)
    }
  })

  it('keeps superseded prompts on disk, because rows point at their hashes', () => {
    // prompt_sha is a content hash stamped on every transcript and spec row.
    // Deleting a superseded prompt orphans every row that names it.
    for (const name of ['agent-v2.md', 'spec-v1.md', 'announce-v1.md']) {
      expect(existsSync(promptPath(name))).toBe(true)
    }
  })

  it('points AGENT_PROMPT at v10, and keeps v9 unedited on disk', () => {
    // The live interview prompt, pinned so a revert fails a test rather than
    // quietly restoring what v10 corrected: v9 told friends that investments
    // were "not connected yet" (they are, since 2026-08-21) and that
    // "refreshes happen when they log in" (they do not — there is no login
    // sync and cannot be one; a friend presses Refresh).
    //
    // Both of those were FALSE STATEMENTS TO A FRIEND, which is why this was a
    // new version rather than an edit: prompts are added, never edited
    // (CLAUDE.md > Data safety), because every transcript row written while v9
    // shipped stamps its hash, and editing the file would silently change what
    // an already-stored hash points at.
    expect(AGENT_PROMPT).toBe('agent-v10.md')
    const v9 = loadPrompt('agent-v9.md')
    const v10 = loadPrompt(AGENT_PROMPT)
    expect(v9.sha).not.toBe(v10.sha)
    expect(existsSync(promptPath('agent-v9.md'))).toBe(true)
    // v8 too: every superseded version stays on disk forever.
    expect(existsSync(promptPath('agent-v8.md'))).toBe(true)
  })

  it('agent-v10 tells the friend the truth about refreshes and investments', () => {
    // The two corrections that justified the version. Asserted on CONTENT
    // rather than on the sha, so a future v11 that reintroduced either error
    // would have to do so deliberately.
    const { text } = loadPrompt('agent-v10.md')
    expect(text).not.toContain('refreshes happen when they log in')
    expect(text).toMatch(/investment holdings and trades/i)
    // And the consequence a friend has to hear: nothing reaches them outside
    // the app, because their key only exists while they are signed in.
    expect(text).toMatch(/no alerts|nothing can reach them outside/i)
  })

  it('points ANNOUNCE_PROMPT at v3, and keeps v1 and v2 unedited on disk', () => {
    // Two false premises removed in two steps, each a new file rather than an
    // edit — announce-v1.md and v2 have both stamped their hash on real
    // transcript rows (CLAUDE.md > Onboarding). v2 dropped v1's "they
    // confirmed this design and read a preview"; v3 dropped v2's opening
    // claim that the dashboard "was just rebuilt", which required knowing
    // whether an earlier version was ever built — a question this codebase has
    // answered wrongly three times (ledger D9, and lib/chat/announce.ts's
    // plainBody). Pinning the constant means an accidental revert fails a test
    // instead of quietly restoring a premise.
    expect(ANNOUNCE_PROMPT).toBe('announce-v3.md')
    const v1 = loadPrompt('announce-v1.md')
    const v2 = loadPrompt('announce-v2.md')
    const v3 = loadPrompt(ANNOUNCE_PROMPT)
    expect(new Set([v1.sha, v2.sha, v3.sha]).size).toBe(3)

    // Neither premise survives into what actually ships...
    expect(v3.text).not.toContain('They confirmed this design and read a')
    expect(v3.text).not.toContain('was just\nrebuilt')

    // ...and both older files are untouched, exactly as they shipped.
    expect(v1.text).toContain('They confirmed this design and read a')
    expect(v2.text).toContain('was just\nrebuilt')
  })
})
