# Step 1a — Auth, Test Layout, Test Gate

**Date:** 2026-08-10
**Status:** Approved, pre-implementation
**Covers:** The application half of build-order step 1 from
`architecture-overview.md`, plus the test directory layout and the pre-commit
test-coverage gate.

**Paired with:** `2026-08-10-step1-infra-and-deploy-design.md`, which takes this
work from a localhost checkpoint to a live one at `app.stairwell.run`. That spec
owns the droplet, TLS, DNS, and the deploy path. Nothing here depends on it.

**Checkpoint:** on localhost, Nico logs in as two dev users; each is 404-blind to
the other's space; the admin portal loads, empty. Re-verification of this same
checkpoint against the live URL is the infra spec's exit condition.

Decisions in `architecture-overview.md` and `CLAUDE.md` are settled and are not
relitigated here. This document records only what step 1a adds.

---

## 1. Decisions made during this design

| Question | Decision |
|---|---|
| Session model | Two-tier: session persists, derived key does not |
| Key lifetime | Idle TTL 4h, absolute ceiling 12h, wiped on logout |
| Test runner | Vitest everywhere; `seed.py` covered by asserting on the DB it produces |
| Gate A trigger | Schema-triggered only (a lone generator edit passes) |
| Gate B skip | `SKIP_TEST_GATE=1`, which names the untested files on stderr |

Hostname, edge/TLS, and VPS decisions live in the infra spec.

### 1.1 Build sequence

**The gate extensions are built and harness-verified before any auth code is
written.** §4 lands first — both gates, all ~45 harness cases green — and only
then does §2 and §3's application code begin.

This is not merely tidy ordering. It makes the auth work the first real traffic
through Gate B: every commit of `lib/`, `app/`, and `middleware.ts` has to
satisfy the scope rules that were just written, on real changes rather than on
synthetic path lists. A gate that is wrong in practice reveals itself
immediately, while the only thing depending on it is a step whose tests are
being written anyway — rather than months later, when working around it is
cheaper than fixing it.

The test *layout* (§3) is a prerequisite of the gate, not a consumer of it: Gate
B's scope table names `tests/`, `modules/tests/`, and `users/<name>/tests/`, so
those directories and the Vitest config exist before the gate that points at
them. Directory scaffolding and config are Gate B-exempt, so this ordering does
not deadlock.

---

## 2. Auth and session

### 2.1 Platform data

Step 1a introduces a platform database, distinct from the per-user encrypted DBs
described in `architecture-overview.md` §4. It holds accounts, sessions,
transcripts, metrics, and the request queue — the records Nico is already
promised access to at onboarding. It is not encrypted with any user's key.

- Production: `platform.db` on the server. Denied locally by the guard hook,
  which is correct.
- Development: `platform/dev/synthetic.db`. The basename is deliberate — the
  guard hook in `.claude/hooks/deny-sensitive-files.sh` matches on basename, and
  `synthetic.db` is the only allowed name.

Step 1a only *writes* accounts and sessions. The `transcripts` and `metrics`
tables are defined now — with their append-only triggers (§2.6) — but stay empty
until steps 2 and 7 populate them. Defining them now costs nothing and means the
append-only guarantee is in place before the first row ever exists, rather than
being retrofitted onto data that is already sacred.

### 2.2 The password does two jobs

The two derivations must not be computable from each other:

- `auth_hash = Argon2id(password, salt_auth)` — stored, verifies login
- `db_key = Argon2id(password, salt_key)` — **never stored**, SQLCipher key

Both salts persist in the accounts row; only the verifier does. Reading the
entire platform database gets an attacker no closer to any user's data.

### 2.3 Two-tier state

| State | Cookie | Key in memory | Reachable |
|---|---|---|---|
| Anonymous | none | — | `/login` |
| Authenticated | valid session id | absent | `/unlock`, chat, transcript |
| Unlocked | valid session id | present | everything |

Sessions persist in the platform DB as an opaque id, delivered in an
httpOnly / Secure / SameSite=Lax cookie. The derived key lives only in a
process-memory map and dies with the process.

The consequence is intentional: a deploy leaves users logged in but locked, so
the chat surface keeps working across the live-build-and-deploy tweak loop
(`architecture-overview.md` §6), while data panels require a fresh password
entry.

### 2.4 Key map lifetime

`Map<sessionId, { key, lastSeenAt }>`, with:

- **Idle TTL: 4 hours**, refreshed on activity.
- **Absolute ceiling: 12 hours** from unlock, not refreshable. An active
  late-night session still cannot carry a key into the next morning.
- **Explicit logout** wipes the map entry and deletes the session row.
- Expiry is enforced on access and by a sweep interval, so an idle process does
  not retain keys.

The ceiling matters beyond hygiene: step 6 makes login the trigger for Plaid
sync. A key surviving overnight would silently turn "morning open → sync" into
"morning open → stale data."

Tested with fake timers: expiry at idle TTL, refresh-on-activity, the absolute
ceiling overriding refresh, and logout wiping immediately.

### 2.5 Routing and authorization

