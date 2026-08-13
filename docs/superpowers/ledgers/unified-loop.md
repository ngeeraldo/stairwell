# Unified proposal loop — decisions ledger

Spec: `docs/superpowers/specs/2026-08-13-unified-proposal-loop/` (three handoff files)
Plan: `docs/superpowers/plans/2026-08-13-unified-proposal-loop.md`
Branch: not yet cut — this ledger is opened **before** the build, to record the
§7 resolutions and the rulings the plan depends on. The "Built" and "Residual
risks" sections get written after the branch lands, as in every other ledger here.

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
`currentSpec(db, accountId)?.version ?? null` immediately before `insertSpec`. A
model-authored lineage pointer is a hallucination waiting to become a permanent row
in an append-only table; a server-computed one cannot be wrong.

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
possible — small changes usually land within a few hours." Selection is by
`hasConfirmedSpec`, computed server-side and passed to the card as a boolean.

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
