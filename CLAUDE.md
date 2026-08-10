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
- spec.md + mockup.html in the user's folder are the build contract.
  Build toward the mockup. Feasibility doubts → flag to Nico, don't guess.

## Testing
- Changes to data logic (queries, panels, derived tables) require test
  changes in the same commit. Pure styling/copy changes do not.
- Tests run against a fresh synthetic.db and must pass before deploy.

## Sacred data
- Metrics log and chat transcripts are append-only. Never migrate, rewrite,
  or "clean up" these files.