# Scoped spec authoring and build notes — design

**Status:** proposed, 2026-08-17. Supersedes nothing; amends the unified proposal
loop (`2026-08-13-unified-proposal-loop/`) in two places, named in §2.

Two problems, deliberately designed together because the second is what makes the
first safe.

**Problem 1 — nothing records what was actually built.** `users/<slug>/spec.md` is
a projection of the newest confirmed spec, overwritten on every pull. It says what
the friend asked for. Nothing anywhere says what shipped, what was traded off, what
turned out infeasible, or why a panel ended up a table instead of a chart. At v2
that is an inconvenience; at v6 it means every build re-derives decisions that were
already made and forgotten. The deploy announcement has the same hole from the
other end: it is a fixed sentence pasted from `change_summary`
(`lib/chat/announce.ts:129-136`), so the friend is told what they asked for, never
what they got.

**Problem 2 — every proposal regenerates the whole dashboard.** One model call
re-emits the entire `SpecVersion` and a second re-draws the entire `mockup_html`,
whatever the size of the request. Two costs follow, and the second is worse than
the first:

- **Cost and latency scale with the dashboard, not the ask.** Output tokens are
  the expensive half and effectively all of the wait, and they grow with every
  panel a friend accumulates. A one-word relabel on a five-screen dashboard costs
  the same as designing it.
- **Regeneration drift.** The untouched 95% of a dashboard is put through a
  generative process on every single request. The only thing carrying those panels
  forward intact is a paragraph of prose in `platform/prompts/spec-v2.md:19-23`
  asking the model to copy them verbatim. Every proposal is a fresh chance to
  silently reword, restructure, or drop a panel nobody mentioned.

The fix for problem 2 is to ask the model only for the change and let the server do
the copying. That makes the stored spec a smaller statement about the dashboard,
which is precisely why problem 1 has to be fixed at the same time: the builder's
context has to come from somewhere.

---

## 1. Shape, in one page

```
FRIEND: "call the eating-out panel 'Takeaway'"        (Sam, v8, 5 screens, 20 panels)

  1. SPEC CALL   in:  transcript + current v8 JSON      (ids live here — still needed)
                 out: { ops: [ { op: "replace_panel", panel: {...} } ],
                        change_summary: "Renamed …", … }

  2. APPLIER     applyPatch(v8, patch) -> full v9        pure function, no model
                 the other 19 panels are COPIED, byte for byte
                 result validated by parseSpecVersion — today's validator, unchanged

  3. STORE       one specs row; payload = full v9 + the ops that produced it
                 no DDL — payload is already TEXT

  4. MOCKUP      draws only the affected screen(s)       (phase 2)

  5. CARD        leads with the change, shows the affected surface  (phase 2)

  6. BUILD       users/sam/notes/v9.md written on the version branch,
                 committed with the build — added, never edited

  7. ANNOUNCE    drafts from the notes + what Sam already knows,
                 prints for review, sends on --send
```

Steps 1–3 are Part B, steps 4–5 are Part C, steps 6–7 are Part A.

---

## 2. What is NOT changing

This repo's expensive mistakes have come from amending an invariant without
noticing. Naming these first so a reviewer can check the design against them
rather than infer them.

