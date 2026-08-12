# Step 3 — ntfy.sh conversation alerts — design

**Date:** 2026-08-12
**Status:** APPROVED — four decisions ruled by Nico on 2026-08-12 (§3), on top
of four ruled in advance on 2026-08-11 (§2).
**Covers:** A content-free push notification to Nico's phone when a friend
starts a conversation.

**Origin:** `architecture-overview.md` §7 — "Alerts via ntfy.sh … session start
— first message after 30+ min silence, debounced". Decisions taken in advance
are recorded in `docs/superpowers/ledgers/step3.md`.

**Sequencing:** the required-env presence check landed first, deliberately
(`docs/superpowers/ledgers/required-env.md`), so `NTFY_TOPIC` is covered by
that gate from the day it exists rather than retrofitted after a phone that
never buzzes teaches us the same lesson twice.

---

## 1. Scope

| In | Out |
|---|---|
| One alert: a new conversation started | The second §7 alert — "spec confirmed / tweak requested" |
| Hosted `ntfy.sh` | Self-hosting an ntfy server |
| Fire-and-forget send plus a metric on both outcomes | Retries, queues, or any delivery guarantee |
| `NTFY_TOPIC` in `deploy/required-env` | Any sync of the topic value to or from the droplet |

The second alert is out because nothing to hang it on exists yet: spec
confirmation arrives in step 4. Adding a placeholder now would be a second
trigger rule with no producer.

No retries. A push notification that arrives late is worth less than the
complexity of a queue, and the metric makes a systematic failure visible
without one.

---

## 2. Decided in advance — do not relitigate

From `docs/superpowers/ledgers/step3.md`, ruled 2026-08-11:

1. **Hosted `ntfy.sh`, not self-hosted.**
2. **Alerts are content-free. Never message text.** This is what makes a
   third-party push service compatible with the privacy model rather than a
   contradiction of it — `architecture-overview.md` puts TLS termination on the
   droplet specifically so no third party sees anything. Lock-screen previews
   are a product change that re-opens self-hosting, not a copy tweak.
3. **Alert failure is fire-and-forget plus a metric.** A friend's chat turn must
   never fail because a push timed out.
4. **Nico supplies the topic name and installs the app** at go-live. The topic
   is a shared secret with no auth around it — anyone who knows it can both
   subscribe and publish — so it lives in `.env`, never in the repo.

---

## 3. Decided during this brainstorm

### D1. The alert fires at mint, before the model replies

Not after a completed turn. A friend who showed up and hit a chat outage is
exactly when the signal matters most; gating on success would make an outage a
*silent* phone, which is the same false-green shape as `step2.md` items 15 and
16.

### D2. Conversations on an `admin` account do not alert

Nico's step-4 interview runs on his own account and he will be at the computer
for it. Self-buzzing is how a tone gets ignored. The rule is one column —
`accounts.role` — so it is testable in one place.

### D3. `NTFY_TOPIC` is `REQUIRED`, not `DEGRADED`

By the letter of `deploy/required-env`, one broken feature with everything else
fine reads `DEGRADED`. That reading is wrong here, and the list's own wording
says why: `DEGRADED` is for absences where "its own error path carries it".
This absence has no error path a human meets — no 503, no error page, just a
phone that never buzzes. That is the `REQUIRED` definition: "a false green
nobody goes looking for". Nico supplies the topic at go-live regardless, so
blocking costs nothing after day one.

### D4. Local development sends for real, to a separate topic

`.env.local` gets a distinct topic Nico does not subscribe to. Every local
conversation start therefore exercises the real send path.

The rejected alternative was a `NODE_ENV` gate, which would mean the send path
never runs outside production — the exact class of thing that ships broken.
This mirrors the `PLATFORM_DB` ruling in `required-env.md`: be explicit locally
rather than exempt, because exemption is how a guard trains people to ignore
it.

---

## 4. Design

