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

14. PRE-PASS TRANSCRIPTS ARE PLUMBING EVIDENCE ONLY, NOT PRODUCT EVIDENCE.
    `platform/prompts/agent-v1.md` is still the structural draft. Its sha is
    `e274e1d89eae`, and every transcript row written before the substantive
    pass carries that value — including the local checkpoint turn on
    2026-08-11 and anything produced by the droplet deploy that follows.
    Those rows are valid evidence that the plumbing works: streaming,
    conversation grouping, prompt-sha stamping, metrics shape, the admin
    pane. They are NOT evidence about the interview itself — the wording
    that decides whether a friend answers usefully has not been written yet.
    Nico's substantive pass lands before checkpoint sign-off, followed by one
    redeploy and a live chat turn confirming the new sha serves. Any read of
    interview quality must filter on `prompt_sha != 'e274e1d89eae'`; that is
    exactly the query the per-row sha exists to make possible.

---

## Operational findings from the first step-2 deploy (2026-08-11)

15. A DEPLOY REPORTED SUCCESS WHILE DEPLOYING NOTHING. The first run of
    `deploy.sh` after `main` moved to 705901a printed
    "Deployed 73971b8. Service is active and serving." Its `git pull
    --ff-only` fetched nothing and did not error, so every downstream gate —
    build, 243 tests, restart, smoke — passed truthfully against the OLD
    code. A later manual `git fetch` on the droplet retrieved
    `73971b8..705901a` without complaint, and the droplet's config was
    correct throughout (branch main, upstream origin/main, standard refspec,
    not shallow, no url rewrites). Root cause never proven — the original
    pull's output was not captured. Leading explanation is a stale ref
    advertisement served to an anonymous HTTPS fetch, which is transient.
    MITIGATION, cheap and reliable: read the `Deployed <sha>` line at
    deploy.sh:118 and confirm it matches the sha you pushed. That line is
    the only thing that distinguished "deployed successfully" from
    "successfully deployed nothing", and it is why this was caught at all.

16. THE FIRST LIVE CHAT TURN FAILED ON A MISSING `ANTHROPIC_API_KEY`, which
    was flagged twice before the deploy and believed already present. The
    deploy reported success regardless, because `smoke.sh` does not exercise
    `/api/chat`. Same failure class as item 15: a green deploy over a
    non-functional app. See the queued task below.

## Queued task — required-env presence check

Ruled by Nico on 2026-08-11, to run through the normal brainstorm -> spec ->
plan cycle as its own small task. NOT a blocker for the step-2 checkpoint.

Scope IN:
  - `deploy/required-env`: committed list of variable NAMES with one-line
    purposes, never values. One source of truth, replacing the separate
    lists that docs/local-dev.md and deploy/PROVISION.md maintain today and
    which will drift.
  - A check in `deploy.sh`, positioned AFTER the pull (so a deploy that
    introduces a requirement enforces it on itself — the same reasoning as
    the re-exec block at deploy.sh:51-56) and BEFORE `npm ci` (so a missing
    variable costs seconds, not a full build and test cycle). Reports
    missing NAMES only.
  - The equivalent check on local `npm run dev`, so a missing variable
    surfaces there rather than at a chat turn.

Scope OUT, deliberately:
  - Any sync of a local .env to the server. Rejected by Nico: it would cross
    the local/server boundary the privacy model keeps deliberate, and would
    put key material on a path that does not currently exist.
  - Validity checking. This verifies PRESENCE only; an expired or wrong key
    still passes and still fails at the first real request. Closing that gap
    means a live API call on every deploy — real money and a real session
    per deploy, for a rarer failure than a missing variable. Accepted limit.

Note: this modifies the deploy contract, which CLAUDE.md governs explicitly
and which has already produced one self-exempting bug (the deploy that first
shipped smoke.sh skipped its own gate). Design cycle, not improvisation.

CLOSED — commits b91fde5, c7939b5 (the list and its parser), cbb82d8 (the
deploy-time bash checker), 75cc1e5, 2f77f21 (deploy.sh gate, positioned
after the pull and before `npm ci`), c1170fc, e6e52be (the startup witness
in `instrumentation.ts`), and the docs commit that closes this entry
(`deploy/required-env` made the single source of truth in local-dev.md,
PROVISION.md, and CLAUDE.md, replacing the separate lists those two docs
used to maintain).

