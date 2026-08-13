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

# ---------------------------------------------------------------------------
# Anti-drift pre-commit gate (.githooks/pre-commit)
#
# Sourced with SCHEMA_GATE_SOURCE_ONLY=1 so only check_schema_drift() is
# exposed — no real commits, no staging, no repo state touched.
# ---------------------------------------------------------------------------
GATE="$(cd "$HOOK_DIR/../.." && pwd)/.githooks/pre-commit"

echo "Anti-drift gate: schema.sql needs a same-user companion"
if [ ! -f "$GATE" ]; then
  printf '  %-6s %-34s %s\n' "FAIL" "gate script present" "missing $GATE"
  fail=$((fail + 1))
  failed_cases+=("gate script present")
else
  # gate_check <expected BLOCK|PASS> <label> <staged paths...>
  gate_check() {
    local expected=$1 label=$2
    shift 2
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE"
      check_schema_drift "$@"
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  gate_check BLOCK "schema alone" \
    users/alice/schema.sql
  gate_check PASS  "schema + same-user seed.py" \
    users/alice/schema.sql users/alice/seed.py
  gate_check PASS  "schema + same-user tests/" \
    users/alice/schema.sql users/alice/tests/test_panels.py
  gate_check BLOCK "alice schema + bob tests/" \
    users/alice/schema.sql users/bob/tests/test_panels.py
  gate_check BLOCK "alice schema + bob seed.py" \
    users/alice/schema.sql users/bob/seed.py
  gate_check PASS  "no schema.sql staged at all" \
    CLAUDE.md .claude/hooks/test-hooks.sh .gitignore
  gate_check PASS  "empty staged list"
  gate_check BLOCK "two users, only one satisfied" \
    users/alice/schema.sql users/alice/seed.py users/bob/schema.sql
  gate_check PASS  "two users, both satisfied" \
    users/alice/schema.sql users/alice/seed.py \
    users/bob/schema.sql users/bob/tests/test_x.py
  gate_check PASS  "root schema.sql (rule is per-user)" \
    schema.sql
  gate_check BLOCK "schema + unrelated same-user file" \
    users/alice/schema.sql users/alice/spec.md

  gate_check BLOCK "platform schema alone" \
    platform/schema.sql
  gate_check PASS  "platform schema + platform/seed.ts" \
    platform/schema.sql platform/seed.ts
  gate_check PASS  "platform schema + tests/" \
    platform/schema.sql tests/auth/password.test.ts
  gate_check BLOCK "platform schema + user tests/" \
    platform/schema.sql users/alice/tests/panels.test.ts
  gate_check BLOCK "platform schema + platform doc" \
    platform/schema.sql platform/notes.md
  gate_check BLOCK "platform unsatisfied, user satisfied" \
    platform/schema.sql users/alice/schema.sql users/alice/seed.py
  gate_check PASS  "platform + user, both satisfied" \
    platform/schema.sql platform/seed.ts \
    users/alice/schema.sql users/alice/tests/panels.test.ts
  gate_check PASS  "modules/plaid.sql is not a schema.sql" \
    modules/plaid.sql

  # gate_a_block_output <staged paths...> -> the block message on stderr
  gate_a_block_output() {
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE" >/dev/null 2>&1
      check_schema_drift "$@" 2>&1 >/dev/null
    )
  }

  # Gate A must not recommend --no-verify: it drops all three commit gates
  # (A, B, C) for a developer who only tripped Gate A. It should instead say
  # plainly to stage the companion change. No new skip variable — the fix
  # is a reword, not a fourth bypass.
  gate_a_out=$(gate_a_block_output users/alice/schema.sql)
  if printf '%s' "$gate_a_out" | grep -qF -- "--no-verify"; then
    printf '  %-6s %-34s %s\n' "FAIL" "Gate A does not recommend --no-verify" "found '--no-verify' in block output"
    fail=$((fail + 1))
    failed_cases+=("Gate A does not recommend --no-verify")
  else
    printf '  %-6s %-34s %s\n' "PASS" "Gate A does not recommend --no-verify" "no mention"
    pass=$((pass + 1))
  fi
  if printf '%s' "$gate_a_out" | grep -qF "companion change"; then
    printf '  %-6s %-34s %s\n' "PASS" "Gate A tells you to stage the companion change" "says 'companion change'"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s %s\n' "FAIL" "Gate A tells you to stage the companion change" "missing 'companion change'"
    fail=$((fail + 1))
    failed_cases+=("Gate A tells you to stage the companion change")
  fi
fi
echo

echo "Gate B: guarded changes need same-scope tests"
if [ ! -f "$GATE" ]; then
  printf '  %-6s %-34s %s\n' "FAIL" "gate script present (B)" "missing $GATE"
  fail=$((fail + 1))
  failed_cases+=("gate script present (B)")
