# Step 4 — Interview → Structured Spec Flow

**Date:** 2026-08-12
**Status:** Approved, pre-implementation
**Covers:** Build-order step 4 — the agent proposes a spec and a rendered HTML
mockup inline in chat, the friend confirms it with a button, and the confirmed
artifact lands in the admin portal and reaches the repo through one command.

**Paired with:** `2026-08-11-step2-chat-and-transcripts-design.md` (the chat
surface, the transcript, the metrics shape) and
`2026-08-12-step3-ntfy-alerts-design.md` (the alerter, and its content-free
guarantee). Both must be complete; this step modifies both.

**Checkpoint:** Nico runs his own interview end-to-end **logged in as
`devtwo`**, confirms the spec, his phone buzzes, and the spec + mockup render
in the admin portal and pull into the repo with `./scripts/pull-spec.sh
devtwo`. See §11 for why the checkpoint is not run as `nico`.

---

## 1. Decisions made during this design

| Question | Decision |
|---|---|
| Where the confirmed spec lives | Platform DB is the record; the repo files are an export (§2, §9) |
| How the spec is emitted | Tool use, not sentinels in prose (§4) |
| Threading | Zero-payload hand-raise in the chat call, then a dedicated structured-output authoring call (§4) |
| What confirms | A button on the proposal card, never the agent's reading of a reply (§5) |
| Mockup containment | `<iframe srcdoc sandbox="">` — no scripts, no same-origin, everywhere it renders (§6) |
| Spec fields | Six, frozen: `title`, `summary`, `background`, `panels`, `manual_logging`, `open_questions` (§3) |
| Spec versioning | Append-only proposals; confirmation is a second append; `version` derived at read (§2) |
| `spec_confirmed` alert | In scope. It is what forces the alert module's content-free guarantee to generalise (§7) |
| `context` metric | Derived from whether a confirmed spec exists. Forced by this step (§8) |
| Tweak-request queue | Deferred to step 5 (§12) |
| Mid-interview escalation alert | Deferred. `open_questions` rides with the spec (§12) |
| Substantive prompt rewrite | Out of scope. Step 4 makes a structural prompt change only (§10) |

---

## 2. Data

Two new tables in `platform/schema.sql`, both append-only, both carrying the
same `no_update` / `no_delete` trigger pair the sacred tables already use.

```sql
CREATE TABLE IF NOT EXISTS specs (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL,
  conversation_id TEXT    NOT NULL,
  prompt_sha      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,   -- the validated tool input, JSON
  mockup_html     TEXT    NOT NULL,
  at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spec_confirmations (
  id         INTEGER PRIMARY KEY,
  spec_id    INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
```

### 2.1 The record is the payload, not the markdown

`spec.md` is **rendered** from `payload` by `lib/spec/render.ts`, deterministically
and at export time. It is not stored.

This is what makes the markdown format revisable. A stored-markdown design
freezes every formatting decision made on the first day into rows that can
never be rewritten; rendering from structure means improving how a spec reads
lets every past spec be re-exported in the new format. The build contract is
still a file (CLAUDE.md > Build contract); the file is now a projection of the
record rather than the record itself.

`mockup_html` is a separate column rather than a field inside `payload` because
it is large and most reads do not want it — the admin list, the version
history, and the `open_questions` summary all read the payload alone.

### 2.2 Confirmation is a second append, not a status column

A `status` column would require an `UPDATE`, which is precisely what
append-only forbids, and which the triggers would reject at runtime.

Keeping them apart is also the more honest model. A proposal and a confirmation
are different facts about different moments, the same way `stream_aborted` and
`chat_error` are different facts in step 2. The current spec for an account is
*the newest `specs` row that has a `spec_confirmations` row*. Proposals that
were never confirmed stay in the record permanently, which is product data
rather than clutter: how many rounds an interview took before a friend said yes
is one of the few directly comparable numbers across pilot users.

### 2.3 `version` is derived, never stored

A spec's version is its position in the account's proposal list ordered by
`at, id`. Storing a version number would need a `COUNT(*) + 1` at insert and
would reproduce the `conversationIdFor` race (step-2 spec §8) for no benefit.
Derived at read, it cannot drift and cannot race.

### 2.4 These tables are outside `reshape.ts`, deliberately

