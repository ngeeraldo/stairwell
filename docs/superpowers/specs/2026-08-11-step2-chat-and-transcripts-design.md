# Step 2 — Chat Surface, Agent, and Transcripts

**Date:** 2026-08-11
**Status:** Approved, pre-implementation
**Covers:** Build-order step 2 — the toggleable chat window, the Claude-backed
agent with system prompt v1, transcript persistence, and the admin transcript
pane. Plus one auth-tier correction (§4) that step 2 forces into the open.

**Paired with:** `2026-08-10-step1-auth-and-test-gate-design.md` (auth, session,
test gates) and `2026-08-10-step1-infra-and-deploy-design.md` (droplet, deploy).
Both must be complete; neither depends on this one.

**Checkpoint:** a dev user chats with the bot at `https://app.stairwell.run`
and the transcript appears in the admin portal, grouped into conversations.

---

## 1. Decisions made during this design

| Question | Decision |
|---|---|
| Provider / SDK | Anthropic, `@anthropic-ai/sdk`, in-process. No separate backend. |
| Model | `claude-opus-5`, read from `CHAT_MODEL`, stamped per call into metrics |
| Conversation grouping | `session_id` **and** `conversation_id`; boundary = first message after 30+ min silence |
| Prompt versioning | Versioned file under `platform/prompts/`; `prompt_sha` on every transcript row |
| Streaming | Yes. Assistant turn appends **only** on completion |
| Aborted stream | Append nothing; log `stream_aborted`; UI shows an explicit interrupted marker |
| Metrics shape | `metrics.data`, nullable JSON. Four token counters, not two |
| Chat placement | Toggleable panel on `/[user]`, open by default |
| Request cycle | Route handler owns the stream (§3) |
| Locked sessions | A locked session reaches its own `/[user]` and can chat; data panels stay locked (§4) |
| Prompt text and Gate B | Explicit `platform/prompts/*` exemption arm, not the incidental `*.md` one |

### 1.1 What the plan did and did not already decide

`architecture-overview.md` names Plaid and SQLite as decided and marks them
not-to-relitigate. It never names an LLM provider — line 146 says only "LLM
chatbot". No provider marker exists anywhere in the repo and no LLM SDK is
installed, so this spec makes that choice rather than recording one.

The model id is configuration, not architecture. It lives in `CHAT_MODEL` and
is written into every metrics row, so a later model comparison can be done
retroactively against real pilot traffic instead of re-running anything.

---

## 2. Data

Both sacred tables gain columns. This is the one part of step 2 that cannot be
revised later: `transcripts` and `metrics` are append-only and never migrated
(CLAUDE.md > Sacred data), so anything not captured from the first API call is
not recoverable.

### 2.1 Column additions

`transcripts` gains three `TEXT NOT NULL` columns:

| Column | Meaning |
|---|---|
| `session_id` | The auth session that produced the row. Audit trail. |
| `conversation_id` | The product unit. What "the interview" means as a query. |
| `prompt_sha` | First 12 hex chars of the sha-256 of the prompt file bytes. |

`metrics` gains `data TEXT`, nullable JSON.

`prompt_sha` goes on **every** row, user turns included. A user turn was not
produced by the prompt, but it was shaped by it, so stamping both sides is what
makes "did v3 change how people answer?" a query rather than a guess. A short
content hash rather than a human label, so a quiet edit to the prompt file
cannot pass itself off as the version that came before it.

### 2.2 Why `session_id` alone is not enough

`session_id` is an auth artifact and is wrong for grouping in both directions.

It is too fine: `lib/session/store.ts` mints a fresh random id on every login,
so a logout, a second device, or cleared cookies splits one continuous
conversation across ids.

It is too coarse: `lib/session/cookie.ts` sets a 30-day TTL, so a friend who
just opens the dashboard each morning holds one session for the whole pilot.
The interview, week-1 tweaks, and week-3 chat would all carry the same id — the
interview stops being separable at exactly the moment the retention analysis
needs it.

Both columns are kept. `session_id` answers "which login wrote this";
`conversation_id` answers "which conversation is this".

### 2.3 `conversation_id`

