// lib/spec/author.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import {
  currentSpec,
  hasConfirmedSpecBelow,
  insertSpec,
  readSpecs,
  type SpecRecord,
} from '@/lib/db/specs'
import { toMessages } from '@/lib/chat/history'
import { MOCKUP_PROMPT, SPEC_PROMPT, loadPrompt } from '@/lib/chat/prompt'
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
import {
  MOCKUP_JSON_SCHEMA,
  SPEC_JSON_SCHEMA,
  SpecShapeError,
  type SpecDraft,
} from './schema'
import { parseMockupInput, parseSpecDraft, sealVersion } from './validate'
import { renderLegacyMarkdown } from './render'
import { readStoredSpec, type StoredSpec } from './stored'

/**
 * One proposal, as it reaches the card — whichever way it got there.
 *
 * `spec` is the SAME tagged union readStoredSpec returns, because this type is
 * what the NDJSON `proposal` line carries (app/api/chat/route.ts) AND what
 * app/[user]/page.tsx builds from the stored row. A card streamed mid-turn and
 * a card rendered on page load must have one shape at every commit; two
 * near-identical unions would be two chances to render the wrong arm.
 *
 * This path now only ever produces the `version` arm: it asks for and
 * validates the whole-surface shape. The `legacy` arm remains reachable from
 * the READERS, for rows written before the unified loop — `specs` rejects
 * UPDATE, so those can never be rewritten (unified-loop ledger, D4).
 */
