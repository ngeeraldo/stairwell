#!/usr/bin/env bash
# Regression harness for deny-sensitive-files.sh.
#
# Pipes every known payload shape into the guard hook and checks the decision.
# No live tool calls — stdin/stdout only, so this is safe to run any time.
# Exits nonzero if any case regresses.
#
# Run after any plugin update or hook change (see CLAUDE.md > Data safety).
set -uo pipefail

HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOOK="$HOOK_DIR/deny-sensitive-files.sh"

if [ ! -x "$HOOK" ]; then
  echo "FATAL: $HOOK is missing or not executable" >&2
  exit 2
fi

pass=0
fail=0
failed_cases=()

# decide <payload> -> prints DENY / ALLOW / ERROR
decide() {
  local payload=$1 out rc
  out=$(printf '%s' "$payload" | "$HOOK" 2>/dev/null)
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "ERROR"
    return
  fi
  if [ -z "$out" ]; then
    echo "ALLOW"
    return
  fi
  # A deny must be well-formed AND carry a non-empty reason citing CLAUDE.md,
  # otherwise the block is useless to whoever hits it.
  local decision reason
  decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "MALFORMED"' 2>/dev/null) || decision="MALFORMED"
  reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null) || reason=""
  if [ "$decision" != "deny" ]; then
    echo "MALFORMED"
  elif [ -z "$reason" ] || ! printf '%s' "$reason" | grep -q 'CLAUDE.md'; then
    echo "NO-REASON"
  else
    echo "DENY"
  fi
}

# check <expected> <label> <payload>
check() {
  local expected=$1 label=$2 payload=$3 actual
  actual=$(decide "$payload")
  if [ "$actual" = "$expected" ]; then
    printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
    fail=$((fail + 1))
    failed_cases+=("$label")
  fi
}

# check_path <expected> <tool> <path>
check_path() {
  local expected=$1 tool=$2 path=$3 payload
  payload=$(jq -nc --arg t "$tool" --arg p "$path" \
    '{tool_name:$t, tool_input:{file_path:$p}}')
  check "$expected" "$tool $path" "$payload"
}

echo
echo "Guard hook regression tests — $HOOK"
echo

echo "Databases: non-synthetic must be DENIED"
check_path DENY Read  "/Users/nico/Documents/code/stairwell/fake-real.db"
check_path DENY Read  "probe-nonexistent.db"
check_path DENY Write "prod.db"
check_path DENY Edit  "users/nico/prod.DB"
check_path DENY Read  "prod.sqlite"
check_path DENY Read  "prod.sqlite3"
check_path DENY Read  "prod.SQLITE3"
check_path DENY Read  "/var/data/customer.db"
echo

echo "Sidecars: hold the same rows, must be DENIED"
check_path DENY Write "prod.db-wal"
check_path DENY Write "prod.db-shm"
check_path DENY Write "prod.db-journal"
check_path DENY Write "prod.sqlite-wal"
check_path DENY Write "probe.sqlite3-wal"
check_path DENY Read  "users/nico/real.db-shm"
echo

echo "Secrets: .env family must be DENIED"
check_path DENY Read  "/Users/nico/Documents/code/stairwell/.env"
check_path DENY Read  ".env"
check_path DENY Edit  ".env.local"
check_path DENY Write ".env.production"
echo

echo "synthetic.db and its sidecars must be ALLOWED"
check_path ALLOW Read  "synthetic.db"
check_path ALLOW Read  "./synthetic.db"
check_path ALLOW Write "synthetic.db-wal"
check_path ALLOW Write "synthetic.db-shm"
check_path ALLOW Write "synthetic.db-journal"
check_path ALLOW Read  "synthetic.sqlite3"
echo

echo "Ordinary project files must be ALLOWED"
check_path ALLOW Edit  "schema.sql"
check_path ALLOW Edit  "seed.py"
check_path ALLOW Edit  "mockup.html"
check_path ALLOW Read  "architecture-overview.md"
check_path ALLOW Read  "notes-wal.md"
check_path ALLOW Edit  "users/nico/spec.md"
echo

echo "Payload shapes without a file_path must pass through"
check ALLOW "Bash (no file_path)" \
  '{"tool_name":"Bash","tool_input":{"command":"ls"}}'
check ALLOW "empty tool_input" \
  '{"tool_name":"Read","tool_input":{}}'
check DENY  "NotebookEdit notebook_path .db" \
  '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"prod.db"}}'
echo

total=$((pass + fail))
if [ $fail -eq 0 ]; then
  echo "All $total checks passed."
  echo
  exit 0
fi

echo "$fail of $total checks FAILED:"
for c in "${failed_cases[@]}"; do
  echo "  - $c"
done
echo
echo "The data-safety guard has regressed. Do not run against real data until this is green."
echo
exit 1
