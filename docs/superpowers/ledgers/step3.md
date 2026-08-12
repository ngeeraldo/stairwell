# Step 3 ledger — ntfy.sh alerts

Spec: `docs/superpowers/specs/2026-08-12-step3-ntfy-alerts-design.md`

Opened before step 3 begins, to hold decisions Nico made in advance on
2026-08-11 while closing step 2. No implementation has started.

Four further decisions were ruled during the 2026-08-12 brainstorm — alert
timing, admin suppression, `NTFY_TOPIC` severity, and local-dev behaviour.
They live in §3 of the spec rather than being duplicated here.

## Decisions already made — do not relitigate

1. **Hosted `ntfy.sh`, not self-hosted.** Self-hosting is scope this pilot
   does not need.

2. **Alerts are content-free. Never message text.** The shape is
   "devtwo started a conversation" — a signal, not a payload.

   This is what makes hosted ntfy compatible with the privacy model rather
   than a contradiction of it. `architecture-overview.md` lines 72-79 put
   TLS termination on the droplet specifically so no third party sees
   anything; routing alert *content* through ntfy.sh would put one back in
   the path. Content-free alerts keep the third party honest without paying
   for self-hosting. If message previews on the lock screen are ever wanted,
   that is a product change that re-opens the self-hosting question — it is
   not a copy tweak.

3. **Alert failure is fire-and-forget plus a metric.** A friend's chat turn
   must never fail because a push notification timed out. The metric is the
   only way anyone would ever discover that alerts had silently stopped.

4. **Nico supplies the topic name and installs the app** when step 3 is
   live. The topic is a shared secret with no auth around it — anyone who
   knows it can both subscribe and publish — so it belongs in the droplet's
   `.env` and in the local environment, never in the repo.

## Sequencing ruled

The required-env presence check (queued in `step2.md`) lands **before**
step 3, so the ntfy topic is covered by that check from the day it exists
rather than retrofitted after it bites. A missing topic fails the same way
items 15 and 16 in `step2.md` did: a green deploy over something that
silently does not work — here, a phone that simply never buzzes.

## Free inheritance from step 2

The alert condition needs no new rule. `architecture-overview.md` line 126
defines it as "first message after 30+ min silence, debounced", and step 2's
`conversation_id` (see `lib/chat/conversation.ts`) is minted on exactly that
boundary. The alert reduces to "a new `conversation_id` was minted" — one
primitive, no second rule that can drift from the first.

Step 3 will therefore also exercise the 30-minute boundary continuously in
production, which is why `step2.md` records the manual boundary check as
deliberately deferred rather than skipped.

---

## Built

Plan: `docs/superpowers/plans/2026-08-12-step3-ntfy-alerts.md`. Five tasks, all
landed on `step3-ntfy-alerts` on 2026-08-12. 349 tests pass, `tsc --noEmit` is
clean, and `next build` succeeds.

The free inheritance held. `conversationIdFor` gained a `started` flag and that
was the entire trigger — no second boundary rule was written. The required-env
work also paid out as designed: declaring `NTFY_TOPIC` needed **no code change
at all**, because `deploy/check-env.sh` and `lib/env/report.ts` both read the
list.

One deviation from the plan, taken under the standing "adopt the stronger test"
policy: the plan's metric-write test asserted only that the alerter resolved.
That assertion passes with every inner guard deleted, because the outer
backstop catches everything — it could not have failed for the reason its own
comment gave. It now also asserts the send still happened, which is the claim
that actually distinguishes "the metric failed" from "the alert failed".

**NOT DEPLOYED.** See "Go-live" below — the remaining steps are Nico's.

## Residual risks

1. **A TYPO'D TOPIC PASSES EVERY LAYER.** `check-env.sh` proves presence, not
   validity. ntfy.sh accepts a publish to a topic with no subscribers and
   returns 200, so the alerter records `alert_sent`. Deploy green, metric
   green, phone silent — the exact shape this step was built to prevent,
   surviving one level up. Only a real test push catches it, which is why
   go-live step 4 below is a step and not an assumption.

2. **A CONCURRENT FIRST MESSAGE CAN DOUBLE-BUZZ.** `started` is derived from
   `lastTranscriptRow`, with no lock between the read and the insert. Two
   requests racing on one account can both see no prior row, both mint, and
   both alert. Pre-existing in step 2's `conversation_id` minting; step 3 gives
   it a visible symptom for the first time. Harmless (two notifications), and
   the fix — a transaction around read-and-insert — costs more than the
   symptom.

3. **AN IN-FLIGHT ALERT IS LOST SILENTLY ON RESTART.** The send is
   fire-and-forget and nothing tracks it at shutdown, so a deploy landing
   inside the ~5-second window drops both the push *and* its metric row: the
   `record` call never runs. A dropped alert normally leaves an `alert_failed`
   row; this is the one path that leaves nothing at all.

4. **NOTHING PINS THE 5-SECOND TIMEOUT.** The test asserts only that *an*
   `AbortSignal` is attached. `ALERT_TIMEOUT_MS` could be changed to 5 ms and
   every test would stay green while every alert timed out — recorded as
   `alert_failed`/`timeout`, at least, so it would be visible in the log.

5. **CONTENT-FREENESS IS STRUCTURAL PER FUNCTION, NOT PER FILE.** The guarantee
   is that `conversationAlerter` has no parameter for text. A second alert type
   added to `lib/alerts/` would carry no such guarantee automatically, and the
   leak test only covers this one. Step 4's "spec confirmed / tweak requested"
   alert is where this gets tested.

6. **`docs/local-dev.md` NOW NAMES THREE ENVIRONMENT VARIABLES** with nothing
   pinning them. Residual 7 in `required-env.md`, widened by one as predicted
   in the design spec. Accepted, not closed.

## Go-live — Nico's, in this order

Values live only in `.env`, which the guard hook denies reading, so none of
this can be done from here.

1. Pick a topic name and add `NTFY_TOPIC=<topic>` to the droplet's `.env`.
   Unguessable: the topic is a shared secret with no auth around it.
2. Install the ntfy app and subscribe to that topic.
3. Run `deploy/deploy.sh`. Attempted before step 1, it aborts before `npm ci` —
   that is the gate working, not a failure.
4. Send a real message from a `user` account (**not** `nico` — admin accounts
   are suppressed by design) and confirm the phone buzzes. This is the only
   check that catches residual 1.
5. Locally, add `NTFY_TOPIC` to `.env.local` with a *different* topic you do
   not subscribe to. Until then, every local conversation start writes an
   `alert_failed`/`no_topic` row and `npm run dev` warns at startup.