else
  # coverage_check <expected BLOCK|PASS> <label> <staged paths...>
  coverage_check() {
    local expected=$1 label=$2
    shift 2
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE"
      check_test_coverage "$@"
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  coverage_check BLOCK "lib/ alone" \
    lib/session/store.ts
  coverage_check PASS  "lib/ + tests/" \
    lib/session/store.ts tests/session/store.test.ts
  coverage_check BLOCK "app/ alone" \
    "app/admin/page.tsx"
  coverage_check BLOCK "middleware.ts alone" \
    middleware.ts
  coverage_check BLOCK "scripts/ alone" \
    scripts/create-dev-users.ts
  coverage_check PASS  "scripts/ + tests/" \
    scripts/create-dev-users.ts tests/scripts/createDevUsers.test.ts
  coverage_check BLOCK "root-level .ts alone (instrumentation.ts)" \
    instrumentation.ts
  coverage_check BLOCK "root-level .tsx alone" \
    fake-root-component.tsx
  coverage_check PASS  "root-level .ts + tests/" \
    instrumentation.ts tests/instrumentation.test.ts
  coverage_check BLOCK "platform/ code alone" \
    platform/migrate.ts
  coverage_check PASS  "docs only" \
    README.md docs/superpowers/specs/x.md architecture-overview.md
  coverage_check PASS  "styling only" \
    "app/globals.css" public/logo.svg
  coverage_check PASS  "config only" \
    package.json next.config.ts tsconfig.json vitest.config.ts .gitignore
  coverage_check BLOCK "nested json is code, not config" \
    lib/config.json
  coverage_check PASS  "nested json + platform tests/" \
    lib/config.json tests/db/config.test.ts
  coverage_check BLOCK "nested yaml in platform scope" \
    platform/rules.yaml
  coverage_check BLOCK "nested toml in modules scope" \
    modules/plaid.toml
  coverage_check BLOCK "nested json in user scope" \
    "users/alice/app/data.json"
  coverage_check BLOCK "user panel alone" \
    "users/alice/app/panels/spend.tsx"
  coverage_check PASS  "user panel + same-user tests/" \
    "users/alice/app/panels/spend.tsx" users/alice/tests/spend.test.ts
  coverage_check BLOCK "user panel + other-user tests/" \
    "users/alice/app/panels/spend.tsx" users/bob/tests/spend.test.ts
  coverage_check PASS  "user contract files only" \
    users/alice/mockup.html users/alice/spec.md
  coverage_check BLOCK "modules/ alone" \
    modules/plaid.sql
  coverage_check PASS  "modules/ + modules/tests/" \
    modules/plaid.sql modules/tests/plaid.test.ts
  coverage_check BLOCK "modules/ + platform tests/" \
    modules/plaid.sql tests/auth/password.test.ts
  coverage_check BLOCK "platform code + modules tests/" \
    lib/db/platform.ts modules/tests/plaid.test.ts
  coverage_check BLOCK "hook alone" \
    .githooks/pre-commit
  coverage_check PASS  "hook + harness" \
    .githooks/pre-commit .claude/hooks/test-hooks.sh
  coverage_check BLOCK "guard hook alone" \
    .claude/hooks/deny-sensitive-files.sh
  coverage_check PASS  "settings.json is config" \
    .claude/settings.json
  coverage_check PASS  "tests/ alone" \
    tests/auth/password.test.ts
  coverage_check PASS  "empty staged list"
  coverage_check PASS  "seed.py alone is Gate A territory" \
    users/alice/seed.py
  coverage_check PASS  "seed.ts alone is Gate A territory" \
    platform/seed.ts
  coverage_check PASS  "schema.sql alone is Gate A territory" \
    platform/schema.sql
  coverage_check BLOCK "two scopes, only one satisfied" \
    lib/db/platform.ts tests/db/platform.test.ts "users/alice/app/panels/spend.tsx"
  coverage_check PASS  "two scopes, both satisfied" \
    lib/db/platform.ts tests/db/platform.test.ts \
    "users/alice/app/panels/spend.tsx" users/alice/tests/spend.test.ts

  # class_check <expected> <label> <path>
  #
  # Calls _gate_b_class directly rather than going through check_test_coverage,
  # so it can assert the classification string itself. platform/prompts/*.md
  # was already exempt via the *.md arm below it, by accident of file
  # extension rather than intent — this pins the explicit arm added ahead of
  # it, and (the case that actually matters) proves the glob did not swallow
  # the rest of platform/. A rule of `platform/*` instead of
  # `platform/prompts/*` would pass the first assertion and silently exempt
  # every guarded file under platform/; the second assertion is what catches
  # that.
  class_check() {
    local expected=$1 label=$2 path=$3 actual
    actual=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE"
      _gate_b_class "$path"
    )
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  class_check exempt "platform/prompts/*.md classifies exempt (explicit arm)" \
    platform/prompts/agent-v1.md
  class_check "guard:platform" "platform/chat.ts still guarded (glob not over-broad)" \
    platform/chat.ts
  class_check "guard:platform" "a non-prose file under platform/prompts/ stays guarded" \
    platform/prompts/loader.ts

  class_check "guard:platform" "users/registry.ts is guarded, not unguarded" \
    users/registry.ts
  class_check "guard:user:alice" "users/alice/queries.ts still scopes to its own user" \
    users/alice/queries.ts
  class_check "guard:platform" "users/registry.json is guarded (not just .ts/.tsx/.sh)" \
    users/registry.json
  class_check "guard:platform" "a bare extensionless users/manifest is guarded" \
    users/manifest

  # skip_check <expected BLOCK|PASS> <label> <staged paths...>
  skip_check() {
    local expected=$1 label=$2
    shift 2
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE"
      SKIP_TEST_GATE=1 check_test_coverage "$@"
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # skip_says <expected-substring> <label> <staged paths...>
  skip_says() {
    local expected=$1 label=$2
    shift 2
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE" >/dev/null 2>&1
      SKIP_TEST_GATE=1 check_test_coverage "$@" 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # skip_silent <label> <staged paths...>
  skip_silent() {
    local label=$1
    shift
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE" >/dev/null 2>&1
      SKIP_TEST_GATE=1 check_test_coverage "$@" 2>&1 >/dev/null
    )
    if [ -z "$out" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "silent"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s expected silence, got output\n' "FAIL" "$label"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  skip_check PASS "SKIP_TEST_GATE turns block into pass" \
    lib/session/store.ts
  skip_says "lib/session/store.ts" "skip names the untested file" \
    lib/session/store.ts
  skip_says "platform:" "skip names the scope" \
    lib/session/store.ts
  skip_silent "skip is silent when nothing is guarded" \
    README.md package.json
  skip_silent "skip is silent when tests are staged" \
    lib/session/store.ts tests/session/store.test.ts
fi
echo

echo "Gate C: TypeScript errors block the commit"
if [ ! -f "$GATE" ]; then
  printf '  %-6s %-34s %s\n' "FAIL" "gate script present (C)" "missing $GATE"
  fail=$((fail + 1))
  failed_cases+=("gate script present (C)")
else
  # Stub commands stand in for the real compiler via TYPECHECK_CMD so this
  # group runs in milliseconds instead of shelling out to tsc repeatedly.
  # The real, unstubbed compiler is exercised separately (see below).
  _stub_tsc_pass() { return 0; }
  _stub_tsc_fail() { echo "TS2345: FAKE_TSC_STUB_MARKER not assignable" >&2; return 1; }

  # typecheck_check <expected BLOCK|PASS> <label> <TYPECHECK_CMD stub> <staged paths...>
  typecheck_check() {
    local expected=$1 label=$2 cmd=$3
    shift 3
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE"
      TYPECHECK_CMD="$cmd" check_typecheck "$@"
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # typecheck_skip_check <expected BLOCK|PASS> <label> <cmd> <staged paths...>
  typecheck_skip_check() {
    local expected=$1 label=$2 cmd=$3
    shift 3
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE"
      TYPECHECK_CMD="$cmd" SKIP_TYPECHECK=1 check_typecheck "$@"
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # typecheck_says <expected-substring> <label> <cmd> <staged paths...>
  typecheck_says() {
    local expected=$1 label=$2 cmd=$3
    shift 3
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE" >/dev/null 2>&1
      TYPECHECK_CMD="$cmd" check_typecheck "$@" 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # typecheck_skip_says <expected-substring> <label> <cmd> <staged paths...>
  typecheck_skip_says() {
    local expected=$1 label=$2 cmd=$3
    shift 3
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE" >/dev/null 2>&1
      TYPECHECK_CMD="$cmd" SKIP_TYPECHECK=1 check_typecheck "$@" 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # typecheck_skip_silent <label> <cmd> <staged paths...>
  typecheck_skip_silent() {
    local label=$1 cmd=$2
    shift 2
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$GATE" >/dev/null 2>&1
      TYPECHECK_CMD="$cmd" SKIP_TYPECHECK=1 check_typecheck "$@" 2>&1 >/dev/null
    )
    if [ -z "$out" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "silent"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s expected silence, got output\n' "FAIL" "$label"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # 1. Staged .ts + stubbed passing typecheck -> allows.
  typecheck_check PASS  "staged .ts + passing typecheck" \
    _stub_tsc_pass lib/auth/password.ts
  # 2. Staged .ts + stubbed FAILING typecheck -> blocks.
  typecheck_check BLOCK "staged .ts + failing typecheck" \
    _stub_tsc_fail lib/auth/password.ts
  # 3. Staged .tsx + stubbed failing typecheck -> blocks.
  typecheck_check BLOCK "staged .tsx + failing typecheck" \
    _stub_tsc_fail "app/admin/page.tsx"
  # 4. No TypeScript staged -> allows, fast path (command must not even run).
  typecheck_check PASS  "no TypeScript staged (fast path)" \
    _stub_tsc_fail CLAUDE.md
  # 5. Staged .ts + failing typecheck + SKIP_TYPECHECK=1 -> allows.
  typecheck_skip_check PASS "SKIP_TYPECHECK turns block into pass" \
    _stub_tsc_fail lib/auth/password.ts
  # 6. The skip announces itself on stderr. Checks for "Gate C SKIPPED", not
  # "SKIP_TYPECHECK=1" alone — that literal also appears in the block
  # message's bypass suggestion, so it would not distinguish the skip
  # branch from the block branch.
  typecheck_skip_says "Gate C SKIPPED" "skip announces itself" \
    _stub_tsc_fail lib/auth/password.ts
  # 7. The skip is silent when no TypeScript is staged.
  typecheck_skip_silent "skip is silent when no TypeScript staged" \
    _stub_tsc_fail CLAUDE.md
  # 8. Blocking output includes the compiler's own message.
  typecheck_says "FAKE_TSC_STUB_MARKER" "blocking output includes compiler's own message" \
    _stub_tsc_fail lib/auth/password.ts
  # 9. SKIP_TYPECHECK=1 does not leak into Gate A (schema drift stays blocked).
  SKIP_TYPECHECK=1 gate_check BLOCK "SKIP_TYPECHECK does not leak into Gate A" \
    users/alice/schema.sql
  # 9b. Same property for Gate B: SKIP_TYPECHECK=1 is not a coverage bypass
  # either. No live defect today (SKIP_TYPECHECK is read only inside
  # check_typecheck), but the mutation was otherwise invisible to this harness.
  SKIP_TYPECHECK=1 coverage_check BLOCK "SKIP_TYPECHECK does not leak into Gate B" \
    lib/session/store.ts
  # 10. A file merely named like TypeScript (wrong extension) does not trigger.
  typecheck_check PASS  "file named like TypeScript, wrong extension" \
    _stub_tsc_fail "docs/typescript-notes.md"
fi
echo

echo "Gate D: a broken build blocks the push"
PUSH_GATE="$(cd "$HOOK_DIR/../.." && pwd)/.githooks/pre-push"
if [ ! -x "$PUSH_GATE" ]; then
  printf '  %-6s %-34s %s\n' "FAIL" "gate script present (D)" "missing or not executable: $PUSH_GATE"
  fail=$((fail + 1))
  failed_cases+=("gate script present (D)")
else
  # Stub commands stand in for the real build via BUILD_CMD so this group
  # runs in milliseconds instead of shelling out to `next build` (~1 min).
  # The real, unstubbed build is exercised separately (see report).
  _stub_build_pass() { return 0; }
  _stub_build_fail() { echo "Module not found: Can't resolve 'node:crypto' FAKE_BUILD_STUB_MARKER" >&2; return 1; }
  _MISSING_BUILD_CMD="___stairwell_gate_d_no_such_command___"

  # build_check <expected BLOCK|PASS> <label> <BUILD_CMD stub>
  build_check() {
    local expected=$1 label=$2 cmd=$3
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE"
      BUILD_CMD="$cmd" check_build
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # build_skip_check <expected BLOCK|PASS> <label> <cmd>
  build_skip_check() {
    local expected=$1 label=$2 cmd=$3
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE"
      BUILD_CMD="$cmd" SKIP_BUILD_GATE=1 check_build
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # build_says <expected-substring> <label> <cmd>
  build_says() {
    local expected=$1 label=$2 cmd=$3
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE" >/dev/null 2>&1
      BUILD_CMD="$cmd" check_build 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # build_skip_says <expected-substring> <label> <cmd>
  build_skip_says() {
    local expected=$1 label=$2 cmd=$3
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE" >/dev/null 2>&1
      BUILD_CMD="$cmd" SKIP_BUILD_GATE=1 check_build 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # build_skip_silent <label> <cmd>
  #
  # "Silent" here means the SKIP notice stays silent — check_build always
  # prints a one-line progress notice before running the build (see
  # pre-push), independent of pass/fail/skip, so the stub run is never
  # byte-for-byte empty. What must stay silent specifically is the
  # "Gate D SKIPPED" announcement, which is only correct to print when the
  # gate would actually have blocked.
  build_skip_silent() {
    local label=$1 cmd=$2
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE" >/dev/null 2>&1
      BUILD_CMD="$cmd" SKIP_BUILD_GATE=1 check_build 2>&1 >/dev/null
    )
    if ! printf '%s' "$out" | grep -qF "Gate D SKIPPED"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "no skip notice"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s expected no skip notice, got one\n' "FAIL" "$label"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # 1. Stubbed passing build -> allows the push.
  build_check PASS  "stubbed passing build" \
    _stub_build_pass
  # 2. Stubbed FAILING build -> blocks the push.
  build_check BLOCK "stubbed failing build" \
    _stub_build_fail
  # 3. Blocking output includes the build's own distinctive message.
  build_says "FAKE_BUILD_STUB_MARKER" "blocking output includes build's own message" \
    _stub_build_fail
  # 4. SKIP_BUILD_GATE=1 with a failing build -> allows.
  build_skip_check PASS "SKIP_BUILD_GATE turns block into pass" \
    _stub_build_fail
  # 5. The skip announces itself on stderr.
  build_skip_says "Gate D SKIPPED" "skip announces itself" \
    _stub_build_fail
  # 6. The skip is SILENT when the build passed anyway.
  build_skip_silent "skip is silent when the build passed" \
    _stub_build_pass
  # 7. Exit 127 (command not found) reports a missing-toolchain failure, not
  # a build error, and still blocks (fails closed) when not skipped.
  build_check BLOCK "BUILD_CMD not found (exit 127) still blocks" \
    "$_MISSING_BUILD_CMD"
  build_says "Gate D could not run the build" "exit 127 reports missing toolchain, not a build error" \
    "$_MISSING_BUILD_CMD"
  # 8. SKIP_BUILD_GATE=1 must not leak into any pre-commit gate — all three
  # (A, B, C) must still block with it set. Task 8G's equivalent case
  # initially covered only one of the two gates it should have; cover all
  # three here.
  SKIP_BUILD_GATE=1 gate_check BLOCK "SKIP_BUILD_GATE does not leak into Gate A" \
    users/alice/schema.sql
  SKIP_BUILD_GATE=1 coverage_check BLOCK "SKIP_BUILD_GATE does not leak into Gate B" \
    lib/session/store.ts
  SKIP_BUILD_GATE=1 typecheck_check BLOCK "SKIP_BUILD_GATE does not leak into Gate C" \
    _stub_tsc_fail lib/auth/password.ts

  # 9. Sourcing check_build directly (cases 1-8 above) proves the decision
  # logic is correct, but proves nothing about the file's main block — the
  # stdin drain, the call to check_build, and `exit $?`. A hook whose main
  # block never calls check_build would still pass every case above. Invoke
  # the file AS A SCRIPT, both directions, so the harness would catch that
  # exact class of bug (the same "green but doesn't run" failure this task
  # exists to prevent, one level up).
  #
  # TEST_CMD is pinned to a passing stub in both cases below: main now runs
  # check_tests before check_build (see pre-push), so without a TEST_CMD
  # override these would shell out to a real `npx vitest run` and these
  # cases would stop isolating BUILD_CMD's effect on the exit code.
  as_script_out=$(printf '' | TEST_CMD=true BUILD_CMD=false bash "$PUSH_GATE" origin http://x </dev/null 2>&1)
  as_script_rc=$?
  if [ $as_script_rc -eq 1 ]; then
    printf '  %-6s %-34s %s\n' "PASS" "as-a-script: failing BUILD_CMD blocks" "exit 1"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s got exit %s, want 1\n' "FAIL" "as-a-script: failing BUILD_CMD blocks" "$as_script_rc"
    fail=$((fail + 1))
    failed_cases+=("as-a-script: failing BUILD_CMD blocks")
  fi

  as_script_out=$(printf '' | TEST_CMD=true BUILD_CMD=true bash "$PUSH_GATE" origin http://x </dev/null 2>&1)
  as_script_rc=$?
  if [ $as_script_rc -eq 0 ]; then
    printf '  %-6s %-34s %s\n' "PASS" "as-a-script: passing BUILD_CMD allows" "exit 0"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s got exit %s, want 0\n' "FAIL" "as-a-script: passing BUILD_CMD allows" "$as_script_rc"
    fail=$((fail + 1))
    failed_cases+=("as-a-script: passing BUILD_CMD allows")
  fi
fi
echo

echo "Gate E: a failing test suite blocks the push"
if [ ! -f "$PUSH_GATE" ]; then
  printf '  %-6s %-34s %s\n' "FAIL" "gate script present (E)" "missing $PUSH_GATE"
  fail=$((fail + 1))
  failed_cases+=("gate script present (E)")
else
  # Stub commands stand in for the real suite via TEST_CMD so this group
  # runs in milliseconds instead of shelling out to `npx vitest run`. The
  # real, unstubbed suite is exercised separately (see report).
  _stub_tests_pass() { return 0; }
  _stub_tests_fail() { echo "FAIL tests/session/keymap.test.ts FAKE_TEST_STUB_MARKER" >&2; return 1; }
  _MISSING_TEST_CMD="___stairwell_gate_e_no_such_command___"

  # tests_check <expected BLOCK|PASS> <label> <TEST_CMD stub>
  tests_check() {
    local expected=$1 label=$2 cmd=$3
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE"
      TEST_CMD="$cmd" check_tests
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # tests_skip_check <expected BLOCK|PASS> <label> <cmd>
  tests_skip_check() {
    local expected=$1 label=$2 cmd=$3
    local rc
    (
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE"
      TEST_CMD="$cmd" SKIP_TEST_RUN_GATE=1 check_tests
    ) >/dev/null 2>&1
    rc=$?
    local actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # tests_says <expected-substring> <label> <cmd>
  tests_says() {
    local expected=$1 label=$2 cmd=$3
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE" >/dev/null 2>&1
      TEST_CMD="$cmd" check_tests 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # tests_skip_says <expected-substring> <label> <cmd>
  tests_skip_says() {
    local expected=$1 label=$2 cmd=$3
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE" >/dev/null 2>&1
      TEST_CMD="$cmd" SKIP_TEST_RUN_GATE=1 check_tests 2>&1 >/dev/null
    )
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s missing '\''%s'\''\n' "FAIL" "$label" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # tests_skip_silent <label> <cmd>
  #
  # "Silent" here means the SKIP notice stays silent — check_tests always
  # prints a one-line progress notice before running the suite, independent
  # of pass/fail/skip, so the stub run is never byte-for-byte empty. What
  # must stay silent specifically is the "Gate E SKIPPED" announcement,
  # which is only correct to print when the gate would actually have
  # blocked.
  tests_skip_silent() {
    local label=$1 cmd=$2
    local out
    out=$(
      # shellcheck disable=SC1090
      SCHEMA_GATE_SOURCE_ONLY=1 . "$PUSH_GATE" >/dev/null 2>&1
      TEST_CMD="$cmd" SKIP_TEST_RUN_GATE=1 check_tests 2>&1 >/dev/null
    )
    if ! printf '%s' "$out" | grep -qF "Gate E SKIPPED"; then
      printf '  %-6s %-34s %s\n' "PASS" "$label" "no skip notice"
      pass=$((pass + 1))
    else
      printf '  %-6s %-34s expected no skip notice, got one\n' "FAIL" "$label"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # 1. Stubbed passing suite -> allows the push.
  tests_check PASS  "stubbed passing test suite" \
    _stub_tests_pass
  # 2. Stubbed FAILING suite -> blocks the push.
  tests_check BLOCK "stubbed failing test suite" \
    _stub_tests_fail
  # 3. Blocking output includes the suite's own distinctive message.
  tests_says "FAKE_TEST_STUB_MARKER" "blocking output includes test suite's own message" \
    _stub_tests_fail
  # 4. SKIP_TEST_RUN_GATE=1 with a failing suite -> allows.
  tests_skip_check PASS "SKIP_TEST_RUN_GATE turns block into pass" \
    _stub_tests_fail
  # 5. The skip announces itself on stderr.
  tests_skip_says "Gate E SKIPPED" "skip announces itself" \
    _stub_tests_fail
  # 6. The skip is SILENT when the suite passed anyway.
  tests_skip_silent "skip is silent when the suite passed" \
    _stub_tests_pass
  # 7. Exit 127 (command not found) reports a missing-toolchain failure, not
  # a test failure, and still blocks (fails closed) when not skipped.
  tests_check BLOCK "TEST_CMD not found (exit 127) still blocks" \
    "$_MISSING_TEST_CMD"
  tests_says "Gate E could not run the test suite" "exit 127 reports missing toolchain, not a test failure" \
    "$_MISSING_TEST_CMD"
  # 8. SKIP_TEST_RUN_GATE=1 must not leak into any pre-commit gate or into
  # Gate D — each must still block/run with it set.
  SKIP_TEST_RUN_GATE=1 gate_check BLOCK "SKIP_TEST_RUN_GATE does not leak into Gate A" \
    users/alice/schema.sql
  SKIP_TEST_RUN_GATE=1 coverage_check BLOCK "SKIP_TEST_RUN_GATE does not leak into Gate B" \
    lib/session/store.ts
  SKIP_TEST_RUN_GATE=1 typecheck_check BLOCK "SKIP_TEST_RUN_GATE does not leak into Gate C" \
    _stub_tsc_fail lib/auth/password.ts
  SKIP_TEST_RUN_GATE=1 build_check BLOCK "SKIP_TEST_RUN_GATE does not leak into Gate D" \
    _stub_build_fail

  # 9. As in Gate D: sourcing check_tests directly proves the decision logic,
  # not that the file's main block actually calls it before check_build.
  # Invoke the file AS A SCRIPT, both directions.
  as_script_out=$(printf '' | TEST_CMD=false BUILD_CMD=true bash "$PUSH_GATE" origin http://x </dev/null 2>&1)
  as_script_rc=$?
  if [ $as_script_rc -eq 1 ]; then
    printf '  %-6s %-34s %s\n' "PASS" "as-a-script: failing TEST_CMD blocks" "exit 1"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s got exit %s, want 1\n' "FAIL" "as-a-script: failing TEST_CMD blocks" "$as_script_rc"
    fail=$((fail + 1))
    failed_cases+=("as-a-script: failing TEST_CMD blocks")
  fi

  # 10. Ordering: TEST_CMD runs before BUILD_CMD (main's fail-fast design).
  # A failing TEST_CMD with a PASSING BUILD_CMD (case 9) already proves
  # check_tests genuinely gates the push on its own; this case proves the
  # specific ordering by checking which gate's message appears when BOTH
  # would fail — if main called check_build first, this would report a
  # build failure instead.
  as_script_out=$(printf '' | TEST_CMD=false BUILD_CMD=false bash "$PUSH_GATE" origin http://x </dev/null 2>&1)
  as_script_rc=$?
  if [ $as_script_rc -eq 1 ] && printf '%s' "$as_script_out" | grep -qF "PUSH BLOCKED — tests failed"; then
    printf '  %-6s %-34s %s\n' "PASS" "as-a-script: tests run before build" "blocked at Gate E"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s got exit %s\n' "FAIL" "as-a-script: tests run before build" "$as_script_rc"
    fail=$((fail + 1))
    failed_cases+=("as-a-script: tests run before build")
  fi
fi
echo

echo "Deploy smoke check: serving, not merely started"
SMOKE_SCRIPT="$(cd "$HOOK_DIR/../.." && pwd)/deploy/smoke.sh"
if [ ! -x "$SMOKE_SCRIPT" ]; then
  printf '  %-6s %-38s %s\n' "FAIL" "smoke script present and executable" "missing or not +x: $SMOKE_SCRIPT"
  fail=$((fail + 1))
  failed_cases+=("smoke script present and executable")
else
  # deploy/smoke.sh talks HTTP, so the harness stubs its one fetch primitive via
  # SMOKE_FETCH, exactly as Gates D and E stub BUILD_CMD and TEST_CMD. The stub
  # is invoked as `stub <method> <url>` and prints the status code on line 1 and
  # the Location header on line 2 — the same contract the real curl path honours.
  smoke_sandbox=$(mktemp -d)

  # smoke_check <expected PASS|BLOCK> <label> <stub-body>
  smoke_check() {
    local expected=$1 label=$2 body=$3
    local stub="$smoke_sandbox/fetch-$((pass + fail)).sh" rc actual
    {
      echo '#!/usr/bin/env bash'
      echo 'method="$1"; url="$2"'
      echo "$body"
    } > "$stub"
    chmod +x "$stub"
    SMOKE_FETCH="$stub" SMOKE_ATTEMPTS=3 SMOKE_SLEEP=0 \
      "$SMOKE_SCRIPT" https://app.stairwell.run >/dev/null 2>&1
    rc=$?
    actual="PASS"
    [ $rc -ne 0 ] && actual="BLOCK"
    if [ "$actual" = "$expected" ]; then
      printf '  %-6s %-38s %s\n' "PASS" "$label" "$actual"
      pass=$((pass + 1))
    else
      printf '  %-6s %-38s got %s, want %s\n' "FAIL" "$label" "$actual" "$expected"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # smoke_says <expected-substring> <label> <stub-body>
  smoke_says() {
    local expected=$1 label=$2 body=$3
    local stub="$smoke_sandbox/fetch-$((pass + fail)).sh" out
    {
      echo '#!/usr/bin/env bash'
      echo 'method="$1"; url="$2"'
      echo "$body"
    } > "$stub"
    chmod +x "$stub"
    out=$(SMOKE_FETCH="$stub" SMOKE_ATTEMPTS=3 SMOKE_SLEEP=0 \
      "$SMOKE_SCRIPT" https://app.stairwell.run 2>&1)
    if printf '%s' "$out" | grep -qF "$expected"; then
      printf '  %-6s %-38s %s\n' "PASS" "$label" "says '$expected'"
      pass=$((pass + 1))
    else
      printf '  %-6s %-38s missing %s\n' "FAIL" "$label" "'$expected'"
      fail=$((fail + 1))
      failed_cases+=("$label")
    fi
  }

  # A fully healthy deployment: /login 200, / -> absolute /login on the right
  # host, POST /api/login -> relative.
  _SMOKE_GOOD='
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  smoke_check PASS "healthy deployment" "$_SMOKE_GOOD"

  # Readiness. curl exits 0 on a 502, so a naive exit-code poll passes instantly
  # while Caddy is still returning Bad Gateway. This is the mistake that produced
  # phantom results while the checkpoint was being run by hand.
  # Everything EXCEPT /login is healthy here, deliberately. An earlier version of
  # this case returned 000 for the other paths, and stayed green against a mutant
  # whose readiness check accepted any status — the root-redirect check failed
  # instead, so the case proved nothing about readiness. With the rest healthy,
  # only the readiness check can block, and the case is diagnostic.
  smoke_check BLOCK "permanent 502 on /login blocks" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 502; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  smoke_says "never returned 200" "502 reported as a readiness failure" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 502; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  # A 502 that clears must NOT fail the deploy — the restart window is normal.
  smoke_check PASS "transient 502 then 200 passes" '
counter="'"$smoke_sandbox"'/poll-count"
n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$counter"
case "$method $url" in
  "GET https://app.stairwell.run/login")
      if [ "$n" -lt 2 ]; then echo 502; else echo 200; fi; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  # OUTAGE 1: the absolute redirect naming the internal origin. /login answers
  # 200 and the root returns a healthy-looking 307, so liveness alone passes.
  smoke_check BLOCK "redirect naming localhost blocks" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://localhost:3000/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  smoke_says "yields the internal origin" "internal-origin redirect names the cause" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://localhost:3000/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  # OUTAGE 2: middleware ERR_INVALID_URL. /login is not matched by the failing
  # branch, so it still answers 200 — liveness passes and only the root 500s.
  smoke_check BLOCK "root 500 blocks (middleware throw)" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 500; echo "" ;;
  *) echo 000; echo "" ;;
esac'

  # A route handler regressing to an absolute Location — the opposite layer, and
  # invisible to every other check here.
  smoke_check BLOCK "absolute route-handler Location blocks" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "https://app.stairwell.run/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  # Protocol-relative resolves to a DIFFERENT origin, so it must not be accepted
  # as "relative".
  smoke_check BLOCK "protocol-relative redirect blocks" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "//evil.example/login" ;;
  *) echo 000; echo "" ;;
esac'

  # Redirecting somewhere other than /login.
  smoke_check BLOCK "root redirect to the wrong path blocks" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 200; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/unlock" ;;
  *) echo 000; echo "" ;;
esac'

  # There is deliberately no skip variable. If one is ever added, this fails and
  # whoever added it has to justify it.
  smoke_check BLOCK "no skip variable turns a failure into a pass" '
case "$method $url" in
  "GET https://app.stairwell.run/login") echo 502; echo "" ;;
  "GET https://app.stairwell.run/") echo 307; echo "https://app.stairwell.run/login" ;;
  "POST https://app.stairwell.run/api/login") echo 303; echo "/login?error=1" ;;
  *) echo 000; echo "" ;;
esac'

  # Every case above exercises deploy/smoke.sh directly. NONE of them would notice
  # deploy.sh dropping the call — the same blind spot Task 12G found in Gate D,
  # where 11 green cases coexisted with a pre-push hook that never invoked the
  # gate. This is a static check because deploy.sh's other steps (git pull, npm
  # ci, next build, systemctl) cannot be run in the harness; it pins the one thing
  # that would silently disarm the contract.
  DEPLOY_SCRIPT="$(cd "$HOOK_DIR/../.." && pwd)/deploy/deploy.sh"
  if grep -qE '^[^#]*\./deploy/smoke\.sh' "$DEPLOY_SCRIPT"; then
    printf '  %-6s %-38s %s\n' "PASS" "deploy.sh actually invokes smoke.sh" "invocation present"
    pass=$((pass + 1))
  else
    printf '  %-6s %-38s %s\n' "FAIL" "deploy.sh actually invokes smoke.sh" "no uncommented ./deploy/smoke.sh call"
    fail=$((fail + 1))
    failed_cases+=("deploy.sh actually invokes smoke.sh")
  fi

  # ...and that a smoke failure aborts rather than being logged and ignored.
  # ^[^#]* anchors this to an UNCOMMENTED line. Without it the pattern matched
  # `# if ! ./deploy/smoke.sh; then` and stayed green against a mutant that had
  # commented the gate out — caught by running exactly that mutation.
  if grep -qE '^[^#]*if ! \./deploy/smoke\.sh; then' "$DEPLOY_SCRIPT" \
     && grep -qE '^[^#]*exit 1' "$DEPLOY_SCRIPT"; then
    printf '  %-6s %-38s %s\n' "PASS" "smoke failure aborts the deploy" "guarded and exits nonzero"
    pass=$((pass + 1))
  else
    printf '  %-6s %-38s %s\n' "FAIL" "smoke failure aborts the deploy" "smoke result is not gating"
    fail=$((fail + 1))
    failed_cases+=("smoke failure aborts the deploy")
  fi

  # deploy.sh replaces ITSELF at step 2 (git pull), so the deploy that introduces
  # a contract change would otherwise be the one deploy exempt from it. Measured:
  # the run that first delivered smoke.sh skipped the gate and reported the OLD
  # success message. Both halves of the mitigation are pinned here because each
  # fails silently on its own.
  if grep -qE '^[^#]*DEPLOY_REEXECED=1 exec \./deploy/deploy\.sh' "$DEPLOY_SCRIPT"; then
    printf '  %-6s %-38s %s\n' "PASS" "re-execs when deploy scripts change" "exec present"
    pass=$((pass + 1))
  else
    printf '  %-6s %-38s %s\n' "FAIL" "re-execs when deploy scripts change" "no re-exec: a contract change would skip its own deploy"
    fail=$((fail + 1))
    failed_cases+=("re-execs when deploy scripts change")
  fi

  # Wrapping the body in main() makes bash parse the whole file before running
  # any of it, so a mid-run replacement cannot splice old and new lines together.
  if grep -qE '^main "\$@"' "$DEPLOY_SCRIPT" && grep -qE '^main\(\) \{' "$DEPLOY_SCRIPT"; then
    printf '  %-6s %-38s %s\n' "PASS" "body wrapped in main() for atomic parse" "main() and call present"
    pass=$((pass + 1))
  else
    printf '  %-6s %-38s %s\n' "FAIL" "body wrapped in main() for atomic parse" "unwrapped: a mid-run pull can splice this file"
    fail=$((fail + 1))
    failed_cases+=("body wrapped in main() for atomic parse")
  fi

  # The re-exec must be guarded, or it recurses forever.
  if grep -qE '^[^#]*-z "\$\{DEPLOY_REEXECED:-\}"' "$DEPLOY_SCRIPT"; then
    printf '  %-6s %-38s %s\n' "PASS" "re-exec is guarded against looping" "guard present"
    pass=$((pass + 1))
  else
    printf '  %-6s %-38s %s\n' "FAIL" "re-exec is guarded against looping" "unguarded exec would recurse"
    fail=$((fail + 1))
    failed_cases+=("re-exec is guarded against looping")
  fi

  rm -rf "$smoke_sandbox"
fi
echo

echo "setup.sh: repairs the exec bit on all four hook scripts"
SETUP_SCRIPT="$(cd "$HOOK_DIR/../.." && pwd)/setup.sh"
if [ ! -f "$SETUP_SCRIPT" ]; then
  printf '  %-6s %-34s %s\n' "FAIL" "setup.sh present" "missing $SETUP_SCRIPT"
  fail=$((fail + 1))
  failed_cases+=("setup.sh present")
else
  # A fully sandboxed fake repo — never touches the real .githooks/.claude
  # in this checkout. setup.sh only needs: to be inside a git work tree,
  # jq on PATH (already true in this environment), and the four scripts it
  # checks to exist at their usual relative paths.
  setup_sandbox=$(mktemp -d)
  mkdir -p "$setup_sandbox/.claude/hooks" "$setup_sandbox/.githooks"
  (cd "$setup_sandbox" && git init -q) >/dev/null 2>&1
  cp "$SETUP_SCRIPT" "$setup_sandbox/setup.sh"

  hook_files=(
    .claude/hooks/deny-sensitive-files.sh
    .claude/hooks/test-hooks.sh
    .githooks/pre-commit
    .githooks/pre-push
  )
  for f in "${hook_files[@]}"; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$setup_sandbox/$f"
  done
  # Strip the exec bit from all four to simulate a fresh clone that lost it
  # (e.g. a zip download rather than a real git checkout) — this is the
  # exact scenario setup.sh's repair step exists for.
  chmod -x "${hook_files[@]/#/$setup_sandbox/}"

  (cd "$setup_sandbox" && bash setup.sh) >/dev/null 2>&1

  still_not_exec=()
  for f in "${hook_files[@]}"; do
    [ -x "$setup_sandbox/$f" ] || still_not_exec+=("$f")
  done

  if [ ${#still_not_exec[@]} -eq 0 ]; then
    printf '  %-6s %-34s %s\n' "PASS" "repairs exec bit on all four, incl. pre-push" "all executable"
    pass=$((pass + 1))
  else
    printf '  %-6s %-34s still not executable: %s\n' "FAIL" "repairs exec bit on all four, incl. pre-push" "${still_not_exec[*]}"
    fail=$((fail + 1))
    failed_cases+=("repairs exec bit on all four, incl. pre-push")
  fi

  rm -rf "$setup_sandbox"
fi
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
