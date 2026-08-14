import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const PROMPT_DIR = resolve(process.cwd(), 'platform/prompts')

/**
 * The interview prompt. New versions are new FILES, never edits.
 *
 * v4 adds a verbatim opening message the agent speaks first (delivered by
 * lib/chat/opening.ts, not by a model call) and an "After they confirm"
 * section — which was dead text against this codebase until
 * lib/chat/confirmations.ts started putting confirmations in front of the
 * model at all.
 */
export const AGENT_PROMPT = 'agent-v4.md'

/**
 * The spec-authoring prompt. Separate from the interview prompt so the output
 * contract can be iterated without touching interview wording, and so the two
 * eras stay separable in the record. As of v2 it no longer covers the mockup
 * — that moved to its own call and its own prompt, MOCKUP_PROMPT below.
 */
export const SPEC_PROMPT = 'spec-v2.md'

/**
 * The mockup-rendering prompt. Takes a validated spec version as JSON and
 * emits the self-contained HTML preview — split out from SPEC_PROMPT so a
 * spec can be authored and validated without also generating and discarding
 * HTML on a rejected draft.
 *
 * v2 adds the two things v1's output kept getting wrong: a fluid container
 * (v1 said "on a phone-width screen", and got a ~430px column centred on a
 * 1440px monitor) and an explicit rule that spec METADATA — `intent`,
 * `context_of_use`, descriptions — is used to decide how to render a panel and
 * never rendered as visible caption. Nothing in v1 asked for those captions;
 * the model inferred them from "every panel appears in the mockup", which is
 * why the fix is an instruction rather than a deletion.
 */
export const MOCKUP_PROMPT = 'mockup-v2.md'

export type LoadedPrompt = { text: string; sha: string }

/**
 * A bare filename resolved under platform/prompts.
 *
 * Throws if the name contains path traversal (e.g., `../../.env`). This project
 * denies reading `.env` files and non-synthetic databases at the tool layer —
 * this guard prevents a way around those boundaries.
 */
export function promptPath(name: string): string {
  const path = resolve(PROMPT_DIR, name)
  const rel = relative(PROMPT_DIR, path)
  // If relative path starts with "..", the resolved path escapes the directory
  if (rel.startsWith('..')) {
    throw new Error(`Path traversal not allowed: ${name}`)
  }
  return path
}

/**
 * Read and hash a file at an already-resolved path, no containment guard.
 *
 * Test-only entry point: every production call site passes a bare name
 * through loadPrompt below. This exists so the suite can hash disposable
 * temp files (for the sha-stability and sha-changes-on-edit assertions)
 * without loadPrompt itself accepting an absolute path — an escape hatch
 * there would skip promptPath's traversal guard for a real bare name too,
 * which is exactly the hole this project's own guard-hook rule (CLAUDE.md >
 * Data safety) exists to prevent for `.env` and non-synthetic databases.
 */
export function loadPromptAtPath(path: string): LoadedPrompt {
  const text = readFileSync(path, 'utf8')
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text, sha }
}

/**
 * Read a shipped prompt by bare name and hash its bytes.
 *
 * The sha is stamped on every transcript row and every spec row so a row is
 * tied to the exact prompt text that produced it — a content hash rather than
 * a human label, because a label can be reused across a quiet edit and a hash
 * cannot.
 *
 * Only ever resolves under platform/prompts, via promptPath's traversal
 * guard — no absolute-path bypass. Callers that need to hash an arbitrary
 * file (tests, only) use loadPromptAtPath above instead.
 *
 * Read per call rather than memoized: the files are a few KB next to a
 * multi-second API call, and a module-level cache would need a test-only reset
 * hook to stay testable.
 */
export function loadPrompt(name: string = AGENT_PROMPT): LoadedPrompt {
  return loadPromptAtPath(promptPath(name))
}