Items 15 and 16 above are two deploys that reported success over an app
that did not actually work. This task guards the configuration half of
that failure class. Item 16's cause — a missing `ANTHROPIC_API_KEY` —
is listed in `deploy/required-env` as `DEGRADED`, so a droplet that starts
without it now logs a `[env] missing DEGRADED: ANTHROPIC_API_KEY …` warning
at boot instead of staying silent until the first chat turn 503s; had it
been `REQUIRED`, the deploy itself would have aborted before `npm ci`.
Item 15's cause — a stale git ref that made `git pull` fetch nothing — is a
different failure class, unrelated to configuration, and is not addressed
by this task; it remains open on the mitigation already recorded there.

17. deploy sudo password unconfirmed after failed attempts through a
    no-terminal SSH path; verify with ssh -t + sudo -v at next maintenance;
    deploys unaffected (NOPASSWD grant).

## Queued task — cache the conversation history, not just the system prompt

Ruled by Nico on 2026-08-11 after the first live turns. To be done at some
point; explicitly NOT a blocker for the step-2 checkpoint.

`cache_control: ephemeral` currently sits on the system block only, so the
page-length prompt rides at cache-read rates while the entire conversation
history is resent uncached on every turn. Measured on the droplet's first
two turns: turn one ~743 total input tokens (12 uncached + 731 cache write),
turn two ~916 (185 uncached + 731 cache read). The 185 is the turn-one
exchange plus the turn-two message, at full price.

That is a linear cost curve against conversation length, and the pilot's
whole thesis is friends still chatting at week three — so the curve matters
exactly where the product is trying to succeed.

Likely shape: a second cache breakpoint on the last message of the history,
so the growing prefix caches too. Constraints to respect when designing it:
the API allows at most 4 breakpoints per request; the cached prefix must be
byte-stable, so anything volatile placed ahead of it silently invalidates
everything after; and the minimum cacheable prefix on claude-opus-5 is 512
tokens, which the system prompt already clears on its own. Verify with
`usage.cache_read_input_tokens` — if it does not rise with conversation
length after the change, the breakpoint is in the wrong place.

---

## Step 2 checkpoint: SIGNED OFF COMPLETE (2026-08-11, Nico)

architecture-overview.md line 146 — "Dev user chats with the bot; transcript
appears in admin" — both halves verified live on app.stairwell.run at
commit 705901a:
  - dev user chatted, reply streamed, two turns persisted
  - transcript renders in the admin pane, grouped under conversation
    2ef318b3, prompt_sha on every turn
Plus, confirmed live rather than only in tests: prompt caching
(cache_creation 731 -> cache_read 731), the C1 empty-reply fix (a second
turn succeeded, so no poisoning row), I5 (two chat_error rows with
kind: no_api_key recorded a total outage that would previously have written
nothing), and the two-tier lock across a real service restart.

### Waiver: prompt pass no longer gates sign-off

Nico's earlier condition was that his substantive agent-v1.md pass land
before checkpoint sign-off. WAIVED by him on 2026-08-11. The pass moves to
a holistic prompt strategy session, to happen before test user #1 at the
latest. The structural draft stays live in the meantime.

This is safe because item 14 already marks every draft-era transcript
(prompt_sha e274e1d89eae) as plumbing evidence and explicitly not evidence
about interview quality. The waiver changes when the prompt is written, not
whether the record can tell the two eras apart — which is what the per-row
content hash was for.

### Deliberately deferred: plumbing checks 3 and 5

Check 3, ABORT. Close the tab mid-stream and confirm a stream_aborted row
appears. Deferred, and folded into the verification turn of whichever
deploy comes next: tab-close mid-stream, then a fresh turn. The open
question is whether Next propagates client disconnect to request.signal at
all. If it does not, stream_aborted never fires in production and the event
is dead code — worth knowing, but it changes nothing today, and an event
that never fires cannot write a wrong row.

Check 5, THE 30-MINUTE BOUNDARY. Send, wait 31 real minutes, send again,
confirm two conversations. Deferred on cost/benefit: the rule is unit-tested
including the exactly-at-the-gap case that an off-by-one would break, and
production has already confirmed the same-conversation half (four rows, one
conversation_id). Only the new-conversation half is untested live, and it
costs 31 minutes of wall clock to test. Step 3 will exercise it incidentally
and continuously, because its alert fires precisely when a new
conversation_id is minted.
