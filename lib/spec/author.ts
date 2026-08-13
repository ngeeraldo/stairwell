// lib/spec/author.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { insertSpec, readSpecs } from '@/lib/db/specs'
import { toMessages } from '@/lib/chat/history'
import { SPEC_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import type { ChatContext } from '@/lib/chat/context'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  ChatStreamError,
  UNKNOWN_ERROR,
  type ChatClient,
  type ProposeResult,
  type Served,
  type Usage,
} from '@/lib/chat/client'
import { LEGACY_SPEC_JSON_SCHEMA, parseLegacySpecInput } from './legacy'
import type { StoredSpec } from './stored'

/**
 * One proposal, as it reaches the card — whichever way it got there.
 *
 * `spec` is the SAME tagged union readStoredSpec returns, because this type is
 * what the NDJSON `proposal` line carries (app/api/chat/route.ts) AND what
 * app/[user]/page.tsx builds from the stored row. A card streamed mid-turn and
 * a card rendered on page load must have one shape at every commit; two
 * near-identical unions would be two chances to render the wrong arm.
 *
 * Today this path only ever produces the `legacy` arm — the authoring call
 * below still asks for and parses the frozen six-field shape. Task 10 is what
 * makes the `version` arm reachable from here. The readers handle both
 * already, deliberately ahead of that switch: reversed, there would be a
 * window where a confirmed proposal renders as nothing.
 */
export type Proposal = {
  id: number
  version: number
  spec: StoredSpec
  mockup_html: string
}

export type AuthorDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  context: ChatContext
}

export type AuthorInput = {
  accountId: number
  conversationId: string
  signal: AbortSignal
}

/** Honest defaults for a call that failed before the API reported anything. */
const NO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
const NO_SERVED: Served = { model_served: CHAT_MODEL, fallback_fired: false }

/**
 * Write one proposal, or record why it could not be written.
 *
 * Returns undefined on EVERY failure path, expected or not — this function
 * never throws. It runs AFTER the chat turn's assistant row is already
 * appended, and a failed preview must not retroactively turn a delivered
 * reply into a failed turn: a throw here would propagate out of runTurn into
 * the route's ReadableStream AFTER the reply was already saved, killing the
 * stream with no `{done:true}`, no `controller.close()`, and no failure
 * metric anywhere to explain why.
 *
 * The whole body sits inside one outer try/catch specifically so a failure
 * with no dedicated branch — loadPrompt (PROMPT_DIR resolves against
 * process.cwd(), not guaranteed to be the repo root under systemd),
 * insertSpec, the version read-back, or the spec_proposed write itself —
 * still records a metric and returns undefined rather than escaping.
 * turn.ts additionally wraps its own call to this function as a second,
 * belt-and-braces layer.
 */