### 4.1 The trigger is already built

`architecture-overview.md` defines the alert condition as "first message after
30+ min silence, debounced". `lib/chat/conversation.ts` already mints a
`conversation_id` on exactly that boundary, and says so in its own comment. The
alert therefore reduces to **"a `conversation_id` was minted"** — one primitive,
no second rule that can drift from the first.

What is missing is only that the minting is not *reported*.
`conversationIdFor` returns a string whether it minted or reused, so nothing
downstream can tell the two apart.

**Change:** `conversationIdFor` returns `{ id: string; started: boolean }`.

The rejected alternative was for `runTurn` to compare the returned id against
`lastTranscriptRow` itself. That reimplements the boundary in a second place,
which is the drift this whole approach exists to avoid.

### 4.2 Placement in `runTurn`

`lib/chat/turn.ts` gains one dependency, `alert: (accountId: number) => void`,
and calls it when `started` is true — positioned:

- **After** `appendTranscript` of the user row. The alert asserts that a
  conversation started. If that insert throws, none did.
- **Before** the stream opens. The model's reply latency is not something the
  phone should wait on, and by D1 a turn that errors alerts anyway.

The dependency is a synchronous `void` function, so `runTurn` cannot
accidentally await it and cannot observe its outcome. Tests pass a spy: **chat
tests never reach ntfy.sh**, the same rule `lib/chat/turn.ts` already follows
for the Anthropic client.

### 4.3 `lib/alerts/ntfy.ts`

```
conversationAlerter({ topic, fetch, db, now }): (accountId: number) => void
```

**The returned function accepts an account id and nothing else.** There is no
parameter through which message text could reach ntfy.sh. Content-freeness (§2
item 2) is structural here, not a discipline someone has to remember — a future
edit that wanted to include message text would have to widen the signature,
which is a visible change rather than a silent one.

The posted body is exactly:

```
<slug> started a conversation
```

Sequence:

1. Look up the account by id. This needs a new `findAccountById` in
   `lib/auth/accounts.ts`, alongside the existing `findAccountBySlug`.
2. `role === 'admin'` (D2) or no account found → return, send nothing, record
   nothing. Suppression is not a failure.
3. No topic → record `alert_failed` with `reason: 'no_topic'` and return. This
   is the belt to D3's braces; the deploy gate is what should actually prevent
   it.
4. Otherwise start the POST with `AbortSignal.timeout(5000)` and return
   immediately.

The timeout is not optional detail: a hung ntfy.sh with no timeout holds a
socket for as long as the process lives, and fire-and-forget means nobody is
watching it.

The promise is `.catch()`-guarded end to end, **including the metric write**.
An `appendMetric` throw inside a floating promise is an unhandled rejection,
which under Node's default is a process-level event, not a logged line —
precisely the failure that must never be caused by an alert (§2 item 3).

### 4.4 Metrics — both outcomes, not only failures

Two events, in the style `chat_turn` / `chat_error` already establishes (one
event per fact, not one event with a boolean):

| Event | `data` |
|---|---|
| `alert_sent` | `{ kind: 'conversation_started', status }` |
| `alert_failed` | `{ kind: 'conversation_started', reason, status }` |

`reason` is one of `http` (a non-2xx response), `network` (fetch threw),
`timeout` (the abort fired), `no_topic`. `status` is the HTTP status for
`http` and `null` for the other three.

`timeout` and `network` are the same rejection channel, so they are separated
by the error's `name` being `TimeoutError` — what `AbortSignal.timeout` raises.
Anything else is `network`. Collapsing the two would hide the distinction
between "ntfy.sh is slow" and "the droplet has no egress", which are different
problems with different fixes.

**Why success is recorded too.** Failure-only leaves silence ambiguous: no rows
could mean nobody chatted, or it could mean alerting is dead. With `alert_sent`,
conversation starts — derivable from `transcripts` — diff against alerts sent,
so a silent stoppage is a visible gap rather than an absence of evidence. §2
item 3 makes the metric the only way anyone would ever discover alerts had
stopped; a metric that cannot distinguish "quiet" from "broken" does not
discharge that.

