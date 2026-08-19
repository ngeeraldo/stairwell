#!/usr/bin/env bash
# Pull one user's current spec into the repo. Run from the repo root on the
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
# export-spec.ts refuses to run at all if PLATFORM_DB is unset (no fallback —
# see its header). --local supplies platform/dev/synthetic.db itself, via
# `${PLATFORM_DB:-...}`, so a bare `./scripts/pull-spec.sh <user> --local`
# still works without the caller exporting anything first — but a caller who
# HAS set PLATFORM_DB (a test pointed at a disposable db, an agent pointed
# elsewhere) is passed through unchanged. That default belongs here, in the
# wrapper that only ever runs locally against synthetic data, and not inside
# export-spec.ts itself, which the OTHER branch below also calls against the
# REAL platform database on the droplet.
#
# This script is a thin wrapper and does no file writing itself: fetch the
# current spec as JSON from export-spec.ts, hand it to write-spec-pair.ts.
#
# export-spec.ts prints nothing on stdout unless it has a result ready (it
# refuses an account with no spec at all, and a corrupt stored payload throws
# before anything is printed). Combined with `set -euo pipefail` below, a
# failure there aborts this script before write-spec-pair.ts ever runs — no
# half-written spec.md.
#
# write-spec-pair.ts is where the atomic-write guarantee actually lives —
# temp-write, move any existing file aside, commit by rename, roll back to
# the original on any ordinary catchable failure — as a plain,
# directly-testable module rather than shell-embedded JS. It used to write a
# PAIR (spec.md and mockup.html); it writes spec.md alone now, as of the
# mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task 6) —
# nothing composes or serves mockup HTML any more. See that file's own
# comments for exactly what is and is not covered, and
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
    json=$(PLATFORM_DB="${PLATFORM_DB:-platform/dev/synthetic.db}" npx tsx scripts/export-spec.ts "$user")
  else
    # `set -a; . ./.env` because a non-interactive ssh loads no profile and no
    # EnvironmentFile — only systemd does that for the running service. Without
    # it PLATFORM_DB is unset on the far side and export-spec.ts used to fall
    # back to the SYNTHETIC database, on the production box. That failed loudly
    # here only by luck: platform/dev/ does not exist in the droplet's checkout,
    # because git will not create a directory whose only contents are
    # gitignored. Had it existed, this would have written synthetic data into
    # users/<name>/spec.md as if it were the friend's real spec.
    # export-spec.ts now refuses to run without PLATFORM_DB rather than
    # guessing; this line is what supplies it.
    #
    # Nothing is echoed: `.env` is sourced by the REMOTE shell and only
    # export-spec.ts's JSON comes back over stdout.
    json=$(ssh deploy@app.stairwell.run \
      'cd /home/deploy/stairwell && set -a && . ./.env && set +a && npx tsx scripts/export-spec.ts '"$user")
  fi

  npx tsx scripts/write-spec-pair.ts "users/$user" "$json"

  echo "spec.md is Gate B exempt — commit it when you are ready."
}

main "$@"