Minted by `conversationIdFor(db, accountId, now)`:

- No prior transcript row for the account → fresh random hex.
- `now - last.at > 30 minutes` → fresh random hex.
- Otherwise → reuse the last row's `conversation_id`.

The 30-minute boundary is not invented here. `architecture-overview.md` line
126 already defines it for the step-3 alerts — *"session start — first message
after 30+ min silence, debounced."* Step 2's grouping and step 3's alerting
want the same primitive, so step 3 reduces to "`conversation_id` is new → ntfy"
rather than a second, separately-drifting rule.

The id is computed **once**, when the user turn is appended. The assistant turn
reuses that value verbatim and never recomputes the gap.

### 2.4 Why this is not a migration

`lib/db/platform.ts` exec's `schema.sql` on every open, so schema.sql is
already the de-facto migration runner — but only for `IF NOT EXISTS` DDL, which
will not alter an existing table. And SQLite rejects `ADD COLUMN ... NOT NULL`
without a `DEFAULT`, so an ALTER route would leave a freshly-created database
and a migrated one carrying different schemas. Drift in the sacred table is the
specific outcome this project's rules exist to prevent.

There is a cleaner reading. `appendTranscript` and `appendMetric` have no
production callers — they appear only in `tests/db/appendOnly.test.ts`. Neither
table has ever been written to outside the test suite. This is therefore not a
migration of data; it is finishing a table definition before its first use.

A new `lib/db/reshape.ts` runs **before** the schema exec in `openPlatformDb`.
For each sacred table it compares `PRAGMA table_info` against the expected
column set, and:

- column missing **and** `COUNT(*) = 0` → drop the table, letting the schema
  exec recreate it. Dropping a table drops its triggers and indexes, and
  schema.sql's `CREATE TRIGGER IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
  rebuild them in the same open.
- column missing **and** the table is not empty → throw, naming the table and
  the row count.

The second branch is the point of the module. The production database is never
opened during development (CLAUDE.md > Data safety), so this design cannot
verify emptiness by inspection — it checks at runtime instead of assuming. If
the assumption is wrong, the deploy fails loudly and the site 500s until a
human intervenes; history is untouched.

Precisely: `getDb()` is lazy, so `openPlatformDb` runs on the first database
touch rather than at boot — the process starts healthy and then 500s per
request. `deploy/smoke.sh`'s login step touches the database, so the throw does
fail the deploy. There is no rollback; `deploy/deploy.sh` says so in its own
words. Accepting that outcome is deliberate: an outage is recoverable by hand,
and a destroyed append-only table is not.

### 2.5 `metrics.data`

Nullable JSON, so future metric shapes never require another change to the
sacred table. Four events ship in step 2:

```
{ event: 'chat_turn',        data: { input, output, cache_read, cache_creation,
                                     model, effort, prompt_sha, context,
                                     model_served, fallback_fired } }

{ event: 'stream_aborted',   data: { input, output, cache_read, cache_creation,
                                     model, effort, prompt_sha, context,
                                     delivered_chars } }

{ event: 'chat_error',       data: { input, output, cache_read, cache_creation,
                                     model, effort, prompt_sha, context,
                                     model_served, fallback_fired,
                                     kind, status, type, delivered_chars } }

{ event: 'chat_empty_reply', data: { input, output, cache_read, cache_creation,
                                     model, effort, prompt_sha, context,
                                     model_served, fallback_fired,
                                     stop_reason, delivered_chars } }
```

`stream_aborted` and `chat_error` are separate events because they are separate
facts. The first is the user or their network walking away; the second is the
API failing. Both append no assistant row, but conflating them would make the
cost log unreadable, and `kind` is what distinguishes a rate limit from a
refusal from a timeout when the week-3 numbers get read.

`kind` is derived by `instanceof` against the SDK's exported error classes, in
`lib/chat/client.ts`. It cannot come from `error.name`: no class in
`@anthropic-ai/sdk`'s hierarchy assigns `name`, so `RateLimitError`,
`AuthenticationError`, `InternalServerError` and the rest all inherit
`Error.prototype.name === "Error"` and the field would be a constant. It cannot
come from `constructor.name` either — that is minifier-fragile in a Next
production build. `status` and `type` carry the HTTP status and the API's own
`error.type` discriminator where the response supplied them. `lib/chat/turn.ts`
does not import the SDK; the normalized shape crosses that boundary as plain
data.

