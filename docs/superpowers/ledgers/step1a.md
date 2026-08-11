# SDD ledger — plan: docs/superpowers/plans/2026-08-10-step1a-auth-and-test-gate.md

=== BRANCH COMPLETE — final whole-branch review clean, fix wave verified ===
Final state: 143 tests / 16 files, 135 harness checks, tsc clean, next build
succeeds, tree clean at 1582645. Merge verdict: READY.

Whole-branch review (opus) found 1 Critical + 8 Important that THIRTEEN
task-scoped reviews had each missed by looking only at their own slice:
  - CRITICAL C1 (controller-verified independently): create-dev-users.ts called
    regeneratePlatform() with no arg, so it ignored PLATFORM_DB entirely, while
    the step-1b plan invokes it WITH PLATFORM_DB=/home/deploy/... On production
    it would seed the wrong file, print a true-but-misleading success, and leave
    the served DB empty — and the obvious repair was DESTRUCTIVE, since
    regeneratePlatform rmSyncs the target and the script then DELETEd all
    accounts. It survived every prior review because scripts/** classified as
    `unguarded` under Gate B, the Task 3 fail-open logged and deferred long ago.
  - The reviewer found the pair the process was hunting for: C1 was benign only
    while the committed TEST-ADMIN password could not reach production. Fixing
    C1 alone would have put a repo-committed admin credential on a public host.
    Individually benign, jointly a live compromise.
  - I6: a THIRD instance of "green does not mean works" — no gate ever ran the
    test suite. Gate B only checks a tests/ path is STAGED, so editing a comment
    satisfied it; a commit reddening 50 tests passed all four gates.
  - I4: spec line 110 promised a sweep interval "so an idle process does not
    retain keys". sweep() had NO caller outside tests, so a key stayed resident
    until process restart — days, not the 4h/12h promised.

NICO'S RULINGS (final): non-destructive INSERT-only script with ADMIN_PASSWORD
from env; add vitest to the pre-push gate (Gate E); Gate A reworded with NO
fourth skip variable.

Fix wave: 11 fixes, 8 incremental commits (f034027..1582645). Re-review clean.
  - Re-reviewer proved the implementer's UNREQUESTED extra fix was necessary:
    it ran a mutant that wipes live keys against the PRE-WAVE test file and got
    9/9 green — fully vacuous. The shared KEY constant would have made the
    zeroing change silently compare zeroed-to-zeroed. The key(fill) factory was
    required, not gold-plating.
  - Re-reviewer verified the sweep-test coupling trap did NOT fire, using three
    aliased mutant keymaps without ever modifying the worktree.
  - Re-reviewer traced fix 5's redirect loop-freedom by hand for all three
    states and confirmed every path terminates in 2-3 hops.
  - Re-reviewer confirmed the sweep scheduler is wired in the real build by
    inspecting .next/server/instrumentation.js for setInterval().unref(), and
    that the edge bundle correctly contains none.

RESIDUALS — parked, not blocking (controller adjudication):
  1. SHOULD NOT WAIT: step-1b plan line 511 runs create-dev-users.ts without
     ADMIN_PASSWORD, so it now exits 1. Fails SAFE (nothing written) but the
     documented 1b flow will not work as written. One-line docs edit.
  2. MINOR (new): an unlocked session whose account row was deleted out-of-band
     loops /login -> / -> /login. Prevented for the app by ON DELETE CASCADE +
     foreign_keys=ON; reachable only via an external sqlite3 CLI with FKs off.
  3. MINOR (new): Gate B now guards next-env.d.ts, so a Next upgrade
     regenerating it blocks a commit staging it alone.
  4. MINOR (new): the script's own docstring shows a command its new guard
     rejects (omits ADMIN_PASSWORD).
  5. putKey()'s overwrite path still abandons the replaced 32-byte buffer.
  6. platform/seed.ts inserts an account via raw SQL, bypassing createAccount's
     new validation; no CHECK constraint on accounts.slug makes it structural.
  7. An authenticated-but-locked user cannot reach /login and /unlock has no
     logout control — a forgotten password is a dead end until the cookie is
     cleared. Pre-existing routeFor design, now made live.
  8. create-dev-users.ts is not transactional: a mid-run failure leaves a
     partial DB that refuse-if-populated then permanently rejects.


Worktree: /Users/nico/Documents/code/stairwell/.claude/worktrees/step1a-auth-and-test-gate
Branch: worktree-step1a-auth-and-test-gate
Base: bc2bc61 (local main tip — specs + plans present)
Baseline: ./setup.sh green, 44 checks, 11 in the gate group.

Tasks: 14. Gate work is Tasks 2–4 and must land before Task 5 (plan §1.1).

Task 1: complete (commits 88d9bba..2a4ca69, review clean)
  - Reviewer flagged one "cannot verify from diff": that npm install / vitest
    actually pass. Resolved by the controller: `npx vitest run` = 1 passed, and
    both native modules (better-sqlite3-multiple-ciphers, @node-rs/argon2) load
    under Node v22.13.1. Not a gap.

Task 2: complete (commits 2a4ca69..e31db5d, review clean)
  - Gate A generalised to a two-row pattern table. 52 checks, 19 in the gate
    group. All 11 pre-existing gate verdicts unchanged.
  - Reviewer independently probed beyond the brief's 8 cases: nested variants
    (x/platform/schema.sql, platform/sub/schema.sql) correctly ungated;
    cross-scope prefix leakage absent in both directions; "testsFOO/" does not
    satisfy the "tests/" prefix. No findings.

Task 3: fix round 1/5 (1 addressed, 0 open — Gate B exempted *.json/*.yml/
  *.yaml/*.toml at any depth, failing open for lib/config.json etc.; commits
  a851bbd..4bcbffe)
Task 3: complete (commits e31db5d..4bcbffe, review clean). 84 checks.
  - Implementer caught a real bug in the PLAN's own hook text: the main block
    ended on `[ $rc -ne 0 ] && exit 1` with nothing after it, so bash would use
    that failed test's status as the script exit code and the hook would have
    blocked EVERY valid commit. Fixed with a trailing `exit 0`; plan corrected
    in a851bbd.
  - Config fail-open was also plan-mandated. Nico ruled: root-level only.
    Fixed in 4bcbffe with 5 covering cases.
Task 3: minor (deferred): the Gate B block message advertises SKIP_TEST_GATE=1,
  which does not exist until Task 4. Self-resolves there; verify at Task 4.
Task 3: minor (deferred): `unguarded` is a quiet fail-open for any new
  top-level directory nobody classifies. Deliberate per the 4-way interface,
  and Task 14's scripts/ relies on it. Final review should confirm it is still
  the right default.
Task 3: minor (deferred): harness case "nested json + platform tests/" passes
  both pre- and post-fix, so it does not pin the bug. Harmless; the other four
  new cases do the pinning. Implementer self-reported this honestly.

Task 4: complete (commits 4bcbffe..53aae8a, review clean). 89 checks.
  - Reviewer verified live: skip prints only when the gate would have blocked;
    SKIP_TEST_GATE does NOT leak into Gate A (check_schema_drift still blocks);
    multi-scope grouping omits satisfied scopes. CLAUDE.md verbatim.11
  - Task 3's deferred "SKIP_TEST_GATE advertised but unimplemented" is RESOLVED.
Task 4: minor (deferred): harness case "skip names the untested file" asserts a
  bare filename that appears in BOTH the skip and block messages, so it is not
  diagnostic. Real coverage comes from skip_check + the "platform:" case.
Task 4: minor (deferred) METHODOLOGY: two non-diagnostic harness cases now
  (Task 3 + Task 4), same shape — a new case that would also have passed
  pre-fix. Controller is adding "confirm each new assertion would fail against
  the pre-fix code" to remaining dispatches. Final review: check whether the
  two existing cases are worth tightening.

--- Gate work complete. Tasks 5-14 are the first real traffic through Gate B. ---

--- STANDING POLICY (Nico, at Task 5) ---
When a reviewer proposes a strictly stronger test than the plan mandates, the
controller adopts it WITHOUT asking again. "Plan-mandated" is not a shield for
a weak test. Every substitution is logged here.
-----------------------------------------

Task 5: fix round 1/5 in progress — replace grep-over-source assertions in
  tests/routing/root.test.ts with a behavioural redirect assertion.
Task 5: minor (deferred): the commit carries a Next.js-generated tsconfig.json
  rewrite (array reformatting + allowJs:true). All load-bearing options
  survived and `tsc --noEmit` is clean; noise only.
Task 5: minor (deferred): no automated coverage of the actual dev-server
  redirect; only the source-string check. Partly addressed by the fix round.
Task 5: fix round 1/5 (1 addressed, 0 open — grep-over-source assertions
  replaced with a behavioural redirect test; commits c44195c..b5f672c)
Task 5: complete (commits 53aae8a..b5f672c, review clean). Suite: 2 tests.
  - Re-reviewer independently proved diagnosticity two ways: redirect target
    changed -> fail; redirect removed entirely -> fail ("Number of calls: 0"),
    so the mock is not vacuous. Restored the file, clean tree verified.
  - Layout test dropped rather than kept weak. Re-reviewer agreed: layout.tsx
    has no branching logic, so nothing real is left uncovered.
  - SUBSTITUTION under the standing policy: plan mandated substring assertions;
    reviewer's behavioural test adopted instead.

--- SESSION 1 ENDED HERE (controller exited after Task 6's commit + report,
    before the Task 6 review). Session 2 resumed at the Task 6 review.
    Recovery check on resume: worktree clean at c08dd71, 8/8 tests green,
    89/89 hook checks green, no stashes, nothing lost. ---

Task 6: implemented + committed in session 1 (c08dd71); reviewed in session 2.
  Review verdict: spec ✅ compliant (all four files byte-identical to the
  brief), task quality Approved, with one Important finding.
  - Reviewer independently verified the implementer's TDD evidence rather than
    trusting it, and confirmed the trigger-removal + static-scan removal proofs
    are real.
  - Important (plan-mandated): appendMetric (lib/db/appendOnly.ts) is never
    invoked by any test. The metrics UPDATE/DELETE tests insert via raw SQL, so
    a write path into a SACRED append-only table ships with zero direct
    coverage. The hole is in the brief's own test file, not implementer drift.
  - ADOPTED under the Task 5 standing policy without re-asking Nico: this is a
    strictly stronger test than the plan mandates. Entering fix round 1.
  - Controller resolution of the reviewer's ⚠️ ("schema is a dependency for
    later tasks"): not a gap. accounts/sessions are consumed by Tasks 10-13 and
    the requests table by Task 14; each has its own coverage. Nothing to fix here.
Task 6: minor (deferred): transcripts.role and metrics.event have no CHECK
  constraint, unlike accounts.role. Not brief-mandated; future hardening.
Task 6: fix round 1/5 (1 addressed, 0 open — appendMetric now has a direct test
  asserting account_id/event/at via raw SELECT; commits c08dd71..d88a6e2)
Task 6: complete (commits b5f672c..d88a6e2, review clean). Suite: 9 tests.
  - Fix was test-only; lib/db/appendOnly.ts confirmed byte-identical, so no
    unrequested public API surface (no readMetric) was added.
  - Diagnosticity PROVEN this time: parameter swap made the new test fail with
    account_id="session_open" / event="7.0", restore byte-identical. This is
    the methodology fix the Task 4 note asked for — the third non-diagnostic
    assertion did NOT happen.
  - SUBSTITUTION under the standing policy, logged: the brief's test file
    omitted any direct appendMetric coverage; reviewer's stronger test adopted.
Task 6: minor (deferred): Task 6's own self-review flagged that no test guards
  against a FUTURE migration path issuing DROP TRIGGER. Out of scope for 6;
  later schema-change tasks must respect it. Final review should confirm.

Task 7: implemented on the cheap tier (brief carried complete verbatim code).
  Review verdict: spec ✅ compliant, task quality Approved, ZERO Critical and
  ZERO Important findings.
  - Implementer's own diagnosticity proof was real: rewired regenerateUser to
    the platform path, 3/4 tests failed, restore byte-identical.
  - Reviewer went further and reasoned about the two failure modes the proof
    did NOT cover (silent no-op, swallowed error) and showed the suite still
    fails loudly via test 3's ENOENT. No swallowed-error path exists.
  - Controller resolution of the ⚠️ (accounts column list trusted against Task
    6's schema): not a gap. regeneratePlatform would throw on a mismatch and
    test 1 calls it, so the INSERT is exercised. Confirmed against schema.sql.
  - ADOPTING minor #1 under the Task 5 standing policy rather than deferring:
    noCross.test.ts test 4 asserts only the returned path string, so in
    isolation it passes for a regenerateUser that does nothing. That is exactly
    the "weak test the plan mandated" the policy exists to catch. Entering fix
    round 1 to add an existence/content check.
Task 7: fix round 1/5 (1 addressed, 0 open — "nowhere else" test now asserts
  existsSync + reads COFFEE PALACE TEST back out of the seeded db, so it is
  diagnostic standalone; commits 67bd6fc..5d3a062)
Task 7: complete (commits d88a6e2..5d3a062, review clean). Suite: 13 tests.
  - Re-reviewer traced the strengthened assertion manually rather than trusting
    it: a regenerateUser returning the right path but writing nothing now fails
    at existsSync before reaching the content check. Gap genuinely closed.
  - Re-reviewer independently ran wc -l and confirmed the corrected "24 lines"
    stat. The fabricated 117 is gone.
Task 8: review found 1 Critical + 2 Important. Reviewed on the top tier because
  this is the crypto core; that was the right call — the Critical was invisible
  to every check the project had.
  - CRITICAL (verified by controller, not just claimed): lib/auth/password.ts
    does not compile. TS2748, ambient const enum Algorithm under
    isolatedModules. `npx tsc --noEmit` = 1 error; next.config.ts sets no
    ignoreBuildErrors, so `next build` is a hard failure. It passed BOTH
    pre-commit gates and a 19/19 green suite because vitest transpiles via
    esbuild and never typechecks. The brief's own verbatim text is what
    produced it — same class as Task 3's plan-text bug, fixed the same way.
  - IMPORTANT: the test named "uses different salts, so the key is not
    recoverable from the hash" is UNFALSIFIABLE. A 32-byte buffer's base64 is
    44 chars with '=' padding; the PHC digest segment is unpadded 43 chars, so
    not.toContain(padded) passes even when digest and key are byte-identical.
    The hex assertion can never match a base64 PHC string at all. The task's
    headline security claim was guarded by two assertions incapable of failing.
  - IMPORTANT (plan-mandated): subarray(0,32) silently yields a DIFFERENT key
    if outputLen/version defaults ever change; toHaveLength(32) still passes.
    Implementer analysed the safe direction (short digest, caught loudly) and
    missed the unsafe one (different digest, silent).

--- NICO'S RULINGS (at Task 8) ---
1. deriveDbKey: adopt hashRaw + pin outputLen: 32. Byte-identical key today, so
   no data implication; removes string parsing, truncation hazard, and the
   key-in-immutable-string lifetime issue together.
2. Typecheck gate: ADD IT NOW to .githooks/pre-commit, with harness cases.
   A build-breaking commit passing both gates is the hole that let this ship.
   This is new scope beyond the plan, accepted deliberately. Becomes Task 8G,
   run after Task 8 closes so no two implementers touch the branch at once.
-----------------------------------

Task 8: fix round 1/5 (3 addressed, 0 open — tsc-clean Argon2id pin via type-only
  import + `2 as Algorithm`; unfalsifiable substring assertions replaced with
  digest.equals(key) + cross-salt derivation; hashRaw with outputLen: 32 pinned,
  PHC parse and subarray truncation deleted; known-answer test added;
  commits bed33be..fa2db15)
Task 8: complete (commits 5d3a062..fa2db15, review clean). Suite: 20 tests.
  - Controller verified `npx tsc --noEmit` exits 0 directly. Build unbroken.
  - Re-reviewer did NOT accept the load-bearing claims on report. It ran both
    derivation paths in one process against the installed binding and measured
    oldKey.equals(newKey) = true itself. The refactor does not rekey.
  - Re-reviewer also verified the algorithm actually REACHING the library, not
    just that the cast compiles: PHC prefix is $argon2id$v=19$m=19456,t=2,p=1,
    and an algorithm:1 control produces $argon2i$. A cast that compiled to the
    wrong enum member would have been worse than the original error.
  - Known-answer test confirmed non-circular: expectation is a hardcoded
    literal, not recomputed from deriveDbKey.
Task 8: minor (deferred): outputLen: 32 passed twice at password.ts:56 (via the
  OPTS spread and explicitly). Harmless; invites a future half-edit.
Task 8: minor (deferred): `version` still not explicitly pinned in OPTS. Covered
  de facto by the known-answer test, which pins v=19 — a default shift fails
  loudly rather than rekeying. Explicit pin covers 5 of 6 params; the 6th rests
  on the KAT. Final review may want the explicit pin.
Task 8: minor (deferred): the KAT cannot detect REMOVAL of the explicit
  algorithm pin, since Argon2id is the library default — re-reviewer confirmed
  identical hex with algorithm omitted. The explicit OPTS pin covers that case.
Task 8: still deferred, untouched by design: bare `catch { return false }` in
  verifyPassword, its (storedHash, password) argument order which returns a
  silent false on a swapped call, and missing malformed-hash/empty-password
  coverage. Task 9 consumes this module — watch for the argument-order trap.

Task 8G: Gate C — typecheck. NEW SCOPE per Nico's ruling at Task 8, not in the
  original plan. Brief authored by the controller (behaviour + 10 harness cases
  specified; implementer designed the bash). Commit 5d232e7.
  Controller verified directly: harness 89 -> 99 checks, tsc exit 0, vitest
  20/20, tree clean.
  Review verdict: spec ✅ compliant, task quality Approved, 0 Critical,
  1 Important.
  - Reviewer independently re-ran the implementer's self-flagged weak cases
    (2, 3, 9) against its OWN adversarial mutations and confirmed all three are
    genuinely pinned. It also found case 3's real value is the *.tsx branch, not
    the shared path the report claimed — report rationale weaker than reality.
  - Fast path proven with a marker-file stub: compiler never invoked when no
    TypeScript is staged.
  - Extension matching proven true-suffix against notes.tsx.bak, foo.ts.md,
    x.ts/inner.md, "a b/c.ts.orig". Paths with spaces handled.
  - Trailing `exit 0` intact; Task 3's exit-code bug not reintroduced. No
    working-tree mutation (scanned for stash/checkout/mktemp/writes).
  - IMPORTANT: the Gate C block message told developers to use
    `git commit --no-verify`, which bypasses ALL THREE gates, where Gate B's
    message points at its narrow self-announcing bypass. A developer following
    the on-screen instruction would ship past schema-drift and test-coverage
    too. Entering fix round 1.
Task 8G: ADOPTED under the Task 5 standing policy (stronger test than the brief
  mandated): the brief's case 9 named only Gate A, and the reviewer DEMONSTRATED
  that a SKIP_TYPECHECK leak into Gate B ships undetected. Adding the Gate B
  half. No live defect today — SKIP_TYPECHECK appears only inside
  check_typecheck — but the mutation was invisible.
Task 8G: fix round 1/5 (5 addressed, 0 open — block message now points at
  SKIP_TYPECHECK=1 not --no-verify; case 6 re-pinned on "Gate C SKIPPED"; Gate B
  anti-leak case added; exit-127 reported as a tooling failure not a type error;
  skip notice states the commit-message obligation; TYPECHECK_CMD made local;
  commits 5d232e7..32623f5)
Task 8G: complete (commits fa2db15..32623f5, review clean). Harness: 100 checks.
  - Controller verified: 100/100 harness, tsc exit 0, vitest 20/20, tree clean.
  - Re-reviewer PROVED the old case 6 was vacuous rather than assuming it: in
    the mutated hook (skip branch deleted) the old literal "SKIP_TYPECHECK=1"
    still appeared via the block message, so the old case would have passed with
    no skip branch at all. The re-pinning is real, not cosmetic.
  - Re-reviewer confirmed `local TYPECHECK_CMD="${TYPECHECK_CMD:-...}"` still
    picks up the harness's exported stub — bash evaluates the RHS before `local`
    shadows the name. The stub mechanism is not regressed.
  - exit-127 branch confirmed not to misreport real type errors: tsc's own
    documented exit statuses are 0-5, and the branch still fails closed.
Task 9: implemented 5aac968, DONE_WITH_CONCERNS. Controller-required extras
  beyond the brief (both delivered): sweep() coverage, and a static scan for
  console/JSON.stringify/fs writes guarding the never-logged rule.
  Review verdict: spec ❌ (one Important), 0 Critical. Suite 29 tests.
  - The implementer found a REAL BUG in the brief's own test 7: it never calls
    getKey during its ~12h wait, so the 4h idle TTL kills the entry before the
    ceiling logic runs — permanently red regardless of implementation. Reviewer
    simulated it and confirmed: at t=43,199,000 the idle gap is 43,198,000 vs a
    14,400,000 TTL. Deviation (hourly polling) accepted; same class as Task 3's
    plan-text bug.
  - The implementer also reported, honestly and correctly, that the brief's
    claim was half-wrong: of the two ceiling tests only "expires at the absolute
    ceiling even when constantly refreshed" catches the refresh-resets-ceiling
    mutation. "cannot survive from one morning to the next" is killed by idle
    expiry and never exercises the ceiling at all.
  - IMPORTANT (plan-mandated): test 7 "restarts the ceiling on re-unlock" passes
    IDENTICALLY whether or not the ceiling restarts. Reviewer ran the arithmetic
    both ways: correct impl gives a ceiling gap of 43,198,000; the mutant that
    never restarts gives 43,199,000 — both under the 43,200,000 ceiling, so both
    green, and no intermediate poll crosses it either. The brief's 1000ms gap
    sits below the final margin. Test 4 pins "refresh must not extend"; NOTHING
    pinned "re-unlock must restart" — an implementation that silently never
    restarts would ship green and lock users out early mid-day.
  - ADOPTED under the Task 5 standing policy without asking: widen the gap, plus
    the reviewer's suggestion to pass a DISTINCT buffer on re-unlock (nothing
    currently verifies putKey stores the buffer it was handed on overwrite —
    every call passes the same KEY object, so a putKey that refreshed timestamps
    but kept the old entry's key would pass all nine tests).
  - Reviewer verified the sweep() clock-rewind trick genuinely works by
    simulating a no-op sweep: the stale entry gets resurrected and the assertion
    goes red. Not vacuous.
Task 9: fix round 1/5 (5 addressed, 0 open — ceiling-restart test widened to a
  3,600,000ms gap so it actually pins restart; distinct KEY2 buffer on re-unlock
  pins that putKey stores what it was handed; non-vacuous-walk guard on the
  static scan; fragility-trap comment at the sweep rewind site; returned-buffer
  contract in the docstring; commits 5aac968..5c8fa67)
Task 9: complete (commits 32623f5..5c8fa67, review clean). Suite: 29 tests.
  - Re-reviewer redid the arithmetic INDEPENDENTLY under both implementations
    rather than checking the report's numbers. Correct impl: now-unlockedAt =
    43,198,000 at the final poll, alive with 2000ms margin. Mutant preserving
    unlockedAt=0: survives iteration 11 at exactly 43,200,000 (boundary
    equality) then dies at iteration 12 on 46,798,000 — a 3,598,000ms overshoot,
    not a razor's edge. Confirmed idle refresh cannot mask the result.
  - Confirmed the widened test makes no sibling test vacuous: test 4 covers the
    ceiling under a single unlock, test 3 covers idle refresh alone, and test 7
    now uniquely covers ceiling-restart AND key-overwrite.
  - keymap.ts change was comment-only, as constrained.

Task 10: implemented fe603c1. Controller-required extras beyond the brief (all
  three delivered): checkPassword coverage, COOKIE_OPTIONS flag assertions, and
  a strengthened key-material scan.
  Review verdict: spec ✅ compliant, Approved, 0 Critical, 1 Important.
  Suite: 39 tests.
  - The brief's key-material assertion was BROKEN and the controller caught it
    pre-dispatch: it checked JSON.stringify(rows) for the key's HEX, but a key
    stored as a BLOB renders as {"type":"Buffer","data":[...]} with no hex at
    all. Reviewer built its own probe matrix and confirmed: BLOB in a neutrally
    named column is missed by BOTH original assertions, caught by the new scan.
    hex TEXT and base64 TEXT also caught. No false positive on a clean schema.
  - verifyPassword's reversed (storedHash, password) order — the trap flagged in
    the Task 8 ledger entry — is called CORRECTLY at accounts.ts:42 and was not
    "fixed" by the implementer.
  - No cross-test keymap leak: vitest isolates the module registry per file, and
    within the file every sid is a fresh randomBytes(32).
  - Duplicate-slug error carries no bound parameters — reviewer probed the
    failure path and confirmed no auth_hash sentinel in e.message or e.stack.
  - IMPORTANT (plan-mandated): session expiry is a silent logout that does NOT
    drop the key. destroySession drops it; readSession just returns undefined
    and leaves the keymap entry alive, so a key can outlive its session by up to
    the 12h ceiling. Bounded defense-in-depth, not a live leak — no normal route
    reaches getKey after readSession returns undefined.

--- NICO'S RULING (at Task 10) ---
readSession drops the key on the expired branch before returning undefined.
Minimal change; DB semantics untouched so Tasks 11-13 see no difference. NOT
adding a row-delete — that would make readSession a write path and hand every
downstream reader a lock-failure mode.
-----------------------------------

Task 10: fix round 1/5 (6 addressed, 0 open — dropKey on the expired branch per
  Nico's ruling with NO row-delete; SESSION_TTL_MS and SESSION_COOKIE pinned;
  exact-boundary case discriminating < from <=; key scan extended to the
  JSON-serialised buffer form; duplicate-slug throw recorded;
  commits fe603c1..986bdbf)
Task 10: complete (commits 5c8fa67..986bdbf, review clean). Suite: 44 tests.
  - PROCESS NOTE: the implementer hit a 600s watchdog stall AFTER finishing the
    code and the 262-line fix report but BEFORE committing. Controller inspected
    the working tree, confirmed all six items and both mutation proofs were
    already done, and resumed the agent for verify-and-commit only. Nothing was
    redone and nothing was lost. Worth remembering: a stalled agent is not
    necessarily lost work — inspect the tree before re-dispatching.
  - The implementer found the CONTROLLER'S OWN specified expiry test was not
    diagnostic: advancing fake timers past SESSION_TTL_MS (30d) also blows past
    ABSOLUTE_TTL_MS (12h), so the keymap would have expired the key on its own
    and the test could not tell that apart from readSession's dropKey. Same
    observable, two causes. It redesigned rather than implementing as written.
  - The redesign: freeze the clock at 0 and never advance it, then UPDATE
    sessions.expires_at to -1 directly. The row is expired while alive() is
    trivially true, so readSession's dropKey is the ONLY path that can make
    getKey undefined. Re-reviewer verified this against keymap.ts independently
    and confirmed the isolation is real.
  - Re-reviewer confirmed by reading the full current file that NO DELETE was
    added to readSession — Nico's ruling respected exactly.
Task 11: implemented a5d35c4 + 3bae6f2. Controller-required extras beyond the
  brief (all three delivered and verified effective): requireState behavioural
  tests, middleware()/config.matcher tests, getDb() tests.
  Review verdict: spec ❌ (2 Important, both plan-mandated), 0 Critical.
  Suite: 68 tests.
  - The implementer's OWN self-review caught that its cookie mock ignored the
    .get() key name, so a wrong-cookie-name bug in guard.ts would have passed
    silently. Fixed in 3bae6f2. Reviewer confirmed the fix closes the hole and
    noted a subtlety: the test uses mockClear() not mockReset(), so the
    name-checking implementation survives between tests — mockReset() would have
    silently reverted it.
  - The controller's requireState requirement was VINDICATED: the brief's excuse
    ("a thin adapter; the decision it delegates to is tested elsewhere") was
    exactly wrong, and the bug found was in the adapter layer.
  - Reviewer confirmed the platform/dev/ hazard is closed and could NOT have
    been masked by cleanup: no static import of instance/guard, every dynamic
    import preceded by PLATFORM_DB pointing at mkdtempSync, and it probed the
    driver to confirm a missing parent directory THROWS rather than creating it.
  - resolveState checks readSession BEFORE getKey (resolve.ts:17-18), which
    matters: readSession expires the row and dropKeys, so an expired session
    with a live key resolves anonymous, not unlocked. Reverse order would leak.
  - IMPORTANT #1 (plan-mandated, brief line 168 verbatim) — REAL SECURITY LEAK:
    routeFor uses startsWith('/admin'), so '/adminbob' returns null and an
    AUTHENTICATED-BUT-LOCKED session reaches it without passing /unlock.
    accounts.ts does no slug validation and reserves nothing, so an account with
    slug 'adminbob' is creatable. This is precisely the two-tier-lock leak the
    task exists to prevent, and it is silent — every admin assertion uses the
    exact string '/admin'. FIXING WITHOUT ASKING: unambiguous bug in the plan's
    text with one intent-preserving fix, same class as Task 3's hook bug and
    Task 8's TS2748.
  - IMPORTANT #2 — CONTROLLER RESOLVED, NOT A DEFECT: reviewer flagged that
    getDb()'s 'platform/dev/synthetic.db' fallback throws because the directory
    does not exist and openPlatformDb does no mkdir. Verified nothing sets
    PLATFORM_DB locally (npm run dev is bare `next dev`). BUT Task 14 creates
    scripts/create-dev-users.ts which consumes regeneratePlatform (Task 7),
    whose default target is exactly that path and which DOES mkdir. So this is a
    documented ordering requirement — seed before dev — not a break. Downgraded
    to a docs item for Task 14. Production unaffected: step1b sets PLATFORM_DB.
Task 11: fix round 1/5 (3 addressed, 0 open — isAdminPath segment-boundary
  helper replaces the bare startsWith; redundant '/admin' dropped from LOCKED_OK;
  pathname-plumbing test; matcher length assertion; commits 3bae6f2..eae90ec)
Task 11: complete (commits 986bdbf..eae90ec, review clean). Suite: 72 tests.
  - The /adminbob assertion was run RED against the unfixed code first
    ("expected null to be '/unlock'"), so the leak is genuinely pinned.
  - Re-reviewer enumerated every affected path rather than trusting the fix:
    /admin -> null, /admin/ -> null, /admin/settings -> null, /adminbob ->
    /unlock, /administrator -> /unlock. No regression: the real admin subtree
    stays reachable by a locked session; only same-named slugs are bounced.
  - Re-reviewer verified the LOCKED_OK removal was genuinely redundant (not a
    regression) and independently confirmed by grep that only ONE prefix-shaped
    match existed — all other .has() calls are exact Set lookups.
  - The new requireState('/unlock') test confirmed non-vacuous: a requireState
    ignoring its argument and hardcoding '/a' would call redirect and fail it.

Task 12: implemented 699769d. Controller-required extras: route-handler tests
  (the brief covered only lib/auth/flow.ts), plus investigations B and C.
  Suite: 84 tests. Both diagnosticity mutants caught (login-adds-putKey RED on
  "leaves the session locked"; dropKey removal RED on the logout assertion).

*** CRITICAL — `next build` FAILS. Controller verified directly. ***
  node:crypto UnhandledSchemeError; import trace node:crypto -> lib/session/
  store.ts. middleware.ts imports SESSION_COOKIE from store.ts, which imports
  randomBytes from node:crypto; only a const is used but the whole module graph
  reaches the edge bundle. INTRODUCED BY TASK 11 (which created middleware.ts)
  and undetected for two full tasks.
  THE GATE LESSON REPEATS ONE LEVEL UP: Gate C was added because "tests green"
  did not mean "compiles". Now "tsc green" does not mean "builds" — tsc passes,
  vitest passes 84/84, and the production build is broken. The 8G report's line
  that "tests green being treated as verified" is the real cost was right, and
  the same blind spot existed one tier above it.

--- NICO'S RULINGS (at Task 12) ---
1. Fix: extract SESSION_COOKIE and COOKIE_OPTIONS into lib/session/cookie.ts
   with zero node: imports; store.ts re-exports, middleware.ts imports from
   there. One definition, and it structurally prevents a future node: dep from
   reaching the edge bundle.
2. Build gate: BOTH tiers. Add a PRE-PUSH build gate with harness cases (Task
   12G), AND assert `npx next build` in Task 14's checkpoint. Explicitly NOT
   per-commit — that is the wrong tier for a minute-long mutating check that
   writes .next/ as a side effect.
-----------------------------------

Task 12: fix round 1/5 (4 addressed, 0 open — lib/session/cookie.ts extracted
  with zero node: imports, store.ts re-exports, middleware.ts imports directly;
  next build restored; edge-safety static scan; middleware import allowlist;
  commits 699769d..38911a5)
Task 12: complete (commits eae90ec..38911a5, review clean). Suite: 87 tests.
  - Controller verified `npx next build` directly: exit 0, Middleware bundle
    compiles at 34.2 kB.
  - Re-reviewer confirmed the re-export is a genuine `export { ... }` and NOT a
    redeclaration, so there is exactly one definition — two definitions that
    happened to agree would have been a latent bug dressed as a fix.
  - Re-reviewer traced the allowlist regex by hand against the ORIGINAL bug's
    import line and confirmed it fails: '@/lib/session/store' is captured and is
    absent from the allowlist. The test genuinely catches the bug that shipped.
  - Coverage honesty confirmed: the middleware assertion is direct-import only,
    NOT a transitive graph walk, and both the test's inline comments and the
    report say so unprompted and name the uncaught case. No overclaiming.
  - Verified every pre-existing SESSION_COOKIE/COOKIE_OPTIONS import site still
    resolves through the re-export; no import site needed editing.

Task 12G: Gate D — pre-push build gate. NEW SCOPE per Nico's ruling at Task 12.
  Brief authored by the controller (behaviour + 8 harness cases). Commit b3cccc3.
  Controller verified: harness 100 -> 111, vitest 87/87, tsc 0, tree clean,
  git ls-files -s confirms mode 100755.
  Review verdict: spec ✅ compliant, Approved, 0 Critical, 3 Important.
  - Implementer honestly reported that the harness-first RED run only exercised
    the "file missing" guard, so instead of claiming RED proved diagnosticity it
    mutated the WORKING implementation per case and confirmed exactly the
    matching assertion flipped. Reviewer judged this method STRONGER than the
    RED-first evidence it replaced: RED-before-implementation only proves the
    code did not exist. This is a methodology improvement worth keeping.
  - Reviewer ran the hook end-to-end five ways (pass/fail/missing-cmd/skip-
    suppressing/skip-silent) and confirmed it fails closed on every path.
  - Reviewer verified ${BUILD_CMD:-...} uses :- not -, so an exported-but-EMPTY
    BUILD_CMD falls back to the real command instead of degenerating to rc=0 and
    a silent pass. That was the most dangerous silent-gate-off mode and it is
    closed.
  - IMPORTANT #1 — THE SAME FAILURE CLASS, ONE LEVEL UP AGAIN: all 11 assertions
    source the file and call check_build directly; NOTHING executes .githooks/
    pre-push as a script. Delete the check_build call from its main block and
    the harness still reports "All 111 checks passed" while every push sails
    through. Exactly what this task exists to prevent.
  - IMPORTANT #2: the harness guards with [ ! -f ] not [ ! -x ], and git FAILS
    OPEN on a non-executable hook (skips it, push proceeds). setup.sh repairs
    and verifies the exec bit for the guard, harness and pre-commit but not
    pre-push — an unexplained asymmetry on the one gate whose failure is silent.
  - IMPORTANT #3: the report justified case 4 with "covered by the RED phase
    (case does not exist pre-implementation)" — an argument that would validate
    any case ever written, and the exact fallacy that sank two earlier tasks.
    The property is genuinely covered; the report does not establish it.

Task 12G: fix round 1/5 (4 addressed, 0 open — two as-a-script cases exercising
  the main block; -x guard replacing -f; the hollow case-4 claim replaced with a
  real skip-branch mutation; progress notice + narrowed case 6;
  commits b3cccc3..b391295)
Task 12G: complete (commits 38911a5..b391295, review clean). Harness: 113 checks.
  - Re-reviewer independently REPRODUCED every mutation rather than trusting the
    report. Deleting check_build from the main block: all 11 sourced cases stay
    green, only the new as-a-script blocking case flips. That asymmetry is the
    proof the blind spot was real and is now closed.
  - The -x guard verified to fail closed for BOTH a non-executable file and a
    missing one.
  - The case-6 narrowing verified NOT to have gutted the case: re-reviewer
    reproduced a skip-notice-fires-unconditionally mutation and the narrowed
    assertion still catches it.
  - Progress notice confirmed stderr-only, never touching stdout on the pass path.
Task 12G: minor (deferred): the two as-a-script cases capture output but assert
  only the exit code — a missed chance to pin the blocked-build message on that
  path. Also `printf '' | ... </dev/null` is redundant; the redirect supersedes
  the pipe. Both cosmetic.

Task 13: implemented b6d6e24, DONE_WITH_CONCERNS. Controller-required extras:
  page-component tests with a THROWING notFound mock, plus assessments B and C.
  Review verdict: Approved, 0 Critical, 1 Important (an incomplete assessment,
  not a code defect). Suite: 102 tests.
  - Reviewer traced ALL SIX paths through app/[user]/page.tsx and confirmed the
    404-blindness is airtight: owner renders; non-owner, unknown slug and admin
    all hit the identical zero-argument notFound(); there is no app/not-found.tsx
    to echo the slug; and the DB work never varies with whether the target row
    exists, because accountFor queries by session.account_id and never by slug.
  - The throwing-notFound requirement was the right call: the implementer used
    distinct sentinels (NEXT_NOT_FOUND vs NEXT_REDIRECT:<path>) and asserted
    .rejects.toThrow, so a component that failed to stop would fail the test.
    Reviewer confirmed the mutation output carries the full <main><h1> tree —
    direct evidence the assertion discriminates.
  - requireState-before-ownership confirmed to leak nothing: routeFor returns
    /unlock for a locked session on EVERY non-admin pathname, so a locked owner
    and a locked non-owner are identical from outside.
  - The implementer hit Gate B trying to land a comment-only app/ fix, refused
    both banned workarounds, reverted and disclosed. Correct behaviour; the
    gates worked.

*** IMPORTANT — THE TIMING ORACLE DEFEATS TASK 13's 404-BLINDNESS. ***
  The reviewer connected two findings the controller had logged separately.
  Task 13 hides whether a slug exists. But /api/login is reachable with NO
  cookie (excluded from the middleware matcher), both outcomes redirect to the
  same /login?error=1, and the only difference is wall-clock: 0.009ms unknown
  slug vs 14.1ms known slug. An unauthenticated attacker enumerates accounts
  and the blindness is defeated in practice.

--- NICO'S RULING (at Task 13) ---
Fix it NOW as Task 13G, before Task 14's checkpoint declares the branch done.
Verify against a fixed dummy Argon2 hash on the unknown-account path so both
branches pay the same cost. Brief authored; dispatch after Task 13's fix lands.
-----------------------------------

Task 13: fix round 1/5 (4 addressed, 0 open — canSeeUserSpace fails closed;
  three page-layer locked-session/admin tests; header comments folded in
  alongside tests so Gate B passed honestly; globalThis.React scoped with
  vi.stubGlobal/unstubAllGlobals; commits b6d6e24..0c5bc8b)
Task 13: complete (commits b391295..0c5bc8b, review clean). Suite: 106 tests.
  - Re-reviewer enumerated every session/slug combination by hand and confirmed
    the fail-closed change fixes no-session+no-slug while leaving all five
    legitimate cases unchanged.
  - Re-reviewer derived the diagnosticity proof FROM SOURCE rather than
    re-applying the mutation (read-only constraint) and independently arrived at
    exactly the claimed failure modes: with the pathname hardcoded to /unlock,
    LOCKED_OK.has('/unlock') returns null, so both locked tests fall through —
    the non-owner 404s instead of redirecting and the owner renders without
    throwing at all.
  - The three new page tests assert BOTH the throw sentinel and that the other
    mock was NOT called, so a render or a wrong-sentinel throw fails.
Task 13: CARRY FORWARD — slug reservation and slug-SHAPE validation both belong
  in createAccount. Confirmed collisions: admin, login, unlock (static routes
  always win, so such an account is permanently unreachable — availability, not
  confidentiality). Reviewer added favicon.ico, which the middleware matcher
  excludes. Also: app/[user]/page.tsx builds requireState's pathname from the
  route param, so a slug decoding to 'admin/anything' would skip the /unlock
  bounce — safe only because no such account can exist. A /^[a-z0-9-]+$/ check
  belongs in the same work.
Task 13: minor (deferred): tests mutate globalThis.React without restoring it,
  so components are compiled by esbuild's classic transform rather than the SWC
  path production uses. Harmless under vitest isolation; the test-time render is
  not build-faithful.

Task 13G: THE TIMING ORACLE IS CLOSED. Commits 952e558 + 88c6a19 (fix round 1).
  Measured medians of 15: BEFORE 0.055ms unknown-slug vs 14.79ms wrong-password
  (~270x). AFTER 14.25ms vs 14.17ms (~1.006x). Suite: 108 tests.
  - Reviewer verified the load-bearing property by calling the raw binding
    directly rather than trusting the report: verify(DUMMY_HASH,'x') costs
    14-19ms of real work; a malformed control THROWS in 0.058ms. Confirmed the
    committed hash's embedded params (argon2id, v=19, m=19456, t=2, p=1, 16-byte
    salt, 32-byte digest) match OPTS exactly.
  - Reviewer confirmed the oracle is closed AT THE ENDPOINT, not merely
    narrowed: findAccountBySlug is an indexed probe differing by ~1us, four
    orders of magnitude under the jitter on a 14ms verify, and the after-fix
    ranges fully overlap. Cost also confirmed password-length independent, so
    the channel cannot be reopened via the password field.
  - unlock() correctly left unchanged, with a STRONGER reason than the report
    gave: validity of a candidate session id is already freely observable, since
    resolveState/routeFor redirect an unknown id to /login and a live one to
    /unlock. The unlock timing channel discloses nothing a cookie probe does not.
  - IMPORTANT #2 was found by the reviewer and was in NOBODY's report: DUMMY_HASH
    hardcoded m/t/p while OPTS independently owned them. A routine OPTS bump
    would leave the dummy branch cheaper and silently reopen a smaller,
    DIRECTIONAL gap. Now pinned by comparing split('$').slice(0,4) across both
    branches — segment 4 is exactly the cost-parameter block.
  - IMPORTANT #1: the implementer honestly reported the malformed-hash gap as
    unclosable without a stopwatch. The reviewer showed it was closable in three
    lines, because @node-rs/argon2's verify THROWS on a malformed encoding. That
    honesty is what let the reviewer aim precisely — a report claiming full
    coverage would have buried it.
  - Re-reviewer confirmed the shape regex ALSO matches a malformed string, so
    the new deterministic assertion is the only check that would catch a bad
    swap — not a duplicate. Costs one real ~14ms verify, called once.

Task 12: RESOLVED BY TASK 13G — user-enumeration timing oracle in
  login(). MEASURED by the implementer: 0.009ms for an unknown slug vs
  14.1-14.2ms for a wrong password, ~1500x, consistent across two runs.
  findAccountBySlug returning nothing short-circuits before any Argon2 work.
  Standard mitigation is to verify against a dummy hash on the unknown-account
  path so both branches cost the same. NOT fixed — it is a design change on the
  auth path. Low practical risk for a handful of known users; cheap to close.
Task 12: C (matcher) RESOLVED AS REAL, not benign: the implementer worked out
  that a 307 preserves the POST method and /login has no POST handler, so a
  cookie-less POST to /api/unlock or /api/logout would 405 rather than landing
  on the login page. Must be addressed alongside the matcher work — carry to
  Task 13/14.

Task 11: CARRY FORWARD TO TASK 12: the middleware matcher covers all api/* except
  api/login, and all of public/. No API routes exist yet, but once /api/unlock
  and /api/logout land (Task 12), a cookie-less call gets a 307 to /login
  (method-preserving) and the client receives login page HTML with status 200
  instead of a 401 — an API caller cannot distinguish success from rejection.
  Task 12 must address this when it creates those routes.
Task 11: CARRY FORWARD TO TASK 13: nothing reserves slugs, so an account named
  'admin' would collide with the /admin route, and 'adminbob' motivated the
  Important above. Task 13 owns /[user] routing and should decide.
Task 11: minor (deferred): routeFor('unlocked', '/login') returns '/', and
  app/page.tsx redirects '/' to '/login'. If Task 12's login page ever calls
  requireState that is an infinite redirect loop. Latent; nothing wires it yet.
Task 11: minor (deferred): getDb's singleton has no reset/close hook, is never
  closed on shutdown, and latches PLATFORM_DB on first read, so a Next dev-server
  HMR reload can open a second handle. Tests work around it with
  vi.resetModules(), which couples future consumers' tests to that idiom.

Task 10: minor (deferred): the report's Proof 1 overstated its evidence — it
  used a column named `key_blob`, which the brief's own not.toContain('key')
  assertion would itself have caught, so it did not prove the original PAIR was
  blind. Reviewer's neutrally-named-column probe does prove it. Conclusion
  stands; the stated evidence was weaker than the claim. Third report-accuracy
  slip on this plan — reviewers keep catching them, which is the system working.
Task 10: minor (deferred): a key written as JSON.stringify(buffer) into a TEXT
  column still escapes the strengthened scan. Exotic vs BLOB/hex/base64.
Task 10: minor (deferred) FOR FINAL REVIEW: "issues unpredictable session ids"
  proves only pairwise distinctness over 50 draws and length >= 32 — a
  zero-padded monotonic counter passes it identically. The actual security
  property rests entirely on randomBytes(32), which no assertion inspects.
  Reviewer independently confirmed the implementer's honest self-report.
Task 10: minor (deferred) FOR FINAL REVIEW: "never stores the password" is a
  plain substring check; any encoded-yet-wrong storage escapes it. It does scan
  every account column, which is the part that matters.

Task 9: minor (deferred) FOR FINAL REVIEW: `alive()` treats NEGATIVE elapsed as
  alive, so a backwards clock step (NTP, manual change) extends a key past both
  lifetimes. Low real-world impact but this is the one module holding a key.
  COUPLING TRAP: the sweep test's rewind trick RELIES on that permissiveness —
  if a later task hardens this, the sweep test keeps passing while silently
  becoming vacuous. Any hardening must redesign test A in the same commit.
Task 9: minor (deferred): getKey returns the stored Buffer by reference and
  nothing zeroes it on removal, so a caller can corrupt the key for later reads,
  and a retained reference keeps key material live after dropKey/sweep — "wiped
  on logout" is true of the map, not of process memory. No consumers exist yet;
  decide zero-on-drop when the first one lands (Task 10 or 12).
Task 9: minor (deferred): sweep() has no scheduler anywhere in the branch, so
  getKey's lazy delete is the only thing reclaiming keys. Flag for whichever
  task owns process startup.
Task 9: minor (deferred): the static scan's regex misses node:fs/promises,
  require('fs'), and process.stdout.write. Inherited from the appendOnly idiom
  it was told to mirror.

Task 8G: DEFERRED FOR FINAL REVIEW / NICO: Gate A's own block message still
  advertises `git commit --no-verify` (.githooks/pre-commit:101) — the same
  defect just fixed in Gate C, and it bypasses all three gates. PRE-EXISTING
  from the Task 2 era, not a 8G regression, and unlike Gates B and C, Gate A has
  no narrow bypass of its own, so --no-verify is genuinely its only escape
  hatch. Fixing properly would mean adding a fourth skip variable, which is
  scope Nico has not approved. Flagged, not fixed.
Task 8G: minor (deferred): test-hooks.sh Gate C group calls gate_check, defined
  inside the Gate A group's else branch — the file's only cross-group helper
  reference. Safe today; refactoring Gate A would break a Gate C case.
Task 8G: minor (deferred): TYPECHECK_CMD is a silent kill switch if exported
  from a shell profile (unlike SKIP_TYPECHECK, which announces). Reviewer
  grepped: nothing in setup.sh or .claude/settings.json sets or exports it, and
  the indirection is brief-mandated for harness speed. Judged acceptable.
Task 8G: minor (deferred): --diff-filter=ACMR means a commit that ONLY deletes a
  .ts file never triggers Gate C, though a deletion can break the build. Also
  the extension match is case-sensitive, so page.TSX on macOS's
  case-insensitive filesystem compiles but skips the gate. Both inherent, not
  introduced here.

Task 7: minor (deferred): regeneratePlatform's zero-arg default target
  (platform/dev/synthetic.db) is never exercised — deliberate, since calling it
  would write into the repo. A regression in REPO resolution or the default
  path would go undetected. Inherited trade-off from the brief, not drift.
Task 7: minor (deferred): regenerateUser joins `name` into a filesystem path
  with no validation (e.g. '../../etc'). Internal dev tooling with no untrusted
  input today; worth a one-line guard if ever exposed more broadly.
Task 7: minor (deferred): seedPlatform assumes its target directory exists (the
  caller does mkdirSync); implicit contract undocumented, so a future direct
  caller hits ENOENT.
Task 7: minor (deferred) METHODOLOGY: the implementer's report claimed
  platform/seed.ts is "117 lines" when the diff shows 24 — a fabricated stat in
  otherwise sound TDD evidence. Shipped code is unaffected. Cheap-tier reports
  need their stats treated as unverified; the reviewer caught it, which is the
  system working. Watch for recurrence on later cheap-tier tasks.
