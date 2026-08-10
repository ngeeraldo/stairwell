# Step 1a — Auth, Test Layout, Test Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pre-commit test-coverage gate, then the auth, session, and routing layer behind it, ending at a localhost checkpoint where two dev users are 404-blind to each other and an empty admin portal loads.

**Architecture:** Gate work lands first (Tasks 2–4) so the auth code that follows is the first real traffic through Gate B. Auth uses two Argon2id derivations from one password with separate salts — a stored verifier and a never-stored SQLCipher key — and a two-tier session where the session row persists but the derived key lives only in a TTL map in process memory.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Vitest 3, `better-sqlite3-multiple-ciphers`, `@node-rs/argon2`, bash (hooks).

**Spec:** `docs/superpowers/specs/2026-08-10-step1-auth-and-test-gate-design.md`

## Global Constraints

- Node 22. Pinned in `package.json` `engines`; the server compiles native modules against it.
- All dev and testing runs on synthetic data only. The only database filename that may be opened locally is `synthetic.db` — the guard hook matches on basename.
- Derived keys exist only in the in-process TTL map — never serialized, persisted, logged, or written to the sessions table. Passwords and keys never appear in cookies, localStorage, URLs, or any persisted artifact.
- Key map: idle TTL 4 hours refreshed on activity; absolute ceiling 12 hours from unlock, not refreshable; wiped on explicit logout.
- `/[user]/…` returns 404, never 403, when the session does not own the slug.
- `transcripts` and `metrics` are append-only, enforced by SQLite triggers.
- Tests are `*.test.ts` under `tests/`, `modules/tests/`, or `users/*/tests/`.
- Every commit from Task 5 onward must satisfy Gate B. The `git add` lines in each Commit step are exact for this reason.
- Never commit a `.db` file. `.gitignore` already covers them.

---

## File Structure

**Hooks (modified):**
- `.githooks/pre-commit` — Gate A generalized to a pattern table; Gate B added as a second sourceable function.
- `.claude/hooks/test-hooks.sh` — gate group grows from 11 cases to ~45.

**Tooling (created):**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts` — all Gate B-exempt.

**Platform data:**
- `platform/schema.sql` — accounts, sessions, transcripts, metrics, requests + append-only triggers.
- `platform/seed.ts` — exports `seedPlatform(targetPath)`.
- `lib/db/platform.ts` — connection open/close, migration application.
- `lib/db/appendOnly.ts` — append and read functions for transcripts/metrics. No update or delete.

**Auth and session:**
- `lib/auth/password.ts` — `hashPassword`, `verifyPassword`, `deriveDbKey`.
- `lib/auth/accounts.ts` — account lookup and creation.
- `lib/session/keymap.ts` — the TTL key map.
- `lib/session/store.ts` — session rows and cookie handling.
- `middleware.ts` — three-state routing.

**Routes:**
- `app/(auth)/login/page.tsx`, `app/api/login/route.ts`
- `app/(auth)/unlock/page.tsx`, `app/api/unlock/route.ts`
- `app/api/logout/route.ts`
- `app/[user]/page.tsx`
- `app/admin/page.tsx`

**Tests:**
- `tests/support/synthetic.ts` — `regeneratePlatform`, `regenerateUser`.
- `tests/db/appendOnly.test.ts`, `tests/support/noCross.test.ts`
- `tests/auth/password.test.ts`, `tests/session/keymap.test.ts`, `tests/session/store.test.ts`
- `tests/routing/middleware.test.ts`, `tests/routing/userSpace.test.ts`, `tests/routing/admin.test.ts`

**Docs (modified):** `CLAUDE.md`, `architecture-overview.md`

---

### Task 1: Toolchain and test layout

No application code — this task creates only Gate B-exempt config plus the test tree the gate's scope table will name. The gate does not exist yet.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `tests/smoke.test.ts`, `modules/tests/.gitkeep`

**Interfaces:**
- Consumes: nothing.
- Produces: `npx vitest run` as the test command; `npx vitest run <path>` for scoped runs.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "stairwell",
  "private": true,
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "better-sqlite3-multiple-ciphers": "^11.7.0",
    "@node-rs/argon2": "^2.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "preserve",
    "incremental": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'modules/tests/**/*.test.ts',
      'users/*/tests/**/*.test.ts',
    ],
    environment: 'node',
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
```

- [ ] **Step 4: Write the smoke test**

