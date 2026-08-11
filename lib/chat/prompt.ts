import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PROMPT_PATH = resolve(process.cwd(), 'platform/prompts/agent-v1.md')

export type LoadedPrompt = { text: string; sha: string }

/**
 * Read the system prompt and hash its bytes.
 *
 * The sha is stamped on every transcript row so a row is tied to the exact
 * prompt text that produced it — a content hash rather than a human label,
 * because a label can be reused across a quiet edit and a hash cannot.
 *
 * Read per call rather than memoized: the file is a few KB next to a
 * multi-second API call, and a module-level cache would need a test-only
 * reset hook to stay testable.
 */
export function loadPrompt(path: string = PROMPT_PATH): LoadedPrompt {
  const text = readFileSync(path, 'utf8')
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text, sha }
}
