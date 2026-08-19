// lib/spec/author.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { currentSpec, insertSpec, readSpecs, type SpecRecord } from '@/lib/db/specs'
import { toMessages } from '@/lib/chat/history'
import { SPEC_PATCH_PROMPT, SPEC_PROMPT, loadPrompt } from '@/lib/chat/prompt'
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
import { SPEC_JSON_SCHEMA, SpecShapeError, type SpecDraft } from './schema'
import { parseSpecDraft, sealVersion } from './validate'
import { renderLegacyMarkdown } from './render'
import { readStoredSpec, type StoredSpec } from './stored'
import { applyPatch, parsePatch, PATCH_JSON_SCHEMA, type SpecPatch } from './patch'

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
  /**
   * The spec row's own timestamp, so the card can be placed in conversation
   * order rather than collected at the bottom (onboarding ledger D5).
   */
  at: number
  spec: StoredSpec
  // mockup_html, preview_html and first all lived here through the mockup
  // loop and are gone as of the mockup-loop removal (plan
  // 2026-08-19-remove-the-mockup-loop, Task 4): the card that rendered a
  // preview and read `first` for its delivery promise no longer exists
  // (Task 2), and this function no longer draws a preview to describe (this
  // task). `mockup_html` and `preview_html` were the composed document and
  // the scoped-to-what-changed excerpt of it; `first` was whether this was
  // the account's first-ever dashboard. specs.mockup_html the COLUMN stays —
  // see the insertSpec call below — this is only the field that used to
  // carry its value on the returned proposal.
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
 */
function metricMessage(error: unknown): string {
  if (error instanceof SpecShapeError) return error.message.replace(/"[^"]*"/g, '"…"')
  return error instanceof Error ? error.message : String(error)
}

/**
 * The one pair every metrics row this module writes carries: which shape the
 * writer was asked for, and how many ops it proposed. Factored out narrowly —
 * unified-loop ledger residual 10 predicted this file's five hand-built
 * `appendMetric` sites would need a builder once a sixth arrived, and Task 13
 * added a sixth (`mockup_failed`, for the mockup call's own failure mode).
 * The mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task 4)
 * deleted that site along with the call it reported on, leaving five again.
 * This pair is pure mechanical repetition with no per-site decision in it,
 * so pulling it out costs nothing.
 *
 * Deliberately NOT a wrapper around appendMetric itself: `spec_aborted`
 * reports honest zeros on purpose, `kind` is computed differently at every
 * site, and `message` is present at some and absent at others. Residual 10's
 * own reasoning is that factoring those would either push them back out to
 * the call sites anyway, or quietly make one site's rule the default for all
 * of them — exactly the hiding of distinctions it was written to prevent.
 * This helper stops at the one pair that has no such distinction to hide.
 *
 * `ops_count` is a COUNT, never the ops themselves: `metrics` is append-only
 * and the standing bound is counts, never content — an op carries panel ids
 * derived from what the friend asked for. `patch` must be THIS attempt's
 * parse outcome, not a stale one — see the reset at the top of the attempt
 * loop below.
 */
