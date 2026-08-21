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
 *
 * v5 adds one thing: the agent tells someone roughly how long the preview takes
 * before it calls the tool. The wait is about a minute and mostly spent drawing;
 * a person who was told to expect that waits, and a person who was not decides
 * the product is broken and starts clicking.
 *
 * v6 hands the agent users/<slug>/current.md — the builder's description of
 * what is actually deployed — and tells it to trust that over the spec. Until
 * v6 the agent received no description of the dashboard at all and
 * reconstructed one from the conversation, which is why a second conversation
 * could discuss panels that were never built the way they were proposed.
 *
 * v7 removes the preview. There is no mockup and nothing to confirm: calling
 * propose_spec writes a spec in the background and the build arrives. The
 * agent now says briefly what it will have built, because the card that used
 * to say it is gone.
 *
 * v8 puts a question back where the button was. Reaching "when you have
 * enough" no longer means proposing — the agent asks whether there is anything
 * else they want in this build, once, and proposes on their next message
 * whatever it says. Removing the card removed the moment a person could say
 * "actually, one more thing", and people routinely give one want and remember
 * the second only when asked. The bar in "When you have enough" is unchanged.
 *
 * v9 changes what the proposing message itself says, in the two ways it was
 * getting wrong. It no longer describes back what is being built: v7 asked for
 * that ("say briefly what you are having built") because the card that used to
 * say it had just been removed, but the friend has only just finished
 * describing the thing, so the summary spends the whole message on the one
 * thing in it they already know. And it now says WHEN — the next morning for a
 * first dashboard, a few hours for a change, the same timings "What to promise"
 * has always carried — because that is the thing they cannot know, at the only
 * moment it matters. Before v9 someone said "that's everything" and got a
 * receipt with no date on it.
 */
export const AGENT_PROMPT = 'agent-v10.md'

/**
 * The spec-authoring prompt. Separate from the interview prompt so the output
 * contract can be iterated without touching interview wording, and so the two
 * eras stay separable in the record.
 *
 * v4 makes the spec change-only. The writer's base is users/<slug>/current.md
 * — the builder's description of what is actually deployed — instead of the
 * previous spec row, which was a prediction written before any code existed.
 * It emits change_summary, changes, data_requirements and open_questions:
 * no ids, no whole-surface restatement, and no title/summary/background,
 * which current.md now answers.
 *
 * It also drops two false premises v2 and v3 both carried: a "current
 * confirmed version" (nothing confirms) and a preview card the change_summary
 * would appear in (nothing previews).
 *
 * spec-v2.md and spec-v3.md stay on disk. spec-v3.md was SPEC_PATCH_PROMPT,
 * used when a current-shape version existed to patch; there is one authoring
 * path now, so that constant is gone while the file it named is not —
 * prompt_sha on existing spec rows points at both.
 */
export const SPEC_PROMPT = 'spec-v4.md'

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
 *
 * v3 replaces "every number is loudly fake" with plausible values, adds a
 * restraint section (the verdict is the screen; `shows` is a ceiling, not a
 * floor), and tells the model NOT to add a banner. The honesty signal moved
 * from the numbers to a banner injected at serve time by lib/spec/banner.ts —
 * a guard the model could not forget, which "£000.00" was not. (Describes the
 * mechanism as it existed at the time: `lib/spec/banner.ts` was itself
 * deleted along with the rest of the mockup loop — see MOCKUP_SCREENS_PROMPT's
 * own docstring, below.)
 *
 * HISTORICAL as of Task 18 (final review, Minor 8): no production code calls
 * this anymore. The Task 18 cutover to a scoped, per-screen mockup call
 * (MOCKUP_SCREENS_PROMPT below, SCREEN_MOCKUP_JSON_SCHEMA, `composeMockup`)
 * superseded the whole-document call this prompt drove — and that successor
 * was later deleted too, along with MOCKUP_SCREENS_PROMPT itself (see its own
 * docstring). Kept, not deleted:
 * `mockup_prompt_sha` rows written before that cutover point at this file's
 * hash, and prompts are added, never edited or removed (CLAUDE.md) — an
 * already-written hash must keep resolving to real prompt text.
 */
export const MOCKUP_PROMPT = 'mockup-v3.md'

/**
 * The per-screen mockup prompt. Not v4 of MOCKUP_PROMPT's call — a separate
 * call with a separate schema (SCREEN_MOCKUP_JSON_SCHEMA), asking for one
 * `<section class="screen">` fragment per affected screen rather than a whole
 * self-contained document. lib/spec/mockupCompose.ts owns the document
 * around the fragments: the frame, the published default styles (the
 * "nudge"), and confining each fragment's own `<style>` block to the screen
 * that authored it. This is what makes reuse possible at all — a screen a
 * patch did not touch keeps its already-drawn fragment rather than being
 * redrawn (and re-billed) alongside the ones that changed.
 *
 * HISTORICAL as of the mockup-loop removal (plan
 * 2026-08-19-remove-the-mockup-loop, Task 4): no production code calls this
 * anymore. `lib/spec/author.ts` no longer draws a mockup at all — a proposal
 * is the spec call alone. Kept, not deleted, for the same reason MOCKUP_PROMPT
 * above is: `mockup_prompt_sha` rows written before this cutover point at
 * this file's hash, and prompts are added, never edited or removed
 * (CLAUDE.md) — an already-written hash must keep resolving to real prompt
 * text.
 */
export const MOCKUP_SCREENS_PROMPT = 'mockup-v4.md'

/**
 * The deploy-announcement prompt. Turns one build's friend-facing notes into
 * the sentence that lands in their chat.
 *
 * A drafted announcement is the first GENERATED text this system writes into
 * an append-only transcript, which is why scripts/announce-deploy.ts drafts by
 * default and only sends on --send.
 *
 * v2 fixes a false premise the mockup-loop removal left behind: v1 told the
 * model not to repeat what the friend already knows because "they confirmed
 * this design and read a preview of it." Nobody confirms anything now and
 * there is no preview, so a friend reading this announcement has never seen
 * their dashboard — v2 tells the model to say briefly what it does instead
 * of withholding that. New file, not an edit: transcript rows already stamp
 * announce-v1.md's hash as their prompt_sha (CLAUDE.md > Data safety).
 *
 * v3 drops the first-vs-rebuilt distinction, which v2 still carried in its
 * opening line ("their dashboard was just rebuilt"). There is one announcement
 * now and the model is not told which build this is, because knowing meant
 * answering "was an EARLIER version ever built" and every cheap way of asking
 * that has been wrong at least once — see lib/chat/announce.ts's plainBody for
 * the three, and ledger D9. v3 says the same thing either way and forbids
 * phrasings that only make sense for one of them.
 */
export const ANNOUNCE_PROMPT = 'announce-v3.md'

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
