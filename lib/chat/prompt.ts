import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const PROMPT_DIR = resolve(process.cwd(), 'platform/prompts')

/** The interview prompt. New versions are new FILES, never edits. */
export const AGENT_PROMPT = 'agent-v1.md'

/**
 * The spec-authoring prompt. Separate from the interview prompt so the output
 * contract and the mockup conventions can be iterated without touching
 * interview wording, and so the two eras stay separable in the record.
 */
export const SPEC_PROMPT = 'spec-v1.md'

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
 * Read a prompt and hash its bytes.
 *
 * The sha is stamped on every transcript row and every spec row so a row is
 * tied to the exact prompt text that produced it — a content hash rather than
 * a human label, because a label can be reused across a quiet edit and a hash
 * cannot.
 *
 * Absolute paths are used as-is, which is what lets the suite hash temp files
 * without a second entry point.
 *
 * Read per call rather than memoized: the files are a few KB next to a
 * multi-second API call, and a module-level cache would need a test-only reset
 * hook to stay testable.
 */
export function loadPrompt(name: string = AGENT_PROMPT): LoadedPrompt {
  const path = isAbsolute(name) ? name : promptPath(name)
  const text = readFileSync(path, 'utf8')
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text, sha }
}
