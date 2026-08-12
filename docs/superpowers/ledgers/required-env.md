# Ledger — required-env presence check

Spec: `docs/superpowers/specs/2026-08-11-required-env-check-design.md`
Plan: `docs/superpowers/plans/2026-08-12-required-env-check.md`
Origin: `docs/superpowers/ledgers/step2.md` items 15 and 16 — two deploys that
reported success over an app that did not work.

Five tasks, four of which needed a fix round, then a whole-branch review that
found **three ways the guard itself could fail open**, each demonstrated by
executing the shipped script. All three are closed and re-verified. What
follows is what survived.

---

## Residual risks

1. **THE ENV-FILE MODEL IS A UNION OF LINES; THE REAL ENVIRONMENT IS
   LAST-WINS.** `deploy/check-env.sh` asks whether a name appears on *some*
   line, never *which line won*. systemd's `EnvironmentFile` and dotenv both
   take the last assignment, so:

   ```
   A=x
   A=
   ```

   exits 0 — the guard says present — while the process actually receives
   `A=''`. `lib/env/report.ts` counts an empty value as missing, and
   `lib/db/instance.ts` uses `??` rather than `||`, so an empty `PLATFORM_DB`
   is **not** the documented synthetic fallback: the empty string is passed
   straight to `openPlatformDb`.

   This is the one residual that can still ship a broken app behind a green
   guard, and it is reachable by exactly the workflow the docs prescribe —
   appending `KEY=value` below an existing key. Two neighbouring shapes behave
   the same way: a whitespace-only value, and (probably — untested from here)
   `A=""`, since systemd strips surrounding quotes.

   **Fix when taken:** derive presence from the LAST matching assignment
   rather than from any matching line.

   **CLOSED.** `deploy/check-env.sh` now reduces each assignment to a flag
   and a name in file order (`1 NAME` yields a value, `0 NAME` yields the
   empty string) and judges only the LAST line mentioning the name. All
   three empty-yielding shapes are covered: `NAME=`, whitespace-only, and
   `NAME=""` / `NAME=''` — the quoted pair is no longer "probably", because
   residual 6 established that systemd does strip surrounding quotes. Value
   text is discarded inside sed and never reaches a shell variable, so
   NAMES-ONLY is unchanged. Reproduced failing first (the duplicate-key file
   above exited 0), then passing. Agreement rows added for both duplicate-key
   orders, whitespace-only, quoted-empty, and a quoted single space (present,
   not missing) — with the `env` column declaring last-wins semantics, which
   is the belief the row exists to pin.

2. **SEVERITY IS VALIDATED ONLY ON THE MISSING PATH.** The presence `continue`
   in `deploy/check-env.sh` runs before the severity `case`, so a malformed
   severity on a variable that happens to be *present* is never noticed.
   Fail-closed — it becomes an exit 2 the moment that variable goes absent —
   so this delays diagnosis rather than shipping a broken app. The matching
   hole is in the agreement table: every `tsThrows` case pairs the malformed
   line with an absent variable, so the divergence sits in the one untested
   cell. One-line fix (move the `continue` below the `case`) plus one table
   row.

   Note for the record: the fix-wave report claims severity is now validated
   for every line "whether or not the variable turns out to be present". That
   is backwards — the ordering is unchanged from the pre-fix script. Recorded
   here because a wrong claim about a guard's coverage is the class of thing
   this branch exists to stop trusting.

   **STILL OPEN, now PINNED.** The residual-1 and -3 fix left the ordering
   alone — the presence `continue` still runs before the severity `case` —
   but the untested cell is no longer untested: the agreement table has a row
   `a typo'd severity on a PRESENT variable` asserting bash exit 0 against a
   TypeScript throw. It records today's behaviour rather than endorsing it,
   so moving the `continue` below the `case` turns that row red and the
   change is visible instead of silent.

3. **AN EMPTY OR COMMENTS-ONLY LIST EXITS 0.** A truncated or accidentally
   blanked `deploy/required-env` disables the gate entirely and reports
   success. Both halves agree, so the agreement table structurally cannot
   catch it. "The checklist is empty" and "nothing is missing" are the same
   green.

   **CLOSED.** `deploy/check-env.sh` counts the entries the loop accepted and
   exits 2 — the broken-list code, alongside a malformed line and an
   unreadable list — when there are none, printing only the list's path.
   `deploy.sh` already branches on 2 and aborts, so this is fail-closed; its
   operator message now reads "unreadable, empty, or malformed". The
   agreement table gained an empty-list row and a comments-and-blank-lines
   row, both recording a DESIGNED divergence: bash is the gate and exits 2,
   while `lib/env/report.ts` is the runtime witness, has no list to diff
   against, and must never throw.

