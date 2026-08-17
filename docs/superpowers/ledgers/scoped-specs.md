# Scoped specs and build notes — decisions ledger

Spec: `docs/superpowers/specs/2026-08-17-scoped-specs-and-build-notes-design.md`
Plan: `docs/superpowers/plans/2026-08-17-scoped-specs-and-build-notes.md`
Branch: `scoped-specs`, base `5f0aee0`.

Opened after Task 19 (Part C's last code task), at Task 20, alongside the CLAUDE.md
and architecture-overview.md updates for Part C. Parts A, B and C are built; Part D
(Tasks 22–26, screen tabs and mockup-route CSP hardening) and the final
whole-branch review are not. **Built** and the live-checkpoint section are left
empty until the branch ships, matching `unified-loop.md`'s own convention.

---

## Rulings

### D1. Patch authored, whole surface stored — and why delta-only storage lost

`lib/spec/patch.ts`'s writer emits only the change (`SpecPatch.ops`); `applyPatch`
(pure, no database, no model) produces the full next `SpecDraft`, and that whole
surface — never the patch alone — is what `insertSpec` writes to `specs.payload`.
The ops ride alongside, flat, as `SpecVersion.ops` (D2).

**Why not store deltas and reconstruct on read.** Two independent reasons, not one:

- `specs` rejects UPDATE and DELETE (`specs_no_update`/`specs_no_delete`,
  `platform/schema.sql:112-122`). A chain of deltas has no row to correct if one
  is ever found to have applied wrong — the corruption is silent and it
  propagates into every reconstruction after it, forever.
- **`lib/spec/diff.ts` computes its structural diff whole-vs-whole**, from the
  two *stored* payloads, entirely independently of what `ops` claims happened.
  Storing the whole is what makes that comparison possible at all: the design
  doc's own failure-mode table states it plainly — *"Applier does something
  other than the ops claimed | `diff.ts` still computes whole-vs-whole from the
  stored payloads, independently of `ops`. The two can be compared and
  disagreement is detectable. **Delta-only storage has nothing to check itself
  against; this is the main reason the whole is stored.**"* (design doc §7). A
  delta-only store would have no independent witness to a bug in `applyPatch`.

The stored row is therefore a smaller *statement* about the dashboard (D8) but not
a smaller *record* of it — `dashboard.tsx`'s build contract, `pull-spec.sh`,
the admin pane's diff, and `parseSpecDraft`'s validation gate all still see one
complete `SpecVersion`, exactly as before this branch.

### D2. `ops` is `null`, never `[]`, on a whole-surface version

`lib/spec/schema.ts:87-90`: *"`ops` is NULL for a version authored whole-surface
… Null says 'this version was not produced by a patch'; an empty array would say
'it was produced by a patch that changed nothing', which is a different and
impossible claim."* `parseSpecVersion` (`lib/spec/validate.ts:40-48`) reads a
missing `ops` key — every row written before this branch — the same as `null`,
since `specs` rejects UPDATE and none of those rows can ever gain one. Documented
in CLAUDE.md's spec-version bullet (line ~126).

A related, easy-to-miss corollary Task 9 fixed: an all-`null` `set_meta` op used
to pass the "a patch must change something" check while changing nothing — the
same failure mode as an empty `ops` array, through a different door. It is now
rejected, because it would otherwise produce a permanent proposal row whose only
op is inert.

### D3. v1 and a legacy base author whole-surface by running the SAME code, not by testing a parallel path against it

`lib/spec/author.ts` picks `mode = base === undefined ? 'whole' : 'patch'`
(line 423), where `base` is the current confirmed version *only if it is
already in current-shape JSON*. On the `'whole'` arm the function calls
`loadPrompt(SPEC_PROMPT)` and `parseSpecDraft(proposed.input)` — **the same
prompt file and the same validator this branch found already in place**, not a
new function written to reproduce their behaviour. `SPEC_PATCH_PROMPT` and
`applyPatch` are additions that sit beside that path, never inside it.

This is how unified-loop's R3 requirement — *"version-1-from-empty-spec IS
behaviour-preserving"* — is satisfied here: a first-ever conversation and a
legacy account's one-time whole-surface version travel *the exact code* that
existed before patch authoring did. There is nothing to write a
behaviour-equivalence test for, because there are not two implementations of the
whole-surface path, there is one, shared. A future change that duplicates
`SPEC_PROMPT`/`parseSpecDraft` "for the whole-surface case" inside the patch
branch would silently reopen the question R3 closed by construction.

### D4. Failure classification is by PHASE, not by error class

`lib/spec/author.ts`, the block above `parsePatch`/`applyPatch` in the attempt
loop: a local `phase: 'malformed_spec' | 'patch_failed'` variable is set to
`'patch_failed'` immediately before `applyPatch(base, patch)` runs, and stays
`'malformed_spec'` otherwise. The metric row's `kind` is read from that variable,
never inferred from what was thrown.

**Why not `error instanceof SpecPatchError ? 'patch_failed' : 'malformed_spec'`,**
which is the version that looks obviously right: `SpecPatchError` is Task 10's
subclass for a patch that named a nonexistent id, but the shape checks *inside*
a patch op are shared with the whole-surface validator — a malformed `order` in
`update_screen`, a non-string in `open_questions`, a bad nested panel in
`add_screen`/`add_panel`/`replace_panel` all reach the same `lib/spec/fields.ts`
helpers (`integer`, `textList`, `parsePanel`, `parseScreen`) that throw the BASE
`SpecShapeError`, not the subclass. An `instanceof` check would silently record
every one of those as `malformed_spec` — "the model returned the wrong shape" —
when the true story is "the shape was right and it would not apply to this
base", forever, in a table that rejects UPDATE.

This was found at Task 9's re-review as a NEW Important finding created by
Task 9's own refactor (extracting `integer()`/`textList()` into `fields.ts` made
two more patch-shape errors throw the base class), and the finding was
**dissolved by changing the mechanism, not by widening the fix** — the re-reviewer
showed the blast radius (every op that nests a `parsePanel`/`parseScreen` call)
was already wider than a call-site fix could close, which meant the
classification method itself was wrong. Phase cannot be inferred incorrectly
because it is never inferred: the code already knows, at the moment of the throw,
which of the two calls it was standing inside.

