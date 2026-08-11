# Personal Dashboard Pilot

Full rationale and build order: architecture-overview.md (read it before
architectural changes; do not relitigate decided items).

## Stack (decided — do not relitigate)
- Next.js App Router, full-stack, single service. No separate backend.
- Per-user encrypted SQLite via better-sqlite3-multiple-ciphers (SQLCipher).
- Plaid official Node SDK. Python = standalone dev scripts only, never a server.

## Data safety (hard rules)
- All dev and testing runs on synthetic data ONLY. Never open, read, or
  query any *.db other than synthetic.db.
- synthetic.db is regenerated from seed.py at session start — never edit it directly.
- All synthetic merchants/values are loudly fake ("COFFEE PALACE TEST").
- Never log, commit, or write real user data, Plaid tokens, or secrets to
  code, fixtures, tests, or debug output.
- Derived keys exist only in the in-process TTL map — never serialized,
  persisted, logged, or written to the sessions table. Passwords and keys
  never appear in cookies, localStorage, URLs, or any persisted artifact.
- Real DBs exist only on the server. If a non-synthetic .db appears locally,
  stop and flag it. ONE known exception: fake-real.db in the repo root is a
  deliberate decoy holding no data, used to test the guard hook. Do not flag
  it, and do not open it — it stays denied like any other non-synthetic .db.
- The guard is .claude/hooks/deny-sensitive-files.sh, a PreToolUse hook that
  denies Read/Edit/Write on any database file (*.db, *.sqlite, *.sqlite3 and
  their -wal/-shm/-journal sidecars) that is not synthetic.db, and on .env
  files. A denial is the rule working, not a bug to route around.
- After any plugin update or hook change, run .claude/hooks/test-hooks.sh
  and confirm all pass.
- On any fresh clone of this repo, run ./setup.sh before doing anything else.

## Schema & module rules
- schema.sql + seed.py + tests/ update in the SAME commit. No drift.
- Shared module internals (e.g. plaid.sql) are NEVER forked per user.
  User-specific needs = views/derived tables in the user's own schema.
- Shared-module changes happen from repo root only, never inside /users/<name>/.

## Build contract
- spec.md + mockup.html in the user's folder are the build contract for
  **user dashboards** (`users/<name>/`, `app/[user]/`).
  Build toward the mockup. Feasibility doubts → flag to Nico, don't guess.
- **Platform auth pages** (`app/(auth)/login`, `app/(auth)/unlock`, `app/admin`)
  are NOT covered by any mockup.html. Their contract is the step-1a design doc,
  docs/superpowers/specs/2026-08-10-step1-auth-and-test-gate-design.md (§3 owns
  this layout). Absence of a mockup is not a reason to leave an auth-page gap
  unfixed — check the design doc instead.
- Deploys go out through deploy/deploy.sh only — never by editing files on
  the droplet. Tests gate the restart.
- The app runs behind a reverse proxy, so `request.url` is NOT the URL the
  browser asked for. Redirects use lib/http/redirect.ts: host-relative in route
  handlers, absolute in middleware (Next rejects a relative Location there).
  Never reintroduce `new URL(path, request.url)` — it names the internal origin
  and every local check passes anyway.

## Testing
- Changes to data logic (queries, panels, derived tables) require test
  changes in the same commit. Pure styling/copy changes do not.
- Tests run against a fresh synthetic.db and must pass before deploy.
- Run tests with `npx vitest run`. Scope a run with a path:
  `npx vitest run users/nico`, `npx vitest run tests`.
- The pre-commit gate enforces the first rule by scope:
  - `app/`, `lib/`, `platform/`, `middleware.ts` → a test under `tests/`
  - `modules/` → a test under `modules/tests/`
  - `users/<name>/` → a test under `users/<name>/tests/`
  - `.githooks/`, `.claude/hooks/` → `.claude/hooks/test-hooks.sh`
- Docs, styling, and config are exempt by path. `schema.sql` and the seed
  generators are governed by the anti-drift rule instead.
- `SKIP_TEST_GATE=1 git commit` skips the coverage gate only, and prints the
  untested files. When Claude uses the skip, it states the reason in the
  commit message.
- A commit staging any `.ts`/`.tsx` file also runs a typecheck gate
  (`npx tsc --noEmit`) and blocks on a compiler error, printing the
  compiler's own message. vitest transpiles through esbuild and does not
  catch type errors, so this gate is the only thing that actually runs the
  compiler. It checks the working tree, not the staged content, so a
  partially-staged file is typechecked against unstaged edits too — a known,
  accepted limitation. `SKIP_TYPECHECK=1 git commit` skips it only, and only
  announces the skip when a TypeScript file was actually staged. When Claude
  uses the skip, it states the reason in the commit message.
- A pre-push gate runs `npx vitest run` (Gate E) and then `npx next build`
  (Gate D) on every push, unconditionally — a break in either can originate
  anywhere (a config edit, a dependency bump, an innocent-looking import), so
  there is no fast path. `tsc --noEmit` clean does not mean the build
  succeeds: a middleware.ts import that pulled in `node:crypto` via
  lib/session/store.ts broke `next build` for two full tasks while the suite
  stayed green and Gate C stayed clean — Gate D exists because "tsc clean"
  does not mean "builds". Gate B (pre-commit) only checks that a guarded
  change staged some file under `tests/`, not that the suite passes — Gate E
  exists because "a test file is staged" does not mean "the tests pass".
  Gate E runs first (fail fast on the cheap check before paying for the
  ~1-minute build). `SKIP_TEST_RUN_GATE=1 git push` skips Gate E only,
  `SKIP_BUILD_GATE=1 git push` skips Gate D only, each only announcing the
  skip when it actually would have blocked. When Claude uses either skip, it
  states the reason in the commit message.

## Local dev
- Running the app, the dev account credentials, and how to reset the local
  database: docs/local-dev.md. The admin password is never recorded in the
  repo — it comes from ADMIN_PASSWORD at seed time.

## Ledgers
- Before working on a file, check docs/superpowers/ledgers/ for residual risks
  touching it. Rulings made during fix rounds become tasks, not log entries.

## Sacred data
- Metrics log and chat transcripts are append-only. Never migrate, rewrite,
  or "clean up" these files.