function modeFields(
  mode: 'patch' | 'whole' | null,
  patch: SpecPatch | undefined,
): { authoring_mode: 'patch' | 'whole' | null; ops_count: number | null } {
  return { authoring_mode: mode, ops_count: patch?.ops.length ?? null }
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
      // currentSpec now returns the newest row whether or not it was ever
      // confirmed, so confirmed_at CAN genuinely be null here — this
      // fallback used to be defensive-only (the type said null was possible;
      // currentSpec never actually produced it) and is now a real path.
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
 * One model call: the spec, retried once on a validation failure. As of the
 * mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task 4) there
 * is no second call drawing a preview from the validated draft — `insertSpec`
 * runs once the spec validates, passing `mockupHtml: ''` for the NOT NULL
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
  // WHICH SHAPE THE WRITER WAS ASKED FOR, and read by the outer catch too —
  // same reason as promptSha. null is a real, meaningful third value here,
  // not a missing one: it means the call failed BEFORE mode was decided
  // (currentSpec or readStoredSpec threw), which is exactly the case where
  // no prompt was chosen either — see the prompt_sha comment on the outer
  // catch below. Do not default this to 'whole'; that would assert a mode
  // was chosen when none was, in a row that can never be corrected.
  let mode: 'patch' | 'whole' | null = null
  // The ops as PARSED on a patch attempt, undefined on a whole-surface
  // attempt or before any attempt has parsed successfully. Read by every
  // metrics site in this function, including the outer catch, for the same
  // reason mode is: an op count on an error row is what lets a query group
  // ANY row — success or failure — by how expensive patch authoring turned
  // out to be.
  let patch: SpecPatch | undefined

  try {
    // What the writer is SHOWN as the current confirmed version. Read here
    // because that is when the prompt is built; the lineage pointer stored on
    // the row is read again at write time instead, and the two reads are
    // deliberately separate — see sealVersion below.
    const current = currentSpec(db, input.accountId)

    /**
     * WHICH SHAPE THE WRITER IS ASKED FOR — and it is decided in the same place
     * that already decides what the writer is SHOWN (currentVersionBlock's three
     * arms), so the two can never disagree about which era this account is in.
     *
     * `patch` only when there is a confirmed row AND it is in the current shape.
     * Both other arms author the whole surface:
     *
     *   - v1 has no base to patch, and the first-ever conversation is the one
     *     thing this may not change (unified-loop §7 R3). Same prompt, same
     *     schema, same code as before this existed.
     *   - a LEGACY row carries no ids, so there is nothing for an op to name.
     *     `specs` rejects UPDATE, so it can never gain any. That account authors
     *     whole-surface exactly once and is on the patch path from its next
     *     version.
     */
    const storedCurrent = current === undefined ? undefined : readStoredSpec(current.payload)
    const base =
      storedCurrent !== undefined && storedCurrent.kind === 'version'
        ? storedCurrent.version
        : undefined
    mode = base === undefined ? 'whole' : 'patch'

    const loaded = loadPrompt(mode === 'patch' ? SPEC_PATCH_PROMPT : SPEC_PROMPT)
    promptSha = loaded.sha
    const system = loaded.text
    const schema = mode === 'patch' ? PATCH_JSON_SCHEMA : SPEC_JSON_SCHEMA

    // Named `metricBase`, not `base`: `base` above is the SpecVersion a patch
    // applies against, and this is a different thing that happens to share
    // the obvious name — the spread of fields every metrics row this
    // function writes carries.
    const metricBase = {
      model: CHAT_MODEL,
      effort: CHAT_EFFORT,
      prompt_sha: promptSha,
      context,
    }

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
      // Reset per attempt, not just declared once: `patch` must reflect only
      // THIS attempt's parse outcome. Without this reset an attempt that
      // never reaches (or never completes) parsePatch — a network error, an
      // abort, or a reply that fails to parse at all — would report
      // ops_count from an EARLIER attempt's successfully-parsed-but-
      // inapplicable patch onto a row that never held one. That is a
      // permanently wrong row: `metrics` rejects UPDATE. The post-loop uses
      // (sealVersion, spec_proposed) are unaffected — they run only after the
      // winning attempt reassigned `patch` in that same iteration.
      patch = undefined
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
          schema,
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
              ...modeFields(mode, patch),
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
            ...modeFields(mode, patch),
          },
        })
        return undefined
      }
      // Recorded for the outer catch as well — see the declaration above.
      result = proposed

      // WHICH PHASE FAILED IS THE CLASSIFICATION — not which error class was
      // thrown. Ruled at Task 9's re-review, and it is the whole reason the
      // metrics kinds can be trusted.
      //
      // The tempting version discriminates on `error instanceof SpecPatchError`.
      // That silently misclassifies, because the shape checks inside a patch are
      // shared with the whole-surface path: a malformed `order` in an
      // update_screen op, a non-string in `open_questions`, and any bad nested
      // panel all reach `fields.ts` helpers that throw the BASE class. Those
      // rows would land in an append-only log as `malformed_spec` forever, and
      // `metrics` rejects UPDATE.
      //
      // Phase cannot be got wrong, because it is not inferred: parsing failed,
      // or applying failed, and the code knows which one it was standing in.
      // The meanings come out clean too — `malformed_spec` is "the model
      // returned the wrong shape", `patch_failed` is "the shape was right and
      // it would not apply to this base", which is the genuinely new failure
      // mode worth watching.
      let phase: 'malformed_spec' | 'patch_failed' = 'malformed_spec'
      try {
        // `base !== undefined` is the whole condition: `mode` is DERIVED from
        // it above (`mode = base === undefined ? 'whole' : 'patch'`), so the
        // two can never disagree — checking `mode === 'patch'` here too would
        // be redundant. Kept as this narrowing form (not `mode === 'patch'`)
        // because it is what lets the compiler prove `base` is a SpecVersion
        // at the applyPatch call below, without a non-null assertion.
        if (base !== undefined) {
          patch = parsePatch(proposed.input)
          phase = 'patch_failed'
          draft = applyPatch(base, patch)
        } else {
          draft = parseSpecDraft(proposed.input)
        }
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
            // Set above, before the call that can fail. See the phase comment.
            kind: phase,
            status: null,
            type: null,
            attempt,
            message: metricMessage(error),
            ...modeFields(mode, patch),
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

    // The one place a SpecVersion is constructed on this path, and the lineage
    // pointer comes from the RECORD, never from anything the model wrote:
    // `parseSpecDraft` rejects a draft carrying one outright, because a
    // model-authored lineage pointer is a hallucination that becomes a
    // permanent wrong row in an append-only table (ledger D2).
    //
    // Re-read here rather than reused from the `current` above, and the gap
    // between the two is the whole point. Everything between them is the spec
    // call, which can run past a minute, and the confirm buttons on the card
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
    const sealed = sealVersion(
      draft,
      currentSpec(db, input.accountId)?.version ?? null,
      // The ops as PARSED, never as the model returned them: parsePatch is what
      // turned a reply into a value, and the row must carry the thing the
      // applier actually acted on.
      patch?.ops ?? null,
    )

    // Read ONCE and used for both the row and the proposal that describes it.
    // Two calls to now() would put the card at a different moment from the row
    // it renders, and after a reload the card would move.
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
        ...modeFields(mode, patch),
      },
    })

    return {
      id,
      version,
      at,
      // `version`, because that is what this path genuinely produced:
      // parseSpecDraft validated the whole-surface shape and sealVersion
      // attached the server's lineage pointer. The tag is a statement of fact
      // about the payload.
      spec: { kind: 'version', version: sealed },
    }
  } catch (error) {
    // Anything with no dedicated branch above. promptSha may or may not be
    // known depending on where this fired. result may or may not be known
    // too: NO_USAGE/NO_SERVED are honest only for a failure that struck
    // before client.propose() returned anything. If propose() already
    // succeeded — insertSpec, the version read-back, or the spec_proposed
    // append itself is what threw — result carries the real, billed
    // counters and those are what must be reported, not zero.
    //
    // The message goes through metricMessage for a reason that is easy to
    // miss: currentVersionBlock reads the CURRENT spec, so a stored row that
    // no longer validates throws a SpecShapeError quoting ids out of THAT
    // spec, and it lands right here.
    //
    // `prompt_sha: null` paired with `authoring_mode: null` is not a gap —
    // it is the honest value for a call that failed before any prompt was
    // chosen. Mode selection now reads the account's current spec (to decide
    // patch vs whole) BEFORE loadPrompt runs, so a stored current-version row
    // that no longer validates — the same failure the paragraph above
    // describes — throws here with no mode ever decided and no prompt ever
    // loaded. Stamping SPEC_PROMPT's hash on that row would claim a prompt
    // was involved when none was, in a table that can never be corrected.
    // Null is the honest answer to "which prompt", the same way it is the
    // honest answer to "which mode".
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
        ...modeFields(mode, patch),
      },
    })
    return undefined
  }
}