`lib/db/reshape.ts` is the one place in `lib/db` allowed to drop a sacred
table, and CLAUDE.md says never to widen that exception. `specs` and
`spec_confirmations` are therefore **not** added to its watched set.

The consequence is stated plainly so nobody discovers it later: these tables
get their columns right the first time. A field we omit is missing from every
spec written before we notice, and adding one is a hand-fix on the droplet, not
a mechanism. That is the same bargain step 2 struck for `transcripts` and
`metrics`, and it is why §3 fixes the field list before any code is written.

---

## 3. What a spec carries

Six fields. Frozen, per §2.4.

| Field | Meaning |
|---|---|
| `title` | Short name for the dashboard. |
| `summary` | What this dashboard is for, in the friend's own framing. |
| `background` | What the agent learned about **the person** that did not become a panel. |
| `panels[]` | `{name, shows, why, source}` where `source` is `plaid`, `manual`, or `derived`. |
| `manual_logging[]` | What they agreed to log by hand, and how often. |
| `open_questions[]` | What the agent would not promise, handed to Nico. |

### 3.1 `background` is defined by what it excludes

The field exists so the admin pane can answer "do I need to read the whole
transcript?" without the reader having to read the whole transcript.

It is specified as **the residue** — existing habits and apps, what they worry
about, what they turned down, constraints they mentioned — rather than as "a
summary of the conversation". A neutral recap would compress toward the panels,
because the model writes it having just decided them, and would duplicate
`summary` at longer length. Defining it by exclusion is what makes it carry
information the other five fields do not.

**It is the one field that can be wrong rather than merely incomplete.**
Everything else in a spec is a decision; this is an interpretation, written by
a model, and it is the field a reader would use *in place of* the source. The
mitigation is framing, not machinery: it is a reading aid that tells you
whether you need the transcript, and the transcript is in the same admin pane,
one section away. Nothing downstream may treat it as ground truth.

### 3.2 `open_questions` is an inbox, not documentation

`platform/prompts/agent-v1.md` already tells the agent that a request it cannot
confirm is "worth asking Nico about" rather than something to guess at. That
rule protects a friend from a promise the pilot cannot keep, and today it is
discharged by the agent saying so in a chat message that Nico finds later.

`open_questions` gives those flags a structured home and a delivery moment. §9
renders them at the top of the admin spec pane for that reason — they are not
part of the build description, they are asks addressed to the reader.

---

## 4. Runtime — proposing

### 4.1 Two calls, and why

The chat call raises a hand; a second, dedicated call authors the artifact.

**`propose_spec`** is a tool with an **empty input schema**. The agent calls it
when it judges the interview has enough. Because it carries no payload,
`lib/chat/client.ts`'s streaming path only has to report *which tool was
called* — it never has to accumulate a large JSON body out of
`input_json_delta` events alongside the text it is already streaming to a
friend's screen.

**The authoring call uses structured outputs, not a second tool.**
`output_config.format` with a `json_schema` (§3) constrains the response
itself, so the model cannot return anything but a schema-valid object. That is
the same guarantee a forced `tool_choice` would buy, with no `tool_use` block
to extract and no tool/thinking interaction to reason about — and it is the
single largest reliability difference between this design and emitting the
payload inline through the chat stream.

`propose_spec` stays a tool because it is genuine tool use: the agent choosing
to act. The authoring call is not choosing anything; it is being told to emit
one shape.

Checked against the current API rather than assumed: structured outputs are
supported on `claude-opus-5` and work with extended thinking, and
`output_config` carries `effort` and `format` together.

The authoring call gets its own system prompt file, `platform/prompts/spec-v1.md`,
and therefore its own `prompt_sha` — so the output contract and the mockup
conventions can be iterated without touching interview wording, and the two
eras stay separable in the record. That separation is the same property the
per-row content hash bought in step 2.

**Rejected: a `tool_result` continuation.** Sending a result back so the agent
narrates the proposal inside the same turn would require `lib/chat/history.ts`
to carry `tool_use` / `tool_result` blocks. It rebuilds history as plain text
today, and step-2 residual 13 already flags that rebuild as fragile against
thinking blocks. Real structural risk for a conversational nicety.

**Rejected: sentinel-delimited blocks in prose.** A truncated fenced block
looks superficially valid and would be persisted as a complete spec; a
truncated tool call surfaces as `stop_reason: max_tokens`. The failure modes
are not comparable.

