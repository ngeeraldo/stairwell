# Required-env presence check — design

**Date:** 2026-08-11
**Status:** APPROVED — all four decisions ruled by Nico on 2026-08-12 (§5).
**Covers:** A guard that makes a missing environment variable fail loudly and
early, instead of surfacing as a green deploy over a broken feature.

**Origin:** `docs/superpowers/ledgers/step2.md` items 15 and 16. Two step-2
deploys reported success over an app that did not work — once because a pull
silently brought nothing, once because `ANTHROPIC_API_KEY` was absent. The
second is what this addresses. `deploy/smoke.sh` catches "started but not
serving"; neither of these was visible to it.

**Sequencing:** ruled to land before step 3, so the ntfy topic that step 3
introduces is covered from the day it exists rather than retrofitted
(`docs/superpowers/ledgers/step3.md`).

---

## 1. Scope, as ruled

| In | Out |
|---|---|
| `deploy/required-env` — committed list of variable NAMES, never values | Any sync of a local `.env` to the server |
| A check in `deploy.sh`, after the pull, before `npm ci` | Validity checking — presence only |
| The same guarantee for local development | Secret management tooling of any kind |

The sync exclusion is Nico's, and load-bearing: it would put key material on a
local→server path the privacy model deliberately does not have.

Presence-only is a knowingly accepted limit. An expired or wrong key passes
this check and still fails on the first real request. Closing that gap means a
live API call per deploy — real money and a real session, for a rarer failure
than a missing variable.

---

## 2. Four findings from the codebase that shape the design

### 2.1 The variable that caused the outage is invisible to the codebase

Every `process.env` reference in the repo resolves to one of: `ADMIN_PASSWORD`,
`CHAT_MODEL`, `PLATFORM_DB`, `NEXT_RUNTIME`.

**`ANTHROPIC_API_KEY` does not appear.** The Anthropic SDK reads it internally;
our code never names it. So any attempt to derive the required list by
scanning source would miss precisely the variable whose absence broke the first
live chat turn.

That settles a question worth settling explicitly: the list is hand-maintained,
and `deploy/required-env` must carry a note that variables read by dependencies
belong in it too. This is the strongest argument for the file existing at all —
the information is not recoverable from the code.

### 2.2 The guard hook forbids a `.env` test fixture

`.claude/hooks/deny-sensitive-files.sh:48` denies Read/Edit/Write on `.env` and
`.env.*`. A test cannot create a fixture with either shape, and that denial is
the rule working.

Consequence for the interface, not merely for the tests: the checker takes the
file path as a parameter rather than hardcoding `.env`. A tempfile with an
arbitrary name is then testable, and the production path is supplied by the
caller. A hardcoded path would be untestable without fighting the hook.

### 2.3 "Present" is two different questions with two different homes

- **At deploy time**, before the restart, the only thing that can be inspected
  is the `.env` *file* — the new process does not exist yet. Catching a missing
  name here is what keeps the old version serving.
- **At runtime**, the meaningful question is whether the variable is in
  `process.env` *after* Next has loaded its dotenv files.

These are not interchangeable, and the local case makes that concrete. A
pre-`next dev` npm script cannot see `.env.local`, because Next loads it —
checking there would mean reimplementing Next's dotenv precedence and getting
it subtly wrong.

`instrumentation.ts` already exists, already runs once at server startup, is
already guarded to the nodejs runtime, and is already tested
(`tests/instrumentation.test.ts`). It sees the fully-resolved environment in
both dev and production. It is the natural home for the runtime half, and it
makes the local guarantee free rather than a second mechanism.

### 2.4 The variables are not equally required

| Variable | Missing means | Read by |
|---|---|---|
| `PLATFORM_DB` | Falls back to the synthetic dev database — in production, catastrophic and silent | `lib/db/instance.ts` |
| `ANTHROPIC_API_KEY` | Chat 503s; every other page works | Anthropic SDK, internally |
| `ADMIN_PASSWORD` | A seeding script refuses to run; the server is unaffected | `scripts/create-dev-users.ts` |
| `CHAT_MODEL` | Falls back to `claude-opus-5` — an intended default, not a failure | `lib/chat/client.ts` |

A single severity would be wrong in both directions. Crashing the server on a
missing `ANTHROPIC_API_KEY` would **regress ledger item I5 on purpose**: that
fix exists so a missing key yields a clean 503 and a logged `chat_error` while
the rest of the site keeps working. Conversely, treating a missing
`PLATFORM_DB` as a warning leaves production silently reading a synthetic
database.

So the list needs a severity axis. It has two levels — see D2.

---

## 3. Proposed shape

Three pieces, each independently testable.

**`deploy/required-env`** — the source of truth. One entry per line: a name, a
severity, and a one-line purpose. Comments with `#`. Never a value. Replaces
the variable lists currently duplicated in `docs/local-dev.md` and
`deploy/PROVISION.md`, which will otherwise drift.

**`lib/env/required.ts`** — a pure module with two functions and no I/O policy
of its own:
- `parseRequiredEnv(text: string)` → the parsed entries. Takes text, not a
  path, so it is trivially testable.