export type Proposal = {
  id: number
  version: number
  spec: StoredSpec
  mockup_html: string
  /**
   * Whether THIS card is the account's first dashboard, and therefore which
   * delivery promise it makes (ledger D9). Server-computed, per card, and
   * carried on the proposal itself rather than passed down the page.
   *
   * It has to ride here because the two ways a card reaches the screen do not
   * share a moment in time: the page-load card is built by app/[user]/page.tsx
   * during a render, but a card proposed mid-conversation arrives through the
   * `proposal` NDJSON line and the page never re-renders. A boolean computed
   * once per page load and applied to every card said "at the latest, it'll be
   * here tomorrow morning" about a one-word relabel proposed an hour later —
   * exactly the contradiction D9 exists to prevent, on the most load-bearing
   * promise in the pilot.
   */
  first: boolean
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

/**
 * How many times the SPEC call may run for one proposal.
 *
 * Two: the first attempt, plus one retry carrying the validator's own message
 * back so the model can correct itself (unified-loop ledger, D6). The retry
 * fires ONLY for a validation failure — a complete JSON object that the
 * validator rejected. A truncated reply, an unparsable one, and every API
 * error failed for reasons another sample will not fix, and each attempt
 * costs a full authoring latency the friend is watching a spinner through.
 */
export const MAX_SPEC_ATTEMPTS = 2

/** Honest defaults for a call that failed before the API reported anything. */
const NO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
const NO_SERVED: Served = { model_served: CHAT_MODEL, fallback_fired: false }

/**
 * Everything about the MOCKUP call, under its own flat names (ledger D15).
 *
 * The four standard counters (`input`/`output`/`cache_read`/`cache_creation`)
 * and `prompt_sha` mean "the spec call" on every row this module writes, so
 * grouping or joining the metrics log by them is never corrupted by the second
 * call. The mockup call's own numbers and its prompt's hash ride alongside
 * under these names instead.
 *
 * `mockup_prompt_sha` is what ties a stored `mockup_html` to the exact prompt
 * text that produced it (ledger D13). It cannot live on `specs` — that table
 * takes no new column — and `metrics` cannot be backfilled, so a row written
 * without it is a preview whose provenance is lost for good.
 *
 * Null, never zero or a placeholder, when the call did not get that far: zero
 * is a claim that nothing was billed, and that is false for a call that
 * returned (or truncated) before something downstream rejected it. Flat rather
 * than nested, because the step-4 ledger already records spreading a nested
 * `usage` beside flat counters as a hazard in `chat_error`.
 *
 * One function for the whole group so a new metrics site cannot pick up the
 * counters and silently omit the sha, or the other way round.
 */
function mockupFields(
  usage: Usage | undefined,
  promptSha: string | null,
): {
  mockup_input: number | null
  mockup_output: number | null
  mockup_cache_read: number | null
  mockup_cache_creation: number | null
  mockup_prompt_sha: string | null
} {
  return {
    mockup_input: usage?.input ?? null,
    mockup_output: usage?.output ?? null,
    mockup_cache_read: usage?.cache_read ?? null,
    mockup_cache_creation: usage?.cache_creation ?? null,
    mockup_prompt_sha: promptSha,
  }
}

/**
 * A failure message fit for an append-only table: the SHAPE of the failure,
 * never the content of the spec.
 *
 * The validator's messages quote what they rejected — `duplicate panel id
 * "eating_out"`, `panel "x" annotates "y"` — because those quoted ids are
 * exactly what lets the model correct itself on the retry. They are also
 * derived from what the friend asked for, and `metrics` is sacred and
 * append-only: nothing written here can ever be edited or removed.
 *
 * This is not a leak — Nico can already read the whole transcript and the
 * whole payload in the admin pane, so the marginal disclosure is nil. It is
 * consistency: `spec_confirmed` carries counts and never content, and a rule
 * that holds on one row of a table but not its neighbour stops being a rule.
 *
 * Redaction applies to `SpecShapeError` and nothing else, because the quoting
 * convention is that class's: every content interpolation in lib/spec/validate.ts
 * is double-quoted, and everything left unquoted there is structural (a path
 * like `screens[0].panels[1]`, or one of the fixed `kind`/`status` enums). Any
 * other error reaching here — SQLite, the SDK, a bug — carries infrastructure
 * text with no spec content in it, and mangling that would cost real debugging
 * information for nothing.
 *
 * The retry path deliberately does NOT go through this: the model gets the
 * full message, quoted ids and all.
 */
function metricMessage(error: unknown): string {
  if (error instanceof SpecShapeError) return error.message.replace(/"[^"]*"/g, '"…"')
  return error instanceof Error ? error.message : String(error)
}

/**
 * The current confirmed version, as the writer sees it. Three arms, because
 * all three are real states and none may silently look like another:
 *
 *   - none    → an explicit "this is the first version, the spec is empty",
 *               so the v1 prompt has the same SHAPE as every later one rather
 *               than one with a section missing. Behaviour-preserving: the
 *               first-ever conversation is the one thing this branch is not
 *               allowed to change (§7 resolution R3).
 *   - current → JSON, because id stability is the point and the ids have to
 *               be copyable verbatim.
 *   - legacy  → renderLegacyMarkdown's output plus a note that ids must be
 *               assigned fresh. A pre-unification row has no ids to stabilise
 *               against, and it can never gain any (`specs` rejects UPDATE),
 *               so the honest instruction is "start the ids here".
 *
 * Rendered rather than dumped as JSON on the legacy arm so the writer reads
 * the same document a human would read as the build contract, and so a shape
 * the current schema cannot describe never looks like one that it can.
 */
function currentVersionBlock(current: SpecRecord | undefined): string {
  if (current === undefined) {
    return (
      'There is no confirmed spec for this account yet. The current spec is ' +
      'empty and this is version 1: assign every screen, panel, and value id ' +
      'fresh.'
    )
  }

  const stored = readStoredSpec(current.payload)
  if (stored.kind === 'version') {
    return (
      `The dashboard's current confirmed version is v${current.version}, ` +
      'below as JSON. Reuse its ids exactly for anything that is still the ' +
      'same thing, even where you are renaming or reshaping it.\n\n' +
      JSON.stringify(stored.version, null, 2)
    )
  }

  return (
    `The dashboard's current confirmed version is v${current.version}. It ` +
    'predates the current format and carries no ids, so it is written out ' +
    'below as prose rather than JSON. Treat it as what already exists, and ' +
    'assign every screen, panel, and value id in your version fresh.\n\n' +
    renderLegacyMarkdown(stored.payload, {
      // authorSpec is handed an accountId, not a slug, and the writer has no
      // use for one — it never names the person. Looking one up would add an
      // accounts read to a path whose only job is to hand over the content of
      // a spec. The version and the confirmation time are the real values.
      slug: 'this account',
      version: current.version,
      // currentSpec only ever returns a CONFIRMED row, so confirmed_at is
      // non-null here; the fallback exists because the type says it can be.
      confirmedAt: current.confirmed_at ?? current.at,
    })
  )
}

/**
 * The retry turn: the validator's own message, handed back so the model can
 * correct the exact thing that failed.
 *
 * Like "Write the spec now." and the current-version block, this is a
 * CALL-TIME construct and is never appended to transcripts — it is not a
 * thing the friend said (design spec section 4.4).
 */
function retryMessage(problem: string): string {
  return (
    'That draft was rejected before it could be saved, by the validator that ' +
    'guards the record:\n\n' +
    `    ${problem}\n\n` +
    'Write the complete next version again, as one object, with that problem ' +
    'fixed. Do not reply with prose, an apology, or only the part that changed.'
  )
}

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
 * currentSpec, insertSpec, the version read-back, or the spec_proposed write
 * itself — still records a metric and returns undefined rather than escaping.
 * turn.ts additionally wraps its own call to this function as a second,
 * belt-and-braces layer.
 *
 * Two model calls, in order: the spec (retried once on a validation failure),
 * then the mockup from the VALIDATED draft. `insertSpec` runs only after both
 * have succeeded — `mockup_html` is NOT NULL and `specs` rejects UPDATE, so a
 * row written without its preview could never be repaired (ledger D7).
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
  // Populated once a spec client.propose() actually returns, and read by the
  // outer catch too: a call that returned already spent real, billed tokens,
  // even if insertSpec, the version read-back, or the spec_proposed append
  // itself throws afterward. Declared here (not inside the attempt loop)
  // specifically so the outer catch can see it — that scoping bug was the
  // whole defect: a successful, billed propose() followed by a later throw
  // used to log NO_USAGE/NO_SERVED, zeroing out tokens that were real.
  let result: ProposeResult | undefined
  // Same, for the mockup call. Undefined until that call returns.
  let mockupResult: ProposeResult | undefined
  // The mockup prompt's own hash, populated the moment its file is read and
  // read by the outer catch too. Declared here for the same reason promptSha
  // is: a row that names the wrong prompt — or no prompt — is a stored
  // mockup_html nobody can trace back to the text that produced it, in two
  // tables that can never be backfilled.
  let mockupPromptSha: string | null = null
  // Which spec attempt produced the outcome. Every row this function writes
  // carries it, so the log distinguishes "the model got it right first time"
  // from "it took the retry". Zero means no spec call was made at all — the
  // only rows that can carry it are the outer catch's, for a failure that
  // struck before the loop.
  let attempt = 0

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

    // What the writer is SHOWN as the current confirmed version. Read here
    // because that is when the prompt is built; the lineage pointer stored on
    // the row is read again at write time instead, and the two reads are
    // deliberately separate — see sealVersion below.
    const current = currentSpec(db, input.accountId)

    const history = toMessages(readTranscript(db, input.accountId))
    const last = history[history.length - 1]
    // The current-version block always goes, on all three of its arms, so the
    // prompt has one shape on every path. "Write the spec now." is appended
    // ONLY when the last transcript message is an assistant turn: on the usual
    // path the agent said something before calling the tool, so the call needs
    // a user message to answer. On the no-text path the friend's own message
    // is already there and a second instruction buys nothing.
    //
    // Neither is ever written to transcripts: both are call-time constructs,
    // not things the friend said (design spec section 4.4).
    const specMessages = [
      ...history,
      { role: 'user' as const, content: currentVersionBlock(current) },
      ...(last?.role === 'assistant'
        ? [{ role: 'user' as const, content: 'Write the spec now.' }]
        : []),
    ]

    let draft: SpecDraft | undefined
    let feedback: string | undefined

    while (attempt < MAX_SPEC_ATTEMPTS) {
      attempt += 1
      const attemptMessages =
        feedback === undefined
          ? specMessages
          : [...specMessages, { role: 'user' as const, content: retryMessage(feedback) }]

      let proposed: ProposeResult
      try {
        proposed = await client.propose({
          system,
          messages: attemptMessages,
          signal: input.signal,
          schema: SPEC_JSON_SCHEMA,
        })
      } catch (error) {
        if (input.signal.aborted) {
          appendMetric(db, {
            accountId: input.accountId,
            event: 'spec_aborted',
            at: now(),
            data: { ...NO_USAGE, ...base, ...NO_SERVED, attempt },
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
        //
        // No retry from here, for any kind: none of them fail for a reason
        // another sample fixes (ledger D6).
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
            attempt,
          },
        })
        return undefined
      }
      // Recorded for the outer catch as well — see the declaration above.
      result = proposed

      try {
        draft = parseSpecDraft(proposed.input)
        break
      } catch (error) {
        // A schema-constrained REQUEST is not a guarantee about the row that
        // reaches an append-only table. This validator is the last gate, and
        // anything it throws that is not a SpecShapeError is a bug in the
        // validator, not a bad draft — that goes to the outer catch.
        if (!(error instanceof SpecShapeError)) throw error

        // Every attempt gets its own row: this one returned a complete
        // response and cost real, billed tokens, and a cost log reporting
        // zero for a billed turn is fiction.
        //
        // `type` stays null here on purpose: everywhere else in this codebase
        // `type` is the API's own error.type discriminator, and the
        // validator's prose message is not that — putting it there would mix
        // discriminators with sentences for any query that groups spec_error
        // rows by type, permanently. The message goes in its own field —
        // redacted, because the validator quotes the ids it rejected and
        // `metrics` is append-only (see metricMessage above).
        appendMetric(db, {
          accountId: input.accountId,
          event: 'spec_error',
          at: now(),
          data: {
            ...proposed.usage,
            ...base,
            ...proposed.served,
            kind: 'malformed_spec',
            status: null,
            type: null,
            attempt,
            message: metricMessage(error),
          },
        })
        // Checked BEFORE the retry, not after: the friend has walked away and
        // a second authoring call would bill for a card nobody is waiting for.
        if (input.signal.aborted) return undefined
        // The FULL message, quoted ids and all: this one goes to the model,
        // where naming the exact thing that failed is what lets it correct
        // itself. Only the copy bound for the metrics log is redacted.
        feedback = error.message
      }
    }

    // `result` is set by every attempt that returned and `draft` only after
    // one of them validated, so the second half of this condition is
    // unreachable in practice — it is here so the compiler can see what the
    // loop guarantees.
    if (draft === undefined || result === undefined) return undefined

    let mockupHtml: string
    try {
      // Both halves of the loaded prompt are kept: the text goes to the model
      // and the sha onto every row below, so the preview this call produces
      // stays tied to the exact prompt text that produced it.
      const mockupPrompt = loadPrompt(MOCKUP_PROMPT)
      mockupPromptSha = mockupPrompt.sha
      mockupResult = await client.propose({
        system: mockupPrompt.text,
        // The VALIDATED draft, not the raw reply: a mockup generated from
        // anything else could show a panel the spec does not contain, which
        // is a promise made on the friend's behalf (ledger D7).
        messages: [{ role: 'user', content: JSON.stringify(draft) }],
        signal: input.signal,
        schema: MOCKUP_JSON_SCHEMA,
      })
      mockupHtml = parseMockupInput(mockupResult.input)
    } catch (error) {
      // mockup_html is NOT NULL, and a spec row with no preview is a card the
      // friend cannot read. Both calls land or neither does.
      //
      // The four standard counters are the SPEC call's, not the mockup
      // call's — see ledger D15. On the success path those tokens ride on
      // spec_proposed; no spec_proposed is written here, so this row is their
      // only home, and every other row in the log means the same thing by
      // those four names. The mockup call's own usage rides alongside under
      // mockup_* names: from its ProposeResult when the call returned and the
      // validator rejected it, from the error shape when it truncated, and
      // null when it failed before any response came back.
      //
      // An abort during the mockup call lands here too rather than in a
      // spec_aborted row, deliberately: spec_aborted carries NO_USAGE (honest
      // only for a call that never returned), and the spec call's real tokens
      // would vanish from the log. The message says it was aborted.
      const shape = error instanceof ChatStreamError ? error.shape : UNKNOWN_ERROR
      appendMetric(db, {
        accountId: input.accountId,
        event: 'spec_error',
        at: now(),
        data: {
          ...result.usage,
          ...base,
          ...result.served,
          kind: 'mockup_failed',
          status: shape.status,
          type: shape.type,
          attempt,
          message: metricMessage(error),
          ...mockupFields(mockupResult?.usage ?? shape.usage, mockupPromptSha),
        },
      })
      return undefined
    }

    // The one place a SpecVersion is constructed on this path, and the lineage
    // pointer comes from the RECORD, never from anything the model wrote:
    // `parseSpecDraft` rejects a draft carrying one outright, because a
    // model-authored lineage pointer is a hallucination that becomes a
    // permanent wrong row in an append-only table (ledger D2).
    //
    // Re-read here rather than reused from the `current` above, and the gap
    // between the two is the whole point. Everything between them is two model
    // calls that can run three minutes, and the confirm buttons on the card
    // already on screen are gated by `confirming`, not by `busy` — so that
    // card stays clickable for the entire wait while the friend watches
    // "Putting together a preview…". A friend who presses "Build this" in that
    // window changes what the newest confirmed version IS, and a pointer read
    // before the call would name the version it superseded. `specs` rejects
    // UPDATE, so that row could never be repaired: the admin pane's diff and
    // the spec_confirmed counts for this version would be computed against the
    // wrong base forever.
    //
    // A version is a WHOLE-SURFACE spec and the build contract is "the newest
    // confirmed version", so the base that means something is the one this
    // version would supersede when confirmed — which is the record at write
    // time. That the writer was shown an older version is a separate fact, and
    // it is one the transcript and the prompt already carry.
    const sealed = sealVersion(draft, currentSpec(db, input.accountId)?.version ?? null)

    const id = insertSpec(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      promptSha,
      payload: sealed,
      mockupHtml,
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
      data: {
        ...result.usage,
        ...base,
        ...result.served,
        spec_id: id,
        version,
        attempt,
        // Both calls returned and both were billed. Without these the
        // success path would be the one path where a returning model call's
        // usage reaches no metrics row at all — and the one stored
        // mockup_html nobody could tie back to its prompt.
        ...mockupFields(mockupResult.usage, mockupPromptSha),
      },
    })

    return {
      id,
      version,
      // `version`, because that is what this path genuinely produced:
      // parseSpecDraft validated the whole-surface shape and sealVersion
      // attached the server's lineage pointer. The tag is a statement of fact
      // about the payload.
      spec: { kind: 'version', version: sealed },
      mockup_html: mockupHtml,
      // Asked of the record, for THIS version, at the moment the row exists —
      // the same question app/[user]/page.tsx asks of the page-load card, and
      // the same helper, so the two answers cannot drift. Bounded by `version`
      // rather than "has this account ever confirmed anything": the instant a
      // friend confirms their very first card the unbounded reading flips, and
      // that card — a whole first dashboard, nothing built yet — would start
      // describing itself as a small change landing within hours.
      first: !hasConfirmedSpecBelow(db, input.accountId, version),
    }
  } catch (error) {
    // Anything with no dedicated branch above. promptSha may or may not be
    // known depending on where this fired. result may or may not be known
    // too: NO_USAGE/NO_SERVED are honest only for a failure that struck
    // before client.propose() returned anything. If propose() already
    // succeeded — insertSpec, the version read-back, or the spec_proposed
    // append itself is what threw — result carries the real, billed
    // counters and those are what must be reported, not zero. Same for the
    // mockup call's own fields, which are null until it gets that far.
    //
    // The message goes through metricMessage for a reason that is easy to
    // miss: currentVersionBlock reads the CURRENT spec, so a stored row that
    // no longer validates throws a SpecShapeError quoting ids out of THAT
    // spec, and it lands right here.
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
        attempt,
        message: metricMessage(error),
        ...mockupFields(mockupResult?.usage, mockupPromptSha),
      },
    })
    return undefined
  }
}