- `accounts.role ∈ ('user', 'admin')`. The admin account is distinct from the
  two dev users, which is what makes the checkpoint verifiable.
- `/[user]/…` returns **404, not 403**, when the session does not own the slug.
  One dev user cannot confirm the other exists.
- `/admin` requires `role = 'admin'` and is read-only.
- The per-user space is empty at this step, and `/unlock` derives a key against
  nothing. This is deliberate: the state machine and its tests exist now, so
  step 6 fills in the SQLCipher open rather than reworking every request path.

### 2.6 Append-only enforcement

Transcripts and metrics are sacred data (`CLAUDE.md` > Sacred data). Enforcement
is in the database, not in convention:

- `platform/schema.sql` defines `BEFORE UPDATE` and `BEFORE DELETE` triggers on
  `transcripts` and `metrics` that `RAISE(ABORT, 'append-only')`.
- A platform test attempts an UPDATE and a DELETE against each table and asserts
  both abort.
- A second test scans `lib/db/**` for `UPDATE` or `DELETE FROM` statements
  targeting those tables and fails if any appear.

The data layer exposes only append and read functions for these tables.

---

## 3. Repository and test layout

```
app/                    Next.js App Router
  (auth)/login, /unlock
  [user]/…              per-user dashboards (bespoke code)
  admin/                Nico-only, read-only
  api/
lib/                    platform code: auth/, session/, db/, users/
middleware.ts
platform/
  schema.sql            accounts, sessions, transcripts, metrics, requests
  seed.ts               dev seeding
  dev/synthetic.db      gitignored
modules/                shared schema modules — plaid.sql first
  tests/
users/<name>/           spec.md, mockup.html, schema.sql, seed.py, synthetic.db
  tests/                scoped to that dashboard
tests/                  platform tests (auth, session, routing, admin)
  support/
deploy/                 created by the infra spec, exempt from Gate B
```

`modules/` is the home for the shared schema module library named in
`architecture-overview.md` §4. Its internals are never forked per user;
user-specific needs are met with views or derived tables in the user's own
schema.

### 3.1 Vitest configuration

One config, `*.test.ts` naming, include globs covering `tests/**`,
`modules/tests/**`, and `users/*/tests/**`. Scoped runs are a path argument:

```
vitest run                 # everything
vitest run users/nico      # one user's suite
vitest run tests           # platform only
```

Path-argument scoping is what the deferred per-user runner in
`.githooks/pre-commit` will eventually call. That runner stays deferred — it is
still blocked on populated `tests/` directories, exactly as its TODO says.

### 3.2 Synthetic regeneration must not cross

`tests/support/synthetic.ts` exposes two functions, each with an explicit target
path and **no ambient default**:

- `regeneratePlatform()` — runs `platform/seed.ts` → `platform/dev/synthetic.db`
- `regenerateUser(name)` — runs `users/<name>/seed.py` → `users/<name>/synthetic.db`

Per-user suites regenerate in global setup, so "tests run against a fresh
synthetic.db" is mechanical rather than remembered.

A test asserts non-crossing in both directions: regenerating one target leaves
the other's file byte-identical.

---

## 4. Pre-commit gate

Two independent gates in `.githooks/pre-commit`, sharing one staged-path list
(`git diff --cached --name-only --diff-filter=ACMR`). Both are exposed as
sourceable functions under `SCHEMA_GATE_SOURCE_ONLY=1` so the harness can test
them against synthetic path lists with no real commits, matching the existing
pattern.

The hook's fast path becomes: if no staged path is guarded by either gate, exit
0. Still one `git` call.

### 4.1 Gate A — anti-drift

The existing rule, generalized from a hardcoded `users/*` case to a pattern
table:

| Staged schema | Satisfied by, in the same commit |
|---|---|
| `users/<name>/schema.sql` | `users/<name>/seed.py` or `users/<name>/tests/**` |
| `platform/schema.sql` | `platform/seed.ts` or `tests/**` |

Scope matching is strict in both directions. `users/alice` is not satisfied by
`users/bob`; `platform` is not satisfied by either, and neither is satisfied by
`platform`.

All 11 existing gate verdicts are preserved, including
`root schema.sql → PASS` — the rule targets `users/*/schema.sql` and now
`platform/schema.sql`, never a bare `schema.sql`.

**Trigger scope:** only a staged `schema.sql` triggers Gate A. A lone `seed.py`
or `seed.ts` edit passes both gates. This matches the rule as it works today and
was chosen deliberately over full triad symmetry, which would demand a generator
change on test-only commits.

### 4.2 Gate B — test coverage

Every staged path classifies as EXEMPT, TEST, or GUARDED. A guarded scope with
no staged test **in its own scope** blocks the commit.

| Guarded scope | Paths | Satisfied by |
|---|---|---|
| `platform` | `app/**`, `lib/**`, `platform/**`, `middleware.ts` | `tests/**` |
| `modules` | `modules/**` (excluding `modules/tests/**`) | `modules/tests/**` |
| `user:<name>` | `users/<name>/**` (excluding `users/<name>/tests/**`) | `users/<name>/tests/**` |
| `guards` | `.githooks/**`, `.claude/hooks/**` | `.claude/hooks/test-hooks.sh` |

