#!/usr/bin/env bash
# Deploy the pilot. Run on the droplet:
#   ssh deploy@app.stairwell.run '/home/deploy/stairwell/deploy/deploy.sh'
#
# Tests gate the restart (CLAUDE.md > Testing). A failing suite aborts before
# the restart, so the previous version keeps serving. deploy/smoke.sh then gates
# success: starting the process is not the same as serving correctly.
set -euo pipefail

# EVERYTHING lives inside main(), called on the last line, so bash parses the
# WHOLE file before executing any of it.
#
# This is not style. Step 2 below runs `git pull`, which can replace this very
# file mid-execution, and bash reads scripts incrementally by byte offset — a
# file that changes length under it can splice old and new lines together and
# execute the result. Parsing up front removes that hazard entirely.
main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

  echo
  echo "Stairwell deploy — $(git rev-parse --short HEAD) -> ?"
  echo

  # 1. Fresh-clone bootstrap. core.hooksPath is not tracked by git, so a new
  #    clone has no gate until setup.sh runs. Idempotent, so it is safe to leave
  #    in the path permanently rather than making it a manual step that gets
  #    forgotten on the next rebuild.
  if [ "$(git config core.hooksPath || true)" != ".githooks" ]; then
    echo "Hooks not wired — running setup.sh"
    ./setup.sh
  fi

  # 2. Pull
  local before after
  before=$(git rev-parse HEAD)
  git pull --ff-only
  after=$(git rev-parse HEAD)

  # 2a. If that pull changed the deploy scripts themselves, the logic on disk is
  #     no longer the logic running, and the deploy that INTRODUCES a contract
  #     change would be the one deploy exempt from it. Re-exec once so the new
  #     version applies to itself.
  #
  #     Measured, not hypothetical: the deploy that first delivered
  #     deploy/smoke.sh skipped the smoke gate entirely and reported
  #     "Service is active." — the old script's success message — because bash
  #     was still executing the pre-pull file. It passed. Every subsequent deploy
  #     ran the gate correctly, which is what makes this hole so easy to miss:
  #     it is invisible exactly once, on the run that matters most.
  #
  #     BOOTSTRAP CAVEAT, for whoever reads this after a confusing deploy: this
  #     re-exec cannot apply to the deploy that first delivers it, because the
  #     script running then is the one that predates it. The same property, one
  #     level up. So the FIRST deploy after any change to this block still runs
  #     the old logic; the second onwards is correct. If a contract change must
  #     be enforced from its very first deploy, run deploy.sh twice.
  if [ "$before" != "$after" ] && [ -z "${DEPLOY_REEXECED:-}" ]; then
    if ! git diff --quiet "$before" "$after" -- deploy/deploy.sh deploy/smoke.sh; then
      echo
      echo "Deploy scripts changed in this pull — re-executing the new version"
      echo "so the incoming contract applies to this deploy, not just the next."
      echo
      DEPLOY_REEXECED=1 exec ./deploy/deploy.sh "$@"
    fi
  fi

  # 2b. Required configuration must be present before anything expensive
  #     happens, and before the restart that would make a gap live.
  #
  #     Placed AFTER the pull so a deploy that introduces a new requirement
  #     enforces it on itself — the same reasoning as the re-exec above —
  #     and BEFORE npm ci so a missing variable costs seconds rather than a
  #     full install, build and test cycle.
  #
  #     Names only. deploy/check-env.sh never prints a value, and must not
  #     be changed to: this output goes straight into a deploy log.
  #
  #     `.env` here is the same file the systemd unit loads as its
  #     EnvironmentFile — main() cds to the repo root, which is the unit's
  #     WorkingDirectory. tests/deploy/service.test.ts pins that coupling.
  #
  #     Exit 1 and exit 2 both abort, but they are different problems and the
  #     message has to say which: 1 means a variable is missing from .env, 2
  #     means deploy/required-env itself is unreadable, empty, or malformed
  #     (an empty checklist is a broken checklist, not a pass). Reporting
  #     a broken checklist as "configuration missing" sends whoever is reading
  #     the deploy log to the wrong file.
  local env_status=0 env_reason="required configuration missing"
  ./deploy/check-env.sh deploy/required-env .env || env_status=$?
  if [ "$env_status" -ne 0 ]; then
    if [ "$env_status" -eq 2 ]; then env_reason="deploy/required-env is unreadable, empty, or malformed"; fi
    echo >&2
    echo "DEPLOY ABORTED — $env_reason." >&2
    echo "The running version is untouched." >&2
    echo >&2
    exit 1
  fi

  # 3. Install. Full install, NOT --omit=dev: step 5 needs Vitest.
  npm ci

  # 3a. Synthetic per-user databases.
  #
  #     users/*/synthetic.db is gitignored (CLAUDE.md > Data safety: no
  #     database is ever committed), so a fresh checkout has none and every
  #     dashboard would render "its data has not been generated yet".
  #
  #     BEFORE the test gate, not after: tests/users/conventions.test.ts and
  #     the per-user suites are the things that would notice a broken
  #     generator, and a suite that runs first would happily exercise the
  #     no-data path and pass.
  #
  #     Explicit `if !` rather than leaning on `set -e`, so the deploy log
  #     carries a line naming this step instead of ending mid-script.
  if ! npx tsx scripts/regen-synthetic.ts; then
    echo >&2
    echo "DEPLOY ABORTED — synthetic user databases could not be generated." >&2
    echo "The running version is untouched." >&2
    echo >&2
    exit 1
  fi

  # 4. Build
  #
  # NOTE, so nobody over-reads the guarantee below: this overwrites .next/ in
  # place, under the still-running old server, before the test gate runs. What
  # "the previous version keeps serving" means precisely is that the old PROCESS
  # is never restarted, so already-loaded routes keep answering from memory. It
  # does NOT mean the old build is still on disk. `next start` loads server
  # chunks lazily, so a route not yet hit since the last restart can fault
  # against the new .next/ during the build-plus-test window.
  #
  # Accepted for a single-service pilot; the alternative is building to a temp
  # directory and swapping, which is real added scope. Flag to Nico before
  # relying on this path for anything with real users on it.
  #
  # THE HEAP IS RAISED EXPLICITLY, and the number is measured rather than
  # chosen. This droplet is 1 CPU / 961 MB, where Node sizes its default
  # old-space at 493 MB — and `next build` runs tsc, whose peak crossed that
  # when the Plaid SDK arrived (`plaid/dist/api.d.ts` is 3.6 MB). The failure
  # is a bare "Reached heap limit ... Next.js build worker exited with code:
  # null and signal: SIGABRT", which names nothing about its cause.
  #
  # Bisected locally by pinning --max-old-space-size to the droplet's own
  # number:
  #
  #   493 MB, commit before Plaid   PASS
  #   493 MB, commit with Plaid     OOM   <- the regression, exactly
  #   700 MB, commit with Plaid     PASS
  #
  # 900 leaves margin over the 700 that passes. The box has ~646 MB available
  # and 1.8 GB of free swap, so the tail of it swaps — slower on one core, and
  # a build is infrequent. Raising the ceiling is preferred over
  # `typescript: { ignoreBuildErrors: true }`, which also fixes it and would
  # silently turn off the only compiler run that happens on this machine.
  NODE_OPTIONS=--max-old-space-size=900 npm run build

  # 5. Tests gate the restart.
  if ! npx vitest run; then
    echo >&2
    echo "DEPLOY ABORTED — tests failed. The running version is untouched." >&2
    echo >&2
    exit 1
  fi

  # 6. Restart
  sudo systemctl restart stairwell
  sleep 2
  systemctl is-active --quiet stairwell || {
    echo "DEPLOY FAILED — service did not come back up:" >&2
    journalctl -u stairwell -n 30 --no-pager >&2
    exit 1
  }

  # 7. Smoke check. `is-active` above is necessary and NOT sufficient: it goes
  #    true the moment systemd forks npm, several seconds before Next is
  #    listening, and it stays true for a process that serves 500s. A deploy that
  #    starts the process but does not serve correctly is a failed deploy.
  #
  #    Both step-1b outages were redirect bugs that passed the suite, tsc, the
  #    build, and Gates D+E, and would have been caught here. No skip variable
  #    exists on purpose — retarget it with an origin argument if you must.
  if ! ./deploy/smoke.sh; then
    echo "DEPLOY FAILED — the service restarted but is not serving correctly." >&2
    echo "The new code IS live and failing; this is not a rollback." >&2
    journalctl -u stairwell -n 30 --no-pager >&2
    exit 1
  fi

  echo
  echo "Deployed $(git rev-parse --short HEAD). Service is active and serving."
  echo
}

main "$@"