`chat_error` carries the four counters too. The earlier rationale — "an error
before first output has none" — is only true for errors before first output. A
529 or a dropped connection after 400 tokens of output has real, billed
counters.

`chat_empty_reply` is the turn that resolved successfully and delivered nothing
usable: a safety-classifier refusal (HTTP 200, empty `content`,
`stop_reason: "refusal"`) or a `max_tokens` stop that truncated the answer. It
appends no assistant row, because an empty body in an append-only table 400s
every later turn for that account and can never be deleted. `stop_reason` is
recorded so the two causes stay distinguishable.

`model_served` and `fallback_fired` record which model actually answered and
whether a server-side refusal fallback fired (§3.2). Without them a fallback
would silently change the answering model and corrupt exactly the cost
retrospective the four counters exist to support.

`context` is the run kind from `architecture-overview.md` line 136 —
"interview, planning, tweak runs". In step 2 no spec exists yet, so every turn
is `interview`; the transition to `tweak` arrives with step 4.

Four token counters, not two. A page-length system prompt resent on every turn
is the obvious caching candidate, and `cache_control` is enabled from the first
call (§3.2) — so `{input, output}` alone would misstate cost by construction.
`model` and `effort` are recorded per call for the same reason: the amendment's
purpose is retroactive comparability, which only works if the comparison keys
were written down at the time.

### 2.6 `lib/db/appendOnly.ts`

Both writers take the new fields as required arguments. `readTranscript` stays
as-is; a grouped reader is added for the admin pane. The module keeps its
current shape — appends and reads, nothing else.

---

## 3. Runtime

### 3.1 Modules

Decision logic in `lib/`, adapters in `app/`, matching the existing pattern.

| File | Job |
|---|---|
| `platform/prompts/agent-v1.md` | The prompt text. Prose, no logic. |
| `lib/chat/prompt.ts` | `loadPrompt(): {text, sha}`. Read once per process. |
| `lib/chat/history.ts` | Transcript rows → Anthropic `messages`. |
| `lib/chat/client.ts` | The Anthropic SDK behind a narrow interface. |
| `lib/chat/turn.ts` | The append rule, end to end. |
| `app/api/chat/route.ts` | Adapter: resolve state, call `turn.ts`, pipe the stream. |

`turn.ts` takes the client as a parameter rather than importing it. That is what
lets the suite drive every path — completion, abort, API error — without a
network call.

History is the full transcript for the account, not just the current
conversation. Goals surface over weeks (`architecture-overview.md` §5), so the
agent needs to remember earlier conversations. At pilot scale this is far inside
the context window.

### 3.2 The model call

- `model`: `CHAT_MODEL`, defaulting to `claude-opus-5`.
- `max_tokens`: 8192 — far above any conversational turn, so it bounds a
  runaway without risking a truncated reply.
- Thinking: left at the model default (adaptive). Not disabled: on this model
  disabling it risks internal tags leaking into visible output, and the reply
  goes straight to a friend.
- `output_config.effort`: `medium`.
- `cache_control: ephemeral` on the system block.

### 3.3 Wire format

NDJSON. One JSON object per line: `{"t":"…"}` per text delta, then a terminal
`{"done":true}`.

Completion is therefore something the client can observe. "No `done` line" is
exactly the interrupted case, which is what the UI needs to distinguish (§6.1).
A one-way text stream does not need SSE framing.

### 3.4 The append rule

This rule is permanent. Append-only means it cannot be corrected in place later,
so it is specified explicitly rather than left to the implementation.

1. Request arrives. Resolve `conversation_id` (§2.3).
2. **Append the user turn immediately**, with `session_id`, `conversation_id`,
   and `prompt_sha`.
3. Call the model, streaming deltas to the client as they arrive.
4. On the stream completing server-side: **append the assistant turn**, then
   append the `chat_turn` metric.