### D5. `fields.ts` exists to break an import cycle, and the direction is one-way

Pre-flight found that `lib/spec/patch.ts` importing `parsePanel`/`parseScreen`/
`parseSpecDraft` from `validate.ts`, combined with `validate.ts` needing
`parseOp` (a value) from `patch.ts`, would have made the two modules import each
other at runtime — tolerated by ESM only because every use sits inside a
function body, a temporal-dead-zone hazard one refactor away from a runtime
crash in the module that is this repo's last gate before an append-only table.

**Ruling: extract `lib/spec/fields.ts`**, holding the shared field parsers and
the draft validator (`record`, `text`, `nullableText`, `id`, `textList`,
`integer`, `oneOf`, `arrayField`, `nonEmptyArray`, `parsePanel`, `parseScreen`,
`checkInvariants`, `draftFrom`, `parseSpecDraft`, …). Import direction is now
one-way: `fields.ts → schema.ts`, `patch.ts → fields.ts`,
`validate.ts → fields.ts + patch.ts`. `validate.ts` re-exports `parseSpecDraft`
so no pre-existing call site changed. A future addition to either `patch.ts` or
`validate.ts` that reaches back across this boundary (rather than into
`fields.ts`) reopens the cycle this file exists to prevent.

### D6. `affectedScreens(base, next, ops)` — sources resolve against `base`, destinations against `next`

`lib/spec/mockupCompose.ts:55-109`. A patch's ops describe the *next* version,
but a removed panel is gone from `next` and a moved panel is already at its
destination — `next` alone cannot say which screen either one *left*. Left
unresolved, that screen keeps showing a carried-forward fragment for a panel
that is no longer there, in both the friend's card and the stored build
contract. So `remove_panel` and `move_panel` resolve their source screen by
walking `base` (`was(op.panel_id)` / `was(op.id)`); every other op resolves
against `next`. `base` is `null` for a whole-surface version (`ops` is `null`
too, and the function returns "every screen" in that case).