4. **`-qxF`'s `-F` IS NO LONGER INDEPENDENTLY OBSERVABLE.** The identifier
   check rejects a regex metacharacter in a name before the grep is reached,
   so `-F` is unreachable-by-CLI defence in depth. Kept deliberately with a
   comment. If someone deleted the identifier check, `-F` would still save the
   behaviour but no test would notice the deletion.

5. **THE COMMENT-STRIPPING IN `tests/deploy/service.test.ts` IS LINE-ANCHORED,
   NOT A BASH TOKENIZER.** An inline trailing comment (`cmd # note`) or a `#`
   inside a quoted string would survive into the "commands" view used for the
   ordering assertions. Verified not live: every `#` in `deploy/deploy.sh`
   today is on a wholly-comment line. Relevant if that file ever grows an
   inline comment near the pull / check / install sequence.

6. **THE `EnvironmentFile` QUOTING ADVICE IS RIGHT FOR THE WRONG REASON.**
   `deploy/check-env.sh` and `deploy/PROVISION.md` both tell the operator that
   systemd "parses the file literally" so quotes end up inside the value.
   systemd does in fact strip surrounding quotes. The advice — write
   `KEY=value` with no quotes and no `export` — is still correct, and the
   `export` half of the reasoning is accurate. The quoting half is not, and it
   is why residual 1's quoted variants are only probable rather than
   confirmed.

   **CLOSED as wording.** Both texts were corrected while fixing residual 1,
   which depends on the true behaviour: quotes are stripped, so `KEY=""` is
   the empty string and the checker counts it MISSING. The advice — bare
   `KEY=value`, no `export`, no quotes — is unchanged, now with the reason
   that actually holds. `deploy/PROVISION.md` also gained the last-wins
   warning about appending a key that is already in the file, which is the
   workflow residual 1 was reachable through.

7. **`docs/local-dev.md` NAMES `PLATFORM_DB` IN TWO PLACES** with nothing
   pinning it. A small drift channel against the one-source-of-truth rule (a
   name is not a list, so this was accepted) — if the name or its severity
   changes, those sentences go stale silently.

8. **A DIRECTORY PASSED AS THE LIST EXITS 0.** `[ -r "$list" ]` is true for a
   directory; the subsequent read fails, the loop never runs, and the script
   reports success. Same shape as residual 3 — could-not-read produces green.
   Implausible trigger; pre-existing.

---

## Decisions worth not relitigating

- **The bash/TypeScript duplication stays.** The deploy check runs before
  `npm ci`, so it cannot assume `node_modules` exists; on a fresh clone it does
  not. The mitigation is the agreement table in
  `tests/deploy/checkEnv.test.ts`, which now feeds both halves a matrix of
  malformed shapes and asserts the pair (bash exit code, TypeScript
  throws/missing-names). It constrains list-shape divergences. Its `env`
  column is still a hand-declared belief about what systemd yields rather than
  something derived — that is unchanged and unfixable from here — but the
  belief is now written down for the shapes that matter: duplicate keys in
  both orders, whitespace-only, quoted-empty, and a quoted single space. A
  wrong belief in that column is now a visible claim in a row rather than an
  unstated assumption, which is what closing residual 1 turned on.

- **The runtime check never throws** (spec D3), and a healthy boot touches no
  database (D5). A throw in `instrumentation.ts` meets systemd's
  `Restart=on-failure` as a crash loop against a deploy path with no rollback.

- **`PLATFORM_DB` is set explicitly in local development**
  (`platform/dev/synthetic.db`, the same path the code already falls back to)
  rather than being exempted from the check. Chosen during review over
  weakening the check: a `REQUIRED` warning on every healthy local start is how
  a guard trains people to ignore it, and this variable is `REQUIRED` precisely
  because its absence causes a *silent* fallback — so local dev leaning on that
  same silence was the one place to be explicit.

- **The script targets bash 3.2**, macOS's default. No arrays anywhere:
  `"${arr[@]}"` on an empty array is fatal under `set -u` before bash 4.4,
  which would have crashed the guard on the empty-list path on every
  developer's laptop while working fine on the droplet.

- **Existing `env_missing` rows in `platform/dev/synthetic.db` were left in
  place.** `metrics` is append-only by rule; rows recording what actually
  happened are what the table is for. The fix stops the growth rather than
  cleaning up after it.
