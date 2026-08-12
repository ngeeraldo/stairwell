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
# export-spec.ts prints nothing on stdout unless it has BOTH strings ready
# (it refuses an account with no CONFIRMED spec, and a corrupt stored payload
# throws before anything is printed). Combined with `set -euo pipefail`
# below, a failure there aborts this script before mkdir/write ever run — no
# half-written spec.md/mockup.html pair.
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

  mkdir -p "users/$user"
  node -e '
    const fs = require("fs");
    const out = JSON.parse(process.argv[1]);
    const user = process.argv[2];
    fs.writeFileSync(`users/${user}/spec.md`, out.spec_md);
    fs.writeFileSync(`users/${user}/mockup.html`, out.mockup_html);
  ' "$json" "$user"

  echo "Wrote users/$user/spec.md and users/$user/mockup.html"
  echo "Both are Gate B exempt — commit them when you are ready."
}

main "$@"