| Invariant | Still true because |
|---|---|
| `specs` is append-only, rejects UPDATE/DELETE | No trigger changes. Nothing here rewrites a row. |
| `version` derived from row position, never stored | Untouched (unified-loop D2/D3). |
| `based_on_version` server-supplied, read at **write** time | Untouched. The patch is applied against the version the writer was shown; the lineage pointer is still re-read immediately before `sealVersion` (D2's amendment). |
| The build contract is "make the code match the newest confirmed version" | The stored payload is still a complete whole-surface version. A builder never replays history to learn the current shape. |
| `spec.md` + `mockup.html` are the build contract on disk | Both still rendered from one row. Notes are an **addition** beside them, not a replacement. |
| `lib/spec/diff.ts` compares two whole versions | Untouched, and load-bearing in a new way — see §5. |
| Pre-unification rows are read as legacy forever (D4) | `readStoredSpec` discriminates on `Array.isArray(screens)`; the added key does not affect it. |
| Prompts are added, never edited (D13) | Three new files: `spec-v3.md`, `mockup-v4.md`, `announce-v1.md`. |
| Metrics carry counts, never content | The new metric fields are counts and a mode name. Op ids never leave `specs`. |
| No test in the default suite reaches the network | The announce drafter takes its client as a parameter, like `lib/chat/turn.ts`. |

**Two amendments to the unified-loop design, stated plainly rather than slipped in:**

1. **File 02 §3's "the spec-writer call … emits the full next version" becomes
   "emits the full next version *or* a patch the server applies to produce it."**
   The requirement that motivated it — the emitted version must validate before
   anything renders — is *strengthened*, not weakened: the applied result goes
   through the same `parseSpecVersion` gate, and the applier adds a second class of
   rejection on top.
2. **"Highlighting only changed panels in the mockup", listed under *Deferred,
   accepted* as "a styling improvement, not a requirement", is promoted to a
   requirement.** It stops being styling once the patch names exactly what changed:
   showing a friend their entire dashboard to confirm a one-word relabel is the
   defect, and the ops are the fix.

---

## 3. Part A — build notes

### 3.1 The artifact

`users/<slug>/notes/v<n>.md`, one file per confirmed spec version that was built.
Written by the builder on the version branch, committed with the build.

**Added, never edited** — the same rule as migrations and prompts, for the same
reason in a weaker form: the announcer speaks from a notes file, and editing one
after the fact changes what an already-sent, permanently-stored announcement was
based on. A single cumulative `notes.md` was rejected for exactly that reason — a
file that gets appended to also gets edited.

Required shape, parsed rather than trusted:

```markdown
---
slug: sam
version: 9
built_at: 2026-08-17
---

## What shipped
Product-level. What the friend can now see or do that they could not before.

## Built differently
In-spirit adjustments: where the shape of the build differs from how the spec
described it, and why it works better this way. FRIEND-FACING.

## Open
Anything in the confirmed spec that did NOT land. Builder-only, and a routing
instruction rather than a disclosure — see §3.5.

## Notes for the next build
Technical residue: what is fragile, why a structure is the way it is, what a
future version should not assume. BUILDER-ONLY.
```

The first two sections reach the friend; the last two do not. That split is the
whole reason the file has sections at all.

### 3.2 The rule that has to be written down

**Build notes never contain the friend's data.** They are committed to the repo and
readable by anyone with the checkout. They describe the *shape* of what was built —
a table, a panel, a computation — never a row, a value, or a merchant. This is the
same bound `metrics` already carries ("metrics never carry user values"), applied to
a second artifact, and it belongs in CLAUDE.md > Data safety rather than in a
template comment.

### 3.3 Two gates, each checking what it can actually know

**`scripts/announce-deploy.ts` refuses to announce version N without
`users/<slug>/notes/v<n>.md`.** This is the real enforcement point: it runs exactly
once per push per friend, and it is the one moment the version number and the slug
are both in hand.

**`tests/users/conventions.test.ts` checks shape, not presence.** A built folder has
a `notes/` directory, and every file in it matches `v<n>.md` — no strays, no
`notes-old.md`. It deliberately does **not** demand "at least one note", for the
same reason it already declines to demand a write-path test: the sweep cannot know
which versions were built, so the requirement would be a false failure on
`users/devone` (hand-written, never had a spec) and on every folder built before
this convention existed. Backfilling a note for a build that happened months ago
would be fabricating a record, so **no notes are backfilled**.

The directory itself is a different matter: the sweep requires `notes/` to exist on
a built folder, so `devone`, `devtwo`, `run3`, and `run4` each get a
`notes/README.md` **in the same change** — holding the convention, not an invented
record of a build nobody wrote down. Their first real note is written the next time
they are built. (`README.md` also makes the directory trackable; git does not store
empty ones.)

`scripts/new-dashboard.sh` creates `notes/README.md` alongside
`migrations/README.md`, following the existing template pattern.

### 3.4 The announcement becomes a drafted message

`announceDeploy` today composes one of two fixed sentences from `change_summary`.
It gains a drafting step: a model call reading the friend-facing sections of the
notes, the confirmed version's `change_summary`, and the recent transcript — the
last so it can leave out what the friend already knows, which was the ask.

**What the drafter is handed is bounded structurally, not by instruction.** Only
`## What shipped` and `## Built differently` are extracted and passed; `## Open` and
`## Notes for the next build` are never sent. That is a parser boundary, not a line
in a prompt, following `lib/spec/banner.ts` (D19): a guarantee the model cannot
forget beats a rule it is asked to remember. The parser is anchored to the headings
and **throws on a failed parse** rather than sending a partial draft —
`lib/chat/opening.ts` sets that precedent, for the same reason: `transcripts`
rejects DELETE, so a malformed message is permanent.

**The announcement is an update, never a disclosure — Nico's ruling, 2026-08-17.**
A build is made in the spirit of what was asked; it may be structured differently to
actually work. That difference is what the friend hears about, and it is good news
or neutral news by construction. The prompt is bounded to that register, and the
parser is what makes the bound real: the section that could carry bad news is not in
the payload at all.

**Saying nothing extra is a complete answer.** Most builds have no adjustment worth
mentioning, and the drafter must be free to return the plain "here's what landed"
sentence rather than manufacturing an adjustment to fill a section. Generated prose
fails this way by default. The spec prompt already carries the same rule for
`open_questions` — "an empty list is a real, complete answer — never invent items to
fill it" — and `announce-v1.md` states it in the same words.

**`prompt_sha` stops being the `OPERATOR_SHA` sentinel on this path.** That sentinel
means "a human typed this and no prompt produced it". A drafted announcement carries
the real `announce-v1.md` hash instead, so provenance stays honest and the sentinel
keeps meaning what it says. `session_id` stays `OPERATOR_SHA` — there genuinely is
no session. `scripts/ask-user.ts` is unaffected and stays fully operator-typed.

**Dry-run by default.** `npx tsx scripts/announce-deploy.ts sam` drafts, prints, and
writes nothing — not the transcript row, not the `deploy_announced` metric. `--send`
commits both, inside the existing transaction. This is the first *generated* text
this system has ever written into an append-only transcript, and ten seconds of
Nico reading it is cheap against a sentence that can never be removed. It also fits
the runbook's stated grain: several steps are manual on purpose.

**`--plain` is the valve.** If the API is down, `--plain` sends today's fixed
sentence. Without it, a drafting failure **refuses** rather than falling back
silently — a quiet fallback would produce a normal-looking announcement that never
read the notes, which is the failure nobody would notice.

Idempotency is unchanged: `deploy_announced` keyed on the confirmed spec's id, so a
re-run reports rather than repeats.

`deploy/required-env` needs no new **name** — `ANTHROPIC_API_KEY` is already listed
— but its comment does need amending: it currently says absence costs only
`POST /api/chat`, and after this it also costs the announcement. Severity stays
`DEGRADED`: this is an operator command with a `--plain` valve, not a service path.

### 3.5 What happens when the spirit of the ask cannot be honored

"Telling them is enough" holds for a build that delivers what was asked in a shape
that differs. It is **not** a licence to quietly drop something. Without a named
route for that case, "never bad news" degrades into "never mention it", which is the
opposite of what the notes exist for.

So an entry under `## Open` is a **routing instruction, not a disclosure**, and it
never reaches the announcement. It goes back through the surface that already exists
for it, which is the chat:

- **A decision only the friend can make** → `scripts/ask-user.ts`, mid-build, which
  the runbook already covers at step 4 and the agent prompt already tells the agent
  to relay.
- **Something that cannot be built as agreed** → back into the proposal loop as a
  new version. The friend confirmed a spec; a version that cannot deliver it is a
  reason to propose again, not a footnote in a deploy message.

`announce-deploy.ts` therefore **prints a warning to Nico** when the notes carry a
non-empty `## Open`, naming it and continuing. It does not block the announcement —
the part that shipped did ship — but the operator is told, at the one moment they
are already looking, that a conversation is owed. Warning rather than refusal
because the two things are independent: what landed should be announced, and what
did not land needs a chat, and neither should hold up the other.

### 4.1 The patch

`lib/spec/patch.ts`. Eight ops, at **panel granularity**, deliberately coarse:

```
set_meta        { title?, summary?, background? }     omitted when unchanged
add_screen      { screen }                            screen with its panels
update_screen   { id, title, order }
remove_screen   { id }
add_panel       { screen_id, panel }
replace_panel   { panel }                             id inside identifies it
move_panel      { panel_id, screen_id }
remove_panel    { id }
```

**Why panel-granular and not field-granular.** A `set_panel_title` op would save
~150 tokens against `replace_panel` and would cost an op vocabulary large enough
that the validator can no longer be exhaustive. Panels are the unit a friend thinks
in and the unit `diff.ts` already reports on; making them the unit of change means
output is proportional to *changed panels*, which is already the whole win. YAGNI
applies to op vocabularies as much as to features.

Three fields ride on the patch itself rather than as ops, because all three are
small and all three are whole-list semantics:

- `change_summary` — **required**. It is the friend-facing line on the card and the
  announcement's source. A patch with no summary is not proposable.
- `data_requirements` — the whole list. `status` is defined relative to the prior
  version, so re-emitting it keeps that meaning intact.
- `open_questions` — the whole list. "Carry forward the questions you didn't
  mention" is a footgun on a field the spec prompt describes as a to-do list read
  first.

### 4.2 The applier

`applyPatch(base: SpecVersion, patch: SpecPatch): SpecDraft` — pure, no database,
no clock, no model. Rules:

- Ops apply in array order against the result so far, so an op may depend on an
  earlier one in the same patch.
- Any op naming an id that does not resolve → throw. Any `add_*` naming an id that
  already exists → throw.
- `SpecPatchError extends SpecShapeError`, so the existing metrics redaction
  (`metricMessage`, which strips double-quoted segments) covers patch errors
  automatically, and the existing retry machinery treats them as retryable.
- The result goes through `parseSpecDraft`/`checkInvariants` — **today's validator,
  unchanged**. Removing a panel whose value another panel derives from fails there,
  as it should, and the model gets the same message it would have got before.

The retry path is free: `MAX_SPEC_ATTEMPTS = 2` and `retryMessage()` already exist
and already feed a validator message back. A patch error is one more thing they
carry.

### 4.3 Storage

`specs.payload` gains one key. No DDL, no new column, no widening of any exception:

```json
{ "title": "…", "summary": "…", "screens": [ … ],
  "based_on_version": 8,
  "ops": [ { "op": "replace_panel", "panel": { … } } ] }
```

**Flat, beside the version fields — not nested under a `patch` key.**
`readStoredSpec` discriminates on a top-level `screens` array, and `draftFrom` picks
named keys and ignores extras, so this shape leaves every existing reader working
unchanged. A `{ patch, version }` wrapper would break the discriminator and every
consumer with it.

**`parseSpecVersion` must be taught to preserve it.** It reconstructs from named
fields (`sealVersion(draftFrom(src), based)`), so an unrecognised key is silently
dropped on read — the patch would be written and then unreadable. `SpecVersion`
gains `ops: SpecPatchOp[] | null`, parsed explicitly, and `sealVersion` stays the
one construction site.

`ops` is **null**, not `[]`, for a version authored whole-surface. Null says "this
version was not produced by a patch"; an empty array would say "it was produced by
a patch that changed nothing", which is a different and impossible claim.

### 4.4 The three paths, and only one of them is new

| Path | Authoring | `ops` |
|---|---|---|
| **v1** — no confirmed spec | whole-surface, exactly as today | `null` |
| **Legacy base** — a pre-unification confirmed row | whole-surface, once; ids assigned fresh | `null` |
| **Current base** | **patch** | the ops |

The v1 path is byte-identical to today's, which keeps R3's behaviour-preserving
requirement — the one thing the unified loop was not allowed to change — intact
without needing a test to defend it, because the code is the same code.

The legacy path falls out for free: a legacy row has no ids, so there is nothing to
patch against. `currentVersionBlock` already says so and already tells the writer to
assign ids fresh. That account authors whole-surface once and is on the patch path
from its next version.

**Selection is made where `currentVersionBlock` already branches** — one function,
three arms, already written, already the place this decision lives.

### 4.5 Metrics

`spec_proposed` gains `authoring_mode: 'patch' | 'whole'` and `ops_count`. A new
`spec_error` kind, `patch_failed`, joins `malformed_spec`. Counts and a mode name —
no ids, no titles, consistent with the existing bound on diff metrics.

`authoring_mode` is what makes the whole change measurable after the fact: without
it there is no way to ask "did output tokens actually fall" against an append-only
log, and this design's central claim is a cost claim.

---

## 5. Part C — proportional preview (phase 2)

The ops name exactly which screens are affected: any screen added or updated, plus
any screen holding an added, replaced, moved, or removed panel. Two things follow.

**The mockup call draws only those screens.** This is the slow half of the friend's
minute — `lib/chat/prompt.ts` says so explicitly — and it is the half that scales
worst.

**The card shows only those screens.** This is the defect §2's second amendment
promotes: a friend asked to review five screens to confirm one relabel.

### 5.1 Why this needs a table, and why it is phase 2

`specs.mockup_html` holds one opaque model-authored document. You cannot reliably
splice a screen out of it, and making the model emit stable per-screen markers to
splice on would make a guarantee depend on model compliance with a formatting rule
— exactly what D19 says not to do.

So: `spec_screen_mockups (spec_id, screen_id, html)`, append-only with the same
trigger pair as its neighbours. `CREATE TABLE IF NOT EXISTS` needs no migration
mechanism — the precedent is `account_keys`, added the same way for the same reason.
`specs.mockup_html` keeps holding the composed document, so `pull-spec.sh`,
`users/<slug>/mockup.html`, the admin Mockup tab, and the build contract are all
untouched.

Fragments are **not** stored in `payload`. That JSON is read on every proposal to
build the writer's current-version block, and putting HTML in it would feed the
mockup back into the model's own input.

**In scope for this branch — Nico's ruling, 2026-08-17.** All three parts ship
together as the last build before end-to-end testing: they are separable in the code
and not separable in the product, since notes, scoped authoring and a proportional
preview are three halves of one change to how a version reaches a friend.

"Phase 2" therefore names an **ordering inside the plan**, not a later branch. It is
built last because it is the only part that adds a table and the only part that
depends on the ops existing. That ordering keeps the branch coherent if it has to be
paused: up to that point the mockup keeps re-rendering whole, exactly as today.

---

## 6. Does it get cheaper — the honest version

Sam's relabel, v8, five screens, twenty panels. Estimates from the real artifacts
in `users/*/` scaled to that size, not from measurement — no dashboard is that big
yet, which is the point.

| | Today | Phase 1 | Phase 1+2 |
|---|---:|---:|---:|
| Spec call input | ~19k | ~19k | ~19k |
| Spec call output | ~9k | ~0.3k | ~0.3k |
| Mockup call input | ~10k | ~10k | ~2k |
| Mockup call output | ~14k | ~14k | ~3k |
| **Total output** | **~23k** | **~14k** | **~3.3k** |

Three things this table is not allowed to hide:

1. **Input does not shrink, ever.** The model still needs the whole current version
   in front of it, because that is where the ids it must reuse live. Input is the
   cheap half (~5× less per token) and is cacheable across the retry and between
   calls, but it is a real floor. This is a fix for output growth, not total growth.
2. **At today's sizes the saving is modest.** `run4`'s whole spec is ~1.7k tokens
   and its mockup ~900. Phase 1 might halve a proposal today. What changes is the
   *curve*: cost goes from ∝ (dashboard size × requests) to ∝ (change size ×
   requests). The design is bought for v8, not for v2.
3. **Phase 1 alone leaves the mockup untouched**, and the mockup is the larger and
   slower half. If the cost argument is the reason to do this, phase 2 is where most
   of the money is; if drift and the friend's review burden are the reasons, phase 1
   carries them.

---

## 7. Failure modes

| Failure | What catches it |
|---|---|
| Patch names a nonexistent panel id | `SpecPatchError`, retry with the message, then `spec_error` `patch_failed`. No row written. |
| Patch applies cleanly but produces an invalid version | `parseSpecDraft`/`checkInvariants` — today's gate, unchanged. |
| **Applier does something other than the ops claimed** | `diff.ts` still computes whole-vs-whole from the stored payloads, independently of `ops`. The two can be compared and disagreement is detectable. Delta-only storage has nothing to check itself against; this is the main reason the whole is stored. |
| A version's `ops` are wrong but its whole is right | Harmless to the build contract, which reads the whole. Degrades the card and the announcement for that one version only, and does not propagate — every later patch applies to the stored whole, not to the ops. |
| Notes file missing at announce time | `announce-deploy.ts` refuses, naming the path. |
| Notes file malformed | Anchored parser throws before any model call. |
| Something in the spec did not land | `## Open` is builder-only and routes back to the chat (§3.5); `announce-deploy.ts` warns Nico that a conversation is owed. |
| Drafted announcement invents an adjustment to have something to say | `announce-v1.md` states that saying nothing extra is a complete answer; Nico reads it — dry-run is the default. |
| API down at announce time | Refuses, or `--plain` for today's fixed sentence. Never a silent fallback. |
| A stray file in `notes/` | `conventions.test.ts` shape check. |

**The residual risk worth stating up front:** an append-only chain of ops is
permanent, and a patch that applied cleanly but did not mean what the friend meant
is not detectable by any of the above. That is unchanged from today — a
whole-surface version can be wrong in exactly the same way — but the patch makes
each version a *smaller* statement, so the wrongness is smaller and more local too.

---

## 8. Files touched

**Part A — build notes** (~6–9 tasks)

```
NEW   platform/templates/dashboard/notes/README.md.tmpl
NEW   platform/prompts/announce-v1.md
NEW   lib/build/notes.ts              parse + section extraction, anchored
NEW   lib/chat/draftAnnouncement.ts   the model call, client injected
EDIT  lib/chat/announce.ts            drafted body, real prompt_sha, dry-run split
EDIT  scripts/announce-deploy.ts      --send / --plain, refuse without notes
EDIT  scripts/new-dashboard.sh        scaffold notes/
NEW   users/{devone,devtwo,run3,run4}/notes/README.md   convention, not a record
EDIT  tests/users/conventions.test.ts shape check
EDIT  deploy/required-env             ANTHROPIC_API_KEY comment (no new name)
EDIT  docs/runbook.md                 step 7 (write notes), step 9 (draft, review, send)
EDIT  CLAUDE.md                       notes convention + the no-data rule
```

**Part B — patch authoring** (~10–14 tasks)

```
NEW   lib/spec/patch.ts               ops, applier, SpecPatchError
NEW   platform/prompts/spec-v3.md
EDIT  lib/spec/schema.ts              PATCH_JSON_SCHEMA, SpecVersion.ops
EDIT  lib/spec/validate.ts            parse/preserve ops; reject model-authored ops on the whole path
EDIT  lib/spec/author.ts              mode selection, apply, metrics
EDIT  lib/chat/prompt.ts              SPEC_PATCH_PROMPT
EDIT  architecture-overview.md, docs/dashboard-build-rules.md, CLAUDE.md
```

**Part C — proportional preview** (~5–7 tasks)

```
NEW   platform/prompts/mockup-v4.md
NEW   lib/spec/mockupCompose.ts       affected screens, compose, fragment store
EDIT  platform/schema.sql             spec_screen_mockups + triggers
EDIT  lib/spec/author.ts, app/[user]/ChatPanel.tsx
```

**A live checkpoint is required, not optional.** The suite drives a fake client, so
"the API accepts `PATCH_JSON_SCHEMA`" and "`spec-v3.md` produces output the applier
accepts" are unprovable locally — the unified-loop ledger records this as the thing
only a production run settled last time. One run against `app.stairwell.run` on a
throwaway slug, exercising: a patch against a current base, a whole-surface v1, and
a legacy base.

---

## 9. Open questions for Nico

1. ~~**Phase 2 in this branch or the next one?**~~ **Resolved 2026-08-17: this
   branch.** All three parts, then the end-to-end test. See §5.1.
2. **Who writes the notes when the build was mostly Claude's work?** The design says
   "the builder", which in practice means Claude Code writing them during step 7 and
   Nico reviewing them at commit. Worth confirming that is the intent rather than
   Nico writing them by hand.
3. **Should `spec_error` `patch_failed` retry once or twice?** The current bound is
   two attempts total, chosen when the failure mode was a schema violation. A patch
   error is a different and arguably more correctable failure.

---

## 10. Out of scope

Multi-dashboard-per-user. Automating the build step. A generalized entry-widget
write route (still unified-loop D10's deferred item, unaffected by any of this).
Any change to the encryption model, the read-only dashboard handle, or the
two-writers rule. Backfilling notes for builds that predate the convention.