```ts
// tests/smoke.test.ts
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Install and run**

```bash
npm install
npx vitest run
```

Expected: 1 passed. If `better-sqlite3-multiple-ciphers` fails to build, that is a native toolchain problem, not a plan problem — install Xcode command line tools and retry.

- [ ] **Step 6: Create the modules test directory placeholder**

```bash
mkdir -p modules/tests && touch modules/tests/.gitkeep
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests/smoke.test.ts modules/tests/.gitkeep
git commit -m "Add Node toolchain and Vitest test layout"
```

---

### Task 2: Gate A — the platform schema pattern

Generalize `check_schema_drift` from a hardcoded `users/*` case to a two-row pattern table. All 11 existing verdicts must survive unchanged.

**Files:**
- Modify: `.githooks/pre-commit:22-85`
- Modify: `.claude/hooks/test-hooks.sh:167-188` (add cases after the existing block)

**Interfaces:**
- Consumes: nothing.
- Produces: `check_schema_drift <staged paths...>` — exit 0 allows, exit 1 blocks. Sourceable via `SCHEMA_GATE_SOURCE_ONLY=1`. Signature unchanged.

- [ ] **Step 1: Write the failing harness cases**

Add to `.claude/hooks/test-hooks.sh`, immediately after the existing `gate_check BLOCK "schema + unrelated same-user file"` line and before the closing `fi`:

```bash
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
```

- [ ] **Step 2: Run the harness to verify the new cases fail**

```bash
.claude/hooks/test-hooks.sh
```

Expected: FAIL on `platform schema alone` (got PASS, want BLOCK), `platform schema + user tests/`, `platform schema + platform doc`, and `platform unsatisfied, user satisfied`. The four PASS-expecting new cases already pass, because the current gate ignores `platform/` entirely.

- [ ] **Step 3: Replace the body of `check_schema_drift`**

In `.githooks/pre-commit`, replace lines 22–85 (the whole function) with:

```bash
check_schema_drift() {
  [ $# -eq 0 ] && return 0

  local f g user satisfied label seed tests_prefix
  local blocked=""

  for f in "$@"; do
    # Pattern table. Each staged schema names the exact generator and the
    # tests/ prefix that satisfy it. Matching is per-scope and strict:
    # users/alice is never satisfied by users/bob, and neither is satisfied
    # by platform.
    case "$f" in
      users/*/schema.sql)
        user=${f#users/}
        user=${user%%/*}
        # Reconstructing the path keeps deeper paths from matching loosely.
        [ "users/$user/schema.sql" = "$f" ] || continue
        label="users/$user"
        seed="users/$user/seed.py"
        tests_prefix="users/$user/tests/"
        ;;
      platform/schema.sql)
        label="platform"
        seed="platform/seed.ts"
        tests_prefix="tests/"
        ;;
      *)
        continue
        ;;
    esac

    satisfied=0
    for g in "$@"; do
      if [ "$g" = "$seed" ]; then
        satisfied=1
        break
      fi
      case "$g" in
        "$tests_prefix"*)
          satisfied=1
          break
          ;;
      esac
    done

    if [ $satisfied -eq 0 ]; then
      case " $blocked " in
        *" $label "*) ;;
        *) blocked="$blocked $label" ;;
      esac
    fi
  done

  [ -z "$blocked" ] && return 0

  {
    echo
    echo "COMMIT BLOCKED — schema drift"
    echo
    echo "CLAUDE.md > Schema & module rules:"
    echo "  \"schema.sql + seed.py + tests/ update in the SAME commit. No drift.\""
    echo
    for label in $blocked; do
      echo "  $label/schema.sql is staged, but nothing else for '$label' is."
      echo "    Stage one of these in the same commit:"
      case "$label" in
        platform)
          echo "      platform/seed.ts"
          echo "      tests/..."
          ;;
        *)
          echo "      $label/seed.py"
          echo "      $label/tests/..."
          ;;
      esac
      echo
    done
    echo "A change to another scope does not satisfy this — the match is per-scope."
    echo
    echo "git commit --no-verify bypasses this gate for genuine exceptions,"
    echo "but that should be rare. Prefer staging the companion change."
    echo
  } >&2

  return 1
}
```

- [ ] **Step 4: Update the fast path**

Replace lines 96–100 of `.githooks/pre-commit` (the `grep -q '/schema\.sql$'` fast path) with:

```bash
# Fast path: most commits touch no schema.sql at all. Bail out immediately so
# the gate costs one git call. Gate B replaces this block in Task 3.
if ! git diff --cached --name-only --diff-filter=ACMR | grep -q '/schema\.sql$'; then
  exit 0
fi
```

This is unchanged in behaviour — `platform/schema.sql` already matches `/schema.sql$`. It is called out so the next task's edit lands in a known place.

- [ ] **Step 5: Run the harness to verify all cases pass**

```bash
.claude/hooks/test-hooks.sh
```

Expected: all checks pass, 19 in the gate group.

- [ ] **Step 6: Commit**

The `guards` scope does not exist yet, so this commit is governed only by Gate A, which no staged path triggers.

```bash
git add .githooks/pre-commit .claude/hooks/test-hooks.sh
git commit -m "Extend anti-drift gate to the platform scope

platform/schema.sql now requires platform/seed.ts or tests/ in the same
commit, matching the per-user rule. Generalizes check_schema_drift from a
hardcoded users/* case to a pattern table. All 11 existing verdicts are
unchanged; 8 cases added."
```

---

### Task 3: Gate B — test coverage

**Files:**
- Modify: `.githooks/pre-commit` (add `_gate_b_class` and `check_test_coverage`; replace the main block)
- Modify: `.claude/hooks/test-hooks.sh` (add a `coverage_check` helper and its cases)

**Interfaces:**
- Consumes: nothing from Task 2 — the gates are independent.
- Produces: `check_test_coverage <staged paths...>` — exit 0 allows, exit 1 blocks. Sourceable under the same `SCHEMA_GATE_SOURCE_ONLY=1` flag. Also `_gate_b_class <path>` printing one of `exempt`, `test:<scope>`, `guard:<scope>`, `unguarded`.

- [ ] **Step 1: Write the failing harness cases**

Add to `.claude/hooks/test-hooks.sh`, after the Gate A block's closing `fi` and before the final tally:

```bash
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
  coverage_check BLOCK "platform/ code alone" \
    platform/migrate.ts
  coverage_check PASS  "docs only" \
    README.md docs/superpowers/specs/x.md architecture-overview.md
  coverage_check PASS  "styling only" \
    "app/globals.css" public/logo.svg
  coverage_check PASS  "config only" \
    package.json next.config.ts tsconfig.json vitest.config.ts .gitignore
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
fi
echo
```

- [ ] **Step 2: Run the harness to verify the new group fails**

```bash
.claude/hooks/test-hooks.sh
```

Expected: every Gate B case errors, because `check_test_coverage` is not defined — the subshell fails, `rc` is nonzero, so all report `BLOCK`. The 11 PASS-expecting cases fail loudly. That is the correct starting state.

- [ ] **Step 3: Add the classifier to `.githooks/pre-commit`**

Insert after `check_schema_drift`'s closing brace, before the `SCHEMA_GATE_SOURCE_ONLY` guard:

```bash
# ---------------------------------------------------------------------------
# Gate B — test coverage.
#
# CLAUDE.md > Testing: "Changes to data logic (queries, panels, derived
# tables) require test changes in the same commit. Pure styling/copy changes
# do not."
#
# Each staged path classifies as exempt, a test, or guarded. A guarded scope
# with no staged test IN ITS OWN SCOPE blocks the commit.
# ---------------------------------------------------------------------------

# _gate_b_class <path>
#   prints: exempt | test:<scope> | guard:<scope> | unguarded
_gate_b_class() {
  local p=$1 u

  # Docs first: a .md is never a test, even under tests/.
  case "$p" in
    *.md|docs/*|LICENSE) echo "exempt"; return ;;
  esac

  # Test paths, which satisfy their own scope.
  case "$p" in
    tests/*) echo "test:platform"; return ;;
    modules/tests/*) echo "test:modules"; return ;;
    .claude/hooks/test-hooks.sh) echo "test:guards"; return ;;
    users/*/tests/*)
      u=${p#users/}
      u=${u%%/*}
      echo "test:user:$u"
      return
      ;;
  esac

  # Gate A's territory. Exempt here so the two gates do not overlap: without
  # this, Gate B would force tests/ for platform/schema.sql and kill Gate A's
  # seed branch, and would break the existing "schema + same-user seed.py"
  # verdict.
  case "$p" in
    schema.sql|*/schema.sql|platform/seed.ts|users/*/seed.py) echo "exempt"; return ;;
  esac

  # Styling, assets, and config.
  case "$p" in
    *.css|*.scss|*.svg|public/*|mockup.html|*/mockup.html) echo "exempt"; return ;;
    *.json|*.yml|*.yaml|*.toml) echo "exempt"; return ;;
    next.config.*|vitest.config.*|tsconfig*|Caddyfile|.gitignore|setup.sh|deploy/*) echo "exempt"; return ;;
  esac

  # Guarded scopes.
  case "$p" in
    app/*|lib/*|platform/*|middleware.ts) echo "guard:platform"; return ;;
    modules/*) echo "guard:modules"; return ;;
    .githooks/*|.claude/hooks/*) echo "guard:guards"; return ;;
    users/*/*)
      u=${p#users/}
      u=${u%%/*}
      echo "guard:user:$u"
      return
      ;;
  esac

  echo "unguarded"
}
```

- [ ] **Step 4: Add `check_test_coverage`**

Insert immediately after `_gate_b_class`:

```bash
# check_test_coverage <staged paths...>
#   exit 0 = allow commit, exit 1 = block (message on stderr)
check_test_coverage() {
  [ $# -eq 0 ] && return 0

  local p class scope
  local guarded="" satisfied="" untested="" unsatisfied=""

  for p in "$@"; do
    class=$(_gate_b_class "$p")
    case "$class" in
      test:*)
        scope=${class#test:}
        case " $satisfied " in
          *" $scope "*) ;;
          *) satisfied="$satisfied $scope" ;;
        esac
        ;;
      guard:*)
        scope=${class#guard:}
        case " $guarded " in
          *" $scope "*) ;;
          *) guarded="$guarded $scope" ;;
        esac
        untested="${untested}${scope} ${p}
"
        ;;
    esac
  done

  for scope in $guarded; do
    case " $satisfied " in
      *" $scope "*) ;;
      *) unsatisfied="$unsatisfied $scope" ;;
    esac
  done

  [ -z "$unsatisfied" ] && return 0

  {
    echo
    echo "COMMIT BLOCKED — untested change"
    echo
    echo "CLAUDE.md > Testing:"
    echo "  \"Changes to data logic (queries, panels, derived tables) require"
    echo "   test changes in the same commit.\""
    echo
    for scope in $unsatisfied; do
      echo "  scope '$scope' has guarded changes and no staged test:"
      printf '%s' "$untested" | while IFS=' ' read -r s f; do
        [ "$s" = "$scope" ] && echo "      $f"
      done
      case "$scope" in
        platform) echo "    Satisfy it by staging a test under: tests/" ;;
        modules)  echo "    Satisfy it by staging a test under: modules/tests/" ;;
        guards)   echo "    Satisfy it by staging: .claude/hooks/test-hooks.sh" ;;
        user:*)   echo "    Satisfy it by staging a test under: users/${scope#user:}/tests/" ;;
      esac
      echo
    done
    echo "Pure styling or copy changes are exempt by path. If this change is one"
    echo "of those and the path cannot say so, re-run with:"
    echo "  SKIP_TEST_GATE=1 git commit ..."
    echo
  } >&2

  return 1
}
```

- [ ] **Step 5: Replace the main block to run both gates**

Replace everything in `.githooks/pre-commit` from the fast-path comment through the `check_schema_drift` call (lines 96–107 as edited in Task 2) with:

```bash
files=()
while IFS= read -r line; do
  [ -n "$line" ] && files+=("$line")
done < <(git diff --cached --name-only --diff-filter=ACMR)

# Both gates run; both failures are reported before exiting, so a commit that
# trips each one does not require two round trips to discover that.
rc=0
check_schema_drift ${files[@]+"${files[@]}"} || rc=1
check_test_coverage ${files[@]+"${files[@]}"} || rc=1
[ $rc -ne 0 ] && exit 1

# Required. Without it the script's exit status is that of the test above,
# which is 1 when rc is 0 — the hook would block every valid commit.
exit 0
```

The `grep` fast path is removed: Gate B has to classify every staged path, so there is nothing to skip. The hook still makes exactly one `git` call.

- [ ] **Step 6: Run the harness**

```bash
.claude/hooks/test-hooks.sh
```

Expected: all checks pass. Gate group is now ~45.

- [ ] **Step 7: Verify the gate blocks a real commit**

```bash
mkdir -p lib/tmpcheck && echo 'export const x = 1' > lib/tmpcheck/probe.ts
git add lib/tmpcheck/probe.ts
git commit -m "probe"
```

Expected: BLOCKED, naming `lib/tmpcheck/probe.ts` under scope `platform`.

```bash
git restore --staged lib/tmpcheck/probe.ts && rm -rf lib/tmpcheck
```

- [ ] **Step 8: Commit**

```bash
git add .githooks/pre-commit .claude/hooks/test-hooks.sh
git commit -m "Add Gate B: guarded changes require same-scope tests

Scopes: platform (app/, lib/, platform/, middleware.ts -> tests/),
modules, user:<name>, and guards (.githooks, .claude/hooks ->
test-hooks.sh). Docs, styling, and config are exempt by path.

schema.sql and the seed generators are exempt from Gate B and left to
Gate A, so the two gates do not overlap and every existing verdict is
preserved."
```

---

### Task 4: The skip must announce itself

**Files:**
- Modify: `.githooks/pre-commit` (`check_test_coverage`)
- Modify: `.claude/hooks/test-hooks.sh` (two skip cases)
- Modify: `CLAUDE.md` (Data safety and Testing sections)

**Interfaces:**
- Consumes: `check_test_coverage` from Task 3.
- Produces: `SKIP_TEST_GATE=1` behaviour — returns 0 but prints the untested guarded files to stderr, and prints nothing when nothing would have blocked.

- [ ] **Step 1: Write the failing harness cases**

Add after the last `coverage_check` in the Gate B block:

```bash
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
```

- [ ] **Step 2: Run the harness to verify the new cases fail**

```bash
.claude/hooks/test-hooks.sh
```

Expected: `SKIP_TEST_GATE turns block into pass` fails (got BLOCK, want PASS), and both `skip_says` cases fail. The two `skip_silent` cases already pass, since a non-blocking call returns early and prints nothing.

- [ ] **Step 3: Add the skip branch**

In `check_test_coverage`, replace the line `[ -z "$unsatisfied" ] && return 0` and the block that follows it, inserting the skip branch between them:

```bash
  [ -z "$unsatisfied" ] && return 0

  # An announced skip. Printed only when the gate WOULD have blocked, so a
  # SKIP_TEST_GATE exported in a shell profile cannot produce noise that
  # trains the eye to ignore it.
  if [ "${SKIP_TEST_GATE:-0}" = "1" ]; then
    {
      echo
      echo "Gate B SKIPPED (SKIP_TEST_GATE=1) — these guarded files ship untested:"
      for scope in $unsatisfied; do
        printf '%s' "$untested" | while IFS=' ' read -r s f; do
          [ "$s" = "$scope" ] && printf '  %-11s %s\n' "$scope:" "$f"
        done
      done
      echo
      echo "CLAUDE.md > Testing: state the reason for the skip in the commit message."
      echo
    } >&2
    return 0
  fi
```

- [ ] **Step 4: Run the harness**

```bash
.claude/hooks/test-hooks.sh
```

Expected: all pass.

- [ ] **Step 5: Update `CLAUDE.md`**

Add to the **Data safety (hard rules)** section, as a new bullet after the "Never log, commit, or write real user data" bullet:

```markdown
- Derived keys exist only in the in-process TTL map — never serialized,
  persisted, logged, or written to the sessions table. Passwords and keys
  never appear in cookies, localStorage, URLs, or any persisted artifact.
```

Replace the **Testing** section with:

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add .githooks/pre-commit .claude/hooks/test-hooks.sh CLAUDE.md
git commit -m "Announce Gate B skips and document both gates

SKIP_TEST_GATE=1 now prints the guarded files that shipped untested,
grouped by scope, and only when the gate would have blocked - so the
variable being exported cannot produce noise.

CLAUDE.md gains the derived-key rule and the gate scope table."
```

---

### Task 5: Next.js scaffold — first traffic through Gate B

**Files:**
- Create: `next.config.ts`, `app/layout.tsx`, `app/page.tsx`
- Create: `tests/routing/root.test.ts`

**Interfaces:**
- Consumes: the Vitest config from Task 1.
- Produces: a running Next.js app on `localhost:3000`.

This is the first commit where `app/` is staged with the gate live. It must stage a test.

- [ ] **Step 1: Write the failing test**

```ts
// tests/routing/root.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('app shell', () => {
  it('sets a root layout with an html and body element', () => {
    const layout = readFileSync('app/layout.tsx', 'utf8')
    expect(layout).toContain('<html')
    expect(layout).toContain('<body')
  })

  it('does not ship a default Next.js landing page', () => {
    const page = readFileSync('app/page.tsx', 'utf8')
    expect(page).not.toContain('nextjs.org')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/routing/root.test.ts
```

Expected: FAIL — `ENOENT: no such file or directory, open 'app/layout.tsx'`.

- [ ] **Step 3: Create the app shell**

```ts
// next.config.ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3-multiple-ciphers'],
}

export default config
```

```tsx
// app/layout.tsx
export const metadata = { title: 'Stairwell' }

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

```tsx
// app/page.tsx
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/login')
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/routing/root.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Verify the app boots**

```bash
npm run dev
```

Expected: ready on `http://localhost:3000`. Visiting it redirects to `/login`, which 404s — there is no login route yet. That is correct at this point. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add next.config.ts app/layout.tsx app/page.tsx tests/routing/root.test.ts
git commit -m "Add Next.js app shell"
```

If this commit is blocked, Gate B is wrong — `tests/routing/root.test.ts` satisfies the `platform` scope. Fix the gate before continuing.

---

### Task 6: Platform schema with append-only triggers

**Files:**
- Create: `platform/schema.sql`, `lib/db/platform.ts`, `lib/db/appendOnly.ts`
- Create: `tests/db/appendOnly.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openPlatformDb(path: string): Database` — applies `platform/schema.sql`, returns a `better-sqlite3-multiple-ciphers` handle.
  - `appendTranscript(db, { accountId, role, body, at }): void`
  - `appendMetric(db, { accountId, event, at }): void`
  - `readTranscript(db, accountId): TranscriptRow[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/appendOnly.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('append-only tables', () => {
  it('accepts appends and reads them back', () => {
    appendTranscript(db, { accountId: 1, role: 'user', body: 'hello', at: 100 })
    expect(readTranscript(db, 1)).toHaveLength(1)
  })

  it('refuses UPDATE on transcripts', () => {
    appendTranscript(db, { accountId: 1, role: 'user', body: 'hello', at: 100 })
    expect(() =>
      db.prepare("UPDATE transcripts SET body = 'edited'").run(),
    ).toThrow(/append-only/)
  })

  it('refuses DELETE on transcripts', () => {
    appendTranscript(db, { accountId: 1, role: 'user', body: 'hello', at: 100 })
    expect(() => db.prepare('DELETE FROM transcripts').run()).toThrow(
      /append-only/,
    )
  })

  it('refuses UPDATE on metrics', () => {
    db.prepare(
      "INSERT INTO metrics (account_id, event, at) VALUES (1, 'open', 100)",
    ).run()
    expect(() =>
      db.prepare("UPDATE metrics SET event = 'edited'").run(),
    ).toThrow(/append-only/)
  })

  it('refuses DELETE on metrics', () => {
    db.prepare(
      "INSERT INTO metrics (account_id, event, at) VALUES (1, 'open', 100)",
    ).run()
    expect(() => db.prepare('DELETE FROM metrics').run()).toThrow(/append-only/)
  })

  it('has no UPDATE or DELETE against those tables anywhere in lib/db', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk('lib/db')
    const offending = /(UPDATE|DELETE\s+FROM)\s+(transcripts|metrics)\b/i
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), `${f} mutates a sacred table`).not.toMatch(
        offending,
      )
    }
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/db/appendOnly.test.ts
```

Expected: FAIL — cannot resolve `@/lib/db/platform`.

- [ ] **Step 3: Write `platform/schema.sql`**

```sql
-- Platform database. Accounts, sessions, and the sacred append-only logs.
-- Not encrypted with any user key: these are the records Nico is promised
-- access to at onboarding. Per-user data lives in the user's own encrypted
-- database (architecture-overview.md section 4).

CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL UNIQUE,
  role       TEXT    NOT NULL CHECK (role IN ('user', 'admin')),
  auth_hash  TEXT    NOT NULL,
  salt_auth  BLOB    NOT NULL,
  salt_key   BLOB    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);

-- Sacred data. CLAUDE.md > Sacred data: append-only, never migrated,
-- rewritten, or cleaned up. Enforced below in the database itself rather
-- than by convention in the data layer.
CREATE TABLE IF NOT EXISTS transcripts (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  role       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transcripts_account ON transcripts(account_id, at);

CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER,
  event      TEXT    NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS metrics_at ON metrics(at);

CREATE TABLE IF NOT EXISTS requests (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  body       TEXT    NOT NULL,
  at         INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS transcripts_no_update
BEFORE UPDATE ON transcripts
BEGIN
  SELECT RAISE(ABORT, 'transcripts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS transcripts_no_delete
BEFORE DELETE ON transcripts
BEGIN
  SELECT RAISE(ABORT, 'transcripts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS metrics_no_update
BEFORE UPDATE ON metrics
BEGIN
  SELECT RAISE(ABORT, 'metrics is append-only');
END;

CREATE TRIGGER IF NOT EXISTS metrics_no_delete
BEFORE DELETE ON metrics
BEGIN
  SELECT RAISE(ABORT, 'metrics is append-only');
END;
```

- [ ] **Step 4: Write `lib/db/platform.ts`**

```ts
import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type PlatformDb = Database.Database

const SCHEMA = resolve(process.cwd(), 'platform/schema.sql')

/**
 * Open the platform database at an explicit path and apply the schema.
 *
 * The path is always explicit. There is no ambient default, so a test can
 * never accidentally open the production file, and production can never
 * accidentally open a synthetic one.
 */
export function openPlatformDb(path: string): PlatformDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(SCHEMA, 'utf8'))
  return db
}
```

- [ ] **Step 5: Write `lib/db/appendOnly.ts`**

```ts
import type { PlatformDb } from './platform'