**The same signature caught a real defect one task later, in a different
caller.** `lib/spec/author.ts` (Task 18) always had a real `base` to pass, from
`currentSpec`. But Task 19's new page-load reconstruction of the card
(`app/[user]/page.tsx`'s `pageLoadPreview`, needed so a reload shows the same
scoped preview the live card did) first took a shortcut: passing `base` as
`null` unconditionally, reasoned as "narrower, never wrong" since a `null`
base can only shrink the affected list. Its own reviewer traced it op-by-op and
found the opposite: `remove_panel`'s *only* possible contribution needs `base`
to resolve at all, so with `base` forced `null` a remove-panel-only patch
produced an *empty* `affected` list — which falls through to the *whole*
`mockup_html`, **wider** than what the live card had shown moments earlier, on
the exact surface where the friend is deciding whether to confirm. Fixed within
the same task: `pageLoadPreview`'s helper `baseScreensFor` (`app/[user]/page.tsx`,
lines 70-96) now fetches the prior confirmed version's own screens via
`based_on_version`, mirroring what `lib/spec/author.ts` already does with
`currentSpec` at authoring time — so a reload cannot disagree with what the
live card showed.

### D7. An empty affected list skips the mockup call entirely — and that makes `mockupResult` legitimately undefined on a success path

`lib/spec/mockupCompose.ts`'s `set_meta` case contributes nothing to `touched`:
the composed shell renders no title, summary or background, so a meta-only
change alters no pixel, and redrawing every screen to prove that would be
exactly the cost this branch exists to avoid. `lib/spec/author.ts` acts on this:
`if (affected.length > 0)` gates the whole mockup `client.propose()` call: every
existing fragment carries forward unchanged, `previewHtml` falls back to the
full `mockupHtml`, and no second model call is billed.

**Consequence, caught one task later.** This is the first path where a *success*
can reach `spec_proposed` with `mockupResult` still `undefined` — every other
success path has both calls return. `modeFields`/`mockupFields`'s call site
(`lib/spec/author.ts`, the `spec_proposed` `appendMetric`) now reads
`mockupFields(mockupResult?.usage, mockupPromptSha)`, with `?.` doing real work:
without it, a meta-only patch's success path would throw inside the metrics
write, after the row's real data was already valid, over a field that is
correctly absent rather than missing.

### D8. Panel granularity for the ops, and why field-granular ops were rejected

`lib/spec/patch.ts:6-13`, and design doc §4.1: the eight ops (`set_meta`,
`add_screen`, `update_screen`, `remove_screen`, `add_panel`, `replace_panel`,
`move_panel`, `remove_panel`) act at the *panel*, never at a single field inside
one. A `set_panel_title` op would save roughly 150 tokens against re-emitting the
whole panel via `replace_panel` — real, but small — **and would cost an op
vocabulary large enough that the validator can no longer be exhaustive**: every
field of every value kind would need its own settable op, each with its own
shape check and its own retry-feedback message. Panels are the unit a friend
thinks and asks in, and the unit `lib/spec/diff.ts` already reports on, so
making them the unit of a patch already gets the win that matters: output
proportional to *changed panels*, not to the dashboard's total size. "YAGNI
applies to op vocabularies as much as to features" (design doc §4.1).

### D9. The mockup frame is platform-wide and plain; screens stay bespoke; the default styles are a nudge, not a vocabulary; `composeMockup` scopes each fragment's CSS automatically

