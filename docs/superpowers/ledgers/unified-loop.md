# Unified proposal loop — decisions ledger

Spec: `docs/superpowers/specs/2026-08-13-unified-proposal-loop/` (three handoff files)
Plan: `docs/superpowers/plans/2026-08-13-unified-proposal-loop.md`
Branch: `unified-proposal-loop`, 31 commits, `94c540d..4c5f6f4`.

Opened **before** the build to record the §7 resolutions and the rulings the plan
depends on; "Built" and "Residual risks" written after it landed.

---

## §7 resolutions — the three assumptions the handoff could not check

### R1. `propose_spec` is SIGNAL-ONLY, and stays that way

**Resolved against `lib/chat/client.ts:99-120`.** `PROPOSE_TOOL` has a literally
empty `input_schema` (`properties: {}`, `required: []`). The tool is a hand-raise;
the spec is authored by a **second** call (`lib/spec/author.ts` → `client.propose()`)
using structured outputs (`output_config.format` with `SPEC_JSON_SCHEMA`), not by a
forced tool.

The reason it is payload-free is recorded in the code and still holds: a
payload-carrying tool would force `stream()` to accumulate a ~5KB mockup out of
`input_json_delta` events *while* it is pushing text to a friend's screen.

**Ruling: keep it.** §3 of file 02 explicitly permits keeping the current shape when
it can satisfy the validation requirement, and it can. The only change to the tool is
its `description` string, which currently says "the interview has enough" — wording
that encodes exactly the interview/tweak distinction file 01 removes.

### R2. Specs are ALREADY structured-payload-first — no storage migration

**Resolved against `platform/schema.sql:88-96`, `lib/db/specs.ts`, `lib/spec/schema.ts`,
`lib/spec/render.ts`, `scripts/export-spec.ts`.**

`specs.payload` is a TEXT column holding JSON, validated on write by
`parseSpecInput` and re-validated on read by `parseSpecPayload`. `mockup_html` is its
own column. `spec.md` is *rendered* from the payload by `renderSpecMarkdown` at
export time — the file in `users/<slug>/spec.md` even carries a "Generated … do not
hand-edit" banner.

This is precisely the architecture `03-spec-schema.md` assumes. **No markdown-first
migration exists to do.** What changes is the *shape* of the JSON inside that column,
which needs no DDL: the column is TEXT and stays TEXT.

**Consequence for the frozen-fields residual (step-4 ledger residual 4):** that
residual said "the six spec fields are frozen" because `specs` sits outside
`lib/db/reshape.ts` and CLAUDE.md forbids widening that exception. It was about
**columns**, not about the JSON inside `payload`. This change adds no column, so the
exception is not widened. The residual stands unchanged.

### R3. Version-1-from-empty-spec IS behavior-preserving — but only if three things hold

**Resolved by tracing `app/api/chat/route.ts` → `runTurn` → `authorSpec` →
`insertSpec` → the `proposal` NDJSON line → `SpecCard`.**

For the first-ever conversation nothing about the *mechanism* changes: same tool,
same second call, same append, same card, same two buttons, same
`spec_confirmed` → ntfy. The three things the plan must hold to keep the *experience*
identical are:

1. The card still leads with a title and a one-paragraph description. The new schema
   has neither at top level (see D1) — so both are retained.
2. `authorSpec`'s new "here is the current confirmed version" input must degrade to an
   explicit *"this is the first version; the current spec is empty"* rather than being
   omitted, so the writer's prompt is never a different shape on the v1 path.
3. The delivery promise on the card must still say "tomorrow morning" for a
   first dashboard (see D9).

---

## Rulings

### D1. `title`, `summary`, and `background` are RETAINED; `manual_logging` is dropped

`03-spec-schema.md` lists neither `title` nor `summary` nor `background` on
`SpecVersion`. It does not say to *remove* them — it is silent, and file 02's own
precedence rule says "where it is silent, existing conventions stand."

All three have live consumers that break without them:

- `title` — the H1 of `spec.md` (`lib/spec/render.ts:54`), the `<h3>` of `SpecCard`,
  the `<h4>` and iframe title of the admin pane. A whole-surface spec with no name
  for the dashboard is a worse build contract, not a leaner one.
- `summary` — `change_summary` answers *what changed*; nothing else answers *what
  this dashboard is*. At v5 a card that leads with "renamed the eating-out panel" and
  says nothing else is not a description of a dashboard. Retained as the
  whole-surface description; `change_summary` is added alongside it, not instead.
- `background` — the residue about the person that did not become a panel. Step-4
  ledger residual 3 calls it "the one spec field that can be wrong rather than
  merely incomplete," which is an argument for handling it carefully, not for
  deleting the only place that information lives.

`manual_logging` **is** dropped: it is genuinely superseded, since per-value
`kind: "entered"` descriptions and `EntryWidget` carry strictly more. `spec.md`
renders an "Entered by hand" section derived from the entered values instead.

### D2. `version` stays DERIVED; `based_on_version` is SERVER-SUPPLIED, never model-authored

`03-spec-schema.md` puts `version` on the payload, annotated "assigned by the server
on append." In this repo the server already assigns it — by *position*
(`lib/db/specs.ts:76`), never storing it, "so it can neither drift nor race."

