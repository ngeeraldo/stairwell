# System structure changes — unified proposal loop

**For Claude Code.** This describes the target structure, what it replaces, and what
must change in code and in `ARCHITECTURE.md`. It states requirements and decisions;
map them onto the actual repo layout, which you can see and I cannot. Where this
document conflicts with the current implementation, this document wins; where it is
silent, existing conventions stand.

## 1. The core change

**Remove the tweak/build distinction everywhere it exists or was planned.** There is
no tweak classifier, no tweak pipeline, no deferred "tweak-request queue" as a
separate structure. There is exactly one loop:

```
always-on chat (agent as PM, user present)
  → discovery (proportional to ambiguity — may be one turn)
  → readiness gate (want / cost accepted / context of use known)
  → propose_spec
  → spec version N+1 written, schema-validated, appended
  → preview card (leads with what changed vs. version N) — Build this / Not quite yet ⌄
  → confirm → ntfy → Nico + Claude Code build to "make the code match spec vN+1"
  → deploy → agent announces in chat
  → loop
```

Every user request — first-ever interview, a new screen, a relabel — travels this
loop. They differ only in the size of the diff between spec versions and in how much
discovery precedes the proposal.

## 2. One versioned whole-surface spec per user

- The append-only specs table from step 4 becomes the home of **whole-surface spec
  versions**: version N always describes the user's *entire* dashboard (all screens,
  panels, data sourcing), not just what the latest conversation touched.
- Version 1 is the interview-era spec, unchanged in role. Every subsequent confirmed
  proposal appends version N+1 as a complete document.
- The build instruction is always the same: make the user's dashboard code match the
  latest confirmed version. No build ever targets "the code as it is plus a request."
- The diff between consecutive versions is the canonical record of what a request
  was. This replaces free-text request classification and directly feeds the
  "expressible as config vs. needed custom code" metric — compute and store the diff
  (or make it cheaply derivable) rather than classifying chat text later.
- Spec shape and validation rules are in `03-spec-schema.md`.

## 3. propose_spec and the emission path

- Keep the current implementation shape (tool call ending the turn; spec and mockup
  produced by separate call(s) after it) **unless** it cannot satisfy this
  requirement, which is non-negotiable: **the emitted spec version must validate
  against the schema in `03-spec-schema.md` before anything renders to the user.**
  Validation failure is loud — retry the generation call with the validation error;
  never fall back to unvalidated output.
- The spec-writer call takes the transcript *plus the current confirmed spec version*
  as input and emits the full next version. For version 1 the current version is the
  empty spec.
- Mockup generation stays a separate, independently re-runnable step, consuming the
  validated spec version.
- **Proportional preview:** the card leads with what changed relative to the prior
  confirmed version (the `change_summary` from the schema). For version 1, "what
  changed" is the whole dashboard, which degenerates to the current behavior. Full
  mockup re-render is acceptable for the pilot; highlighting only changed panels is
  a styling improvement, not a requirement.
- **Confirmation is always required.** No fast path that deploys without a confirmed
  version, regardless of how trivial the change looks.
- Recommended, small, and optional if it threatens the timeline: an **internal
  critique pass** between spec-writing and preview — one cheap LLM call that reads
  the draft version as a skeptical engineer and designer and returns either
  `pass` or 1–3 follow-up questions. Questions are asked by the agent in chat (the
  user is still present); on answers, the spec-writer re-runs. If skipped, note it
  as deferred in the ledger.

## 4. Post-build behaviors (new, replaces the unspecified "post-build era")

- On deploy, the system enables the agent to post a deploy announcement in the
  user's chat referencing what shipped (sourced from the confirmed version's
  `change_summary`). Mechanism is your choice (e.g., a system-injected event the
  agent turns into a message); requirement is that the announcement is in-chat and
  specific.
- Mid-build blocker questions from Nico surface as agent messages in chat, and the
  answer is captured in the transcript. No new surface — the chat remains the log
  of record.

## 5. Dashboards accept input (make explicit)

Previously implicit; now a stated convention:

- Per-user dashboard code may include **entry widgets** — forms writing to the
  user's own SQLite during their session. This covers both creating new hand-logged
  data and annotating synced data.
- **Annotations on synced rows live in user tables keyed to the synced rows, never
  as edits to shared-module tables.** This is the existing "shared-module internals
  are never forked" rule applied to writes; it protects annotations from being
  trampled by login sync or a re-pull.
- Per-user `tests/` must cover write paths (inserts, annotation joins), not just
  rendering. The co-location/same-commit rule extends to any annotation tables:
  `schema.sql`, `seed.py`, and tests update together.
- The privacy rule is restated as: no component **reads or writes** real data
  unattended. Entry widgets only fire during the user's session, so this holds.

## 6. ARCHITECTURE.md updates

Update the living doc in the same change. Specifically:

1. **§ "The agent's core job"** — reframe as PM-of-one-stakeholder over a versioned
   spec; remove "tweak requests" as a distinct category; keep monitoring-first and
   goals-optional verbatim in spirit. Record the product-identity convention: each
   user's product is a bespoke personal app whose screens may serve any rhythm
   (glanced at over coffee, or used in the moment, e.g. before/after a practice
   session), with one invariant — **every app has a morning surface**, the
   glanceable daily front door, which the agent designs for every user because it
   is the retention instrument the pilot's hypothesis measures.
2. **§ "Tweak loop"** — rename (e.g., "The proposal loop") and rewrite per §1 of
   this document. Remove the deferred message-mirror/approval-gate item or restate
   it against the unified loop.
3. **§ "Data layer"** — add the dashboards-accept-input convention and the
   annotations-in-user-tables rule from §5.
4. **§ "Interview → spec flow"** (however currently titled) — spec versions are
   whole-surface; note the always-required confirmation and proportional preview.
5. **System-shape diagram** — reflect the single loop and the deploy-announcement
   arrow back into chat.
6. **Metrics section** — add spec-version diffs as a first-class metric artifact.

## 7. What to verify before building (assumptions I could not check)

- The actual current shape of `propose_spec` (signal-only vs. payload-carrying) and
  of the spec-writer call — adapt §3 mechanics to what exists, preserving the
  validation requirement.
- Whether the specs table already stores structured payloads or rendered markdown —
  the schema doc assumes a structured payload as source of truth with `spec.md`
  rendered from it; if the current implementation is markdown-first, migrate or
  flag as a ledger decision.
- That version-1-from-empty-spec produces identical behavior to the current
  interview flow — this refactor must be behavior-preserving for the first-ever
  conversation.

## 8. Out of scope

Multi-dashboard-per-user, automation of the build step, autonomous watchers, and
any scaling work beyond the existing 50-user bar. Unchanged: encryption model,
Plaid module, synthetic-data rules, admin portal read-only stance, ntfy alerts
(spec_confirmed still fires on every confirmed version, which now includes small
changes — this is intended; it is the run-to-the-computer signal).