Nico's direction on resuming after the Task 15 pause: the preview frame is
**one** platform-wide, plain frame matching the app's own chrome
(`lib/spec/mockupCompose.ts`'s `FRAME` constant); screens stay fully bespoke
inside it; the default styles published for `MOCKUP_SHELL_CLASSES` (`NUDGE`) are
"a nudge, not a vocabulary" — a model may use them, extend them, or bring its
own `<style>` block and ignore them entirely. Each friend's dashboard is a
bespoke personal app, and confining every one of them to six shared class names
would make them all look the same.

**Making that safe under composition is a separate ruling, and the harder
one.** A composed document holds fragments drawn by separate model calls, weeks
apart. An unscoped `.panel {}` in a screen edited today would silently restyle
a screen nobody touched — the exact class of hazard `lib/spec/banner.ts`
addresses for the SYNTHETIC banner (unified-loop ledger D19). `composeMockup`'s
own doc comment states the principle directly rather than asking the model to
follow it: *"a rule the model must remember is a rule that eventually is not"*
(`lib/spec/mockupCompose.ts:413`) — D19 is where that reasoning comes from,
not where that sentence was written. So `composeMockup` lifts each fragment's
own `<style>` block and rewrites every selector under `#screen-<id>` itself
(`scopeFragmentStyles`), rather than instructing the model to scope its own
selectors.

The scoper is bounded and fails **all-or-nothing per `<style>` block, never as
a silent partial**. It was executed against adversarial CSS during review — a
literal `{` inside a quoted attribute value (`[data-x="{"]`, legal CSS) desyncs
a naive brace counter and silently drops every remaining rule in the block,
including unrelated sibling rules. `scopeCss` is quote- and comment-aware for
exactly this reason, and returns `null` (dropping the whole block) rather than
emitting an unpredictable prefix of it, the moment it hits anything it cannot
structurally parse (an unterminated string/comment, unbalanced braces, an
unhandled at-rule). This degrades *well*, and the reason is D9's first half:
because the frame publishes default styles, a fragment that loses its bespoke
CSS to a parse failure still renders plain-but-presentable, never broken — the
nudge is a floor, not merely a starting point. No cross-screen leak was found
in any shape tried in review; what failed in the earlier version was
gracefulness, not the safety boundary itself.

### D10. `spec_screen_mockups` is a table, not more JSON in `specs.payload`

Design doc §5.1, and now recorded in CLAUDE.md's Sacred data section. Two
independent reasons a fragment cannot live in `payload`:

- `specs.payload` is read on every proposal to build the writer's
  current-version block (`currentVersionBlock`, `lib/spec/author.ts`). Putting
  rendered HTML there would feed the mockup back into the model's own next-turn
  input — an unrelated, unbounded cost added to every future authoring call.
- `specs.mockup_html` is one opaque, model-composed document. Splicing a screen
  back out of it would require the model to emit stable per-screen markers to
  splice on, which makes a guarantee depend on the model's compliance with a
  formatting rule — precisely what unified-loop ledger D19 says not to do.

`spec_screen_mockups (spec_id, screen_id, html, at)` needs no new migration
mechanism — a plain `CREATE TABLE IF NOT EXISTS`, the same precedent
`account_keys` already set for adding a table with no additive migration
mechanism in this repo. That precedent is narrower than it might look:
`account_keys` carries no trigger at all (`platform/schema.sql:156-160`) and
is deliberately mutable — its own comment states a password change "rewrites
this row and nothing else, which is the entire point of the indirection." The
append-only trigger pair on `spec_screen_mockups` matches `specs`, its actual
sibling, not `account_keys`. `lib/db/screenMockups.ts` only appends and reads; `lib/spec/mockupCompose.ts`
is the only place that composes fragments into a document. `specs.mockup_html`
keeps holding the whole composed document and stays the build contract
untouched — `pull-spec.sh`, `users/<slug>/mockup.html`, the admin Mockup tab
and `dashboard.tsx`'s build target all still read it unscoped.

### D11. The announcement is an update, never a disclosure; `## Open` is builder-only and routes back to the chat

Nico's ruling, 2026-08-17, already carried into CLAUDE.md's Onboarding section,
in the bullet beginning "A build that could not deliver something goes back to
the chat, never into the announcement" — cited by section and text, not by
line number, since this repo's own docs-drift lesson is that a line number is
exactly the part that goes stale first (it already had, once, by the time this
finding was fixed). Recorded here because it is one of this branch's
load-bearing decisions, not because it needs a second implementation: `## Open`
and `## Notes for the next build` are two of `notes/v<n>.md`'s four fixed
sections, and `lib/build/notes.ts`'s parser — not prompt wording — is what
keeps them from ever reaching `draftAnnouncement`'s friend-facing input. An
item under `## Open` is a routing instruction (go back to the friend in chat),
never content the announcement discloses on the builder's behalf.
`announce-deploy.ts` warns when that section is non-empty rather than blocking
on it: what landed should still be announced, and what did not land needs a
conversation — neither should hold up the other.

### D12. Metrics honesty on EVERY `appendMetric` site in `lib/spec/author.ts` — and why the six sites are not merged into one wrapper

Same genus as D2 and D7: a field that is present at some call sites and absent
at others, in a table that rejects UPDATE, is a hole a query cannot see. Three
separate decisions, all Task 13:

- **`authoring_mode` (and its paired `ops_count`) is stamped on every metric
  row this function writes — the brief named three sites; the field goes on
  all of them.** The field's whole justification is making this branch's cost
  claim measurable against an append-only log; a `spec_aborted` row with no
  mode is a permanent hole in that series. `mode` is nullable, and `null` is a
  real third value — "failed before the mode was decided" — never a missing
  one.
- **`prompt_sha: null` on a corrupt current-spec-read failure is the honest
  value, and stays null rather than being backfilled.** A failure while
  reading the account's current spec (`currentSpec`/`readStoredSpec` in
  `lib/spec/author.ts`) happens before any prompt is chosen. Stamping
  `SPEC_PROMPT`'s hash there would assert a prompt was involved when none was
  — permanently, since the row can never be corrected. `prompt_sha: null` +
  `authoring_mode: null` together mean one thing: "failed before the prompt
  was chosen."