**Ruling: do not store `version` in the payload.** Storing it would create a second
source of truth for a number already stamped into append-only `spec_proposed` and
`spec_confirmed` metric rows and into `users/devtwo/spec.md`.

**Ruling: `based_on_version` is injected by `authorSpec`, not emitted by the model.**
It is omitted from `SPEC_JSON_SCHEMA` entirely and set from
`currentSpec(db, accountId)?.version ?? null`. A model-authored lineage pointer is a
hallucination waiting to become a permanent row in an append-only table; a
server-computed one cannot be hallucinated.

**It can, however, be stale — so it is read at WRITE time, immediately before
`sealVersion`, not before the authoring call.** Added in the pre-merge fix round.
Authoring is two model calls that can run three minutes, and `ChatPanel`'s confirm
buttons are gated by `confirming`, not by `busy`: the card already on screen stays
clickable for that entire wait. A friend who presses "Build this" while watching
"Putting together a preview…" changes which version is newest-confirmed, and a
pointer read before the call would name the version that confirmation superseded —
permanently, in a table that rejects UPDATE, corrupting the admin pane's diff and the
`spec_confirmed` counts for that version forever.

The version handed to the WRITER is still read before the call, because that is when
the prompt is built; the two reads are deliberately separate. A version is a
whole-surface spec and the build contract is "the newest confirmed version", so the
base that means something is the one this version supersedes when confirmed — the
record at write time. What the writer was shown is a different fact, and the
transcript already carries it.

### D3. Version numbering counts PROPOSALS, not confirmations — and that is kept

`readSpecs` numbers every proposal by position, so a rejected proposal consumes a
number. File 02 §2 talks as though version N+1 follows each *confirmed* version.

**Ruling: keep proposal-position numbering.** Renumbering would rewrite the meaning
of `version` in metric rows that are append-only and already written, and in
`users/devtwo/spec.md`, which says "v1". The confirmed lineage is walked through
`based_on_version` instead — which is what makes the metrics diff confirmed-to-confirmed
even though the numbering is not. A rejected proposal diffs against the same base,
which is also the honest answer: it records what was offered and declined.

### D4. Legacy-marking, not backfill — and this is FORCED, not chosen

`03-spec-schema.md` offers a choice: backfill old specs into the new schema, or mark
them legacy. **The backfill branch is unavailable in this codebase**, and the handoff
author could not have known that:

- `specs` has `specs_no_update` and `specs_no_delete` triggers
  (`platform/schema.sql:112-122`). A row cannot be rewritten in place. Full stop.
- Appending a corrected row instead would fabricate a proposal the friend never saw,
  in an append-only log; it would take the next version number, become "newest," and
  therefore make the *real* confirmation stale — `app/api/spec/confirm/route.ts:57`
  only allows confirming the newest.

**Ruling: pre-schema rows are read as legacy, forever.** `lib/spec/stored.ts`
discriminates on the presence of a `screens` array and returns a tagged union; every
consumer handles both arms. `devtwo`'s confirmed v1 keeps rendering exactly as it does
today, and their next confirmed proposal is v2 in the new shape with
`based_on_version: 1`. Version numbering stays continuous, as the migration note
requires.

### D5. No zod — hand-written validators, in the repo's existing style

`03-spec-schema.md` says to use "whatever the repo already uses (zod is the natural
fit)". The repo already uses hand-written parsers with a `SpecShapeError` carrying a
prose message (`lib/spec/schema.ts`), and has zero validation dependencies.

Four reasons the parenthetical loses to the instruction:

1. `SPEC_JSON_SCHEMA` must exist as literal JSON Schema regardless — it is a request
   parameter for `output_config.format`. zod would either need `zod-to-json-schema`
   (a second dependency) or leave the JSON Schema hand-maintained anyway, so zod
   buys one of the two artifacts and costs a dependency.
2. The validator's message becomes **retry feedback fed back to the model** (D6). A
   hand-written `panels[2].source is not one of plaid, manual, derived` is better
   feedback than a zod issue path.
3. Every cross-field invariant `03` asks for (unique ids, `inputs` resolve,
   `annotates` points at a `synced` value) needs `superRefine` in zod — i.e. hand-written
   predicates either way.
4. Precedent: step-4 ledger residual 1 records that jsdom and testing-library were
   disallowed as new dependencies for this project. The bar applies here too.

**Discretion exercised, flagged to Nico.** Reversible: swapping in zod later touches
one module.

### D6. Validation retry: exactly ONE, and only for a schema failure

File 02 §3: "Validation failure is loud — retry the generation call with the
validation error; never fall back to unvalidated output."

**Ruling: `MAX_SPEC_ATTEMPTS = 2`.** The retry appends a user message carrying the
validator's own message and re-runs. Bounds and reasoning:

- Retry fires **only** on `SpecShapeError`. `truncated_spec`, `unparsable_spec`, and
  every API error keep today's behavior (one `spec_error`, return undefined). A
  validation failure means a complete JSON object came back, so the retry costs a
  normal authoring latency — not another 180-second timeout.
- **Every attempt writes its own metric row.** A failed attempt appends `spec_error`
  with `kind: 'malformed_spec'` and a new `attempt` field; the successful one appends
  `spec_proposed` with the same field. This is not optional: a call that returned
  spent real, billed tokens, and this project's standing rule is that a cost log
  reporting zero for a billed turn is fiction.