### 4.2 Changes to `lib/chat/client.ts`

`StreamResult` gains `tools_called: string[]`, populated from the resolved
message's `tool_use` blocks.

A new `propose()` method issues the authoring call: non-streaming
`messages.create` with `output_config: {effort, format}`. It returns the raw
parsed object, and the same `usage` / `served` / `stop_reason` shape `stream()`
already returns, so the metrics rows stay comparable across both calls. Errors
are wrapped in `ChatStreamError` by the same `describeError` path, so `kind` /
`status` / `type` mean the same thing for an authoring failure as for a chat
failure.

**It does not reuse `MAX_TOKENS`, and it sets an explicit timeout.** `stream()`
runs at 64000 because streaming makes a high ceiling free. A non-streaming call
at that ceiling is the opposite: the SDK scales its own timeout *up* for large
non-streaming `max_tokens`, so a wedged authoring call could hold a friend on
"putting together a preview…" for the better part of an hour with no way out.

`SPEC_MAX_TOKENS = 32000` and a 180-second per-request timeout. The ceiling is
still far above a spec plus a mockup plus adaptive thinking; the timeout is
what bounds the wait. A timeout surfaces through the existing error path as a
`spec_error` with `kind: 'connection_timeout'`, which is a visible failure
rather than a hang.

`turn.ts` still does not import the SDK. `propose()` crosses that boundary as
plain data, exactly as `stream()` does.

### 4.3 The completion rule, restated

Step 2's rule — anything other than `stop_reason: 'end_turn'` is
`chat_empty_reply`, appending no assistant row — is correct only in a world
with no tools. A `propose_spec` call stops with `tool_use` and lands squarely
on it. The rule is therefore restated in full, because `transcripts` is
append-only and this cannot be corrected later:

```
proposed = final.tools_called includes 'propose_spec'
usable   = delivered.trim() !== ''
           && stop_reason is 'end_turn' or 'tool_use'

if (!usable && !proposed)  -> chat_empty_reply metric; no rows; outcome 'empty'
if (usable)                -> append the assistant transcript row
if (proposed)              -> run the authoring call (§4.4)
```

Text and proposal are evaluated **independently**. A turn that calls the tool
without saying anything first still proposes, and still writes no assistant
row — an empty body in an append-only table poisons every later turn for that
account (step-2 spec §2.5), and that hazard does not soften because a tool was
also called. The prompt asks for a sentence before the call; the code does not
depend on getting one.

### 4.4 The authoring call

Runs after the assistant row is appended, inside the same request, streaming
nothing.

Its `messages` are the account's transcript rebuilt by `toMessages`, plus **a
synthetic trailing user message** (`Write the spec now.`) **appended only when
the last message is an assistant turn.**

The conditional matters. On the usual path the agent said something before
calling the tool, so the last row is an assistant turn and the call needs a
user message to answer. On the no-text path (§4.3) the last row is already the
friend's own message, and appending another user turn would send two
consecutive user messages for no gain. Ending on a user message is the only
invariant this needs.

The synthetic message is **never written to `transcripts`** — it is a call-time
construct, not a thing the friend said. Anything reading the transcript sees
only what actually happened.

On success: insert the `specs` row — carrying the **turn's own
`conversation_id`**, so a proposal is attributable to the conversation that
produced it, and `spec-v1.md`'s sha as `prompt_sha`, matching §4.6 — then
append a `spec_proposed` metric and emit the proposal to the client.

On failure: no `specs` row, append a `spec_error` metric, emit
`{"proposal_error": true}`. The friend sees an honest failure and the agent can
raise its hand again on a later turn. The assistant row from the chat half
stays — it was really delivered.

On abort (the friend closed the tab): abort the authoring call, no `specs`
row, append a `spec_aborted` metric.

### 4.5 Wire format

Three new NDJSON line types on `/api/chat`, alongside the existing `{"t":…}`
and `{"done":true}`:

| Line | Meaning |
|---|---|
| `{"authoring":true}` | Text is finished; the preview is being written. Renders the waiting state. |
| `{"proposal":{…}}` | `{id, version, payload, mockup_html}`. Renders the card. |
| `{"proposal_error":true}` | Authoring failed. Renders an honest failure with no card. |

`{"done":true}` still means "the reply is complete and saved" and is still
gated on the turn's outcome. The authoring half never suppresses it: a
completed chat turn whose proposal failed is still a completed chat turn, and
the assistant row for it exists.

