#!/usr/bin/env bash
# Pull one user's confirmed spec into the repo. Run from the repo root on the
# LAPTOP:
#   ./scripts/pull-spec.sh devtwo
#   ./scripts/pull-spec.sh devtwo --local
#
# The droplet never writes into its own git checkout. deploy/deploy.sh runs
# `git pull --ff-only` in the working tree and CLAUDE.md forbids deploying by
# editing files on the droplet, so an app that wrote users/<name>/spec.md at
# runtime would be putting untracked, un-backed-up files inside the deploy
# unit — invisible to the laptop where the dashboard actually gets built.
#
# Without --local this ssh's to the droplet and reads the real (non-synthetic)
# platform database there — see the header of scripts/export-spec.ts. --local
# is the only form an agent runs, against a synthetic PLATFORM_DB.
#
# This script is a thin wrapper and does no file writing itself: fetch the
# confirmed spec as JSON from export-spec.ts, hand it to write-spec-pair.ts.
#
# export-spec.ts prints nothing on stdout unless it has BOTH strings ready
# (it refuses an account with no CONFIRMED spec, and a corrupt stored payload
# throws before anything is printed). Combined with `set -euo pipefail`
# below, a failure there aborts this script before write-spec-pair.ts ever
# runs — no half-written spec.md/mockup.html pair.
#
# write-spec-pair.ts is where the atomic-write guarantee actually lives —
# temp-write, move any existing pair aside, commit by rename, roll back to
# the original pair on any ordinary catchable failure — as a plain,
# directly-testable module rather than shell-embedded JS. See that file's
# own comments for exactly what is and is not covered, and
# tests/scripts/writeSpecPair.test.ts for how each guard is verified.
set -euo pipefail

main() {
  local user="${1:-}"
  if [ -z "$user" ]; then
    echo "usage: ./scripts/pull-spec.sh <user> [--local]" >&2
    exit 2
  fi

  local json
  if [ "${2:-}" = "--local" ]; then
    json=$(npx tsx scripts/export-spec.ts "$user")
  else
    json=$(ssh deploy@app.stairwell.run \
      'cd /home/deploy/stairwell && npx tsx scripts/export-spec.ts '"$user")
  fi

  npx tsx scripts/write-spec-pair.ts "users/$user" "$json"

  echo "Both are Gate B exempt — commit them when you are ready."
}

main "$@"