- The retry messages are **never written to transcripts** — same rule as the existing
  `"Write the spec now."` construct (`lib/spec/author.ts:104`): a call-time construct
  is not a thing the friend said.
- `input.signal.aborted` is checked before the retry.

### D7. Spec and mockup SPLIT into two calls

Today one structured-output call returns the payload *and* `mockup_html` in the same
object. File 02 §3 asks for mockup generation to be "a separate, independently
re-runnable step, consuming the validated spec version."

**Ruling: split.** The load-bearing reason is not token budget — it is that a mockup
generated *alongside* a payload can disagree with it. Under the unified loop the card
leads with what changed and shows the mockup; a mockup showing a panel the spec does
not contain is a promise made on the friend's behalf. Consuming the *validated*
payload makes that class of drift impossible.

**What "independently re-runnable" can and cannot mean here** — a code-visible
constraint the handoff author could not see: it cannot mean "replace a stored row's
mockup," because `specs` rejects UPDATE. It means the mockup call is a separately
callable function, re-runnable *within* an authoring attempt. Both calls complete
before a single `insertSpec`, so `mockup_html NOT NULL` stays honest and no spec row
ever exists without its mockup. A mockup-call failure is a `spec_error` of new kind
`mockup_failed` and writes no row.

### D8. The internal critique pass is DEFERRED

File 02 §3 marks it "recommended, small, and optional if it threatens the timeline"
and asks that a skip be noted here.

**Ruling: skipped.** It is a third model call per proposal *and* a new conversational
behavior — the agent asking 1–3 questions in chat mid-proposal. That directly
competes with the behavior-preserving requirement for the first-ever conversation,
which is the one thing this refactor is not allowed to change. The validation-retry
gate (D6) is non-negotiable and ships; the critique pass is the droppable one, and
this is the drop. Named place to add it later: between `parseSpecDraft` succeeding
and the mockup call in `lib/spec/author.ts`.

### D9. `DELIVERY_LINE` becomes proportional — a conflict only the code shows

`app/[user]/ChatPanel.tsx:299` hard-codes one promise on every card:

> "Your dashboard gets built as soon as possible — at the latest, it'll be here
> tomorrow morning."

It is deliberately fixed chrome, not agent prose, "because it is the most load-bearing
promise in the pilot and it is made at the exact moment the friend decides."

Under the unified loop that same line now appears when someone asks to relabel one
number — where file 01 promises "small changes usually land within a few hours."
The card would contradict the agent, on the sentence the step-4 build went out of its
way to make un-driftable.

**Ruling: two constants, both fixed chrome, chosen by whether this is the account's
first confirmed version.** `DELIVERY_FIRST` keeps today's wording verbatim (so the
v1 path is byte-identical); `DELIVERY_CHANGE` reads "This gets built as soon as
possible — small changes usually land within a few hours."

**Amended twice during the build, and the second amendment matters most.** The
selector is `hasConfirmedSpecBelow(db, accountId, version)` — "is there a confirmed
spec BELOW this card's version" — not `hasConfirmedSpec`. The unbounded question
made a friend's own first dashboard switch to "a few hours" the moment they
confirmed it and reloaded.

And the answer **rides on the proposal itself**, computed server-side at insert
time, with the page-load boolean as a fallback for the card that already existed
when the page rendered. A single page-level boolean was wrong for the same reason:
cards arrive mid-session through the `proposal` NDJSON line, so a relabel's card
inherited the answer computed before it existed and promised tomorrow morning.

Both defects are the same shape and worth naming, because this ruling caused them:
**D9 settled which constant and how to choose, and left unstated WHEN the choice is
made.** A ruling that fixes a value and not its lifetime is only half a ruling —
D2 had the identical gap and produced the identical class of bug.

The fallback is held in place by tests, not by the compiler: `first` is required on
the server's `Proposal` and optional on the client's `CardProposal`, and TypeScript
does not object to a possibly-undefined value in a boolean position, so a future
edit dropping `?? first` would compile clean and silently promise the wrong thing.
`tests/chat/panel.test.ts` is what catches that.

### D10. Dashboards RENDER entry widgets; platform routes do the writing

File 02 §5 says dashboard code may include "entry widgets — forms **writing to** the
user's own SQLite during their session."

**Direct conflict with a hard, recently-hardened rule** the handoff author could not
see. CLAUDE.md > Dashboard folder conventions:

> A dashboard … gets a read-only handle, so it cannot write — on BOTH paths … **the
> walk route's writable open is the only thing that creates or migrates a user's real
> database.** Every write goes through a platform route, which is the only place the
> four ordered checks live.

Step-6a residual 10 records that this was *closed in a fix round* — the render path
handle was made genuinely read-only on purpose, and step 6a's ledger documents the
lockout hazard that motivated it.

**Ruling: satisfy §5 in spirit, one word different.** A dashboard **renders** an entry
widget — a form that POSTs to a platform route; the platform route holds the writable
handle and the four ordered checks. This is exactly what `users/devtwo/dashboard.tsx`
+ `app/api/users/[user]/walk/route.ts` already do, so §5 is describing existing
behavior with imprecise wording rather than asking for a new capability.

