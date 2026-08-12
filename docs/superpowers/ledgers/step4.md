# Step 4 ledger — interview → structured spec flow

Spec: `docs/superpowers/specs/2026-08-12-step4-spec-flow-design.md`
Plan: `docs/superpowers/plans/2026-08-12-step4-spec-flow.md`
Branch: `step4-spec-flow`, 32 commits, `d0f15b4..55a43c7`

## Built

Thirteen tasks, executed subagent-driven with a task review after each and a
whole-branch review at the end. 487 tests pass, `tsc --noEmit` is clean,
`next build` succeeds, `.claude/hooks/test-hooks.sh` is 154/154.

The design held. The agent raises its hand with a zero-payload `propose_spec`
tool; a second non-streaming call authors the spec under structured output; the
friend confirms with a button; the confirmed spec renders in the admin portal
and pulls into the repo with one command.

**Two amendments to the spec were ruled during implementation**, both recorded
in the spec itself rather than only here:

- **§4.3 — `chat_proposed_no_reply`.** The completion rule as designed left the
  proposed-without-usable-reply case writing no metric row at all. That turn's
  own billed input and thinking tokens would have been absent from an
  append-only cost log permanently. Overridden: it contradicts this project's
  own rule that a cost log reporting zero for a billed turn is fiction.
- **§4.1 — structured outputs instead of a forced tool.** Checked against the
  current API before writing the plan. Same guarantee, no `tool_use` block to
  extract, no tool/thinking interaction to reason about.

**One defect caught before any code was written.** The authoring call was
specced non-streaming at `MAX_TOKENS` 64000. The SDK scales its own timeout
*up* for large non-streaming `max_tokens`, so a wedged call could have held a
friend on "putting together a preview…" for the better part of an hour with no
error. It runs at `SPEC_MAX_TOKENS` 32000 with an explicit 180-second timeout,
and a timeout is a visible `spec_error` rather than a hang.

## What the review layer caught

Worth recording because it is the argument for keeping it: **every Important
finding in this branch originated in the plan, not in an implementer's work.**
Task 1's diff was byte-for-byte identical to its brief. A well-specified plan
makes implementers fast and accurate, and it ships the plan's defects
unchallenged unless something independent looks at the result.

The recurring defect was not broken code. It was **tests that could not fail**:

- A markdown-escaping test that passed against unescaped code.
- An exemption keyed on what headings look like, which the attack fixture
  matched, so the test exempted the line it existed to catch.
- A metrics assertion reading "the last row in the table", which returned the
  alerter's row instead — then "fixed" by retiming a test double, hiding the
  broken query rather than repairing it.
- Extracted pure functions that were thoroughly tested while all nine
  call-site mutations survived.
- A rollback guard verified by deleting two blocks at once and attributing the
  failure to the wrong one.

**The control that caught all of them: delete the guarded code and confirm the
test goes red.** Adopted mid-run and applied to every task after Task 4. A test
nobody has watched fail is not yet evidence of anything.

## Residual risks

1. **`ChatPanel`'s wiring has no test coverage.** Nine call-site mutations
   survive the full suite, including `proposals={[]}` — which disconnects the
   entire proposal card region, so the product silently does nothing while the
   suite stays green. The code is correct by inspection and by trace; this is
   regression risk, not a present defect. jsdom and testing-library are not
   installed and were disallowed as new dependencies.

   **The control is the step-4 checkpoint below**, which walks exactly this
   wiring. Treat a change to `ChatPanel`'s `send()`/`onConfirm` body or its
   render props as requiring a manual pass, not just a green suite.

2. **A kill signal mid-export, or a failure during rollback itself, can leave a
   half-written pair.** `scripts/write-spec-pair.ts` guards the precondition,
   write, move-aside, and commit phases — each verified individually by
   deleting it and watching exactly one test go red. The two unrecoverable
   cases are named in the code as trace-verified rather than test-verified.

3. **`background` is the one spec field that can be wrong rather than merely
   incomplete.** Everything else is a decision; this is a model's
   interpretation, and it is the field a reader uses *in place of* the
   transcript. The transcript is one section away in the same pane. Nothing
   downstream may treat it as ground truth.

4. **The six spec fields are frozen.** `specs` and `spec_confirmations` are
   deliberately outside `lib/db/reshape.ts` — CLAUDE.md forbids widening that
   exception. A field added later is missing from every spec written before it,
   permanently, and adding one is a hand-fix on the droplet.

5. **Corrupt stored payloads degrade asymmetrically.** The admin pane shows
   "Unreadable proposal"; the friend's page silently renders no card. Both
   avoid a 500 and both rethrow non-`SpecShapeError` loudly. The friend gets no
   signal, and the row stays confirmable from a stale tab. Narrow and
   self-healing — the agent can propose again.

6. **Client and server disagree about "newest" under a backwards clock step.**
   `withLiveness` picks max `id`; `readSpecs` orders by `at DESC, id DESC`.
   Unreachable in practice — two proposals require two model calls.

7. **No test exercises a mid-stream client disconnect**, so the abort guards on
   the NDJSON enqueues are unproven. Pre-existing, widened by one path here.

8. **`devone` and `devtwo` remain live production logins with published
   passwords** (step-3 residual 7, unchanged). A confirmed spec now sits behind
   that credential too. Should close before the first real user account exists.

## The step-4 checkpoint — Nico's, and BLOCKING

`architecture-overview.md` line 148 says *"Nico runs his own interview
end-to-end."* Run literally, as the `nico` account, it fails for two unrelated
reasons that both look like a broken build: admin accounts are suppressed from
alerts by design, and the admin portal only lists accounts with `role = 'user'`.
That is step 3's trap one level on — testing as yourself looks identical to a
broken feature.

**Ruled: run it as `devtwo`.**

> Log in as `devtwo` at `app.stairwell.run` → run a real interview to
> completion → the agent proposes → the card renders with a working mockup →
> press **Build this** → the phone buzzes → the spec and mockup render in the
> admin portal → `./scripts/pull-spec.sh devtwo` writes both files into the repo.

This is also the only thing that exercises residual 1. Until it passes, the
`ChatPanel` wiring has been verified by nobody.

Before deploying: `deploy/required-env` needs no change (no new variables), and
the first `deploy.sh` run should have its `Deployed <sha>` line checked against
the sha that was pushed — step-2 ledger item 15.

## Deferred, accepted

- `spec_confirmations.spec_id` has no FK to `specs(id)`. House style; the
  account check in `confirmSpec` is the real gate and is mutation-tested.
- The differential markdown-escaping test is fixture-based, so a NEW
  interpolation site added to `render.ts` with no matching fixture would
  regress silently. Bounded by the frozen field list.
- `lib/chat/turn.ts` spreads `...error.shape` wholesale into `chat_error`.
  `ErrorShape` now carries optional `usage`/`served`, so a future shape setting
  them would inject nested objects beside the flat counters. Traced unreachable
  today: `turn.ts`'s catch wraps only `client.stream()`, whose errors come from
  `describeError`, which never sets those fields.
- `spec_aborted` always records zeroes, checked before the post-response kinds,
  so a response that completed and then raced an abort logs billed tokens as
  free. Very narrow window.
- The confirm route calls `readSpecs` twice per request, each pulling every
  proposal's `mockup_html`.
- Duplicate React keys are possible from un-deduplicated model-authored text in
  `open_questions` and `manual_logging`.
- The commit message for `1269f18` says the `chat_error` shape has fifteen
  fields. It has fourteen. The code comment is corrected; the message is
  permanent.
