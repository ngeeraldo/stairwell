// lib/spec/author.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { currentSpec, insertSpec, readSpecs } from '@/lib/db/specs'
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
import { SpecShapeError } from './schema'
import {
  parseSpecChangeDraft,
  sealChange,
  SPEC_CHANGE_JSON_SCHEMA,
  type SpecChangeDraft,
} from './change'

/**
 * One authored proposal. Three fields, because that is all anything consumes:
 * app/api/chat/route.ts fires an alert on its existence, and nothing else
 * looks at it.
 *
 * `spec` used to carry the payload as a StoredSpec, for the card that
 * rendered it mid-turn. That card is gone (mockup-loop removal), and the
 * field was read by nothing but this module's own tests. `mockup_html`,
 * `preview_html` and `first` went with the card in the same removal.
 */
export type Proposal = {
  id: number
  version: number
  /**
   * The spec row's own timestamp, so anything placing this in conversation
   * order has the row's moment rather than its own (onboarding ledger D5).
   */
  at: number
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
  /**
   * users/<slug>/current.md's BODY, or null when the account has no built
   * dashboard. Passed in rather than read here: this function is handed an
   * accountId, not a slug, and reading the filesystem is not its job.
   *
   * app/api/chat/route.ts performs the one read, for the chat call itself,
   * and lib/chat/turn.ts hands the same value on. One read, two consumers —
   * the agent talking to the friend and the writer recording what they asked
   * for cannot disagree about what the dashboard currently is.
   */
  currentState: string | null
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
 * like `screens[0].panels[1]`, or one of the fixed `kind`/`status` enums).
 *
 * CORRECTED 2026-08-17 (final review, Critical 1): this used to assert that
 * any non-`SpecShapeError` reaching here "carries infrastructure text with no
 * spec content in it". That was true when written and stopped being true the
 * moment a second content-interpolating throw site existed outside
 * validate.ts — lib/spec/mockupCompose.ts's "no fragment for screen" error
 * quoted a friend-derived screen id and, as a plain `Error`, sailed through
 * this function unredacted into the append-only `metrics` table. It is now a
 * `SpecShapeError` for exactly this reason. The actual invariant is narrower
 * and is on the WRITER, not the reader: every error that interpolates spec
 * content into its message must be a `SpecShapeError`, so it gets quoted with
 * double quotes (matching this function's redaction regex) and reaches this
 * function through that class. Anything added later that builds a message out
 * of a friend's own words — a screen id, a panel id, anything typed through
 * the chat surface — must follow that same convention or it will leak here
 * exactly as this one did.
 *
 * The retry path deliberately does NOT go through this: the model gets the
 * full message, quoted ids and all.
 *
 * EXPORTED FOR DIRECT TESTING, and that is the honest way to pin it: no
 * `SpecShapeError` reachable from `parseSpecChangeDraft` interpolates spec
 * content into its message (the change shape carries no ids, and every
 * message on that path is a field path plus a fixed enum list), so a
 * path-level test asserting a redacted metrics row would be fiction — it
 * would pass just as well against a function that redacted nothing. The
 * redaction is a standing guard on an append-only table nobody can correct,
 * which is exactly why it must not be one refactor away from silent deletion.
 * tests/spec/author.test.ts drives it directly instead.
 */
export function metricMessage(error: unknown): string {
  if (error instanceof SpecShapeError) return error.message.replace(/"[^"]*"/g, '"…"')
  return error instanceof Error ? error.message : String(error)
}

/**
 * What the writer is shown as the dashboard that exists.
 *
 * This USED TO render the current spec ROW — model output that no build ever
 * touched, so a second conversation was written against a prediction rather
 * than against the dashboard the friend actually has. That is the whole defect
 * this design exists to remove (design §0). Two arms now, not three: there is
 * one authoring path, because the base is a description rather than a
 * structure with ids to stabilise against.
 *
 * The absent arm is a real state, not a degraded one: an account whose
 * dashboard has not been built yet. Saying so explicitly gives the prompt the
 * same SHAPE on both paths rather than one with a section missing.
 */
function currentStateBlock(currentState: string | null): string {
  if (currentState === null) {
    return (
      'There is no dashboard for this account yet — nothing has been built. ' +
      'Everything you describe is new, so every entry in `changes` is an ' +
      '`add`.'
    )
  }
  return (
    'This is their dashboard as it exists right now, written by the builder ' +
    'after the last build. It is the truth about what is deployed — trust it ' +
    'over anything earlier in this conversation. Describe only what changes ' +
    'against it.\n\n' +
    currentState
  )
}

/**
 * The retry turn: the validator's own message, handed back so the model can
 * correct the exact thing that failed.
 *
 * Like "Write the change now." and the current-state block, this is a
 * CALL-TIME construct and is never appended to transcripts — it is not a
 * thing the friend said (design spec section 4.4).
 */
function retryMessage(problem: string): string {
  return (
    'That draft was rejected before it could be saved, by the validator that ' +
    'guards the record:\n\n' +
    `    ${problem}\n\n` +
    'Write the change again, as one object, with that problem fixed. Do not ' +
    'reply with prose, an apology, or only the part that changed.'
  )
}

/**
 * Write one proposal, or record why it could not be written.
 *
 * Returns undefined on EVERY failure path, expected or not — this function
 * never throws. It runs AFTER the chat turn's assistant row is already
 * appended, and a failed authoring call must not retroactively turn a
 * delivered reply into a failed turn: a throw here would propagate out of
 * runTurn into the route's ReadableStream AFTER the reply was already saved,
 * killing the stream with no `{done:true}`, no `controller.close()`, and no
 * failure metric anywhere to explain why.
 *
 * The whole body sits inside one outer try/catch specifically so a failure
 * with no dedicated branch — loadPrompt (PROMPT_DIR resolves against
 * process.cwd(), not guaranteed to be the repo root under systemd),
 * currentSpec, insertSpec, the version read-back, or the spec_proposed write
 * itself — still records a metric and returns undefined rather than escaping.
 * turn.ts additionally wraps its own call to this function as a second,
 * belt-and-braces layer.
 *
 * One model call: the change, retried once on a validation failure. As of the
 * mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task 4) there
 * is no second call drawing a preview from the validated draft — `insertSpec`
 * runs once the change validates, passing `mockupHtml: ''` for the NOT NULL
 * column that call used to fill (see the insertSpec call below for why the
 * column stays).
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
  // Which spec attempt produced the outcome. Every row this function writes
  // carries it, so the log distinguishes "the model got it right first time"
  // from "it took the retry". Zero means no spec call was made at all — the
  // only rows that can carry it are the outer catch's, for a failure that
  // struck before the loop.
  let attempt = 0
  // The change as PARSED, and undefined until an attempt validates. Declared
  // out here (not inside the try) for the same reason `result` is: the outer
  // catch reads it, so a failure AFTER a successful parse — insertSpec, the
  // version read-back, the spec_proposed append — still reports the count the
  // model actually produced instead of null.
  //
  // It can never go stale: the loop breaks in the same statement that assigns
  // it, so there is no iteration in which a previous attempt's count could
  // survive onto a later attempt's row. `metrics` rejects UPDATE, and that is
  // the failure mode this shape rules out by construction rather than by a
  // reset (the old `patch` variable needed one because parsePatch and
  // applyPatch were two steps and only the second one broke the loop).
  let draft: SpecChangeDraft | undefined

  try {
    const loaded = loadPrompt(SPEC_PROMPT)
    promptSha = loaded.sha
    const system = loaded.text

    // Named `metricBase`: the spread of fields every metrics row this function
    // writes carries.
    //
    // authoring_mode is a CONSTANT now — there is one authoring path — and it
    // is still written on every row. Dropping it would split the series at the
    // era boundary, which is the same reason contextFor still says 'tweak'
    // (unified-loop D11): a query grouping spec rows by mode must be able to
    // see 'patch', 'whole' and 'change' as three eras of one field rather
    // than as one field that stopped existing. `ops_count` is NOT kept the
    // same way: ops are gone, and a column that can only ever be null is a
    // lie in a table nobody can correct. `changes_count` replaces it — a
    // count, never a name, per the standing metrics bound.
    const metricBase = {
      model: CHAT_MODEL,
      effort: CHAT_EFFORT,
      prompt_sha: promptSha,
      context,
      authoring_mode: 'change' as const,
    }

    const history = toMessages(readTranscript(db, input.accountId))
    const last = history[history.length - 1]
    // The current-state block always goes, on both of its arms, so the prompt
    // has one shape on every path. "Write the change now." is appended ONLY
    // when the last transcript message is an assistant turn: on the usual path
    // the agent said something before calling the tool, so the call needs a
    // user message to answer. On the no-text path the friend's own message is
    // already there and a second instruction buys nothing.
    //
    // Neither is ever written to transcripts: both are call-time constructs,
    // not things the friend said (design spec section 4.4).
    const specMessages = [
      ...history,
      { role: 'user' as const, content: currentStateBlock(input.currentState) },
      ...(last?.role === 'assistant'
        ? [{ role: 'user' as const, content: 'Write the change now.' }]
        : []),
    ]

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
          schema: SPEC_CHANGE_JSON_SCHEMA,
        })
      } catch (error) {
        if (input.signal.aborted) {
          appendMetric(db, {
            accountId: input.accountId,
            event: 'spec_aborted',
            at: now(),
            data: {
              ...NO_USAGE,
              ...metricBase,
              ...NO_SERVED,
              attempt,
              // Nothing has parsed on this path — the call never returned —
              // so this is null, and it is null because `draft` says so
              // rather than because a literal was typed here.
              changes_count: draft?.changes.length ?? null,
            },
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
            ...metricBase,
            ...(shape.served ?? NO_SERVED),
            kind: shape.kind,
            status: shape.status,
            type: shape.type,
            attempt,
            changes_count: draft?.changes.length ?? null,
          },
        })
        return undefined
      }
      // Recorded for the outer catch as well — see the declaration above.
      result = proposed

      // ONE PARSE, one classification. There is no patch to apply, so the
      // `phase` discrimination this loop used to carry — `malformed_spec` vs
      // `patch_failed` — has nothing left to discriminate between: a change
      // draft either parses or it does not. Rows already carrying
      // `patch_failed` keep meaning exactly what they said; `metrics` rejects
      // UPDATE and nothing here rewrites history.
      try {
        draft = parseSpecChangeDraft(proposed.input)
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
            ...metricBase,
            ...proposed.served,
            kind: 'malformed_spec',
            status: null,
            type: null,
            attempt,
            message: metricMessage(error),
            // The parse this row is REPORTING is the one that just threw, so
            // there is no count to carry. `draft` is the value, not a typed
            // literal, so this cannot drift from what actually parsed.
            changes_count: draft?.changes.length ?? null,
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

    // The one place a SpecChange is constructed on this path, and the lineage
    // pointer comes from the RECORD, never from anything the model wrote:
    // `parseSpecChangeDraft` rejects a draft carrying one outright, because a
    // model-authored lineage pointer is a hallucination that becomes a
    // permanent wrong row in an append-only table (ledger D2).
    //
    // Re-read here rather than read once before the call, and the gap between
    // the two is the whole point. Everything before this line is the spec
    // call, which can run 47-97 seconds (see RunTurnInput.authoringSignal,
    // lib/chat/turn.ts) — authoring now runs in the BACKGROUND, decoupled from
    // the friend's own connection, so nothing stops them sending another
    // message, and triggering another authorSpec call, while this one is still
    // in flight. A friend who does that changes what the newest spec IS before
    // this call's insert lands, and a lineage pointer read before the call
    // would name the version this one superseded. `specs` rejects UPDATE, so
    // that row could never be repaired: the admin pane's diff for this version
    // would be computed against the wrong base forever.
    //
    // The build contract is "the newest spec" (nothing confirms any more), so
    // the base that means something is the one this version would supersede at
    // write time. That the writer was shown an older state is a separate fact,
    // and it is one the transcript and the prompt already carry.
    const sealed = sealChange(draft, currentSpec(db, input.accountId)?.version ?? null)

    // Read ONCE and used for both the row and the proposal that describes it.
    // Two calls to now() would put the proposal at a different moment from the
    // row it describes, and after a reload it would move.
    const at = now()
    const id = insertSpec(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      promptSha,
      payload: sealed,
      // specs.mockup_html is NOT NULL and `specs` rejects UPDATE — altering
      // the column would be schema surgery on an append-only table that
      // already holds real rows, which is out of scope for lib/db/reshape.ts
      // (proves zero rows first) and lib/db/migrate.ts (data-preserving
      // surgery) alike. '' is honest and readable instead: a row with
      // mockup_html = '' is one authored after the mockup-loop removal
      // (plan 2026-08-19-remove-the-mockup-loop, Task 4), not a row that
      // failed to get its preview.
      mockupHtml: '',
      at,
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
        ...metricBase,
        ...result.served,
        spec_id: id,
        version,
        attempt,
        changes_count: draft?.changes.length ?? null,
      },
    })

    return { id, version, at }
  } catch (error) {
    // Anything with no dedicated branch above. promptSha may or may not be
    // known depending on where this fired. result may or may not be known
    // too: NO_USAGE/NO_SERVED are honest only for a failure that struck
    // before client.propose() returned anything. If propose() already
    // succeeded — insertSpec, the version read-back, or the spec_proposed
    // append itself is what threw — result carries the real, billed
    // counters and those are what must be reported, not zero.
    //
    // `prompt_sha: null` is still a real possibility here and stays exactly as
    // it was: loadPrompt is the first thing the try does, and a failure inside
    // it means no prompt was ever chosen. Stamping SPEC_PROMPT's hash on that
    // row would claim a prompt was involved when none was, in a table that can
    // never be corrected.
    //
    // `authoring_mode` is NOT null-able the same way, and this is the one row
    // where that distinction has to be argued rather than spread in from
    // metricBase (which may not exist yet when this fires). It used to be
    // null here for a failure that struck before a mode was CHOSEN — mode
    // selection read the account's current spec, which could throw. Nothing
    // is chosen any more: there is exactly one authoring path, so 'change' is
    // known before a line of this function runs and is true of every row it
    // can possibly write, including one written by a loadPrompt failure.
    // Writing null instead would say "which era this row belongs to is
    // unknown", which is false, and would leave a permanent hole in the one
    // field that lets the patch/whole/change eras be read as one series.
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
        authoring_mode: 'change' as const,
        ...(result?.served ?? NO_SERVED),
        kind: 'unexpected_error',
        status: null,
        type: null,
        attempt,
        message: metricMessage(error),
        // Real on a failure AFTER the parse (insertSpec, the read-back, the
        // spec_proposed append), null before it. Either way it is the count
        // this call actually held, never a claim about one.
        changes_count: draft?.changes.length ?? null,
      },
    })
    return undefined
  }
}