**What is in scope:** the schema learning to *describe* entry widgets (`EntryWidget`,
`DataRequirement`), the conventions written down in CLAUDE.md and
`architecture-overview.md`, the annotations-in-user-tables rule, and per-user tests
covering write paths.

**What is explicitly OUT of scope, and named as the next thing:** a *generalized*
entry route. Today's walk route hardcodes `INSERT INTO walks`. Once every spec version
routinely declares entry widgets, a hand-written route per panel is the hand-pain the
roadmap says to automate rung-by-rung — but generalizing it means table whitelisting
and field-type validation on the single most security-sensitive path in the repo, and
that deserves its own design. **Flagged to Nico as a scope question.**

### D11. `ChatContext`'s `'interview' | 'tweak'` values are KEPT — a deliberate exception

File 02 §1 says remove the tweak/build distinction "everywhere it exists."
`lib/chat/context.ts` stamps `context: 'interview' | 'tweak'` onto every metrics row.

**Ruling: keep both values; rewrite the comment.** The field is not a pipeline mode —
there is no branch anywhere that reads it. It is a metrics label answering
architecture-overview line 136's question: how much cost goes into winning someone
over versus keeping them. The boundary (first confirmation) is unchanged and still
meaningful. Renaming `'tweak'` → `'revision'` would split a two-week-old append-only
series across two spellings for a wording change, and `metrics` cannot be migrated.

The distinction the handoff wants gone is gone: no classifier, no second pipeline, no
queue. This is a label on a cost log. The comment is rewritten so nobody reads it as a
branch.

### D12. The `requests` table is dead schema and stays dead

`platform/schema.sql:53-58` declares `requests`. Grep confirms **no code reads or
writes it** — it has been unused since step 1. File 02 §1's "no deferred tweak-request
queue as a separate structure" is therefore already true.

**Ruling: leave the table, record it as superseded.** Dropping it means a DDL change
to a file governed by the anti-drift gate for zero benefit. `architecture-overview.md`
§7's "request queue" admin pane is superseded by the spec-version list, and the doc
edit says so.

### D13. New prompt FILES, never edits

`lib/chat/prompt.ts:8` — "New versions are new FILES, never edits," because
`prompt_sha` is stamped on every transcript and spec row. So: `agent-v3.md`
(file 01 verbatim), `spec-v2.md`, `mockup-v1.md` are created; `agent-v2.md` and
`spec-v1.md` stay on disk forever, unedited, because rows point at their hashes.

### D14. `architecture-overview.md`, not `ARCHITECTURE.md`