- **The six `appendMetric` sites in this function are deliberately NOT
  factored into a generic wrapper**, even though this crosses the trigger
  unified-loop residual 10 named (six call sites repeating their field
  shape). Only the `authoring_mode`/`ops_count` pair — which carries no
  per-site decision — was pulled out (`modeFields`). The bodies stayed apart
  on purpose: `mockup_failed` reports the SPEC call's four standard counters,
  not the mockup call's (D15, unified-loop ledger); `spec_aborted` reports
  honest zeros; `kind` is computed differently at every site (including D4's
  `phase` variable above); `message` is present at some sites and absent at
  others. A generic wrapper would make one site's honesty rule the silent
  default for all six — the exact hiding unified-loop residual 10 warned
  against, reintroduced in the name of fixing it.

A future sixth-plus `appendMetric` site in this file that copies an existing
call rather than checking this ruling is the failure mode this exists to
name: the field it silently omits will look like every other row in a query,
until someone needs precisely the row where it is missing.

---

## Two lessons, not decisions

### L1. A test can stop testing its own subject with no line of it changing

Found during Task 13's review, on a **pre-existing** test: *"never writes the
authoring scaffolding to transcripts"* called `confirmed(CURRENT_V1)` against
whole-surface drafts. Once a confirmed current-shape base forces patch mode
(D3), both fixture drafts fail to parse as patches and the call under test
fails outright before doing anything — but the test's assertions only look at
`transcripts`, and a call that never wrote to transcripts leaves it exactly as
clean as a call that succeeded and behaved correctly. The assertion stayed
green for the wrong reason. **No assertion text was touched — the code beneath
it moved, and that alone was enough.**

Nico generalised the mechanism afterward and swept for it (CHECK 1, 2026-08-17).
The naive signature — "a test with only a negative assertion" — is *wrong*: a
test asserting `rejects uppercase letters` should assert only a negative,
because the rejection is the subject under test. The real signature is
narrower and was stated precisely: **a test drives a fallible multi-step
operation, discards its result, and asserts only that something is ABSENT
from a side channel.** A dead operation — one that failed before doing
anything — leaves that side channel clean by default, so the absence assertion
stays trivially true whether the operation ran correctly, ran incorrectly, or
never really ran at all. (The converse is safe: a test asserting a row EXISTS
WITH SPECIFIC CONTENT cannot pass this way, because a dead operation writes no
row.)

Applying that exact signature (not the looser "negative assertion" one, which
returned 167 false positives out of 1102 blocks on a first pass) found three
siblings, all in `tests/chat/turn.test.ts`. Fixed in commit `cec7d49`: each now
carries a positive assertion that the operation under test actually ran, proved
red under an injected early failure and green afterward. Test count was
unchanged (55 → 55) — the fix added assertions, not tests, which is the point:
the tests existed, they were just proving less than they appeared to.

### L2. A reproduced data-corruption bug: `ops_count` leaking a previous attempt's value into an append-only table

