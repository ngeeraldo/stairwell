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