- `missingFrom(entries, present: Set<string>)` → the names absent from a
  supplied set. Takes a set, not `process.env`, for the same reason.

Neither function reads a file or touches the environment. That keeps every
policy decision — which file, which environment, what to do about a miss — in
the two callers, where it can differ.

**Caller A, deploy-time** (`deploy/check-env.sh` or equivalent, invoked from
`deploy.sh`): reads the names present in the environment file, compares, and
aborts the deploy listing the missing names. Never prints a value.

**Caller B, runtime** (`instrumentation.ts`): compares the list against
`process.env` at startup. Never throws (D3). On a miss it records a metric and
continues; a healthy boot writes nothing and touches no database (D5).

---

## 4. What this deliberately does not do

- **No validity checking.** Presence only (§1).
- **No value handling anywhere.** Every code path deals in names. A check that
  printed a value to a deploy log would be worse than the bug it prevents.
- **No new dependency.** Parsing `NAME=` lines does not warrant one.
- **No auto-derivation from source.** §2.1 shows it would miss the important case.

---

## 5. Decisions — all four ruled

Ruled by Nico on 2026-08-12.

### D1. The deploy-time check reads the `.env` file

Not systemd's resolved environment. The check validates what gets hand-edited,
and nothing at issue lives in the unit's `Environment=` lines. `deploy/required-env`
documents that unit-supplied variables (`NODE_ENV`, `PORT`) are out of its scope.

### D2. Two severities

| Severity | Deploy | Runtime |
|---|---|---|
| `REQUIRED` | **Blocks.** | Logs. |
| `DEGRADED` | **Warns, loudly.** | Logs. |

`PLATFORM_DB` is `REQUIRED`, and is the reason the tier exists: its absence
falls back to the *synthetic* database, so production would serve loudly-fake
data while every health check stayed green. A false green is worse than a
crash, because nobody goes looking.

`ANTHROPIC_API_KEY` is `DEGRADED` — ledger I5 already makes its absence a clean
503 with a logged `chat_error`, and that designed degradation should carry it.
It is still flagged loudly at deploy time, because "chat is down" is not a
thing to discover from a friend.

### D3. The runtime check never throws

Crash-looping in front of a friend over a config typo is the wrong failure.
`Restart=on-failure` plus `RestartSec=5` would turn a throw into a loop against
a deploy path with no rollback (ledger I3).

**Deploy-time is the hard gate; runtime is the loud witness.** On a miss the
runtime check records a metric and continues, letting the feature's own
degradation path handle the consequence.

### D4. `docs/local-dev.md` points at `deploy/required-env`

One source of truth. No parallel list to drift.

### D5. Consequence of D3, taken under standing policy — flag for veto

D3 says the runtime check records a metric. `metrics` is a database table, so a
naive implementation would open the database inside `instrumentation.ts` — at
boot, on every start, including healthy ones.

That would change documented behaviour. `getDb()` is deliberately lazy today,
and ledger I3 and §2.4 of the step-2 spec both rest on it: a reshape failure
currently surfaces as a per-request 500 *after* boot, which is what lets
`smoke.sh` fail the deploy. Opening the database at boot would move that
failure into startup — and a reshape throw inside `instrumentation.ts` is
exactly the crash loop D3 exists to prevent.

**Resolution: write the metric only when something is missing.** A healthy boot
touches no database and behaves exactly as today; a misconfigured boot writes
one row. The write is wrapped so it cannot propagate — an instrumentation hook
that crashes the server while reporting a config problem would be its own
punchline.

Recorded rather than assumed, because it narrows D3's wording.

## 6. Testing

- `parseRequiredEnv` and `missingFrom` are pure — table-driven tests, no
  fixtures, no environment mutation.
- The deploy-time caller gets a tempfile with a non-`.env` name (§2.2),
  asserting a missing name is reported and a present one is not, and that no
  value ever appears in the output.
- The runtime caller extends `tests/instrumentation.test.ts`, which already
  manipulates `NEXT_RUNTIME` and restores it.
- ~~A change to `deploy.sh` requires a case in `.claude/hooks/test-hooks.sh`
  under the project's own gate rules.~~ **Wrong — corrected 2026-08-12.**
  CLAUDE.md's Gate B scopes are `app/`, `lib/`, `platform/`, `middleware.ts`,
  `modules/`, `users/<name>/`, `.githooks/` and `.claude/hooks/`. None of them
  covers `deploy/`, and `test-hooks.sh` tests the guard hooks, not the deploy
  script. The plan itself noted `deploy/*` is exempt from Gate B, and the
  implementation was right to ignore this line. `deploy.sh` is covered by
  `tests/deploy/service.test.ts` instead. Left struck through rather than
  deleted so a reader who remembers the rule can see it was retracted.

**One test that must exist, from step 2's lesson:** the check must be observed
FAILING against a deliberately missing variable before it is trusted. A guard
that has only ever been seen to pass is a guard nobody has tested — the
`401(k)` regex and the Gate B prompts arm both needed exactly this.