Found during Task 13's review by tracing a variable's *lifetime*, not by
reading the diff. `patch` (the parsed `SpecPatch`, holding `ops.length` for the
`ops_count` metrics field) was declared once, outside the spec-authoring
attempt loop in `lib/spec/author.ts`, and never reset between attempts.
Reproduced: attempt 1 fails with `patch_failed` after `parsePatch` succeeded
(`ops_count: 1`); attempt 2 fails earlier, before `parsePatch` runs at all
(`malformed_spec`) — and without a reset, that second row *also* reported
`ops_count: 1`, a value that belonged entirely to the first attempt. A wrong
row, permanently, in a table (`metrics`) that rejects UPDATE.

**No test could see it.** Every retry test that exercised two attempts sent the
same op both times, so the correct value and the leaked value were identical by
construction, and no assertion distinguished them. The fix is `patch = undefined`
at the top of each loop iteration (`lib/spec/author.ts`, commented in place so a
future reader understands why the reset exists), so the field on a given row
reflects only that attempt's own parse outcome.

Checked afterward (CHECK 2, Nico, 2026-08-17) against every real database: no
corrupted row exists anywhere. The buggy code lived only between commits
`0b35b62..4cd0c27` on this unmerged, unpushed branch, and never ran against
anything but test temp files.

---

## Deferred, accepted

- **Proper CSP on the mockup routes, in place of the prompt-level "no external
  anything" rule.** `mockup-v3.md`'s rule against fetching anything external
  had no successor in the new per-screen prompt (`mockup-v4.md`,
  `MOCKUP_SCREENS_PROMPT`); Task 17 restored it there, because nothing
  downstream enforces it: `scopeCss` rewrites
  selectors only, never declaration values or raw HTML, and the serving routes'
  bare `sandbox` CSP restricts scripts/forms/navigation, not passive GET
  requests. That is a **stopgap**, named as one at the time: this repo's own
  D19 says a guarantee beats a rule a model must remember, and the real fix —
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:` (Nico's
  pinned values, no font source) on `app/mockup/[version]/route.ts`,
  `app/admin/mockup/[user]/[version]/route.ts`, and
  `app/[user]/MockupDialog.tsx` — is deliberately scheduled as Part D Task 25
  rather than folded into Task 17's diff. Not yet built as of this ledger entry.

---

## Residual risks

1. **The mockup-route CSP hardening above (Deferred, accepted) has not
   shipped.** Until Part D Task 25 lands, a friend opening their own preview
   relies on the prompt instruction alone to stop an outbound request to a
   third party — a real channel for leaking interview-derived content, in a
   product whose pitch is that nobody else sees a friend's data.

2. **Unified-loop residual 3 (the announce transaction's atomicity is proven
   by inspection, not by a test) is still open, and this branch adds a second
   writer path through the same code** (`announce-deploy.ts`'s `--send` /
   `--plain` split). Flagged at Task 6 for triage at the final whole-branch
   review, not yet resolved.

3. **`MOCKUP_JSON_SCHEMA`, `MOCKUP_PROMPT`/`mockup-v3.md`, and
   `parseMockupInput` are orphaned** by the cutover to per-screen mockups
   (Task 18): no production path calls any of them, only their own tests do,
   and `lib/chat/prompt.ts`'s module comment still points at `MOCKUP_PROMPT`
   as the live mockup prompt. **`mockup-v3.md` must not be deleted** — prompts
   are added, never edited (D13, unified-loop ledger), and `mockup_prompt_sha`
   rows already point at its hash. Only the stale comment needs fixing.
   Flagged for triage at the final review.

4. **Fragment provenance can lag a mid-flight confirmation, the same way
   `based_on_version` can (unified-loop D2).** `current`, `base`, and the
   carried-forward fragment map are all read once, before the attempt loop, in
   `lib/spec/author.ts`; `based_on_version` itself is deliberately re-read at
   write time (D2's amendment) to avoid naming a superseded base. The fragment
   map has no equivalent re-read: a confirmation that lands during the ~minute
   an authoring call is in flight can produce a row whose lineage pointer is
   correct but whose *carried fragments* were computed against a version that
   is no longer the one it claims to extend. Same accepted trade-off as D2's
   original gap, now also covering fragment provenance; worth folding into
   that ruling rather than rediscovering independently later.

5. **`readScreenMockups`'s `Map` return has no doc comment on its shape, and
   no test exercises an empty `fragments` array** — a legitimate no-op under
   the all-or-none write contract `insertScreenMockups` enforces.

6. **CSS nesting (`&`) is unhandled by `scopeCss`.** It happens to inherit the
   parent selector's scoping today, but that is incidental, not a guarantee
   the code makes — flagged by the implementer, not relied on anywhere.

7. **`lib/spec/patch.ts`'s prompt (`spec-v3.md`) narrows v2's explicit
   three-namespace id-uniqueness rule into "must not collide with any id
   already in the current version" — broader than `checkInvariants` actually
   enforces.** Safe direction (it never rejects something valid), but the
   prompt promises more restriction than the code requires.

8. **`reqText`'s validator message does not echo a non-string `op` field**, so
   a patch with a numeric `op` value gives a model weaker retry feedback than
   an unrecognised *string* `op` would.

9. **No test feeds `parseSpecVersion` an `ops` array containing one malformed
   element.** The per-element `parseOp` call on the read path
   (`lib/spec/validate.ts:47`) is correct by inspection; the top-level
   not-an-array case is covered, the per-element case is not.

10. **`built_at` in `notes/v<n>.md` is shape-checked (`YYYY-MM-DD`) but not
    calendar-valid** — `2026-13-99` parses. Matters only if `built_at` ever
    feeds date arithmetic; it does not today.

11. **No test covers a duplicate `##` heading or a zero/negative version** in
    `lib/build/notes.ts`'s parser, though the code handles both. Inherited
    from the plan's own test block, not introduced by an implementer.