Exempt, checked before scope classification:

- Docs: `*.md`, `docs/**`, `LICENSE`
- Styling and assets: `*.css`, `*.scss`, `*.svg`, `public/**`, `mockup.html`
- Config: `*.json`, `*.yml`, `*.yaml`, `*.toml`, `next.config.*`,
  `vitest.config.*`, `tsconfig*`, `Caddyfile`, `.gitignore`, `deploy/**`,
  `setup.sh`

The `guards` scope makes an existing CLAUDE.md rule mechanical: touching a hook
without touching the harness stops being something that has to be caught by eye.

### 4.3 Gate separation

Gate B's `platform` scope would otherwise swallow `platform/schema.sql` and
`platform/seed.ts` and force `tests/**`, killing Gate A's `seed.ts` branch — and
the same logic on `users/*/seed.py` would break the currently-passing
`schema + same-user seed.py → PASS`.

Therefore: **`*/schema.sql`, `platform/seed.ts`, and `users/*/seed.py` are
exempt from Gate B and governed by Gate A alone.** The gates do not overlap, and
every existing verdict is preserved.

### 4.4 Escape hatch

`SKIP_TEST_GATE=1 git commit` disables Gate B only. `--no-verify` remains the
blunt instrument but drops Gate A as well, which is the wrong trade for a
styling-only `.tsx` edit that Gate B classifies as guarded.

**A skip is never silent.** When `SKIP_TEST_GATE=1` suppresses a block, the hook
prints to stderr the guarded files that went untested, grouped by scope, so
every skip is a conscious glance rather than a bypass that scrolls past:

```
Gate B SKIPPED (SKIP_TEST_GATE=1) — these guarded files ship untested:
  platform:  app/(auth)/login/page.tsx
             lib/session/cookie.ts
  user:nico: users/nico/app/panels/spend.tsx
```

The message is printed only when the gate *would have blocked*. A commit that
sets the variable but stages nothing guarded prints nothing, so the variable
being exported in a shell profile cannot produce noise that trains the eye to
ignore it.

`CLAUDE.md` gains a matching rule: when Claude uses the skip, it states the
reason in the commit message.

Path-based classification cannot tell a styling-only `.tsx` change from a logic
change. That is an accepted limitation; the announced escape hatch is the answer.

### 4.5 Harness growth

`.claude/hooks/test-hooks.sh` grows its gate group from 11 cases to roughly 45.

New Gate A cases (8):

| Staged | Expected |
|---|---|
| `platform/schema.sql` | BLOCK |
| `platform/schema.sql` + `platform/seed.ts` | PASS |
| `platform/schema.sql` + `tests/auth.test.ts` | PASS |
| `platform/schema.sql` + `users/alice/tests/x.test.ts` | BLOCK |
| `platform/schema.sql` + `platform/notes.md` | BLOCK |
| `platform/schema.sql` + `users/alice/schema.sql` + `users/alice/seed.py` | BLOCK |
| both scopes, both satisfied | PASS |
| `modules/plaid.sql` (not a `schema.sql`) | PASS |

New Gate B cases (~26), covering: each guarded scope unsatisfied and satisfied;
both wrong-scope directions for `user:*` and for `modules` vs `platform`; each
exempt family (docs, styling, config); a test file alone; the empty list;
`seed.py` alone passing Gate B; a mixed commit where only one scope is
satisfied; `.githooks/pre-commit` alone versus paired with the harness;
`SKIP_TEST_GATE=1` turning a block into a pass; the skip message naming every
untested guarded file and its scope; and the skip printing nothing when nothing
guarded is staged.

The existing guard-hook cases in the harness are unchanged.

---

## 5. Documentation updates in the same work

**`CLAUDE.md` > Data safety** gains, verbatim:

> Derived keys exist only in the in-process TTL map — never serialized,
> persisted, logged, or written to the sessions table. Passwords and keys never
> appear in cookies, localStorage, URLs, or any persisted artifact.

**`CLAUDE.md` > Testing** gains the Gate B scopes, the Vitest commands, and the
skip rule: `SKIP_TEST_GATE=1` is available for changes Gate B misclassifies, and
when Claude uses it, the commit message states why.

**`architecture-overview.md`** records the step 1a decisions from §1 — the
two-tier session model and the platform database — so the overview stays the
single source of settled decisions.

---

## 6. Out of scope

Deferred, and not to be built here:

- Everything in the infra spec: droplet, Caddy, TLS, DNS, `deploy/`. This work
  ends at a localhost checkpoint.
- The chat window and LLM chatbot (step 2)
- ntfy.sh alerts (step 3)
- The interview → spec flow (step 4)
- Any per-user dashboard code or panels (step 5)
- Plaid, SQLCipher, and the login-triggered sync (step 6) — this step builds the
  lock state machine, not the encrypted database
- The privacy toggle, metrics off-VPS backup (step 7)
- The scoped per-user test runner inside the pre-commit hook — still blocked on
  populated `tests/` directories, as its existing TODO states