5. On abort (`request.signal`): abort the upstream call, append **no assistant
   row**, append a `stream_aborted` metric with the counters known so far.
6. On API error: append **no assistant row**, append a `chat_error` metric.

The user turn appends immediately and only the assistant turn waits for
completion. An aborted or failed exchange therefore leaves a user row with no
reply — which is what actually happened, and is a signal week-3 analysis wants.
The transcript records what the user actually received.

### 3.5 Auth on `/api/chat`

`middleware.ts` only bounces requests with no session cookie at all, and a
locked session has one, so `/api/chat` reaches the handler. The handler calls
`resolveState` directly: `anonymous` → 401, `authenticated` or `unlocked` →
proceed.

Not `requireState` — that returns redirect targets, which is the wrong response
shape for an API route and would hand a JSON caller a 307 to a page.

---

## 4. The locked-page fix (auth-tier)

Step 2 forces a latent contradiction into the open.

`app/[user]/page.tsx` calls `requireState`, and `routeFor` in
`lib/session/resolve.ts` sends an `authenticated`-but-locked session to
`/unlock`. So a locked user cannot reach the page the chat panel lives on: the
chat API would work while locked, but nothing could call it.

That contradicts `architecture-overview.md` line 59 — *"the chat surface keeps
working across the tweak loop, and data panels ask for the password again."*
Line 59 is the spec; the current routing is an unfinished execution of it, from
a step where no chat surface existed to keep working.

The fix: `routeFor` lets a locked session reach its own `/[user]` space, and the
unlock requirement moves down to the panel layer. In step 2 the panel layer is a
locked placeholder where the dashboard lands at step 5. Cross-user protection is
unchanged — `canSeeUserSpace` still 404s another user's space, and admin is
still not an override.

Four tests ship with it:

- **locked-can-chat** — a locked session reaches `/[user]` and `/api/chat`
  answers it.
- **locked-cannot-see-data** — the data region renders the locked placeholder,
  not dashboard content.
- **anonymous-still-bounced** — no session still redirects to `/login`, and
  `/api/chat` still 401s.
- **unlock-still-works** — `/unlock` continues to promote a locked session, and
  the key still lands only in the in-process map.

---

## 5. System prompt v1

Lives at `platform/prompts/agent-v1.md`. New versions are new files; the sha
stamped on each transcript row ties rows to exact bytes.

Authorship is split. The first pass is structural, written against the list in
`architecture-overview.md` §8 — persona and tone, interview behavior
(monitoring-first framing, goals optional and never demanded, accounts, what
they will realistically log), honest expectation-setting (builds arrive next
morning, tweaks within hours, never promise instant), and escalation rules
(feasibility questions get flagged to Nico, not guessed at). Nico then rewrites
substantively, particularly the interview opening and the monitoring-first
moves.

**The capabilities section is written strictly from the enabled-products
ruling.** Per `architecture-overview.md` §3, enabled are: Transactions (24mo
history), Balance, Transactions Refresh, and Recurring Transactions.
Investments and Liabilities are **not** enabled. The prompt must not imply
otherwise, and must route a friend who needs them to Nico rather than promising
a panel — line 98 makes checking this *before* promising an explicit
requirement. No invented Plaid abilities.

The spec-confirmation output contract named in §8 belongs to step 4 and is out
of scope here.

---

## 6. UI

### 6.1 Chat panel

`app/[user]/ChatPanel.tsx`, a client component on the existing `/[user]` page:
message list, textarea, submit. Open by default, `[hide chat]` toggles it, and
the toggle state lives in `localStorage` — no key material is involved, so the
data-safety rule is untouched.

The reply renders deltas as they arrive. If the stream ends without
`{"done":true}`, the partial text goes grey and is labelled `interrupted — not
saved`, with a `[retry]`. The marker is UI-only; nothing is written. The screen
and the transcript agree, and the user learns the reply is gone instead of
discovering it after a refresh.

`[retry]` is an ordinary new turn, not a special reply-only mode. The user row
from the interrupted exchange was already appended (§3.4) and cannot be amended,
so a retry appends a second user row with the same text. The transcript then
reads: message sent, no reply, message sent again, reply — which is a faithful
record of what happened, and needs no machinery to produce.