File 02 §6 names `ARCHITECTURE.md`. This repo's living doc is
`architecture-overview.md` (referenced by CLAUDE.md's first line). All six §6 edits
land there. Cosmetic, recorded so the mapping is not mistaken for a missed item.

### D15. `mockup_failed` carries the SPEC call's counters, with the mockup call's alongside

Ruled at plan approval, because D7's split creates a cost-accounting hole the
success path does not have. On the happy path the spec call's usage lands on
`spec_proposed`. If the mockup call fails, no `spec_proposed` is written — so
the spec call's real, billed tokens have **no other home**, and a
`mockup_failed` row that reports only the mockup call would leave them off an
append-only cost log permanently.

**Ruling:** the `mockup_failed` row's four standard counters
(`input`/`output`/`cache_read`/`cache_creation`) are the **spec** call's,
because those are the tokens that would otherwise vanish and because every
other row in the log means the same thing by those four names — grouping by
them must not be corrupted by one path. The mockup call's own usage rides
alongside in four explicitly-named flat fields, `mockup_input`,
`mockup_output`, `mockup_cache_read`, `mockup_cache_creation`, each **null**
when the mockup call failed before any response came back (a rate limit, a
connection drop) and populated when it failed *after* one (`truncated_spec`,
`unparsable_spec`, or a validator rejection) — the same distinction
`ErrorShape.usage` already draws.

Flat, not nested: the step-4 ledger's "deferred, accepted" list already
records that spreading a shape carrying nested `usage`/`served` beside flat
counters is a hazard in `chat_error`. Null rather than zero: zero is a claim
that nothing was billed, and on a truncated mockup that is false.

### D16. `deploy_announced` is SYSTEM STATE, not telemetry

Ruled at plan approval. `announceDeploy`'s idempotency check reads the
`deploy_announced` metric row to decide whether it has already spoken. That
makes one row in `metrics` load-bearing for correctness rather than purely
observational — the first such row in this codebase.

Accepted rather than redesigned: `metrics` is append-only and trigger-enforced
against UPDATE and DELETE, so the row cannot be edited or removed through the
application, and adding a table for one boolean per spec is not worth a DDL
change to a guarded file. **The hazard is a human one** — someone later
pruning or archiving `metrics` rows as disposable telemetry would make the
announcement fire again, into an append-only transcript, on a build that
shipped weeks ago. Recorded here and in CLAUDE.md's sacred-data section so the
"never migrate, rewrite, or clean up" rule has a named consequence attached.

### D17. The same-role fold in `toMessages` is PERMANENT, whatever the API does

Ruled after the whole-branch review, and stated as a ruling rather than left as a
residual specifically so nobody deletes it later as dead weight.

`lib/chat/announce.ts` appends an assistant transcript row, and a normal turn
already ends on one, so the first operator announcement to an account makes the
next turn's history read `[…, assistant(reply), assistant(announcement),
user(new)]`. `toMessages` folds that run into one message. Anthropic's own
documentation contradicts itself on whether the unfolded shape is a 400 or a
silent merge, and this build did not settle it.

**Ruling: the fold stays even if the permissive reading is later confirmed.** It
is defensive behaviour this system wants on its own terms, not a workaround
waiting to be retired:

- **The failure it prevents is unrecoverable and total.** On the 400 reading, the
  first announcement breaks that account's chat forever — `transcripts` rejects
  DELETE, `toMessages` replays the pair on every subsequent turn, and the only
  surface a friend has for reporting that anything is wrong is the surface that
  broke. There is no fix short of editing the database by hand.
- **The cost is one blank line** between two things the same speaker said, in the
  request only. Nothing edits history; the rows stay exactly as written and the
  panel still renders each separately.
- **A confirmed "the API merges them" would not make the fold unnecessary** — it
  would make it agree with the API. Deleting it would then hand the same
  responsibility to a third party's implementation detail, on a promise nobody
  versioned, guarding a permanent failure.
- **More producers of same-role runs are coming.** `scripts/ask-user.ts` already
  writes operator rows too, and the design's post-build era adds more. The fold is
  the one place that shape is normalised.

Precedent: this is the identical bet the blank-body filter above it in the same
function already takes, for the identical reason. That filter has outlived the bug
that motivated it and is kept as "the permanent recovery valve"; this is the
second valve on the same pipe.

A future reader who settles the API question should record the answer beside this
ruling and leave the code alone.

---

## Deferred, accepted

- The internal critique pass (D8).
- A generalized entry-widget write route (D10) — raised to Nico as a scope question.
- Highlighting only changed panels in the mockup. File 02 §3 calls full re-render
  "acceptable for the pilot" and the highlight "a styling improvement, not a
  requirement." Skipped.
- Storing the structural diff. `specs` takes no new column (D2/R2), so the diff is
  derived on demand by `lib/spec/diff.ts`. File 02 §2 permits "or make it cheaply
  derivable." Counts (not content) ride on the `spec_confirmed` metric row so the
  metrics pipeline has a time series without a join.

---

## Built

Fourteen tasks, executed subagent-driven with a task review after each and a
whole-branch review at the end. 789 tests pass, `tsc --noEmit` is clean,
`next build` succeeds, `.claude/hooks/test-hooks.sh` is 158/158.

The design held. There is one loop: the agent raises its hand with the same
zero-payload `propose_spec`, a second call authors the **whole surface** under
structured output, a third renders the mockup from the *validated* payload, the
friend confirms, and the diff between confirmed versions is the record of what
they asked for. A first interview and a one-word relabel travel the same path.

**What the pre-flight scan caught, before any code was written.** Two blocking
defects in the plan itself: Task 1 deleted `parseSpecInput` while `author.ts` still
imported it (the branch would not have compiled at the end of the first task), and
Task 9 omitted `author.ts` from its file list although `Proposal` — the type the
NDJSON `proposal` line carries — lives there. Both would have surfaced as
mid-branch breakage; the scan cost twenty minutes.

**Three amendments were ruled during implementation**, each recorded above:

- **D15 extended.** The mockup call's counters were specified on the failure row
  only, leaving the *success* path as the one place a returning, billed model call
  reached no metrics row. Caught by an implementer reading the constraint rather
  than the instruction.
- **D2 given a lifetime.** "Server-computed cannot be wrong" conflated *not
  hallucinated* with *not stale*. The pointer is now read at write time.
- **D9 given a lifetime.** Same gap: which constant was settled, when the choice is
  made was not. The promise now rides on the proposal.

**The recurring lesson, and it is the same one step 4 recorded:** every
Important finding on this branch originated in the plan, not in an implementer's
work. Implementers were fast and accurate against a well-specified brief — and
faithfully shipped the brief's own defects until something independent looked at
the result. Twice an implementer disagreed with a brief and was right both times:
the derived-input error message that contradicted its own test, and a red-test
control instrument that would have proved the wrong thing.

**Defects that only existed in the composition**, invisible to any per-task review:

- An operator announcement appends an `assistant` transcript row after a turn's own
  `assistant` row — the first path in this codebase able to produce consecutive
  same-role messages. Anthropic's own documentation contradicts itself on whether
  that is a 400 or a silent merge. On the 400 reading, the *first* announcement
  bricks that account's chat forever, since `transcripts` rejects DELETE. Closed by
  folding same-role runs in `toMessages`, which makes the question moot.
- `first` was computed once per page load and applied to every card, including cards
  that stream in later — so after confirming v1, a relabel's card promised "tomorrow
  morning". The page-load tests could not see it; only a test driving `applyTurn`
  could.
- `based_on_version` was read before a call that can run three minutes, while the
  previous card's confirm button stayed live.

**Tests that could not fail**, found and fixed: a `not.toContain` that was
vacuously true because `renderToStaticMarkup` escapes the apostrophe in "it'll";
admin assertions matching serialized props rather than rendered output; a mutation
that reddened nothing because no test drove the component doing the threading; a
`not.toContain` for a value the fixture could never have produced. The control that
caught them is the one step 4 adopted — delete the guarded code, confirm exactly the
intended test goes red — now run on every task.

## The checkpoint — PASSED 2026-08-13, in production

Run as `devtwo` against `app.stairwell.run`, on the same 53-commit deploy that
first carried step 6a to the droplet (`8117b6e` → `2c1ee04`). `devtwo` asked for
"a simple counter that counts up by 1 with a reset button" — a genuine new panel
requested against an account whose only confirmed spec is a **legacy** one, so
this exercised the legacy arm rather than the easy path.

What it proves, all of which was previously untestable because the suite drives a
fake client:

- **`SPEC_JSON_SCHEMA` is accepted by the API.** Fifteen fields, nested `anyOf`
  for the three value kinds, required-and-nullable throughout. Nothing before this
  had ever sent one.
- **`spec-v2.md` produces output `parseSpecDraft` accepts.** A prompt describing a
  shape the validator rejects would have been invisible to every test.
- **The separate mockup call works** (D7), and the card rendered its preview.
- **The legacy arm works end to end**: `currentVersionBlock` fed the writer
  devtwo's v1 legacy spec as rendered markdown with the assign-ids-fresh note, and
  the new version was written with `based_on_version: 1`.
- **The card led with what changed**, not the summary.
- **The delivery line read "small changes usually land within a few hours."** This
  is the one worth recording: `first` is false because a confirmed spec exists
  *below* this version. The plan's original rule (`!hasConfirmedSpec`) would have
  said "tomorrow morning" for a one-word counter, and the version the whole-branch
  review forced — `first` riding on the proposal, computed with
  `hasConfirmedSpecBelow` — is what produced the right sentence on a real card.
  Both halves of D9's amendment are confirmed live.
- **ntfy fired on confirmation**, and the card settled to "Building this one."

**Not verified, and left for whenever it is next convenient** — none of these
block anything, and all are cheap:

- The `attempt` value on the `spec_proposed` row. If proposals routinely need two
  attempts, every one silently costs two model calls; the number is one query away
  and nobody has looked.
- `./scripts/pull-spec.sh devtwo` against the new renderer — `renderSpecMarkdown`
  has never run on live data, only fixtures.
- The admin pane's structural diff on a real pair of versions.
- `scripts/announce-deploy.ts` and `scripts/ask-user.ts` against the droplet.

## Residual risks

1. **Nobody has confirmed what the Messages API actually does with consecutive
   same-role messages.** The fold in `toMessages` does not depend on the answer and
   is permanent either way — see **D17**, which is a ruling, not a mitigation. What
   remains genuinely residual is only the not-knowing: anyone reasoning about
   transcript shape for some *other* purpose should know this question was routed
   around rather than settled, and should not read the fold's existence as evidence
   that the 400 behaviour is real.

2. **The metrics redactor is coupled to a convention in a different file.**
   `metricMessage()` strips double-quoted segments, which assumes
   `lib/spec/validate.ts` double-quotes every interpolated content value. It mostly
   does — but `parseSpecVersion` throws ``JSON parse error: ${err.message}`` with the
   inner message unquoted by our code, reachable through the outer catch on a corrupt
   current row. Bounded (~30 chars, and V8 quotes the offending snippet itself), but
   an unquoted interpolation added to `validate.ts` later would silently widen it.

3. **The announce transaction's atomicity is proven by inspection, not by a test.**
   No test induces a mid-transaction failure and asserts the transcript row rolled
   back.

4. **`deploy_announced` metric rows are load-bearing for correctness** — the first
   such row in this codebase (D16). Pruning one makes a weeks-old build announce
   itself again into an append-only transcript. Now stated in CLAUDE.md's sacred-data
   section, because the "never clean up" rule needed the consequence attached.

5. **`scripts/ask-user.ts` writes to an append-only transcript with zero tests** and
   takes no injected clock, unlike its sibling. `scripts/` sits outside the
   pre-commit gate's scopes, so nothing catches it — and it is the model the next
   operator CLI will be copied from.

6. **`alreadyAnnounced` swallows `JSON.parse` failures**, so one corrupt
   `deploy_announced` blob produces a duplicate announcement — the exact permanent
   outcome the function exists to prevent.

7. **The `first` fallback is held by tests, not by the compiler.** `first` is
   required on the server's `Proposal` and optional on the client's `CardProposal`;
   TypeScript does not object to a possibly-undefined value in a boolean position and
   this repo has no ESLint. An edit dropping `?? first` compiles clean and silently
   promises the wrong thing. `tests/chat/panel.test.ts` is the only thing catching it.

8. **`EntryWidget.fields[].choices` never reaches `spec.md`.** A `choice`-typed entry
   field arrives at the builder with no rendered options — an under-specified build
   contract, small but real once a choice field exists.

9. **A generalized entry-widget write route does not exist and is deliberately out of
   scope** (D10). Every panel that accepts input still needs its own hand-written
   platform route holding the four ordered checks. This is the hand-pain the roadmap
   says to automate rung-by-rung; the trigger is spec versions routinely declaring
   entry widgets.

10. **`lib/spec/author.ts` is ~505 lines with five hand-built `appendMetric` sites**
    that each repeat their field shape. Deliberately not factored — the reviewer
    agreed a premature builder would hide the D15 distinctions the comments work to
    make explicit — but a sixth site is where this stops being true.

11. **Pre-existing dangling citations** to `.superpowers/sdd/…` scratch reports
    survive in `app/[user]/ChatPanel.tsx` and `tests/session/keymap.test.ts`, from
    steps 4 and 6a. Not introduced here; noted because this branch fixed its own and
    the pattern will keep recurring until someone sweeps them.

12. **`devone` and `devtwo` remain live production logins with published passwords**
    (step-3 residual 7, step-4 residual 8, unchanged). Should close before the first
    real user account exists.

13. **OPEN, UNDIAGNOSED — a proposal intermittently dies with the friend told a lie.**
    Seen twice in a row on the checkpoint run, then not on the third attempt, with
    no code change in between. It is the most user-visible defect known about this
    branch and it has no root cause. Everything below is fact, gathered before the
    trail went cold; the theories that were *ruled out* are recorded because
    re-deriving them costs an hour.

    **What the friend sees.** The agent replies, "Putting together a preview…"
    appears, and then the turn is marked **"interrupted — not saved"** with a retry
    button, and no card ever arrives.

    **What actually happened.** The turn succeeded completely. `chat_turn` was
    written both times, with the user row and the assistant row committed to
    `transcripts`. The model called `propose_spec`. Then the client connection went
    away, which aborted the authoring call — `spec_aborted` with all-zero counters,
    which is the honest record of a call that died before the API returned anything.
    The route withholds `{done:true}` when `request.signal.aborted`, and the panel
    treats a missing `done` as "interrupted".

    **So the marker is wrong, and this is the part worth fixing first.**
    `finishTurn(state, false)` cannot distinguish *nothing was saved* from *the turn
    was saved and only the preview was lost*. In this failure it says "not saved"
    about a message that IS saved, and offers a retry button that writes a duplicate
    user row into an append-only transcript. That is a correctness bug in the panel
    independent of whatever causes the disconnect, and it predates this branch —
    step 4 shipped the rule. This branch made it much likelier to fire by making the
    authoring window two model calls plus a possible retry where it was one.

    **Evidence from Caddy** (`journalctl -u caddy`), which logs errors even with no
    access log configured:

    ```
    "msg":"aborting with incomplete response","duration":4.592647519,
    "proto":"HTTP/2.0","method":"POST","uri":"/api/chat",
    "error":"reading: context canceled"
    ```

    Two such warnings, durations **4.59s** and **3.03s**, each landing within 10ms
    of a `spec_aborted` row. `context canceled` means the downstream client's
    context died while Caddy was reading from Next.js — the browser went away, not
    a proxy or server timeout.

    **The unexplained part.** Those request windows do not contain the `chat_turn`
    timestamps. The first `chat_turn` was written at `01:12:06.693`; the first
    aborted request did not start until `~01:12:38.6`. So **there were more
    `/api/chat` requests than messages the friend sent**, and the ones being
    cancelled were short-lived. On the successful third attempt, DevTools showed
    exactly one `/api/chat` request. Something occasionally fires extra POSTs and
    abandons them; the mechanism is unknown and is client-side.

    **Ruled out, with reasons:**
    - *Compression buffering hiding the spinner.* The friend confirmed
      "Putting together a preview…" rendered, so `{"authoring":true}` reached the
      browser and `encode zstd gzip` is flushing.
    - *A proxy or server idle timeout.* `deploy/Caddyfile` configures none, the
      observed durations were 3–5s rather than a constant, and Caddy's own log
      attributes the cancellation to the client.

    **The fix that is justified regardless of root cause**, and was not made because
    the trail went cold rather than because it was judged unnecessary: the server
    sends nothing for the entire authoring wait. A heartbeat line the panel ignores
    would keep the connection non-idle and make the wait legible. Alongside it, two
    design questions that are Nico's: whether the panel should distinguish
    "preview failed" from "nothing saved" (it should), and whether `authorSpec`
    should be tied to `request.signal` at all — today a friend closing a laptop
    mid-preview cancels billed work and gets nothing, where the proposal could
    instead be waiting when they come back.

## Deferred, accepted

- The internal critique pass (D8) — never built. Named place to add it:
  between `parseSpecDraft` succeeding and the mockup call in `lib/spec/author.ts`.
- Highlighting only changed panels in the mockup; full re-render ships.
- Storing the structural diff. Derived on demand by `lib/spec/diff.ts`; counts ride
  on the `spec_confirmed` metric row so the pipeline has a time series without a join.
- An abort during the retry gap writes no `spec_aborted` row. A lone
  `malformed_spec` with `attempt: 1` and nothing after it is already distinguishable
  from a give-up, since a non-aborted first attempt always produces a second row.
- `readStoredSpec`'s un-discriminable edges (null body, top-level array, non-array
  `screens`) are traced but untested; all route to the legacy arm and throw
  `SpecShapeError`, which every consumer handles.

---

## D18. Confirmations reach the agent by a read-time merge, and the model allowlist is coupled to CHAT_MODEL — Nico's ruling, 2026-08-14

**The defect.** The agent's entire conversational context is `transcripts`
(`runTurn` -> `toMessages`). Pressing **Build this** writes `specs`,
`spec_confirmations` and `metrics` and touches none of it, so the agent could
not tell a confirmation had happened — observed in testing as an identical v2
proposed straight after v1 was confirmed. Every "After they confirm" instruction
in `agent-v4.md` was dead text against this codebase.

**The fix keeps D5/D5a intact.** `lib/chat/confirmations.ts` merges
`spec_confirmations` into the model request at build time, exactly as
`lib/chat/timeline.ts` merges them into the rendered conversation at read time.
**Nothing new is persisted** — the alternative, appending a transcript row on
confirm, would put a second un-deletable copy of a permanent fact in the sacred
table, and would not have fixed the already-confirmed version without inventing
history. One idea, two consumers, zero new rows.

**Placement is dictated by the API, not by taste.** A `system` message inside
`messages[]` must FOLLOW a user message and be last (or followed by an assistant
turn). A confirmation always follows an ASSISTANT proposal in our transcript, so
the position the reading eye wants is the one placement the API rejects. The
note is appended last, after the turn's own user row.

**THE ALLOWLIST IS COUPLED TO `CHAT_MODEL` AND MUST CHANGE WITH IT.**
Mid-conversation system messages are model-gated:
`MODELS_WITH_MID_CONVERSATION_SYSTEM` lists the models that accept them, and an
unsupported model does **not** degrade — it returns a 400 and the friend's chat
stops entirely. `CHAT_MODEL` is an env override (`deploy/required-env`: "has an
intended default"), so an operator pointing it at, say, `claude-sonnet-5` would
take chat down with a change that looks unrelated to chat. Two consequences,
both permanent:

1. **Changing `CHAT_MODEL` means checking that list.** A model not on it falls
   back to appending the note to the system prompt — chat keeps working, but the
   note loses its position in the conversation, which is the property that makes
   the prompt's "respond to it once" work. That is a degradation, not a fix.
2. **The degradation is observable on purpose.** Every metrics row for a turn
   carries `note_channel`: `messages` (healthy), `system_prompt` (degraded), or
   `none` (nothing confirmed yet). Without it a model swap could silently
   disable half this feature and nothing would say which change did it. It
   carries a channel name and nothing else — no version, no timestamp, no
   content.

**The opener is parsed, not retyped.** `lib/chat/opening.ts` reads the verbatim
message out of the prompt file, anchored to the `## Your first message`
heading — never "the first blockquote", which would silently return the wrong
quote the first time a version adds an example above that section. A failed
parse throws rather than writing an empty row: `transcripts` rejects DELETE, so
a blank opener would be a permanent blank first impression indistinguishable
from the bug it replaced. Its write guard is an EMPTY TRANSCRIPT, deliberately
not `first_session_start` — that metric is load-bearing system state with one
job (onboarding ledger D8), and an account that reached the shell before this
existed has the metric and an empty chat, and should still be greeted.