### 4.6 New metrics events

The three **authoring** events carry the four token counters, `model`,
`effort`, `prompt_sha`, `context`, `model_served`, and `fallback_fired` —
step 2's shape, because they describe a model call.

```
{ event: 'spec_proposed', data: { …counters, …base, spec_id, version } }
{ event: 'spec_error',    data: { …counters, …base, kind, status, type } }
{ event: 'spec_aborted',  data: { …counters, …base } }
```

`prompt_sha` on all three is `spec-v1.md`'s sha, not the interview prompt's.
They are separate events from `chat_turn` rather than a variant of it, so that
"cost of interviewing" and "cost of authoring specs" stay separable in the
log — `architecture-overview.md` §9 asks for token costs split by run kind, and
this is that split at the event level.

`spec_confirmed` (§5.3) is **not** a model call and carries none of that:

```
{ event: 'spec_confirmed', data: { spec_id, version } }
```

Giving it zeroed counters and a fabricated `model` would put four rows of
fiction in the cost log for every confirmation. It records a button press.

---

## 5. Runtime — confirming

### 5.1 The card

The proposal renders in the chat stream as a card: the spec in plain language,
the mockup below it, and two buttons.

> **Build this**  ·  **Not quite yet**
> *Your dashboard gets built as soon as possible — at the latest, it'll be
> here tomorrow morning.*

**"Build this"** names the consequence rather than grading the artifact. An
earlier "This is right" invites agreement with a description; the friend is not
being asked whether the summary is accurate, they are being asked to commit to
a build.

**The delivery line is fixed chrome, not agent prose.** It is the most
load-bearing promise in the pilot and it is made at the exact moment a friend
decides, so it cannot depend on a model remembering to say it on a turn where
it is focused elsewhere. It is passive and does not name Nico: the agent is not
the one building, and naming him turns the agent surface into a middleman.

**It promises no notification.** `architecture-overview.md` line 119 describes
the agent posting "your eating-out panel is live" in chat, but no such
capability exists — nothing can write an assistant transcript row outside a
chat turn, and nothing can push to a friend's browser. Line 49 is the decided
behaviour: *"7am text with the link (delivery nudges stay out-of-app)."* The
card therefore promises only what is true with nobody remembering to do
anything.

**"Not quite yet" is not a button that does anything.** It is the conversation.
The friend says what is off, the agent proposes again, and the new card
supersedes the old one. There is no edit mode and no form — one chat surface,
per `architecture-overview.md` §1.

### 5.2 Superseded cards

Only the newest proposal for an account is live. Earlier cards stay visible in
the scrollback and render **inert** — no buttons — so scrolling back reads as a
history of what was offered rather than a stack of armed buttons.

That is a UI convenience. The rule is enforced server-side in §5.3, because a
stale tab is not bound by what the current page rendered.

### 5.3 `POST /api/spec/confirm`

Body: `{specId: number}`.

| Condition | Response |
|---|---|
| `resolveState` is `anonymous` | 401 |
| Spec not found, or its `account_id` is not the caller's | 404 |
| Not the newest proposal for that account | 409 |
| Already confirmed | 200, no second row |
| Otherwise | Append confirmation + metric, fire the alert, 200 |

404 rather than 403 on a cross-account id, matching `canSeeUserSpace`: a 403
would confirm the row exists. 409 on a superseded spec is what stops a stale
tab confirming a proposal the friend has already talked past. A repeat confirm
is a no-op rather than a second append — append-only makes a duplicate
harmless but permanent, and "confirmed twice" is not a fact about anything.

**Accepted while locked.** The chat surface keeps working when the key is gone
(`architecture-overview.md` line 59), the spec flow lives entirely inside the
chat surface, and confirming touches no user data. Same reasoning, and the same
`resolveState` call, as `/api/chat`.

### 5.4 Reload

`/[user]` reads the newest proposal for the account and passes it to
`ChatPanel`, which renders it exactly as the live stream would. A friend who
closes the tab mid-decision returns to the same card, still confirmable. A
proposal that is never confirmed simply sits there — it costs nothing and it is
still evidence.

---

## 6. The mockup

Rendered as `<iframe srcdoc={mockup_html} sandbox="">` — an empty sandbox
attribute, which grants nothing: no scripts, no same-origin, no forms, no
top-level navigation. Identically in the friend's chat panel and in the admin
pane, so the portal is not the softer target.

