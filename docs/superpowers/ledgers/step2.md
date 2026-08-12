# SDD ledger — plan: docs/superpowers/plans/2026-08-11-step2-chat-and-transcripts.md

Branch: step2-chat-design
Spec: docs/superpowers/specs/2026-08-11-step2-chat-and-transcripts-design.md

--- RESIDUALS — recorded, not all adjudicated ---

1. `conversationIdFor` RACE (spec §8) — KNOWN-UNHANDLED, Nico's ruling, not an
   oversight. Two concurrent turns from one account can both read the same
   last row and disagree on the boundary. Damage is bounded: a mis-grouped
   row, never a lost one. No lock, no serialization added for this.

2. PARTIAL REPLIES ARE INVISIBLE IN THE TRANSCRIPT (spec §3.4) — deliberate.
   If a reply is interrupted mid-stream, the transcript does not carry the
   partial text; the interrupted marker on the row is the mitigation, not a
   gap to close.

3. NO RATE LIMITING (spec §8). `max_tokens` bounds the size of one reply;
   nothing bounds how many turns an account can send in a day.

4. `putKey` OVERWRITE DOES NOT ZERO THE REPLACED BUFFER — carried forward
   from step 1a, noted in `lib/session/keymap.ts:17`. Still open; not
   touched by step 2.

5. `context` IS HARDCODED TO THE LITERAL `'interview'`. It is written into
   append-only `transcripts` rows, so this is correct only until step 4
   ships spec confirmation — at that point `context` must be set from
   whether a confirmed spec exists for the account, and it becomes wrong the
   moment that ships. Rows written before that change will always read
   `'interview'`, permanently: transcripts are sacred data (CLAUDE.md >
   Sacred data) and are never migrated or rewritten to backfill the correct
   value. Step 4 must set `context` going forward; it cannot correct history.

---

## Residual risks from the final whole-branch review

Added after the final review and its fix wave. Items 1-5 above were recorded
before that review ran; these are what survived it.

6. `lib/chat/client.ts` — THE MISSING-CREDENTIAL GUARD HAS UNDISCLOSED FALSE
   POSITIVES. It raises `MissingCredentialError` when both `sdk.apiKey` and
   `sdk.authToken` are null. Three legitimate credential paths leave both
   fields null and would wrongly 503: an `ant auth login` OAuth profile,
   Workload Identity Federation (`ANTHROPIC_FEDERATION_RULE_ID` +
   `ANTHROPIC_IDENTITY_TOKEN[_FILE]`), and the function form of `apiKey`
   (`ApiKeySetter`), whose value the SDK constructor stores as null. None
   fires for this deployment, which authenticates with `ANTHROPIC_API_KEY`
   from the systemd EnvironmentFile. The realistic trip is a developer who
   authenticated with `ant auth login` and has no env var set: chat 503s for
   them where it previously worked.

7. `lib/chat/client.ts` — TWO COMMENTS STATE MECHANISMS THAT ARE FALSE.
   (a) The credential guard's comment says an unauthenticated request "goes
   out and fails 401 mid-stream". It does not: the SDK throws locally in
   `validateHeaders` before any request is sent. The 503 behaviour is right;
   the explanation is not, and it is the only record of why the guard exists.
   (b) The fallback-signal comment claims sticky routing is not consulted on
   streams so the block and `usage.iterations` always agree. The SDK's own
   docs say a fallback with no preceding declining model carries no block.
   Completed-turn metrics are still correct because the code ORs both
   signals; the consequence is confined to `chat_error`, where a mid-stream
   failure after a block-less fallback records `fallback_fired: false`.

8. `app/api/chat/route.ts` — THE `no_api_key` ROW IS A SECOND `chat_error`
   SHAPE. It emits `{model, effort, context, kind, status, type}` while spec
   §2.5 documents `chat_error` as also carrying the four counters,
   `prompt_sha`, `model_served`, `fallback_fired`, and `delivered_chars`.
   Because `metrics` is append-only, anyone later grouping `chat_error` rows
   by `prompt_sha` silently drops these. Aligning the shape only gets more
   expensive as rows accumulate.

9. `metrics` — `stream_aborted` DOES NOT CARRY `model_served` OR
   `fallback_fired`, while the other three chat events do. An aborted turn
   has real billed tokens (that is why it carries counters at all), and if a
   fallback served it those tokens were billed at a different model's rate;
   without the field they are silently priced as `CHAT_MODEL`. Append-only
   means adding the field later creates two eras of `stream_aborted` rows
   that cannot be reconciled. Cheapest to fix before the first real traffic.

   CLOSED — commit 1478481. `stream_aborted` now spreads the same `served`
   in-stream accumulator `chat_error` already reads, so it carries the real
   values if a fallback fired before the abort, or the honest seeded default
   (requested model, no fallback) if nothing was known yet.

10. `lib/chat/client.ts` — THE MODULE HAS NO TESTS OF ITS OWN. `anthropicClient`
    takes an injectable `sdk`, so this is cheap to close. Three fix-critical
    seams are uncovered: the `MissingCredentialError` condition (deleting the
    guard breaks no test, because the route test throws it from a mock), the
    `catch` that wraps SDK errors into `ChatStreamError`, and the extraction
    of `model_served` / `fallback_fired`. C2's error MAPPING is well covered;
    the seam that calls it is not.

11. `tests/chat/prompt.test.ts` — THE FORBIDDEN-TERM REGEX MISSES `401(k)`.
    It matches `401k`, `401-k`, and `401 k`, but not the parenthesised form,
    which is how the term is usually written. This test exists to survive a
    substantive rewrite of `platform/prompts/agent-v1.md`, and that rewrite
    is more likely to produce `401(k)` than `401k`. Worth widening before the
    rewrite rather than after.

    CLOSED — commit 1d9506e. Pattern widened to also match `401(k)`, proven
    by a test that asserts the pattern itself matches the parenthesised form.

12. THE REFUSAL-FALLBACK PATH HAS NEVER RUN LIVE. `fallbacks: 'default'` and
    the `server-side-fallback-2026-07-01` beta flag are typed and fake-tested,
    but `AnthropicBeta` is `(string & {}) | 'literal' | …`, so ANY string
    typechecks as a beta flag — `tsc` clean is not evidence the flag string is
    right. `deploy/smoke.sh` does not exercise `/api/chat`, so a malformed
    pairing would 400 only on a real user's turn. One manual chat turn after
    deploy, watching for a `chat_error` with `kind: 'bad_request'`, is a
    required post-deploy step, not a suggestion.

13. `lib/chat/history.ts` — HISTORY IS REBUILT AS PLAIN TEXT, so thinking
    blocks are never echoed back on same-model continuation. Thinking is on
    by default on `claude-opus-5`, and the SDK warns that stripping thinking
    blocks can trigger ordering/signature 400s. Not exercised today because
    `display` defaults to `"omitted"`, but raising `MAX_TOKENS` to 64000
    makes long thinking turns more likely. Worth checking before step 3.
