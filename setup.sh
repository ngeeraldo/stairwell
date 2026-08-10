#!/usr/bin/env bash
# Fresh-clone setup for the Personal Dashboard Pilot.
#
# Run this before doing anything else in a new clone:
#   ./setup.sh
#
# Git does not track core.hooksPath, so the anti-drift gate does not exist in a
# fresh clone until this runs. Everything here is idempotent — safe to re-run.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 2

GUARD=".claude/hooks/deny-sensitive-files.sh"
HARNESS=".claude/hooks/test-hooks.sh"
GATE=".githooks/pre-commit"

problems=0

echo
echo "Personal Dashboard Pilot — setup"
echo

# --- 1. Sanity: are we in the repo, with the tools the hooks need? ----------

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "  FAIL  not a git repository — run this from inside the clone" >&2
  exit 2
fi

if command -v jq >/dev/null 2>&1; then
  echo "  ok    jq present ($(command -v jq))"
else
  echo "  FAIL  jq not found — the data-safety guard hook cannot parse tool" >&2
  echo "        payloads without it, and would fail open. Install jq first:" >&2
  echo "          brew install jq" >&2
  exit 2
fi

# --- 2. Wire the anti-drift pre-commit gate --------------------------------

git config core.hooksPath .githooks
current=$(git config core.hooksPath)
if [ "$current" = ".githooks" ]; then
  echo "  ok    core.hooksPath = $current"
else
  echo "  FAIL  core.hooksPath is '$current', expected '.githooks'" >&2
  problems=$((problems + 1))
fi

# --- 3. Verify the hook scripts are present and executable -----------------
# The exec bit is tracked by git, so a fresh clone should already be correct.
# If it is not, repair it — a non-executable gate fails silently, which is the
# worst outcome for a guard.

for script in "$GUARD" "$HARNESS" "$GATE"; do
  if [ ! -f "$script" ]; then
    echo "  FAIL  missing: $script" >&2
    problems=$((problems + 1))
    continue
  fi
  if [ -x "$script" ]; then
    echo "  ok    executable: $script"
  else
    if chmod +x "$script" 2>/dev/null; then
      echo "  ok    executable: $script  (repaired — was not executable)"
    else
      echo "  FAIL  not executable and chmod failed: $script" >&2
      problems=$((problems + 1))
    fi
  fi
done

if [ $problems -ne 0 ]; then
  echo
  echo "Setup incomplete: $problems problem(s) above. Fix before continuing." >&2
  echo
  exit 1
fi

# --- 4. Run the regression harness -----------------------------------------

echo
echo "Running guard + gate regression tests..."
if "./$HARNESS"; then
  echo "Setup complete. Guards are live and verified."
  echo
  exit 0
fi

echo "Setup FAILED: the regression harness did not pass." >&2
echo "Do not run against real data until this is green." >&2
echo
exit 1
