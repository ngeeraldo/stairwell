#!/usr/bin/env bash
# Presence check for required environment variables.
#
#   deploy/check-env.sh <required-env-file> <env-file>
#
# Exit 0  no REQUIRED name missing (DEGRADED ones may be, and warn)
# Exit 1  at least one REQUIRED name missing
# Exit 2  usage error, the list is unreadable, the list has NO ENTRIES, or a
#         line of the list is malformed (a broken list is a different
#         condition from a missing variable; deploy.sh aborts on both, so
#         this stays fail-closed)
#
# "No checklist" and "nothing missing" must never share an exit code. A
# truncated or accidentally blanked list would otherwise disable the gate
# entirely and report success — the same false-green class as the two deploys
# that motivated this script, one level up.
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

  # An env file is NOT a union of the names it mentions. systemd's
  # EnvironmentFile and dotenv both take the LAST assignment of a repeated
  # key, so
  #
  #     PLATFORM_DB=platform/dev/synthetic.db
  #     PLATFORM_DB=
  #
  # yields PLATFORM_DB='' — and asking only whether the name appears on SOME
  # line reports it present while the process gets nothing. That shape is
  # reachable by exactly the workflow deploy/PROVISION.md prescribes:
  # appending KEY=value below an existing key.
  #
  # So each assignment is reduced to a FLAG and a NAME, in file order:
  #
  #     1 NAME   this assignment yields a non-empty value
  #     0 NAME   this assignment yields the EMPTY STRING
  #
  # and the last line mentioning a name is the one that decides. Three shapes
  # yield the empty string, all of them hand-edit slips that look fine in a
  # `cat`: `NAME=`, `NAME=   ` (systemd strips surrounding whitespace from an
  # unquoted value) and `NAME=""` / `NAME=''` (systemd strips surrounding
  # quotes). An empty string is not the documented fallback either: lib/db's
  # `process.env.PLATFORM_DB ?? '...'` uses `??`, so `''` is passed straight
  # through. lib/env/report.ts already counts an empty value as missing; this
  # is the half that has to agree with it.
  #
  # NAMES ONLY still holds, and this is where it is easiest to lose: every
  # branch below substitutes the WHOLE line with `<flag> \2`, so the value is
  # discarded inside sed and never reaches a shell variable. The `t` after
  # each branch stops the line being reconsidered by a later, looser one.
  local assigned="" lhs
  lhs='^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)='
  if [ -r "$envfile" ]; then
    # A commented line matches nothing here, so it reads as absent.
    assigned=$(sed -n \
      -e "s/${lhs}[[:space:]]*\$/0 \\2/p" -e t \
      -e "s/${lhs}[[:space:]]*\"\"[[:space:]]*\$/0 \\2/p" -e t \
      -e "s/${lhs}[[:space:]]*''[[:space:]]*\$/0 \\2/p" -e t \
      -e "s/${lhs}.*/1 \\2/p" \
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
  local blocked=0 warned=0 n=0 entries=0 report="" raw decl name severity extra last
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
    entries=$((entries + 1))

    # LAST ASSIGNMENT WINS. Both flag forms for this name are selected, in
    # file order, and only the last of them decides — `1 ` means that
    # assignment yields a value, `0 ` means it yields the empty string.
    #
    # -F: the name is a literal, never a pattern. A name containing a regex
    # metacharacter would otherwise match a DIFFERENT variable and report an
    # absent one as present. The identifier check above already excludes such
    # names; both guards stay, because they fail independently and -F is free.
    #
    # `|| true`: grep exits 1 when the name is assigned nowhere, and under
    # `set -o pipefail` that would kill the script instead of reporting the
    # variable missing — the loudest possible way to fail open.
    last=$(printf '%s\n' "$assigned" | grep -xF -e "1 $name" -e "0 $name" | tail -n 1 || true)
    if [ "$last" = "1 $name" ]; then
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

  # A list with no entries is a BROKEN LIST, not a clean bill of health: an
  # empty file, a file of comments, a file of blank lines. Checked after the
  # loop rather than by pre-scanning the file, so it counts exactly the lines
  # the loop accepted as entries — the two can never disagree. Nothing from
  # the file is echoed here, only its path.
  if [ "$entries" -eq 0 ]; then
    echo "check-env: $list: checklist missing or empty — no variables to check." >&2
    echo "A blank or truncated list would otherwise report success and let the" >&2
    echo "deploy through. \"No checklist\" and \"nothing missing\" are not the" >&2
    echo "same answer." >&2
    exit 2
  fi

  if [ -n "$report" ]; then
    printf '%s' "$report" >&2
  fi

  if [ "$blocked" -gt 0 ]; then
    echo >&2
    echo "check-env: $blocked required variable(s) missing from $envfile." >&2
    echo "Add each as KEY=value — no 'export', no quotes. systemd parses the" >&2
    echo "file itself with no shell, so 'export FOO=x' names a variable called" >&2
    echo "'export FOO'; and it strips surrounding quotes, so KEY=\"\" is the" >&2
    echo "EMPTY STRING, which this check counts as missing." >&2
    return 1
  fi

  if [ "$warned" -gt 0 ]; then
    echo "check-env: $warned degraded variable(s) missing — deploy continues." >&2
  fi
  return 0
}

main "$@"
