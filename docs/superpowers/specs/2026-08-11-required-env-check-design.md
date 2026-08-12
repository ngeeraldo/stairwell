# Required-env presence check — design

**Date:** 2026-08-11
**Status:** DRAFT — four decisions queued for Nico (§5). Not approved, not
planned, no implementation.
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

So the list needs a severity axis. What the axis should be is queued (§5).

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
`process.env` at startup. Behaviour on a miss depends on severity — queued.

---

## 4. What this deliberately does not do

- **No validity checking.** Presence only (§1).
- **No value handling anywhere.** Every code path deals in names. A check that
  printed a value to a deploy log would be worse than the bug it prevents.
- **No new dependency.** Parsing `NAME=` lines does not warrant one.
- **No auto-derivation from source.** §2.1 shows it would miss the important case.

---

## 5. QUEUED FOR NICO — four decisions

Standing policy: CONFIRM-tier taken and logged; DECISION-tier and anything
touching the deploy contract's shape queued. All four below are the latter.

### Q1. What does the deploy-time check read?

The systemd unit supplies `NODE_ENV` and `PORT` via `Environment=` lines and
the rest via `EnvironmentFile=/home/deploy/stairwell/.env`. So:

- **(a) The `.env` file only.** Simple, no privilege needed. Blind to anything
  set by the unit — if a unit-supplied variable ever joined the list it would
  be reported missing when it is fine.
- **(b) systemd's resolved environment** (`systemctl show stairwell -p Environment`
  plus the file). Accurate about what the service will actually receive. More
  moving parts, and needs the unit to be installed — which it is.

**Recommendation: (a), with the list documenting that unit-supplied variables
are out of its scope.** Every variable at issue today lives in the file, and
(b) buys accuracy about a case that has not occurred. But this is exactly the
"deploy contract's shape" question, so it is yours.

### Q2. What is the severity taxonomy, and what does each level do?

Proposal: two levels.
- **`required`** — the deploy aborts, and the runtime check throws at startup.
  For variables whose absence makes the app wrong rather than degraded
  (`PLATFORM_DB` in production).
- **`feature`** — the deploy aborts, but the runtime check only logs. The
  feature's own error path handles it. `ANTHROPIC_API_KEY` is the case: I5
  deliberately makes it a clean 503, and a startup throw would undo that.

The asymmetry is intentional — a deploy is a moment when a human is watching
and nothing is lost by stopping; a running server is not.

### Q3. Should the runtime check ever throw at all?

A throw in `instrumentation.ts` fails startup, and `Restart=on-failure` with
`RestartSec=5` turns that into a crash loop. The deploy would catch it —
`smoke.sh` would fail — but the site is down while it does, and there is no
rollback (ledger I3).

The alternative is log-and-continue at every severity, leaving the deploy-time
check as the only hard gate. Safer; loses the guarantee for anything that
bypasses `deploy.sh`, such as a manual `systemctl restart` after hand-editing
`.env` — which is exactly what happened when the key was added.

**No recommendation. This is the trade-off you should pick**, because it is a
judgement about how the pilot should fail in front of a friend, not a technical
one.

### Q4. Does `docs/local-dev.md` keep its own variable list?

The duplication is the drift risk that motivates a single source of truth. But
`deploy/required-env` is terse by design, and `local-dev.md` explains *how* to
set things for a human reading it for the first time. Replace the list with a
pointer, or keep both and accept the drift?

---

## 6. Testing

- `parseRequiredEnv` and `missingFrom` are pure — table-driven tests, no
  fixtures, no environment mutation.
- The deploy-time caller gets a tempfile with a non-`.env` name (§2.2),
  asserting a missing name is reported and a present one is not, and that no
  value ever appears in the output.
- The runtime caller extends `tests/instrumentation.test.ts`, which already
  manipulates `NEXT_RUNTIME` and restores it.
- A change to `deploy.sh` requires a case in `.claude/hooks/test-hooks.sh`
  under the project's own gate rules, and `test-hooks.sh` must be run and its
  output reported.

**One test that must exist, from step 2's lesson:** the check must be observed
FAILING against a deliberately missing variable before it is trusted. A guard
that has only ever been seen to pass is a guard nobody has tested — the
`401(k)` regex and the Gate B prompts arm both needed exactly this.
