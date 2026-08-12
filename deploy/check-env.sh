#!/usr/bin/env bash
# Presence check for required environment variables.
#
#   deploy/check-env.sh <required-env-file> <env-file>
#
# Exit 0  no REQUIRED name missing (DEGRADED ones may be, and warn)
# Exit 1  at least one REQUIRED name missing
# Exit 2  usage error, the list is unreadable, or a line of the list is
#         malformed (a broken list is a different condition from a missing
#         variable; deploy.sh aborts on both, so this stays fail-closed)
#
# NAMES ONLY. This script must never read, print, or log a VALUE. Two separate
# things make that true, and BOTH are load-bearing:
#
#   1. The env-file parse discards everything from the first `=` onward before
#      the name ever enters a variable.
#   2. Every first field of the LIST is checked against the identifier regex
#      before it is used or echoed. Without that check a line like
#      `FOO=secret REQUIRED` — the file format has no slot for a value, but a
#      well-meaning edit can still write one — would print the secret into the
#      deploy log this runs in. That exact defect was ruled Critical once
#      already in the TypeScript parser (commit c7939b5) and survived here.
#
# So the guarantee is not "there is no code path that could reach a value"; it
# is "no field reaches output until it has passed the identifier check". A
# malformed line is reported by LINE NUMBER only — never by content.
#
# Why bash and not the TypeScript parser it duplicates: this runs BEFORE
# `npm ci`, so node_modules may not exist — on a fresh clone it does not.
# tests/deploy/checkEnv.test.ts pins that the two parsers agree, including on
# malformed input, which is the only region where they can actually diverge.
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
    #
    # `=..*` — at least one character after the `=` — not `=.*`. `NAME=` with
    # nothing after it is a hand-edit slip that systemd turns into an EMPTY
    # STRING, and an empty string is not the documented fallback: lib/db's
    # `process.env.PLATFORM_DB ?? '...'` uses `??`, so `''` is passed straight
    # through rather than defaulted. lib/env/report.ts already counts an empty
    # value as missing; this is the half that has to agree with it.
    present=$(sed -n \
      's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=..*/\2/p' \
      "$envfile")
  else
    echo "check-env: $envfile is not readable — treating every variable as missing" >&2
  fi

  # The list is read line by line from the raw file — not from a pre-filtered
  # stream — so `$n` is the line number an editor shows. That number is the
  # ONLY thing a malformed line is allowed to contribute to the output.
  #
  # Findings are buffered and printed after the loop: if a later line turns
  # out to be malformed we exit 2 having said nothing about the earlier ones,
  # which is what lib/env/required.ts does (it throws before returning any
  # entry). A half-list of MISSING lines followed by a parse error would read
  # as a complete answer.
  local blocked=0 warned=0 n=0 report="" raw decl name severity extra
  while IFS= read -r raw || [ -n "$raw" ]; do
    n=$((n + 1))
    decl=${raw%%#*}
    read -r name severity extra <<<"$decl"
    [ -z "$name" ] && continue

    # Validate BEFORE any use: before the grep (a name is not a regex) and
    # before any echo (a name that failed this check may be a value).
    if ! printf '%s' "$name" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
      echo "check-env: $list line $n: first field is not a valid variable name" >&2
      exit 2
    fi
    if [ -n "$extra" ]; then
      echo "check-env: $list line $n: expected \"NAME SEVERITY\"" >&2
      exit 2
    fi

    # -F: the name is a literal, never a pattern. A name containing a regex
    # metacharacter would otherwise match a DIFFERENT variable and report an
    # absent one as present. The identifier check above already excludes such
    # names; both guards stay, because they fail independently and -F is free.
    if printf '%s\n' "$present" | grep -qxF -- "$name"; then
      continue
    fi

    # Match the severities explicitly. `if REQUIRED … else` would treat every
    # token that is not exactly REQUIRED — a typo, a missing field, lowercase
    # `required` — as the permissive tier, silently converting the only
    # blocking variable into a warning. Never print $severity: it has not been
    # validated and could itself be a smuggled value.
    case "$severity" in
      REQUIRED)
        report="${report}MISSING (REQUIRED): ${name}"$'\n'
        blocked=$((blocked + 1))
        ;;
      DEGRADED)
        report="${report}MISSING (DEGRADED): ${name} — that feature will not work"$'\n'
        warned=$((warned + 1))
        ;;
      *)
        echo "check-env: $list line $n: expected severity REQUIRED or DEGRADED" >&2
        exit 2
        ;;
    esac
  done < "$list"

  if [ -n "$report" ]; then
    printf '%s' "$report" >&2
  fi

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
