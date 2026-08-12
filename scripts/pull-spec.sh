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
#
# The write step below is itself write-temp-then-rename, not two direct
# writes: two independent writeFileSync calls left a real gap where the
# first could land and the second fail (disk full, a permission change, the
# process killed between them), leaving spec.md on disk with no
# mockup.html or a stale one. See the comments in that block for what is
# and is not covered.
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
    const path = require("path");
    const out = JSON.parse(process.argv[1]);
    const user = process.argv[2];
    const dir = `users/${user}`;
    const specPath = path.join(dir, "spec.md");
    const mockupPath = path.join(dir, "mockup.html");
    const specTmp = path.join(dir, ".spec.md.tmp");
    const mockupTmp = path.join(dir, ".mockup.html.tmp");

    // Refuse upfront, before touching anything, if a final path is
    // occupied by something that is not a plain file (most plausibly: a
    // stray directory). Catching this here means the repo is left exactly
    // as it started — nothing gets written, let alone half a pair.
    for (const p of [specPath, mockupPath]) {
      if (fs.existsSync(p) && !fs.statSync(p).isFile()) {
        throw new Error(`${p} exists and is not a regular file — refusing to write`);
      }
    }

    // Write BOTH payloads to temp files in the same directory before
    // touching either final path. If the second write throws (disk full,
    // a permission change, the process killed between them), clean up
    // whatever was already written and exit nonzero — spec.md and
    // mockup.html are untouched either way, so a pre-existing pair from an
    // earlier pull is never left with one file replaced and the other
    // stale or missing.
    try {
      fs.writeFileSync(specTmp, out.spec_md);
      fs.writeFileSync(mockupTmp, out.mockup_html);
    } catch (err) {
      for (const p of [specTmp, mockupTmp]) {
        try { fs.unlinkSync(p); } catch {}
      }
      throw err;
    }

    // Both payloads are safely on disk under temp names. Commit by
    // renaming into place: each rename is a single, near-instant syscall
    // in the same directory (no data copy), so this pair is about as
    // close to a joint commit as fs gives us without hand-rolled
    // two-phase-commit machinery this single-operator tool does not need.
    // A kill signal landing in the gap between these two renames is not
    // recoverable by any in-process cleanup no matter how this is written
    // — the process would be dead before a catch block could run — so the
    // goal here is minimizing that window, not pretending to eliminate it.
    fs.renameSync(specTmp, specPath);
    fs.renameSync(mockupTmp, mockupPath);
  ' "$json" "$user"

  echo "Wrote users/$user/spec.md and users/$user/mockup.html"
  echo "Both are Gate B exempt — commit them when you are ready."
}

main "$@"