Neither event's `data` carries any text. The `account_id` column already
identifies who, so nothing about the alert's subject needs to go in `data`.

### 4.5 Wiring

`app/api/chat/route.ts` builds the alerter and passes it into `runTurn`,
alongside the existing `client` and `now` dependencies. It reads `NTFY_TOPIC`
from `process.env` at call time rather than at module scope, matching how the
route already defers `chatClient()` so a missing credential fails one request
instead of the module import.

### 4.6 Environment

`deploy/required-env` gains one line:

```
NTFY_TOPIC  REQUIRED  # ntfy.sh topic for conversation-start alerts. Absent, no push is sent and nothing user-visible fails — the only symptom is a phone that never buzzes.
```

That is the entire integration. `deploy/check-env.sh` and `lib/env/report.ts`
both read this list, so neither needs a code change — which is the property the
required-env branch was built for, now being collected.

`docs/local-dev.md` gains one sentence directing the reader to set a separate
dev topic in `.env.local` (D4). Noted against `required-env.md` residual 7:
that file now names a third environment variable with nothing pinning it. The
residual is accepted, not closed, and this widens it by one.

**Go-live order:** set `NTFY_TOPIC` in the droplet's `.env`, *then* deploy. A
deploy attempted first will be blocked by `check-env.sh`, which is D3 working.

---

## 5. Testing

`lib/chat/turn.ts` already takes its client as a parameter so tests can pass a
fake; the alerter follows the same contract, with `fetch` injected. **No test
in this step performs a real HTTP request.**

**`tests/chat/conversation.test.ts`** — updated for the `{ id, started }` return
shape, including that a reused id reports `started: false`.

**`tests/chat/turn.test.ts`** — the alert fires on a new conversation; does not
fire on a continuation; still fires when the stream errors (D1).

**`tests/alerts/ntfy.test.ts`**, with a fake `fetch`:

- an `admin` account sends nothing and records nothing;
- an unknown account id sends nothing;
- no topic → `alert_failed` / `no_topic`, no fetch attempted;
- a 200 → `alert_sent`;
- a non-2xx → `alert_failed` / `http` with the status;
- `fetch` rejecting → `alert_failed` / `network`;
- the abort firing → `alert_failed` / `timeout`;
- an `appendMetric` that throws does not produce a rejected promise;
- the request body is exactly `<slug> started a conversation`.

**`tests/alerts/leak.test.ts`** — one test wired through `runTurn` with a real
alerter over a fake `fetch`. A turn is sent whose body is a distinctive
sentinel; the test asserts the fetch **was called**, and that no request it
observed contains the sentinel anywhere — URL, headers, or body.

The "was called" assertion is not decoration. A leak test that passes because
nothing was sent is a test that cannot fail, which this project has already
shipped once and had to close (`step2.md`). Both halves are required for the
test to mean anything.

---

## 6. Accepted limits

- **No delivery guarantee.** A dropped push is an `alert_failed` row and nothing
  more. This is §2 item 3 as ruled, not an oversight.
- **The 5-second timeout is a guess.** It is chosen to be well under any
  plausible human patience for the signal and well over ntfy.sh's normal
  response. Nothing depends on the exact number.
- **`ntfy.sh` learns a slug and a timestamp.** That is the ruled shape (§2 item
  2). It is a real disclosure to a third party, and the reason the alert carries
  nothing else.
- **Presence-checking the topic is not validity-checking it.** A typo'd topic
  passes `check-env.sh`, sends successfully, and buzzes nobody's phone — ntfy.sh
  accepts a publish to a topic with no subscribers. Only a test push at go-live
  catches that, which is why installing the app and confirming one real alert is
  part of §2 item 4 rather than assumed.