export type TranscriptRow = {
  id: number
  account_id: number
  role: string
  body: string
  at: number
}

/**
 * transcripts and metrics are append-only (CLAUDE.md > Sacred data). This
 * module exposes appends and reads and nothing else. The database enforces
 * the same rule with triggers, so a mistake here fails loudly rather than
 * silently rewriting history.
 */
export function appendTranscript(
  db: PlatformDb,
  row: { accountId: number; role: string; body: string; at: number },
): void {
  db.prepare(
    'INSERT INTO transcripts (account_id, role, body, at) VALUES (?, ?, ?, ?)',
  ).run(row.accountId, row.role, row.body, row.at)
}

export function readTranscript(
  db: PlatformDb,
  accountId: number,
): TranscriptRow[] {
  return db
    .prepare('SELECT * FROM transcripts WHERE account_id = ? ORDER BY at')
    .all(accountId) as TranscriptRow[]
}

export function appendMetric(
  db: PlatformDb,
  row: { accountId: number | null; event: string; at: number },
): void {
  db.prepare(
    'INSERT INTO metrics (account_id, event, at) VALUES (?, ?, ?)',
  ).run(row.accountId, row.event, row.at)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/db/appendOnly.test.ts
```

Expected: 6 passed.

- [ ] **Step 7: Commit**

`platform/schema.sql` triggers Gate A, satisfied by `tests/`. `lib/db/*` triggers Gate B's platform scope, satisfied by the same test.

```bash
git add platform/schema.sql lib/db/platform.ts lib/db/appendOnly.ts tests/db/appendOnly.test.ts
git commit -m "Add platform schema with append-only triggers

transcripts and metrics reject UPDATE and DELETE in the database itself,
not by convention. A test attempts both and asserts the abort, and a
second test scans lib/db for statements that would mutate them."
```

---

### Task 7: Synthetic regeneration that cannot cross

**Files:**
- Create: `platform/seed.ts`, `tests/support/synthetic.ts`
- Create: `tests/support/noCross.test.ts`

**Interfaces:**
- Consumes: `openPlatformDb` from Task 6.
- Produces:
  - `seedPlatform(targetPath: string): void`
  - `regeneratePlatform(targetPath?: string): string` — defaults to `platform/dev/synthetic.db`, returns the path written.
  - `regenerateUser(name: string, opts?: { root?: string }): string` — runs `users/<name>/seed.py`, returns the path written.

- [ ] **Step 1: Write the failing test**

The non-crossing assertion needs a second generator, and there is no real user folder at this step. The test builds a throwaway user under a temp root rather than committing a fixture user to the repo.

```ts
// tests/support/noCross.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { regeneratePlatform, regenerateUser } from './synthetic'

let root: string
let platformTarget: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-cross-'))
  platformTarget = join(root, 'platform', 'dev', 'synthetic.db')
  mkdirSync(join(root, 'platform', 'dev'), { recursive: true })
  mkdirSync(join(root, 'users', 'testgen'), { recursive: true })
  writeFileSync(
    join(root, 'users', 'testgen', 'seed.py'),
    [
      'import sqlite3, sys',
      'db = sqlite3.connect(sys.argv[1])',
      'db.execute("CREATE TABLE IF NOT EXISTS spend (merchant TEXT)")',
      'db.execute("INSERT INTO spend VALUES (\'COFFEE PALACE TEST\')")',
      'db.commit()',
      '',
    ].join('\n'),
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('synthetic regeneration', () => {
  it('writes the platform database to its own target', () => {
    const written = regeneratePlatform(platformTarget)
    expect(written).toBe(platformTarget)
  })

  it('regenerating a user leaves the platform database byte-identical', () => {
    regeneratePlatform(platformTarget)
    const before = readFileSync(platformTarget)

    regenerateUser('testgen', { root })

    expect(readFileSync(platformTarget).equals(before)).toBe(true)
  })

  it('regenerating the platform leaves the user database byte-identical', () => {
    const userTarget = regenerateUser('testgen', { root })
    const before = readFileSync(userTarget)

    regeneratePlatform(platformTarget)

    expect(readFileSync(userTarget).equals(before)).toBe(true)
  })

  it('writes the user database inside that user folder and nowhere else', () => {
    const userTarget = regenerateUser('testgen', { root })
    expect(userTarget).toBe(join(root, 'users', 'testgen', 'synthetic.db'))
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/support/noCross.test.ts
```

Expected: FAIL — cannot resolve `./synthetic`.

- [ ] **Step 3: Write `platform/seed.ts`**

```ts
import { openPlatformDb } from '@/lib/db/platform'

/**
 * Generate the synthetic platform database at an explicit path.
 *
 * Loud fake values only (CLAUDE.md > Data safety): anything rendered from
 * this data must read as obviously fake at a glance.
 */
export function seedPlatform(targetPath: string): void {
  const db = openPlatformDb(targetPath)
  try {
    db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM accounts').run()
    // Accounts are seeded by the account helper in production. Here the rows
    // exist only so a dev session has something to log in as; the hashes are
    // placeholders replaced by Task 8's helper when dev users are created.
    db.prepare(
      `INSERT INTO accounts (slug, role, auth_hash, salt_auth, salt_key, created_at)
       VALUES ('devuser-test', 'user', 'PLACEHOLDER-TEST', x'00', x'00', 0)`,
    ).run()
  } finally {
    db.close()
  }
}
```

- [ ] **Step 4: Write `tests/support/synthetic.ts`**

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { seedPlatform } from '@/platform/seed'

const REPO = resolve(__dirname, '..', '..')

/**
 * Regenerate the synthetic platform database.
 *
 * The two regenerators below take explicit targets and share no default. A
 * user generator must never write the platform database and vice versa —
 * tests/support/noCross.test.ts asserts both directions.
 */
export function regeneratePlatform(
  targetPath: string = join(REPO, 'platform', 'dev', 'synthetic.db'),
): string {
  mkdirSync(dirname(targetPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${targetPath}${suffix}`, { force: true })
  }
  seedPlatform(targetPath)
  return targetPath
}