Placement matches `architecture-overview.md` line 46 — a single chat window
alongside the dashboard — so step 5 adds panels beside it rather than relocating
it.

### 6.2 Admin transcript pane

`app/admin/[user]/page.tsx`, admin-only via the existing `isAdmin`, 404 for
anyone else. Transcripts grouped by `conversation_id`, newest conversation
first, each turn showing role, timestamp, and `prompt_sha`. The user list in
`app/admin/page.tsx` becomes links.

Read-only. The admin portal is not a back door into a dashboard
(`lib/auth/authorize.ts`), and transcript visibility is already covered by the
onboarding promise.

---

## 7. Gates, tests, and docs

### 7.1 Tests

No test makes a network call. `turn.ts` takes the client as a parameter and the
suite supplies a fake.

| File | Pins |
|---|---|
| `tests/db/reshape.test.ts` | Drop-if-empty; loud throw when non-empty; triggers rebuilt after a drop |
| `tests/db/appendOnly.test.ts` | Extended for the new required columns |
| `tests/chat/prompt.test.ts` | Sha changes iff the bytes change; stable across reads |
| `tests/chat/turn.test.ts` | Append on completion; nothing on abort; both metric shapes; 30-minute grouping |
| `tests/chat/route.test.ts` | 401 anonymous; works while locked |
| `tests/admin/transcriptPane.test.ts` | Grouping, admin-only, 404 otherwise |
| `tests/routing/*` | The four auth-tier tests in §4 |

### 7.2 Gate B

`.githooks/pre-commit` gains an explicit exemption arm for `platform/prompts/*`.

The file would already be exempt today — `_gate_b_class` matches `*.md` and
returns before reaching the `platform/*` guard arm. But that is exemption by
extension, not by intent: a load-bearing runtime input currently looks like
documentation to the gate, and narrowing the `.md` rule later would silently
make the prompt guarded. The explicit arm records why the prose is exempt while
the loader and the hash stamping are not.

This touches `.claude/hooks` scope, so a case is added to
`.claude/hooks/test-hooks.sh`, which is run and reported per CLAUDE.md.

### 7.3 Docs

- **CLAUDE.md** — `platform/prompts/*` is runtime prose, not documentation and
  not logic: the loader and the hash are tested, the text is not. Plus the rule
  that chat tests never call the live API.
- **deploy/PROVISION.md** — `ANTHROPIC_API_KEY` goes in the existing
  `EnvironmentFile` at `deploy/stairwell.service:11`. A one-time droplet step on
  a file outside the repo; the deploy contract is unchanged and `deploy.sh`
  still owns every deploy.
- **docs/local-dev.md** — local key setup, alongside the existing
  `ADMIN_PASSWORD` guidance. The key is never committed, logged, or written to
  any fixture.

---

## 8. Known-unhandled

**The `conversationIdFor` race.** Two concurrent turns from one account can both
read the same last row and disagree on the boundary, producing either a split
conversation or a merged one. Documented deliberately rather than solved: it
requires one person sending two messages in the same instant from two devices,
the damage is a mis-grouped row rather than a lost one, and the transcript
itself stays correct and complete. Revisit only if it is observed.

**Partial replies are invisible in the transcript.** By design (§3.4). A user
who saw half an answer has no record of it, and the next turn's context does not
include it. This is the deliberate consequence of "the transcript records what
the user actually received", and the interrupted marker (§6.1) is what keeps the
user from being misled.

**No rate limiting.** The chat surface is reachable only by a logged-in pilot
friend. `max_tokens` bounds a single reply; nothing bounds turns per day. Left
out until there is a reason.

---

## 9. Out of scope

- The spec-confirmation output contract and inline HTML mockup rendering (step 4)
- ntfy alerts (step 3) — though §2.3 deliberately supplies the primitive
- Any dashboard panel, and any read of user data (step 5+)
- Plaid, encrypted per-user databases, and the login-triggered sync (step 6)
- The privacy toggle and the off-VPS metrics backup (step 7)
- Message-mirror and the headless-build approval gate (deferred in the plan)