---

## D19. A guard is not present because something nearby resembles it — 2026-08-14

**The finding, in one sentence:** the "MOCKUP" banner visible in earlier
screenshots was **fixture HTML written by `scripts/shots.ts`**, not output the
generator had ever produced — so a screenshot was read as evidence about
generation when it was only evidence about a fixture.

This is the third instance of the same genus in this repo, and the pattern is
worth naming because each one looked different and read identically:

| What looked guarded | What was actually there |
|---|---|
| `logins.txt` ignored by `.gitignore` | the pattern said `logins.txts` — a trailing `s`, matching nothing |
| Nine surviving `ChatPanel` mutations, tallied in a ledger | a number never itemised anywhere; six exist, and six is what could be drilled |
| A "MOCKUP" banner in generated previews | a banner in the seed fixture; nothing generated one, and nothing required it |

In all three the artifact next to the guard resembled the guard closely enough
that nobody looked past it. The screenshot did show a banner. The gitignore did
mention logins. The ledger did state a number. **Resemblance is what makes this
class hard: the check "is it there?" returns yes.**

**The rule this produces.** A screenshot of a fixture is evidence about the
fixture, and nothing else. It says the route serves, the iframe renders, the
layout holds — it says nothing whatever about what a model emits, because the
harness never calls the API (CLAUDE.md > Testing). Any property that depends on
GENERATED output is verified by generating something and looking at it, or it
is not verified. `screenshots/screens.ts` now carries that caveat inline on
`mockup-document`, where someone reaching for the picture will read it.

**And the structural fix, which matters more than the note.** The banner is no
longer requested from the model at all: `lib/spec/banner.ts` injects it at
serve time on both mockup routes, so it cannot be forgotten by a model, missing
from a document stored before the rule existed, or dropped by a future prompt
version. mockup-v3 tells the model NOT to add one, precisely so the route stays
the single source. Injected rather than refused — a refusal would turn a model
slip into a blank preview at the moment a friend is deciding whether to
confirm, and a labelled preview beats a broken one.

This became load-bearing in the same change that made mockups carry plausible
numbers instead of "£000.00". The old honesty signal WAS the ugliness; removing
it without replacing the guarantee would have left previews that look exactly
like a real dashboard, which is the one thing this system must never do.
