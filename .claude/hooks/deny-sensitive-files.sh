#!/usr/bin/env bash
# PreToolUse guard for Read/Edit/Write.
# Enforces the CLAUDE.md "Data safety (hard rules)" section:
#   - synthetic.db is the ONLY database that may be touched locally
#   - .env files hold Plaid tokens / secrets and are off limits
# Fails closed on a matched path: prints a deny decision and exits 0.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -z "$path" ] && exit 0

base=${path##*/}
lower=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')

# SQLite writes sidecars next to the database: foo.db-wal, foo.db-shm,
# foo.db-journal. They hold the same rows as the database itself, so strip the
# sidecar suffix and judge the underlying database name.
stem=$lower
case "$stem" in
  *-wal|*-shm|*-journal) stem=${stem%-*} ;;
esac

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

case "$stem" in
  synthetic.db|synthetic.sqlite|synthetic.sqlite3)
    ;;
  *.db|*.sqlite|*.sqlite3)
    deny "Blocked by CLAUDE.md > Data safety (hard rules): \"All dev and testing runs on synthetic data ONLY. Never open, read, or query any *.db other than synthetic.db.\"

$path is not synthetic.db (or one of its sidecars), so Read/Edit/Write on it is denied.

Also from that section: \"Real DBs exist only on the server. If a non-synthetic .db appears locally, stop and flag it.\" Flag this file to Nico instead of opening it."
    ;;
esac

case "$lower" in
  .env|.env.*)
    deny "Blocked by CLAUDE.md > Data safety (hard rules): \"Never log, commit, or write real user data, Plaid tokens, or secrets to code, fixtures, tests, or debug output.\"

$path is an environment file holding secrets (Plaid tokens, keys), so Read/Edit/Write on it is denied. Ask Nico for the specific value you need rather than reading the file."
    ;;
esac

exit 0