/** Regenerate one user's synthetic database by running that user's seed.py. */
export function regenerateUser(
  name: string,
  opts: { root?: string } = {},
): string {
  const root = opts.root ?? REPO
  const seed = join(root, 'users', name, 'seed.py')
  const target = join(root, 'users', name, 'synthetic.db')
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${target}${suffix}`, { force: true })
  }
  execFileSync('python3', [seed, target], { stdio: 'pipe' })
  return target
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/support/noCross.test.ts
```

Expected: 4 passed. If `python3` is not found, install it — `seed.py` generators are a decided part of the architecture.

- [ ] **Step 6: Confirm nothing was written into the repo**

```bash
git status --short
```

Expected: no `.db` files. `platform/dev/` should not exist yet — the tests wrote only into temp directories.

- [ ] **Step 7: Commit**

```bash
git add platform/seed.ts tests/support/synthetic.ts tests/support/noCross.test.ts
git commit -m "Add synthetic regeneration with no shared default target

regeneratePlatform and regenerateUser each take an explicit target. Tests
assert non-crossing in both directions: regenerating one leaves the other
byte-identical."
```

---

### Task 8: Password derivation with separated salts

**Files:**
- Create: `lib/auth/password.ts`
- Create: `tests/auth/password.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `newSalts(): { saltAuth: Buffer; saltKey: Buffer }`
  - `hashPassword(password: string, saltAuth: Buffer): Promise<string>`
  - `verifyPassword(hash: string, password: string): Promise<boolean>`
  - `deriveDbKey(password: string, saltKey: Buffer): Promise<Buffer>` — 32 bytes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/password.test.ts
import { describe, expect, it } from 'vitest'
import {
  deriveDbKey,
  hashPassword,
  newSalts,
  verifyPassword,
} from '@/lib/auth/password'

describe('password derivations', () => {
  it('verifies a correct password', async () => {
    const { saltAuth } = newSalts()
    const hash = await hashPassword('correct horse', saltAuth)
    expect(await verifyPassword(hash, 'correct horse')).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const { saltAuth } = newSalts()
    const hash = await hashPassword('correct horse', saltAuth)
    expect(await verifyPassword(hash, 'wrong horse')).toBe(false)
  })

  it('derives a 32-byte key', async () => {
    const { saltKey } = newSalts()
    const key = await deriveDbKey('correct horse', saltKey)
    expect(key).toHaveLength(32)
  })

  it('derives the same key for the same password and salt', async () => {
    const { saltKey } = newSalts()
    const a = await deriveDbKey('correct horse', saltKey)
    const b = await deriveDbKey('correct horse', saltKey)
    expect(a.equals(b)).toBe(true)
  })

  it('uses different salts, so the key is not recoverable from the hash', async () => {
    const { saltAuth, saltKey } = newSalts()
    expect(saltAuth.equals(saltKey)).toBe(false)

    const hash = await hashPassword('correct horse', saltAuth)
    const key = await deriveDbKey('correct horse', saltKey)

    // The stored verifier must not contain the key material in any form.
    expect(hash).not.toContain(key.toString('hex'))
    expect(hash).not.toContain(key.toString('base64'))
  })

  it('gives different salts on every call', () => {
    const a = newSalts()
    const b = newSalts()
    expect(a.saltAuth.equals(b.saltAuth)).toBe(false)
    expect(a.saltKey.equals(b.saltKey)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/auth/password.test.ts
```

Expected: FAIL — cannot resolve `@/lib/auth/password`.

- [ ] **Step 3: Write `lib/auth/password.ts`**

```ts
import { hash, verify, Algorithm } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'

/**
 * One password, two derivations, two salts.
 *
 * auth_hash verifies the login and is stored. db_key unlocks the user's
 * SQLCipher database and is NEVER stored — it exists only in the in-process
 * TTL map (CLAUDE.md > Data safety). The salts differ so that the stored
 * verifier gets an attacker no closer to the key.
 */

const OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export function newSalts(): { saltAuth: Buffer; saltKey: Buffer } {
  return { saltAuth: randomBytes(16), saltKey: randomBytes(16) }
}

export async function hashPassword(
  password: string,
  saltAuth: Buffer,
): Promise<string> {
  return hash(password, { ...OPTS, salt: saltAuth })
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password)
  } catch {
    return false
  }
}

export async function deriveDbKey(
  password: string,
  saltKey: Buffer,
): Promise<Buffer> {
  const encoded = await hash(password, { ...OPTS, salt: saltKey })
  // The encoded form is `$argon2id$...$<salt>$<hash>`; take the raw digest.
  const digest = encoded.slice(encoded.lastIndexOf('$') + 1)
  return Buffer.from(digest, 'base64').subarray(0, 32)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/auth/password.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/password.ts tests/auth/password.test.ts
git commit -m "Add Argon2id password verifier and SQLCipher key derivation

Separate salts for the two derivations, so the stored verifier gets an
attacker no closer to the key. The key is returned, never stored."
```

---

### Task 9: The TTL key map

**Files:**
- Create: `lib/session/keymap.ts`
- Create: `tests/session/keymap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `putKey(sessionId: string, key: Buffer): void`
  - `getKey(sessionId: string): Buffer | undefined` — refreshes idle timer on hit.
  - `dropKey(sessionId: string): void`
  - `sweep(): void`
  - `IDLE_TTL_MS` (4h), `ABSOLUTE_TTL_MS` (12h)

- [ ] **Step 1: Write the failing test**

```ts
// tests/session/keymap.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  dropKey,
  getKey,
  putKey,
} from '@/lib/session/keymap'