12. **`draftAnnouncement`'s `loadPrompt` failure throws a raw `Error`**, not
    the `AnnouncementDraftError` every other failure path in that module
    throws — inconsistent, though the documented contract only requires
    "throws." No test exercises the `Array.isArray` branch or a numeric
    `message` on that same path either.

13. **The `MOCKUP`/`currentPayload` test fixture shape is duplicated** between
    `tests/chat/announce.test.ts` and `tests/scripts/announceDeploy.test.ts`.

14. **CLAUDE.md's `notes/` folder description ("README.md, plus v<n>.md")
    reads as though README presence were swept**, but the sweep only forbids
    stray files — an empty `notes/` folder with no README passes.

15. **`docs/dashboard-build-rules.md:32` cites `conventions.test.ts:45` for
    the REQUIRED array; the actual line is 47.** Pre-existing, not introduced
    by this branch.

16. **The "every note in `notes/` parses" sweep test is vacuous today.** No
    folder has a `v<n>.md` yet — by design, since build notes only start
    existing once a version actually ships — so the loop body that would
    parse each one never runs, and the test cannot fail no matter what
    `parseBuildNotes` does. Correct per "shape not presence" (the sweep
    checks the folder's shape, not whether notes exist), but it has never
    been exercised RED, and it stops being vacuous the moment a real build
    lands its first `notes/v1.md`. Flagged for triage at the final review.

17. **`lib/build/notes.ts`'s `usersRoot()` deliberately duplicates the
    one-line `USERS_DIR` fallback `lib/db/userDb.ts` already exports**, rather
    than importing it (Task 2). `userDb.ts` imports
    `better-sqlite3-multiple-ciphers` — a native SQLite binding — at module
    top level; importing from it would drag that binding into every
    downstream consumer of `lib/build/notes.ts`, including an operator CLI
    (`scripts/announce-deploy.ts`) that has no business opening a database.
    The comment at the duplicated function names this by reason
    (`lib/build/notes.ts:162-174`). Not a defect — a deliberate rejection of
    the "obvious" DRY refactor — but a future edit that "cleans up" the
    duplication by importing `usersRoot` from `userDb.ts` reintroduces
    exactly the coupling this avoided, and the two copies have to be kept in
    step by hand if the `USERS_DIR` convention ever changes.

---

## Built

*(written after the branch ships)*

## The checkpoint

*(written after a live checkpoint run — see unified-loop.md's for the shape)*