export async function authorSpec(
  deps: AuthorDeps,
  input: AuthorInput,
): Promise<Proposal | undefined> {
  const { db, client, now, context } = deps
  // Populated once loadPrompt succeeds, and read by the outer catch too, so a
  // later failure's metric row still carries the real prompt sha instead of
  // an unknown placeholder.
  let promptSha: string | null = null
  // Populated once client.propose() actually returns, and read by the outer
  // catch too: a call that returned already spent real, billed tokens, even
  // if insertSpec, the version read-back, or the spec_proposed append itself
  // throws afterward. Declared here (not `let result` inside the inner try)
  // specifically so the outer catch can see it — that scoping bug was the
  // whole defect: a successful, billed propose() followed by a later throw
  // used to log NO_USAGE/NO_SERVED, zeroing out tokens that were real.
  let result: ProposeResult | undefined

  try {
    const loaded = loadPrompt(SPEC_PROMPT)
    promptSha = loaded.sha
    const system = loaded.text

    const base = {
      model: CHAT_MODEL,
      effort: CHAT_EFFORT,
      prompt_sha: promptSha,
      context,
    }

    const history = toMessages(readTranscript(db, input.accountId))
    const last = history[history.length - 1]
    // Appended ONLY when the last message is an assistant turn. On the usual
    // path the agent said something before calling the tool, so the call needs
    // a user message to answer. On the no-text path the friend's own message is
    // already last and a second user turn buys nothing. Ending on a user
    // message is the only invariant this needs.
    //
    // Never written to transcripts: it is a call-time construct, not a thing
    // the friend said (design spec section 4.4).
    const messages =
      last?.role === 'assistant'
        ? [...history, { role: 'user' as const, content: 'Write the spec now.' }]
        : history

    try {
      // LEGACY_SPEC_JSON_SCHEMA, not the current SPEC_JSON_SCHEMA: this path
      // still parses with parseLegacySpecInput below, and pairing a new
      // request schema with the old parser would produce a branch that
      // passes its tests (which drive a fake client) yet fails against the
      // real API. Task 10 switches both the schema and the parser together.
      result = await client.propose({
        system,
        messages,
        signal: input.signal,
        schema: LEGACY_SPEC_JSON_SCHEMA,
      })
    } catch (error) {
      if (input.signal.aborted) {
        appendMetric(db, {
          accountId: input.accountId,
          event: 'spec_aborted',
          at: now(),
          data: { ...NO_USAGE, ...base, ...NO_SERVED },
        })
        return undefined
      }
      // truncated_spec and unparsable_spec fire AFTER a complete response —
      // hitting SPEC_MAX_TOKENS is the single most expensive failure this
      // call has, and propose() carries the real usage/served on the error
      // shape for exactly those two kinds (lib/chat/client.ts). Every other
      // kind — rate limit, connection, auth, ... — failed before any
      // response came back, so shape.usage/shape.served are genuinely
      // absent there and NO_USAGE/NO_SERVED are the honest values, not a
      // shortcut. Do not fabricate in either direction.
      const shape = error instanceof ChatStreamError ? error.shape : UNKNOWN_ERROR
      appendMetric(db, {
        accountId: input.accountId,
        event: 'spec_error',
        at: now(),
        data: {
          ...(shape.usage ?? NO_USAGE),
          ...base,
          ...(shape.served ?? NO_SERVED),
          kind: shape.kind,
          status: shape.status,
          type: shape.type,
        },
      })
      return undefined
    }

    let parsed
    try {
      parsed = parseLegacySpecInput(result.input)
    } catch (error) {
      // A schema-constrained REQUEST is not a guarantee about the row that
      // reaches an append-only table. This validator is the last gate.
      //
      // `type` stays null here on purpose: everywhere else in this codebase
      // `type` is the API's own error.type discriminator, and the
      // validator's prose message is not that — putting it there would mix
      // discriminators with sentences for any query that groups spec_error
      // rows by type, permanently. The message goes in its own field.
      appendMetric(db, {
        accountId: input.accountId,
        event: 'spec_error',
        at: now(),
        data: {
          ...result.usage,
          ...base,
          ...result.served,
          kind: 'malformed_spec',
          status: null,
          type: null,
          message: error instanceof Error ? error.message : null,
        },
      })
      return undefined
    }

    const id = insertSpec(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      promptSha,
      payload: parsed.payload,
      mockupHtml: parsed.mockupHtml,
      at: now(),
    })
    // Read back rather than counting: version is derived from position, and
    // this is the one place that must agree with what the admin pane
    // renders. No non-null assertion: a miss here is exactly the kind of
    // "should never happen" case the outer catch below exists to catch.
    const version = readSpecs(db, input.accountId).find((s) => s.id === id)?.version
    if (version === undefined) {
      throw new Error(`spec ${id} was inserted but not found in readSpecs`)
    }

    appendMetric(db, {
      accountId: input.accountId,
      event: 'spec_proposed',
      at: now(),
      data: { ...result.usage, ...base, ...result.served, spec_id: id, version },
    })

    // Wrapped as `legacy` because that is what this path genuinely produced:
    // parseLegacySpecInput above validated the frozen six-field shape. The tag
    // is a statement of fact about the payload, not a placeholder — Task 10
    // changes the schema, the parser and this tag together.
    return {
      id,
      version,
      spec: { kind: 'legacy', payload: parsed.payload },
      mockup_html: parsed.mockupHtml,
    }
  } catch (error) {
    // Anything with no dedicated branch above. promptSha may or may not be
    // known depending on where this fired. result may or may not be known
    // too: NO_USAGE/NO_SERVED are honest only for a failure that struck
    // before client.propose() returned anything. If propose() already
    // succeeded — insertSpec, the version read-back, or the spec_proposed
    // append itself is what threw — result carries the real, billed
    // counters and those are what must be reported, not zero.
    appendMetric(db, {
      accountId: input.accountId,
      event: 'spec_error',
      at: now(),
      data: {
        ...(result?.usage ?? NO_USAGE),
        model: CHAT_MODEL,
        effort: CHAT_EFFORT,
        prompt_sha: promptSha,
        context,
        ...(result?.served ?? NO_SERVED),
        kind: 'unexpected_error',
        status: null,
        type: null,
        message: error instanceof Error ? error.message : String(error),
      },
    })
    return undefined
  }
}