const KEY = Buffer.alloc(32, 7)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  dropKey('s1')
  vi.useRealTimers()
})

describe('key map lifetime', () => {
  it('returns a key that was just put', () => {
    putKey('s1', KEY)
    expect(getKey('s1')).toEqual(KEY)
  })

  it('expires after the idle TTL', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS + 1)
    expect(getKey('s1')).toBeUndefined()
  })

  it('refreshes the idle timer on access', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS - 1000)
    expect(getKey('s1')).toEqual(KEY)
    vi.advanceTimersByTime(IDLE_TTL_MS - 1000)
    expect(getKey('s1')).toEqual(KEY)
  })

  it('expires at the absolute ceiling even when constantly refreshed', () => {
    putKey('s1', KEY)
    // Touch it every hour. Idle TTL never elapses, but the ceiling still wins.
    for (let elapsed = 0; elapsed < ABSOLUTE_TTL_MS; elapsed += 3_600_000) {
      vi.advanceTimersByTime(3_600_000)
      getKey('s1')
    }
    vi.advanceTimersByTime(1000)
    expect(getKey('s1')).toBeUndefined()
  })

  it('cannot survive from one morning to the next', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(24 * 3_600_000)
    expect(getKey('s1')).toBeUndefined()
  })

  it('drops immediately on logout', () => {
    putKey('s1', KEY)
    dropKey('s1')
    expect(getKey('s1')).toBeUndefined()
  })

  it('restarts the ceiling on re-unlock', () => {
    putKey('s1', KEY)
    vi.advanceTimersByTime(1000)
    putKey('s1', KEY)
    // A re-unlock is a fresh unlock: the ceiling restarts. Re-entering the
    // password is the thing that earns a new 12 hours, which is exactly the
    // property getKey's refresh must NOT have.
    vi.advanceTimersByTime(ABSOLUTE_TTL_MS - 2000)
    expect(getKey('s1')).toEqual(KEY)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/session/keymap.test.ts
```

Expected: FAIL — cannot resolve `@/lib/session/keymap`.

- [ ] **Step 3: Write `lib/session/keymap.ts`**

```ts
/**
 * Derived SQLCipher keys, in process memory only.
 *
 * CLAUDE.md > Data safety: never serialized, persisted, logged, or written to
 * the sessions table. This module is the only place a key is held, and the
 * map dies with the process — which is why a deploy leaves users logged in
 * but locked (architecture spec section 2.3).
 *
 * The absolute ceiling exists because step 6 makes login the trigger for
 * Plaid sync. A key surviving overnight would turn "morning open -> sync"
 * into "morning open -> stale data".
 */

export const IDLE_TTL_MS = 4 * 60 * 60 * 1000
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000

type Entry = { key: Buffer; lastSeenAt: number; unlockedAt: number }

const keys = new Map<string, Entry>()

function alive(e: Entry, now: number): boolean {
  return (
    now - e.lastSeenAt <= IDLE_TTL_MS && now - e.unlockedAt <= ABSOLUTE_TTL_MS
  )
}

export function putKey(sessionId: string, key: Buffer): void {
  const now = Date.now()
  keys.set(sessionId, { key, lastSeenAt: now, unlockedAt: now })
}

export function getKey(sessionId: string): Buffer | undefined {
  const now = Date.now()
  const entry = keys.get(sessionId)
  if (!entry) return undefined
  if (!alive(entry, now)) {
    keys.delete(sessionId)
    return undefined
  }
  entry.lastSeenAt = now
  return entry.key
}

export function dropKey(sessionId: string): void {
  keys.delete(sessionId)
}

/** Drop expired entries so an idle process does not retain keys. */
export function sweep(): void {
  const now = Date.now()
  for (const [id, entry] of keys) {
    if (!alive(entry, now)) keys.delete(id)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/session/keymap.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/session/keymap.ts tests/session/keymap.test.ts
git commit -m "Add the in-memory key map with idle TTL and absolute ceiling

Idle TTL 4h refreshed on activity, absolute ceiling 12h that refreshing
cannot extend, wiped on logout. A key cannot survive from one morning to
the next, which is what keeps step 6's login-triggered sync honest."
```

---

### Task 10: Sessions and the cookie

**Files:**
- Create: `lib/session/store.ts`, `lib/auth/accounts.ts`
- Create: `tests/session/store.test.ts`

**Interfaces:**
- Consumes: `openPlatformDb` (Task 6), `hashPassword`/`verifyPassword`/`newSalts` (Task 8), `putKey`/`dropKey` (Task 9).
- Produces:
  - `createAccount(db, { slug, role, password }): Promise<number>`
  - `findAccountBySlug(db, slug): Account | undefined`
  - `createSession(db, accountId): string` — returns the session id.
  - `readSession(db, sessionId): Session | undefined` — undefined when expired.
  - `destroySession(db, sessionId): void` — also drops the key.
  - `SESSION_COOKIE = 'stairwell_session'`, `SESSION_TTL_MS` (30 days).

- [ ] **Step 1: Write the failing test**

```ts
// tests/session/store.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount, findAccountBySlug } from '@/lib/auth/accounts'
import {
  SESSION_TTL_MS,
  createSession,
  destroySession,
  readSession,
} from '@/lib/session/store'
import { getKey, putKey } from '@/lib/session/keymap'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-sess-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('accounts', () => {
  it('stores a verifier and two distinct salts', async () => {
    await createAccount(db, { slug: 'nico', role: 'admin', password: 'pw' })
    const account = findAccountBySlug(db, 'nico')
    expect(account).toBeDefined()
    expect(account!.salt_auth.equals(account!.salt_key)).toBe(false)
  })

  it('never stores the password', async () => {
    await createAccount(db, { slug: 'nico', role: 'user', password: 'hunter2' })
    const row = JSON.stringify(findAccountBySlug(db, 'nico'))
    expect(row).not.toContain('hunter2')
  })
})

describe('sessions', () => {
  it('round-trips a session', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    expect(readSession(db, sid)?.account_id).toBe(id)
  })

  it('returns undefined for an expired session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    vi.setSystemTime(SESSION_TTL_MS + 1)
    expect(readSession(db, sid)).toBeUndefined()
  })

  it('never writes key material into the sessions table', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 9))
    const row = JSON.stringify(db.prepare('SELECT * FROM sessions').all())
    expect(row).not.toContain(Buffer.alloc(32, 9).toString('hex'))
    expect(row).not.toContain('key')
  })

  it('drops the key when the session is destroyed', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 9))
    destroySession(db, sid)
    expect(getKey(sid)).toBeUndefined()
    expect(readSession(db, sid)).toBeUndefined()
  })

  it('issues unpredictable session ids', async () => {
    const id = await createAccount(db, {
      slug: 'a',
      role: 'user',
      password: 'pw',
    })
    const ids = new Set(
      Array.from({ length: 50 }, () => createSession(db, id)),
    )
    expect(ids.size).toBe(50)
    for (const sid of ids) expect(sid.length).toBeGreaterThanOrEqual(32)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/session/store.test.ts
```

Expected: FAIL — cannot resolve `@/lib/auth/accounts`.

- [ ] **Step 3: Write `lib/auth/accounts.ts`**

```ts
import type { PlatformDb } from '@/lib/db/platform'
import { hashPassword, newSalts, verifyPassword } from './password'

export type Account = {
  id: number
  slug: string
  role: 'user' | 'admin'
  auth_hash: string
  salt_auth: Buffer
  salt_key: Buffer
  created_at: number
}

export async function createAccount(
  db: PlatformDb,
  input: { slug: string; role: 'user' | 'admin'; password: string },
): Promise<number> {
  const { saltAuth, saltKey } = newSalts()
  const authHash = await hashPassword(input.password, saltAuth)
  const info = db
    .prepare(
      `INSERT INTO accounts (slug, role, auth_hash, salt_auth, salt_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.slug, input.role, authHash, saltAuth, saltKey, Date.now())
  return Number(info.lastInsertRowid)
}

export function findAccountBySlug(
  db: PlatformDb,
  slug: string,
): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE slug = ?').get(slug) as
    | Account
    | undefined
}

export async function checkPassword(
  account: Account,
  password: string,
): Promise<boolean> {
  return verifyPassword(account.auth_hash, password)
}
```

- [ ] **Step 4: Write `lib/session/store.ts`**

```ts
import { randomBytes } from 'node:crypto'
import type { PlatformDb } from '@/lib/db/platform'
import { dropKey } from './keymap'

export const SESSION_COOKIE = 'stairwell_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type Session = {
  id: string
  account_id: number
  created_at: number
  expires_at: number
}

/**
 * The session row carries identity and nothing else. The derived key lives in
 * lib/session/keymap.ts and is never written here — see CLAUDE.md > Data
 * safety.
 */
export function createSession(db: PlatformDb, accountId: number): string {
  const id = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare(
    'INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(id, accountId, now, now + SESSION_TTL_MS)
  return id
}

export function readSession(
  db: PlatformDb,
  sessionId: string,
): Session | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Session
    | undefined
  if (!row) return undefined
  if (row.expires_at <= Date.now()) return undefined
  return row
}

export function destroySession(db: PlatformDb, sessionId: string): void {
  dropKey(sessionId)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS / 1000,
} as const
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/session/store.test.ts
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add lib/auth/accounts.ts lib/session/store.ts tests/session/store.test.ts
git commit -m "Add accounts and persisted sessions

The session row carries identity only. A test asserts no key material
reaches the sessions table and that destroying a session drops the key."
```

---

### Task 11: Three-state routing

**Files:**
- Create: `lib/session/resolve.ts`, `lib/db/instance.ts`, `lib/session/guard.ts`, `middleware.ts`
- Create: `tests/routing/middleware.test.ts`

**Interfaces:**
- Consumes: `readSession` (Task 10), `getKey` (Task 9).
- Produces: `resolveState(db, sessionId | undefined): 'anonymous' | 'authenticated' | 'unlocked'`, `routeFor(state, pathname): string | null`, `redirectTargetFor(db, sessionId, pathname): string | null`, `getDb(): PlatformDb`, and `requireState(pathname): Promise<void>`.

The decision logic lives in `lib/session/resolve.ts` so it is testable without booting Next.js. `middleware.ts` and `lib/session/guard.ts` are thin adapters over it.

**Why the guard exists.** `middleware.ts` can only check cookie presence — the edge runtime cannot open SQLite. Without a server-side guard, an authenticated-but-locked session reaches a user space without unlocking, because `canSeeUserSpace` (Task 13) checks the session row and not the key. The guard is what makes the two-tier lock actually hold, and it is why Task 14's checkpoint step 8 passes for the right reason rather than by accident.

- [ ] **Step 1: Write the failing test**

```ts
// tests/routing/middleware.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { createSession } from '@/lib/session/store'
import { putKey } from '@/lib/session/keymap'
import { resolveState, routeFor } from '@/lib/session/resolve'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-route-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveState', () => {
  it('is anonymous with no cookie', () => {
    expect(resolveState(db, undefined)).toBe('anonymous')
  })

  it('is anonymous with an unknown session id', () => {
    expect(resolveState(db, 'nope')).toBe('anonymous')
  })

  it('is authenticated with a session but no key', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    expect(resolveState(db, sid)).toBe('authenticated')
  })

  it('is unlocked with a session and a key', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 1))
    expect(resolveState(db, sid)).toBe('unlocked')
  })
})

describe('routeFor', () => {
  it('sends anonymous users to login', () => {
    expect(routeFor('anonymous', '/nico')).toBe('/login')
    expect(routeFor('anonymous', '/admin')).toBe('/login')
  })

  it('lets anonymous users reach login', () => {
    expect(routeFor('anonymous', '/login')).toBeNull()
  })

  it('sends authenticated users to unlock', () => {
    expect(routeFor('authenticated', '/nico')).toBe('/unlock')
  })

  it('lets authenticated users reach unlock and admin', () => {
    expect(routeFor('authenticated', '/unlock')).toBeNull()
    expect(routeFor('authenticated', '/admin')).toBeNull()
  })

  it('lets unlocked users through', () => {
    expect(routeFor('unlocked', '/nico')).toBeNull()
    expect(routeFor('unlocked', '/admin')).toBeNull()
  })

  it('sends logged-in users away from login', () => {
    expect(routeFor('authenticated', '/login')).toBe('/unlock')
    expect(routeFor('unlocked', '/login')).toBe('/')
  })
})

describe('redirectTargetFor', () => {
  it('sends a locked session away from a user space', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    // This is the two-tier lock holding. Without it, a session that survived
    // a deploy reaches the dashboard without re-entering the password.
    expect(redirectTargetFor(db, sid, '/a')).toBe('/unlock')
  })

  it('lets an unlocked session into a user space', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    putKey(sid, Buffer.alloc(32, 1))
    expect(redirectTargetFor(db, sid, '/a')).toBeNull()
  })

  it('sends a cookie-less request to login', () => {
    expect(redirectTargetFor(db, undefined, '/a')).toBe('/login')
  })

  it('lets a locked session reach unlock', async () => {
    const id = await createAccount(db, { slug: 'a', role: 'user', password: 'pw' })
    const sid = createSession(db, id)
    expect(redirectTargetFor(db, sid, '/unlock')).toBeNull()
  })
})
```

Add `redirectTargetFor` to the import from `@/lib/session/resolve` at the top of the file.

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/routing/middleware.test.ts
```

Expected: FAIL — cannot resolve `@/lib/session/resolve`.

- [ ] **Step 3: Write `lib/session/resolve.ts`**

```ts
import type { PlatformDb } from '@/lib/db/platform'
import { getKey } from './keymap'
import { readSession } from './store'

export type AuthState = 'anonymous' | 'authenticated' | 'unlocked'

/**
 * Two-tier state (architecture spec section 2.3). The session persists across
 * a deploy; the key does not, so a restart leaves users authenticated but
 * locked and the chat surface keeps working.
 */
export function resolveState(
  db: PlatformDb,
  sessionId: string | undefined,
): AuthState {
  if (!sessionId) return 'anonymous'
  if (!readSession(db, sessionId)) return 'anonymous'
  return getKey(sessionId) ? 'unlocked' : 'authenticated'
}

const PUBLIC = new Set(['/login'])
const LOCKED_OK = new Set(['/unlock', '/admin'])

/** The path to redirect to, or null to allow the request through. */
export function routeFor(state: AuthState, pathname: string): string | null {
  if (state === 'anonymous') {
    return PUBLIC.has(pathname) ? null : '/login'
  }
  if (pathname === '/login') {
    return state === 'unlocked' ? '/' : '/unlock'
  }
  if (state === 'authenticated') {
    return LOCKED_OK.has(pathname) || pathname.startsWith('/admin')
      ? null
      : '/unlock'
  }
  return null
}

/** resolveState composed with routeFor — the whole decision in one call. */
export function redirectTargetFor(
  db: PlatformDb,
  sessionId: string | undefined,
  pathname: string,
): string | null {
  return routeFor(resolveState(db, sessionId), pathname)
}
```

- [ ] **Step 4: Write `lib/db/instance.ts` and `lib/session/guard.ts`**

```ts
// lib/db/instance.ts
import { openPlatformDb, type PlatformDb } from './platform'

let db: PlatformDb | undefined

/**
 * Process-wide platform handle. The path is explicit in production via
 * PLATFORM_DB; the fallback is the synthetic dev database, which is the only
 * database name the guard hook allows locally.
 */
export function getDb(): PlatformDb {
  if (!db) db = openPlatformDb(process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db')
  return db
}
```

```ts
// lib/session/guard.ts
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from './store'
import { redirectTargetFor } from './resolve'

/**
 * Server-side state guard for protected pages.
 *
 * middleware.ts cannot do this job: the edge runtime cannot open SQLite, so
 * it can only check that a cookie exists. This is where the two-tier lock is
 * actually enforced — an authenticated-but-locked session gets sent to
 * /unlock rather than reaching a dashboard.
 *
 * A thin adapter by design; the decision it delegates to is tested in
 * tests/routing/middleware.test.ts.
 */
export async function requireState(pathname: string): Promise<void> {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  const target = redirectTargetFor(getDb(), sessionId, pathname)
  if (target) redirect(target)
}
```

- [ ] **Step 5: Write `middleware.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * Thin adapter. The decision logic lives in lib/session/resolve.ts so it can
 * be tested without booting Next.js; middleware runs on the edge runtime and
 * cannot open SQLite, so the full state resolution happens in the route
 * handlers. Here we only bounce requests with no cookie at all.
 */
export function middleware(request: NextRequest) {
  const hasCookie = request.cookies.has(SESSION_COOKIE)
  const { pathname } = request.nextUrl

  if (!hasCookie && pathname !== '/login') {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/login).*)'],
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/routing/middleware.test.ts
```

Expected: 15 passed.

- [ ] **Step 7: Commit**

```bash
git add lib/session/resolve.ts lib/session/guard.ts lib/db/instance.ts middleware.ts tests/routing/middleware.test.ts
git commit -m "Add three-state routing and the server-side unlock guard

resolveState and routeFor hold the anonymous/authenticated/unlocked
decision, testable without booting Next.js. middleware.ts stays a thin
cookie-presence check because the edge runtime cannot open SQLite, so
requireState is where the two-tier lock is actually enforced - without
it, a session that survived a deploy would reach a dashboard without
re-entering the password."
```

---

### Task 12: Login, unlock, and logout

**Files:**
- Create: `app/api/login/route.ts`, `app/api/unlock/route.ts`, `app/api/logout/route.ts`
- Create: `app/(auth)/login/page.tsx`, `app/(auth)/unlock/page.tsx`, `lib/auth/flow.ts`
- Create: `tests/auth/flow.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6, 8, 9, 10, and `getDb()` from Task 11.
- Produces: `login(db, slug, password): Promise<string | null>` and `unlock(db, sessionId, password): Promise<boolean>` in `lib/auth/flow.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/flow.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { login, unlock } from '@/lib/auth/flow'
import { resolveState } from '@/lib/session/resolve'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-flow-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  await createAccount(db, { slug: 'nico', role: 'user', password: 'pw' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('login', () => {
  it('issues a session for correct credentials', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(sid).toBeTruthy()
    expect(resolveState(db, sid!)).toBe('authenticated')
  })

  it('returns null for a wrong password', async () => {
    expect(await login(db, 'nico', 'wrong')).toBeNull()
  })

  it('returns null for an unknown account', async () => {
    expect(await login(db, 'ghost', 'pw')).toBeNull()
  })

  it('leaves the session locked, not unlocked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(resolveState(db, sid!)).not.toBe('unlocked')
  })
})

describe('unlock', () => {
  it('moves an authenticated session to unlocked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(await unlock(db, sid!, 'pw')).toBe(true)
    expect(resolveState(db, sid!)).toBe('unlocked')
  })

  it('rejects a wrong password and stays locked', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(await unlock(db, sid!, 'wrong')).toBe(false)
    expect(resolveState(db, sid!)).toBe('authenticated')
  })

  it('rejects an unknown session', async () => {
    expect(await unlock(db, 'nope', 'pw')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/auth/flow.test.ts
```

Expected: FAIL — cannot resolve `@/lib/auth/flow`.

- [ ] **Step 3: Write `lib/auth/flow.ts`**

```ts
import type { PlatformDb } from '@/lib/db/platform'
import { checkPassword, findAccountBySlug } from './accounts'
import { deriveDbKey, verifyPassword } from './password'
import { putKey } from '@/lib/session/keymap'
import { createSession, readSession } from '@/lib/session/store'

/**
 * Login authenticates and issues a session. It deliberately does NOT unlock:
 * the two-tier model means the key is derived at /unlock, so a deploy leaves
 * users logged in but locked.
 */
export async function login(
  db: PlatformDb,
  slug: string,
  password: string,
): Promise<string | null> {
  const account = findAccountBySlug(db, slug)
  if (!account) return null
  if (!(await checkPassword(account, password))) return null
  return createSession(db, account.id)
}

/** Derive the SQLCipher key and put it in the in-memory map. */
export async function unlock(
  db: PlatformDb,
  sessionId: string,
  password: string,
): Promise<boolean> {
  const session = readSession(db, sessionId)
  if (!session) return false
  const account = db
    .prepare('SELECT auth_hash, salt_key FROM accounts WHERE id = ?')
    .get(session.account_id) as
    | { auth_hash: string; salt_key: Buffer }
    | undefined
  if (!account) return false
  if (!(await verifyPassword(account.auth_hash, password))) return false
  putKey(sessionId, await deriveDbKey(password, account.salt_key))
  return true
}
```

Note the import line at the top of this file is
`import { checkPassword, findAccountBySlug } from './accounts'` and
`import { deriveDbKey, verifyPassword } from './password'` — `unlock` verifies
against the stored hash directly rather than going through `checkPassword`,
which expects a full `Account`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/auth/flow.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Write the routes and pages**

`lib/db/instance.ts` already exists from Task 11 — import `getDb` from it, do
not recreate it.

```ts
// app/api/login/route.ts
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db/instance'
import { login } from '@/lib/auth/flow'
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session/store'

export async function POST(request: Request) {
  const form = await request.formData()
  const slug = String(form.get('slug') ?? '')
  const password = String(form.get('password') ?? '')

  const sessionId = await login(getDb(), slug, password)
  if (!sessionId) {
    return NextResponse.redirect(new URL('/login?error=1', request.url), 303)
  }

  const response = NextResponse.redirect(new URL('/unlock', request.url), 303)
  response.cookies.set(SESSION_COOKIE, sessionId, COOKIE_OPTIONS)
  return response
}
```

```ts
// app/api/unlock/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { unlock } from '@/lib/auth/flow'
import { SESSION_COOKIE } from '@/lib/session/store'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { readSession } from '@/lib/session/store'

export async function POST(request: Request) {
  const form = await request.formData()
  const password = String(form.get('password') ?? '')
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (!sessionId || !(await unlock(getDb(), sessionId, password))) {
    return NextResponse.redirect(new URL('/unlock?error=1', request.url), 303)
  }

  const session = readSession(getDb(), sessionId)!
  const account = getDb()
    .prepare('SELECT slug FROM accounts WHERE id = ?')
    .get(session.account_id) as { slug: string }
  return NextResponse.redirect(new URL(`/${account.slug}`, request.url), 303)
}
```

```ts
// app/api/logout/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE, destroySession } from '@/lib/session/store'

export async function POST(request: Request) {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (sessionId) destroySession(getDb(), sessionId)
  const response = NextResponse.redirect(new URL('/login', request.url), 303)
  response.cookies.delete(SESSION_COOKIE)
  return response
}
```

```tsx
// app/(auth)/login/page.tsx
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Stairwell</h1>
      {error ? <p role="alert">That did not match. Try again.</p> : null}
      <form method="post" action="/api/login">
        <label>
          Who are you? <input name="slug" autoComplete="username" required />
        </label>
        <label>
          Password{' '}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">Log in</button>
      </form>
      <p>
        My tools run on fake data. I&apos;ll see what you tell the agent and what
        you ask for. I won&apos;t open your transactions. I&apos;d have to
        deliberately modify the system to see anything, and I won&apos;t.
        Everything&apos;s deleted when the pilot ends.
      </p>
    </main>
  )
}
```

```tsx
// app/(auth)/unlock/page.tsx
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Unlock your data</h1>
      <p>Your password unlocks your data. It is not stored anywhere.</p>
      {error ? <p role="alert">That did not match. Try again.</p> : null}
      <form method="post" action="/api/unlock">
        <label>
          Password{' '}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">Unlock</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 6: Run the full suite**

```bash
npx vitest run
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/auth/flow.ts app/api/login/route.ts app/api/unlock/route.ts app/api/logout/route.ts "app/(auth)/login/page.tsx" "app/(auth)/unlock/page.tsx" tests/auth/flow.test.ts
git commit -m "Add login, unlock, and logout

Login issues a session but deliberately does not unlock - the key is
derived at /unlock, which is what makes a deploy leave users logged in
but locked."
```

---

### Task 13: User spaces are 404-blind, admin is admin-only

**Files:**
- Create: `lib/auth/authorize.ts`, `app/[user]/page.tsx`, `app/admin/page.tsx`
- Create: `tests/routing/userSpace.test.ts`

**Interfaces:**
- Consumes: `readSession` (Task 10), `findAccountBySlug` (Task 10).
- Produces: `canSeeUserSpace(db, sessionId, slug): boolean` and `isAdmin(db, sessionId): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/routing/userSpace.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { login } from '@/lib/auth/flow'
import { canSeeUserSpace, isAdmin } from '@/lib/auth/authorize'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-authz-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  await createAccount(db, { slug: 'devone', role: 'user', password: 'pw' })
  await createAccount(db, { slug: 'devtwo', role: 'user', password: 'pw' })
  await createAccount(db, { slug: 'nico', role: 'admin', password: 'pw' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('user space authorization', () => {
  it('lets a user see their own space', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(canSeeUserSpace(db, sid!, 'devone')).toBe(true)
  })

  it('does not let a user see another user space', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(canSeeUserSpace(db, sid!, 'devtwo')).toBe(false)
  })

  it('does not let an admin browse user spaces either', async () => {
    // The admin portal is read-only over transcripts and specs. It is not a
    // back door into a user dashboard.
    const sid = await login(db, 'nico', 'pw')
    expect(canSeeUserSpace(db, sid!, 'devone')).toBe(false)
  })

  it('treats an unknown slug the same as a forbidden one', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(canSeeUserSpace(db, sid!, 'ghost')).toBe(false)
  })

  it('refuses with no session', () => {
    expect(canSeeUserSpace(db, undefined, 'devone')).toBe(false)
  })
})

describe('admin authorization', () => {
  it('admits the admin account', async () => {
    const sid = await login(db, 'nico', 'pw')
    expect(isAdmin(db, sid!)).toBe(true)
  })

  it('refuses a dev user', async () => {
    const sid = await login(db, 'devone', 'pw')
    expect(isAdmin(db, sid!)).toBe(false)
  })

  it('refuses with no session', () => {
    expect(isAdmin(db, undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run tests/routing/userSpace.test.ts
```

Expected: FAIL — cannot resolve `@/lib/auth/authorize`.

- [ ] **Step 3: Write `lib/auth/authorize.ts`**

```ts
import type { PlatformDb } from '@/lib/db/platform'
import { readSession } from '@/lib/session/store'

type Row = { slug: string; role: 'user' | 'admin' }

function accountFor(
  db: PlatformDb,
  sessionId: string | undefined,
): Row | undefined {
  if (!sessionId) return undefined
  const session = readSession(db, sessionId)
  if (!session) return undefined
  return db
    .prepare('SELECT slug, role FROM accounts WHERE id = ?')
    .get(session.account_id) as Row | undefined
}

/**
 * A user space belongs to exactly one account. Admin is not an override:
 * the admin portal is read-only over transcripts and specs, not a back door
 * into someone's dashboard.
 *
 * Callers must render 404, never 403 — a 403 confirms the space exists.
 */
export function canSeeUserSpace(
  db: PlatformDb,
  sessionId: string | undefined,
  slug: string,
): boolean {
  return accountFor(db, sessionId)?.slug === slug
}

export function isAdmin(
  db: PlatformDb,
  sessionId: string | undefined,
): boolean {
  return accountFor(db, sessionId)?.role === 'admin'
}
```

- [ ] **Step 4: Write the pages**

```tsx
// app/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { canSeeUserSpace } from '@/lib/auth/authorize'
import { requireState } from '@/lib/session/guard'

export default async function UserSpace({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params

  // Enforce the two-tier lock first: a locked session goes to /unlock rather
  // than reaching a dashboard. middleware.ts cannot do this — the edge
  // runtime cannot open SQLite.
  await requireState(`/${user}`)

  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  // 404, never 403: a 403 would confirm that the other dev user exists.
  if (!canSeeUserSpace(getDb(), sessionId, user)) notFound()

  return (
    <main>
      <h1>{user}</h1>
      <p>Nothing here yet. Your dashboard gets built from your interview.</p>
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
```

```tsx
// app/admin/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'

export default async function AdminPortal() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (!isAdmin(getDb(), sessionId)) notFound()

  const users = getDb()
    .prepare("SELECT slug FROM accounts WHERE role = 'user' ORDER BY slug")
    .all() as { slug: string }[]

  return (
    <main>
      <h1>Admin</h1>
      {users.length === 0 ? (
        <p>No users yet.</p>
      ) : (
        <ul>
          {users.map((u) => (
            <li key={u.slug}>{u.slug}</li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/routing/userSpace.test.ts
```

Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add lib/auth/authorize.ts "app/[user]/page.tsx" app/admin/page.tsx tests/routing/userSpace.test.ts
git commit -m "Add 404-blind user spaces and the admin portal

Admin is not an override on user spaces. Unknown and forbidden slugs are
indistinguishable, so one dev user cannot confirm the other exists."
```

---

### Task 14: The checkpoint

**Files:**
- Create: `scripts/create-dev-users.ts`
- Modify: `architecture-overview.md`

**Interfaces:**
- Consumes: `createAccount` (Task 10), `regeneratePlatform` (Task 7).
- Produces: the verified step 1a checkpoint.

- [ ] **Step 1: Write the dev-user script**

`scripts/` is unguarded by Gate B, which is correct — this is a dev convenience, not platform logic.

```ts
// scripts/create-dev-users.ts
import { openPlatformDb } from '../lib/db/platform'
import { createAccount } from '../lib/auth/accounts'

/**
 * Create the step 1a checkpoint accounts in the synthetic dev database.
 * Passwords are loudly fake, in keeping with CLAUDE.md > Data safety.
 */
const db = openPlatformDb('platform/dev/synthetic.db')
db.prepare('DELETE FROM sessions').run()
db.prepare('DELETE FROM accounts').run()

await createAccount(db, { slug: 'devone', role: 'user', password: 'TEST-DEV-ONE' })
await createAccount(db, { slug: 'devtwo', role: 'user', password: 'TEST-DEV-TWO' })
await createAccount(db, { slug: 'nico', role: 'admin', password: 'TEST-ADMIN' })

console.log('devone / devtwo / nico created in platform/dev/synthetic.db')
db.close()
```

- [ ] **Step 2: Create the dev database and accounts**

```bash
mkdir -p platform/dev
npx tsx scripts/create-dev-users.ts
```

If `tsx` is not installed: `npm install -D tsx` first, then re-run. Add it to `devDependencies`.

- [ ] **Step 3: Run the whole suite**

```bash
npx vitest run
```

Expected: all pass. Record the count.

- [ ] **Step 4: Run the guard and gate harness**

```bash
.claude/hooks/test-hooks.sh
```

Expected: all pass, ~45 in the gate group.

- [ ] **Step 5: Verify the checkpoint by hand**

```bash
npm run dev
```

Then, in a browser:

1. Visit `http://localhost:3000` → redirects to `/login`.
2. Log in as `devone` / `TEST-DEV-ONE` → lands on `/unlock`.
3. Unlock → lands on `/devone`, which says "Nothing here yet."
4. Visit `/devtwo` → **404**, not 403.
5. Visit `/admin` → **404**.
6. Log out, log in as `nico` / `TEST-ADMIN`, unlock → visit `/admin` → the portal loads and lists `devone` and `devtwo`.
7. Visit `/devone` as `nico` → **404**. Admin is not an override.
8. Restart the dev server without clearing cookies → `/devone` redirects to `/unlock`, not `/login`. The session survived; the key did not.

Step 8 is the two-tier model working. If it sends you to `/login`, the session table is not persisting and the model is wrong.

- [ ] **Step 6: Confirm no database was committed**

```bash
git status --short
```

Expected: `platform/dev/synthetic.db` does not appear — `.gitignore` covers `*.db`.

- [ ] **Step 7: Update `architecture-overview.md`**

In the **Core decisions** section, add to **2. Data layer**, after the "Consequence: no background jobs" bullet:

```markdown
- **Two-tier session (step 1a).** The session row persists in the platform
  database; the derived key lives only in an in-process map with a 4h idle TTL
  and a 12h absolute ceiling. A deploy therefore leaves users logged in but
  locked — the chat surface keeps working across the tweak loop, and data
  panels ask for the password again. The key cannot survive overnight, which is
  what keeps login-triggered sync from serving stale data.
- **Platform database.** Accounts, sessions, transcripts, metrics, and the
  request queue live in a single unencrypted `platform.db`, separate from the
  per-user encrypted files. Transcript visibility here is already covered by
  the onboarding promise. `transcripts` and `metrics` reject UPDATE and DELETE
  via SQLite triggers.
```

- [ ] **Step 8: Commit**

```bash
git add scripts/create-dev-users.ts architecture-overview.md package.json package-lock.json
git commit -m "Add dev-user script and record step 1a decisions

Checkpoint verified on localhost: devone and devtwo are 404-blind to each
other, admin is not an override, and a dev-server restart leaves the
session alive but the key gone."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 build sequence — gate first | Tasks 2–4 precede Task 5 onward |
| §2.1 platform data, dev path, empty sacred tables | 6 |
| §2.2 salt separation | 8 |
| §2.3 two-tier state | 11, 12, and checkpoint step 5.8 |
| §2.4 key map TTL and ceiling | 9 |
| §2.5 roles, 404-not-403, empty unlock | 13, 12 |
| §2.6 append-only triggers + both tests | 6 |
| §3 layout | 1 |
| §3.1 Vitest config and scoped runs | 1 |
| §3.2 non-crossing regeneration | 7 |
| §4.1 Gate A pattern table | 2 |
| §4.2 Gate B scopes and exemptions | 3 |
| §4.3 gate separation | 3, step 3 |
| §4.4 announced skip | 4 |
| §4.5 harness growth to ~45 | 2, 3, 4 |
| §5 doc updates | 4 (CLAUDE.md), 14 (architecture-overview.md) |

**Placeholder scan:** none. The one `PLACEHOLDER-TEST` string is a deliberate loud-fake value in seed data, per CLAUDE.md.

**Type consistency:** `PlatformDb` is defined in Task 6 and used unchanged in 7, 10, 11, 13. `openPlatformDb`, `createAccount`, `findAccountBySlug`, `createSession`, `readSession`, `destroySession`, `putKey`, `getKey`, `dropKey`, `resolveState`, `routeFor`, `canSeeUserSpace`, `isAdmin`, `login`, `unlock` keep the same names and signatures everywhere they appear.

**Pre-flight amendments (2026-08-10, approved by Nico before execution):**

1. **The two-tier lock did not hold.** `routeFor` was tested but never wired, and `canSeeUserSpace` checks the session row without checking the key — so an authenticated-but-locked session reached a user space, and Task 14's checkpoint step 8 would have failed. Task 11 now also produces `redirectTargetFor`, `lib/db/instance.ts` (moved forward from Task 12), and `lib/session/guard.ts`; Task 13's `app/[user]/page.tsx` calls `requireState` before authorizing.
2. **`unlock()` cleaned up.** It verifies against the stored hash with `verifyPassword` directly, instead of re-importing `checkPassword` mid-function and casting a partial account with `as never`.
3. **Task 9 test renamed** to `restarts the ceiling on re-unlock`, which is what it asserts. The old name claimed the opposite.
