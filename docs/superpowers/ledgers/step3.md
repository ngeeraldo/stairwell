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

Two deviations from the plan, **both accepted by Nico on 2026-08-12**:

- **The metric-write test was strengthened**, under the standing "adopt the
  stronger test" policy. The plan's version asserted only that the alerter
  resolved — which passes with every inner guard deleted, because the outer
  backstop catches everything. It could not have failed for the reason its own
  comment gave. It now also asserts the send still happened, which is the claim
  that distinguishes "the metric failed" from "the alert failed". Ruled: this
  is what the policy exists for.

- **An alert-on-empty-reply test was added**, beyond the plan's error case.
  Ruled a correct derivation of the at-mint decision rather than a new one: the
  alert asserts presence, and a refusal is still a friend who showed up.

## Shipped

Merged to `main` as a fast-forward (task SHAs preserved), pushed, and deployed
to `app.stairwell.run` on **2026-08-12**. Both checkpoints passed — a real
phone buzzed on both the dev and the production topic, from a non-admin
account, with the `alert_sent` row to match.

The deploy took two attempts, and the first one failing is the better story:
`deploy/check-env.sh` **aborted it** over a missing `NTFY_TOPIC`, after the
pull and before `npm ci`, leaving the running version untouched. See
`required-env.md` — that gate had only ever been observed passing until now.

The topic values appear nowhere in this repo, in any commit, or in any ledger.
Before pushing, history was scanned for the shapes a topic can leak through —
`NTFY_TOPIC=` with a value, any `.env` ever tracked, `ntfy.sh/<topic>` URLs in
any blob, topic-shaped literals, and commit message bodies. The only topic
literals that have ever existed in this repository are `'   '`, `'a/b'`, and
`'topic-abc'`, all test fixtures.

## Residual risks

1. **A TYPO'D TOPIC PASSES EVERY LAYER.** `check-env.sh` proves presence, not
   validity. ntfy.sh accepts a publish to a topic with no subscribers and
   returns 200, so the alerter records `alert_sent`. Deploy green, metric
   green, phone silent — the exact shape this step was built to prevent,
   surviving one level up.

   **MITIGATION RULED (2026-08-12): the step-3 checkpoint, run twice.** Once
   locally against the dev topic; once at go-live against the production
   topic. The second was **blocking**: `check-env.sh` proves presence, only a
   subscribed phone proves the topic, and a deploy is not complete until a
   phone physically buzzes — the same rule `deploy/smoke.sh` already applies to
   serving ("started" is not "serving"), applied to alerting.

   **CLOSED 2026-08-12.** Both checkpoints ran and both buzzed a real phone.
   The residual is closed for the topic in use *today*; it re-opens on any
   topic change, which is why the checkpoint is written out below as a
   procedure rather than a one-time note. Rotate the topic, run it again.

2. **A CONCURRENT FIRST MESSAGE CAN DOUBLE-BUZZ.** `started` is derived from
   `lastTranscriptRow`, with no lock between the read and the insert. Two
   requests racing on one account can both see no prior row, both mint, and
   both alert. Pre-existing in step 2's `conversation_id` minting — the step-2
   design spec §8 "Known-unhandled" documents the same race for *grouping*,
   with the same "revisit only if observed" disposition. Step 3 gives it a
   visible symptom for the first time.

   **DEFERRED, ruled 2026-08-12.** At N=3 friends a duplicate notification is
   cosmetic, and the fix — a transaction around read-and-insert — costs more
   than the symptom. Revisit only if observed in practice. The evidence would
   be two `alert_sent` rows for one account with near-identical `at` values,
   or two conversations in the admin pane that should have been one.

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

7. **`devone` AND `devtwo` ARE LIVE PRODUCTION LOGINS WITH PUBLISHED
   PASSWORDS.** Not a step-3 defect — step 3 only made it visible, because
   checkpoint 2 required a non-admin account and `devone` was the one
   available, so the production checkpoint was run with a credential written
   in plain text in `scripts/create-dev-users.ts` and in `docs/local-dev.md`.
   Anyone who reads the repo can log into `app.stairwell.run` as `devone` and
   chat as them.

   Deliberately out of scope here rather than fixed in passing: it belongs to
   whoever owns account hygiene before real friends are seeded, and the fix
   (delete the fixtures from production, or rotate them to generated
   passwords) touches the account model rather than alerting. **Raised as a
   task, not a log entry** — CLAUDE.md > Ledgers. It should close before the
   first real user account exists, since that is the moment `devone` stops
   being the only thing an intruder could reach.

