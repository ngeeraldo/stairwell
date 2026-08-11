#!/usr/bin/env bash
# Deploy the pilot. Run on the droplet:
#   ssh deploy@app.stairwell.run '/home/deploy/stairwell/deploy/deploy.sh'
#
# Tests gate the restart (CLAUDE.md > Testing). A failing suite aborts before
# the restart, so the previous version keeps serving.
set -euo pipefail

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
git pull --ff-only

# 3. Install. Full install, NOT --omit=dev: step 5 needs Vitest.
npm ci

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
npm run build

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

# 7. Smoke check. `is-active` above is necessary and NOT sufficient: it goes true
#    the moment systemd forks npm, several seconds before Next is listening, and
#    it stays true for a process that serves 500s. A deploy that starts the
#    process but does not serve correctly is a failed deploy.
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
