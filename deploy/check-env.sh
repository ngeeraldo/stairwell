#!/usr/bin/env bash
# Presence check for required environment variables.
#
#   deploy/check-env.sh <required-env-file> <env-file>
#
# Exit 0  no REQUIRED name missing (DEGRADED ones may be, and warn)
# Exit 1  at least one REQUIRED name missing
# Exit 2  usage error, or the list itself is unreadable
#
# NAMES ONLY. This script must never read, print, or log a VALUE. The parse
# below discards everything from the first `=` onward before the name ever
# enters a variable, so there is no code path where a secret could reach the
# deploy log this runs in.
#
# Why bash and not the TypeScript parser it duplicates: this runs BEFORE
# `npm ci`, so node_modules may not exist — on a fresh clone it does not.
# tests/deploy/checkEnv.test.ts pins that the two parsers agree.
set -euo pipefail

# Whole body inside main(), called on the last line, matching deploy.sh's
# own idiom so bash parses the entire file before executing any of it.
main() {
  if [ $# -ne 2 ]; then
    echo "usage: check-env.sh <required-env-file> <env-file>" >&2
    exit 2
  fi

  local list=$1 envfile=$2

  if [ ! -r "$list" ]; then
    echo "check-env: cannot read the required-env list at $list" >&2
    exit 2
  fi

  local present=""
  if [ -r "$envfile" ]; then
    # Names only: optional leading `export `, then NAME, then everything from
    # `=` onward dropped. A commented line never matches, so it reads as absent.
    present=$(sed -n \
      's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' \
      "$envfile")
  else
    echo "check-env: $envfile is not readable — treating every variable as missing" >&2
  fi

  local blocked=0 warned=0 name severity
  while read -r name severity _rest; do
    [ -z "$name" ] && continue
    if printf '%s\n' "$present" | grep -qx -- "$name"; then
      continue
    fi
    if [ "$severity" = "REQUIRED" ]; then
      echo "MISSING (REQUIRED): $name" >&2
      blocked=$((blocked + 1))
    else
      echo "MISSING (DEGRADED): $name — that feature will not work" >&2
      warned=$((warned + 1))
    fi
  done < <(sed 's/#.*//' "$list" | grep -v '^[[:space:]]*$')

  if [ "$blocked" -gt 0 ]; then
    echo >&2
    echo "check-env: $blocked required variable(s) missing from $envfile." >&2
    echo "Add each as KEY=value — no 'export', no quotes; systemd parses the" >&2
    echo "file literally and both end up inside the name or the value." >&2
    return 1
  fi

  if [ "$warned" -gt 0 ]; then
    echo "check-env: $warned degraded variable(s) missing — deploy continues." >&2
  fi
  return 0
}

main "$@"