Two things follow, and both are wanted.

**Model-authored markup can never run code in a friend's session.** The
containment is structural — a capability that was never granted — rather than a
sanitizer that has to keep winning. `mockup_html` is stored verbatim; nothing
attempts to clean it.

**Mockups are permanently non-interactive**, which disciplines them toward
being a layout contract rather than a demo. `architecture-overview.md` line 48
calls the preview "a contract, not an illustration"; a preview that behaves is
a preview that promises behaviour somebody then has to build.

`platform/prompts/spec-v1.md` therefore specifies a single self-contained HTML
document, inline CSS only, no `<script>`, and **loudly fake numbers** —
CLAUDE.md's "COFFEE PALACE TEST" rule applies to a generated preview exactly as
it applies to seed data, and for the same reason: any screen must read
instantly as fake or real.

---

## 7. Alerts — making content-freeness structural

Step-3 residual 5 recorded the gap precisely: content-freeness is guaranteed by
the *shape of one function*, `conversationAlerter`, which has no parameter
through which message text could arrive. Nothing extends that to a second alert
type, and the leak test covers only the one.

Step 4 adds the second alert type, so the guarantee moves up a level.

`lib/alerts/ntfy.ts` gains a fixed table:

```ts
export const ALERT_TEXT = {
  conversation_started: 'started a conversation',
  spec_confirmed: 'confirmed a spec',
} as const

export type AlertKind = keyof typeof ALERT_TEXT
```

The alerter's signature becomes `(kind: AlertKind, accountId: number)`. The
body is `${account.slug} ${ALERT_TEXT[kind]}` and nothing else. There is no
parameter, on any exported function in the module, through which text can
reach ntfy.sh — so the guarantee is now a property of the file rather than a
property of one function in it, and adding a third alert cannot weaken it by
accident.

Everything else about step 3 is unchanged: admin accounts are suppressed and
record nothing, failure is fire-and-forget plus a metric, both outcomes are
recorded, the module never throws and never rejects, and the 5-second timeout
stands. `turn.ts`'s `alert: (accountId: number) => void` dependency type is
unchanged — it receives a kind-bound function, so the type that keeps a push
notification off the critical path of a friend's chat turn stays exactly as it
is.

The leak test is extended to iterate **every key in `ALERT_TEXT`** rather than
testing one alert, so a third kind added later is covered the moment it is
declared.

---

## 8. The `context` repair

Step-2 residual 5: `CHAT_CONTEXT` is the hardcoded literal `'interview'`,
written into append-only rows, and "becomes wrong the moment [spec
confirmation] ships."

`lib/chat/context.ts` replaces it:

```ts
contextFor(db, accountId): 'interview' | 'tweak'
```

`'tweak'` if the account has a confirmed spec, `'interview'` otherwise. Applied
in `turn.ts`, in the authoring events of §4.6, and in `app/api/chat/route.ts`.

This is the field that answers *how much cost goes into winning someone over
versus keeping them* — the retention question, asked of the cost log. It works
going forward only. Rows already written say `'interview'` permanently and are
never backfilled, which is correct: every turn written so far genuinely was
one.

**Also closed here: step-2 residual 8.** `route.ts`'s `no_api_key` row is a
second, narrower `chat_error` shape, missing the four counters, `prompt_sha`,
`model_served`, `fallback_fired`, and `delivered_chars`. That row is being
edited anyway to take `contextFor`, and leaving a known-wrong shape in a line
being touched is how it survives forever. Aligned to the documented
`chat_error` shape with zeroed counters and the honest seeded `served`
defaults.

---

## 9. Admin and export

### 9.1 The spec pane

`app/admin/[user]/page.tsx` gains a spec section beside the existing transcript
pane. Two of the three panes `architecture-overview.md` line 124 asks for; the
request queue is deferred (§12).

It lists every proposal that account has received, newest first, each marked
confirmed or not — so a friend stuck on round three is visible as a friend
stuck on round three rather than as silence. The mockup renders per §6.
`open_questions` sits at the **top**, above the spec body, because it is not
part of the build description: it is the agent telling Nico it refused to
promise something.

Read-only, admin-only, 404 otherwise — unchanged from step 2.

### 9.2 `./scripts/pull-spec.sh <user>`

One command, run from the laptop:

```
./scripts/pull-spec.sh devtwo
```

It reads the droplet's record over ssh — `scripts/export-spec.ts` runs there
under `tsx` and prints JSON to stdout — and writes `users/<user>/spec.md` and
`users/<user>/mockup.html` locally, ready to commit. A `--local` flag reads
`platform/dev/synthetic.db` instead, for development.

**The droplet never writes into its own git checkout.** That is the point of
the export existing at all. `deploy/deploy.sh` runs `git pull --ff-only` in the
working tree and CLAUDE.md forbids deploying by editing files on the droplet;
an app that wrote `users/<name>/spec.md` at runtime would be putting untracked,
un-backed-up files inside the deploy unit, invisible to the laptop where Claude
Code actually builds the dashboard. Storage in the platform DB plus an explicit
pull keeps the deploy contract untouched and puts spec history in the same
place as transcript history.

`users/*/spec.md` and `users/*/mockup.html` are already Gate B exempt
(`.githooks/pre-commit` exempts `*.md` and `mockup.html`), so a pulled spec
commits without a test-coverage argument. `scripts/*` is `guard:platform` and
does require a test under `tests/` — §11 has it.

**`scripts/export-spec.ts` reads a non-synthetic database by design**, on the
server, run by Nico. That is consistent with CLAUDE.md: the platform DB is not
encrypted with any user key and holds "the records Nico is promised access to
at onboarding". It is not consistent with Claude running it locally against
anything but `--local`, and the script says so in its own header.

---

## 10. Prompts

**`platform/prompts/agent-v2.md`** — a new file, not an edit. Step 2 established
that new versions are new files so the per-row sha ties transcript rows to
exact bytes; an in-place edit would let two eras share one identifier.

Its only change from v1 is structural: a section describing when to call
`propose_spec`, that calling it ends the turn, that a card will appear with a
preview the friend can accept or push back on, and that the friend confirms
with a button rather than by saying yes. Interview wording, tone, and the
capabilities section are byte-identical.

**The substantive interview rewrite is explicitly out of scope.** Nico waived
it as a step-2 sign-off condition and moved it to a holistic prompt strategy
session before test user #1. Keeping the structural change separate is what
lets `prompt_sha` still tell the two eras apart when that session lands.

**`platform/prompts/spec-v1.md`** — new. The authoring contract: the six fields
and what makes each one good, the mockup conventions from §6, and a restatement
of the enabled-Plaid-products ruling (Transactions with 24 months of history,
Balance, Transactions Refresh, Recurring Transactions; **not** Investments,
**not** Liabilities). That restatement is not redundant with the interview
prompt: this is the call that writes the panels, and a panel promising an
un-enabled product is a promise to a friend that step 6 cannot keep.

`loadPrompt()` becomes `loadPrompt(name)`, memoized per name, still read once
per process per file.

`platform/prompts/*` remains Gate B exempt by the explicit arm added in step 2.
The loader and the sha stamping are tested; the wording is not.

---

## 11. Tests and the checkpoint

### 11.1 Tests

No test makes a network call. `propose()` is injected the same way `stream()`
is, and the suite supplies a fake.

| File | Pins |
|---|---|
| `tests/spec/schema.test.ts` | The spec schema accepts a good payload and rejects each malformed shape; the JSON Schema sent to the API stays in sync with the validator |
| `tests/spec/render.test.ts` | Payload → markdown is deterministic and covers all six fields |
| `tests/spec/author.test.ts` | Success inserts one row; failure inserts none and records `spec_error`; abort records `spec_aborted`; the synthetic trailing message never reaches `transcripts` |
| `tests/spec/confirm.test.ts` | 401 anonymous; 404 cross-account; 409 superseded; double-confirm appends once; the alert fires; works while locked |
| `tests/chat/turn.test.ts` | Extended for §4.3: tool_use + text, tool_use with no text, no tool + no text, and that `chat_empty_reply` still fires only in the last case |
| `tests/chat/context.test.ts` | `interview` before a confirmed spec, `tweak` after |
| `tests/alerts/leak.test.ts` | Extended to iterate every key in `ALERT_TEXT` |
| `tests/admin/specPane.test.ts` | Proposals listed newest-first with confirmed marked; `open_questions` above the body; admin-only, 404 otherwise |
| `tests/chat/panel.test.ts` | Card renders from a proposal line and from a reload; superseded cards render inert; confirm posts the right id |
| `tests/spec/sandbox.test.ts` | Every iframe rendering `mockup_html` carries `sandbox=""` and never `allow-scripts`, in both the panel and the admin pane |
| `tests/scripts/exportSpec.test.ts` | The exporter produces both files' content from a synthetic DB, and refuses a user with no confirmed spec |