## The step-3 checkpoint — Nico's, run twice

Values live only in `.env` files, which the guard hook denies reading, so none
of this can be done from here.

The checkpoint is the same four moves both times, and it is the only thing that
catches residual 1. Presence checks cannot: a typo'd topic is present.

> **The checkpoint.** Subscribe the phone to the topic → send a message as a
> **non-admin** account → the phone physically buzzes → an `alert_sent` row
> exists for that account in `metrics`.
>
> `nico` is an admin account and is suppressed by design. Testing as yourself
> looks *identical* to a broken alerter: no push, no row, everything green.

### Checkpoint 1 — local, against the dev topic — **PASSED 2026-08-12**

Nico subscribed the phone to the dev topic, sent a message as a non-admin dev
user, the phone buzzed, and the `alert_sent` row was confirmed in
`platform/dev/synthetic.db`.

That is the first end-to-end evidence that the send path works: topic read from
`.env.local`, `started` computed, POST issued, ntfy.sh delivered, metric
written. Everything below the production topic itself is now proven rather than
assumed — which is exactly what D4 (local dev sends for real) was chosen to
buy, and what a `NODE_ENV` gate would have deferred to production.

The steps as run:

1. Pick an unguessable dev topic and add `NTFY_TOPIC=<dev-topic>` to
   `.env.local`. Until this exists, every local conversation start writes an
   `alert_failed`/`no_topic` row and `npm run dev` warns at startup.
2. Subscribe the phone to the **dev** topic.
3. Log in as `devone` or `devtwo` and send a message. If the last local message
   was under 30 minutes ago, this is a continuation and will *not* alert —
   wait, or use the other dev account.
4. Confirm the buzz, then confirm the row:
   `sqlite3 platform/dev/synthetic.db "SELECT * FROM metrics WHERE event LIKE 'alert%' ORDER BY id DESC LIMIT 5;"`

Unsubscribe from the dev topic afterwards if you would rather not be buzzed by
local testing — the send still happens either way, which is the point of D4.

### Checkpoint 2 — production, against the prod topic (BLOCKING) — **PASSED 2026-08-12**

Ran against `app.stairwell.run` as `devone`. The phone buzzed.

1. Pick a **different**, unguessable production topic and add
   `NTFY_TOPIC=<prod-topic>` to the droplet's `.env` — **generated, not
   chosen**. The topic is a shared secret with no auth around it: anyone who
   knows it can subscribe *and* publish, and the alert body carries a friend's
   slug, so a guessable topic leaks who is chatting and when. That is the
   privacy property content-free alerts exist to protect, handed back.
   `printf 'NTFY_TOPIC=stairwell-%s\n' "$(openssl rand -hex 12)" >> .env`
   writes one without ever printing it.
2. Push `main`, then run `deploy/deploy.sh`. Attempted before step 1 it aborts
   before `npm ci` — that is the gate working, not a failure. It did exactly
   that on the first attempt here.
3. Subscribe the phone to the **production** topic.
4. Run the checkpoint against `app.stairwell.run` with a real `user` account.

**Until that phone buzzes, the deploy is not complete.** A green
`deploy/smoke.sh` proves the site serves; it says nothing about whether a
notification will ever arrive. Treat a silent phone here exactly like a failed
smoke check: the deploy did not succeed, whatever every other layer reports.

**Two traps hit on the way through, worth writing down for the next rotation:**

- **`sed -i "s|^NTFY_TOPIC=.*|...|"` is a silent no-op when the key is absent.**
  Rotating an existing value and adding a new one are different commands, and
  the "rotate" form succeeds loudly while changing nothing. `grep -c
  '^NTFY_TOPIC=' .env` printing `0` instead of `1` is the tell, and it comes
  seconds before the deploy would have told you anyway.
- **Do not echo the topic into a terminal you might paste from.** The write
  command above prints nothing; read the value back with an explicit
  `grep '^NTFY_TOPIC=' .env` only when you need to type it into the phone.
