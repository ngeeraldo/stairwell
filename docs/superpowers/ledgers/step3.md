# Step 3 ledger — ntfy.sh alerts

Opened before step 3 begins, to hold decisions Nico made in advance on
2026-08-11 while closing step 2. No implementation has started.

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