`tests/spec/sandbox.test.ts` is its own file rather than an assertion inside
the two render tests, because the property it pins is a security property that
must hold at every render site — including sites added later.

### 11.2 The checkpoint — run as `devtwo`, not as `nico`

`architecture-overview.md` line 148 reads *"Nico runs his own interview
end-to-end; spec + mockup land in the portal."* Run literally, as the `nico`
account, it fails for two unrelated reasons that both look like a broken build:

- Admin accounts are **suppressed from alerts by design** (step-3 §3 D2), so
  the phone would not buzz.
- `app/admin/[user]/page.tsx` selects `WHERE slug = ? AND role = 'user'`, so
  an admin's own space **is not listable in the portal** — the spec would land
  somewhere the portal will not show it.

This is step 3's trap one level on: testing as yourself looks identical to a
broken feature. **Ruled: the interview runs logged in as `devtwo`.** Everything
then works unmodified and the checkpoint exercises the exact path a friend
walks, alert included. The cost is accepted: Nico's own spec lives under a dev
account, so step 5 builds his dashboard from `devtwo`'s record.

> **The checkpoint.** Log in as `devtwo` → run a real interview to completion →
> the agent proposes → the card renders with a working mockup → press **Build
> this** → the phone buzzes → the spec and mockup render in the admin portal →
> `./scripts/pull-spec.sh devtwo` writes both files into the repo.

Note `devtwo` is a live production login with a published password (step-3
residual 7). That residual is unchanged by this step and still belongs to
account hygiene before real friends are seeded — but it now also means a
confirmed spec sits behind that credential.

---

## 12. Known-unhandled

**The agent may never propose.** Nothing forces `propose_spec`; the agent
decides. An interview that never reaches a proposal is a friend who keeps
chatting — a soft failure, visible only by watching. Accepted deliberately over
a hard rule that would fire early on a shy interviewee. `spec_proposed` rows
against conversation counts are the query that would reveal it.

**The authoring call is cache-cold.** It resends the transcript under a
different system prompt, so it pays full input price for context the chat call
just cached. Roughly one extra transcript's worth of input tokens per proposal,
a handful of times per user, ever. Noted rather than optimised; the step-2
queued task on caching history is the place that would address it.

**Concurrent confirms can append twice.** The already-confirmed check and the
insert are not in a transaction. Same shape and same disposition as the
`conversationIdFor` race: it needs one person pressing one button twice in the
same instant, and the damage is a duplicate row rather than a lost one.
Revisit only if observed.

**`background` is interpretation.** §3.1. Stated here too because it is the one
field a later reader could mistake for a record of fact.

**The record and the repo file drift once building starts.** `specs` holds what
the friend confirmed; `users/<name>/mockup.html` holds what is being built, and
they diverge the moment a file is hand-edited. Deliberate — the record is the
promise, the file is the work — and `pull-spec.sh` overwrites the file, so
re-pulling after hand-editing discards local changes.

**No rate limit on proposals.** An account can drive as many authoring calls as
it can reach the propose branch. Same disposition as step 2's un-rate-limited
chat: reachable only by a logged-in pilot friend.

---

## 13. Out of scope

- The tweak-request queue: the unused `requests` table, the third admin pane,
  and a `tweak_requested` alert. A tweak presupposes a dashboard to tweak
  (step 5), and shipping the loop before anything can exercise it widens step 4
  for no evidence.
- A mid-interview escalation alert. `open_questions` reaches Nico at
  confirmation; until then the transcript carries it and the session-start
  buzz already says to go read it. At N=3 with interviews finishing in one
  sitting the delay is near zero, and real transcripts will show whether it
  ever bit.
- The substantive `agent-v1.md` interview rewrite (§10).
- Any dashboard panel, and any read of user data (step 5+).
- Plaid, encrypted per-user databases, login-triggered sync (step 6).
- The privacy toggle and the off-VPS metrics backup (step 7).
- Message-mirror and the headless-build approval gate (deferred in the plan).
