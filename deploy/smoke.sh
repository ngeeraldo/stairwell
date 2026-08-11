#!/usr/bin/env bash
# Post-restart smoke check. Run by deploy/deploy.sh; also runnable by hand:
#   deploy/smoke.sh                          # https://app.stairwell.run
#   deploy/smoke.sh http://localhost:3000    # the origin directly, pre-DNS
#
# THE DEPLOY CONTRACT (Nico's ruling, step 1b): a deploy that starts the process
# but does not serve correctly is a FAILED deploy. `systemctl is-active` goes true
# the moment systemd forks npm — several seconds before Next is listening — so it
# cannot tell "serving" from "started". Measured: Caddy returns 502 for ~4s after
# every restart.
#
# There is deliberately NO skip variable. Use the origin argument to retarget it
# (e.g. before DNS exists); do not add a way to turn it off.
#
# WHY THE REDIRECT SHAPE IS CHECKED, and not just liveness: both step-1b outages
# were redirect bugs that passed the full suite, tsc, next build, and Gates D+E.
#   1. `new URL(path, request.url)` named the internal origin, so every redirect
#      sent the browser to https://localhost:3000/... behind the proxy.
#   2. The fix made middleware redirects relative, which Next's middleware runtime
#      rejects outright — ERR_INVALID_URL, 500 on every cookie-less page request.
# Liveness alone catches neither: case 1 returns a healthy 307, and case 2 leaves
# /login (which middleware ignores) answering 200.
set -uo pipefail

ORIGIN="${1:-${SMOKE_ORIGIN:-https://app.stairwell.run}}"
ORIGIN="${ORIGIN%/}"
ATTEMPTS="${SMOKE_ATTEMPTS:-30}"
SLEEP="${SMOKE_SLEEP:-2}"

# The host we expect an absolute redirect to name. Comparing HOST ONLY, not the
# whole origin: TLS terminates at Caddy, so the app legitimately sees a different
# scheme than the client used.
expected_host="${ORIGIN#*://}"
expected_host="${expected_host%%/*}"

fail() {
  echo >&2
  echo "DEPLOY FAILED — $1" >&2
  echo >&2
  exit 1
}

# Indirected so the harness can stub it, mirroring BUILD_CMD/TEST_CMD in
# .githooks/pre-push. Invoked as: $SMOKE_FETCH <method> <url>
# Must print the status code on line 1 and the Location header (or empty) on 2.
default_fetch() {
  local method="$1" url="$2" raw
  if [ "$method" = "POST" ]; then
    # A slug that cannot exist, so this never touches a real account. It does
    # cost one dummy Argon2 verify — that is the timing-oracle defence in
    # lib/auth/flow.ts doing its job, not waste.
    raw=$(curl -sS -o /dev/null -D - --max-time 10 -X POST \
      --data-urlencode 'slug=smoke-check-no-such-account' \
      --data-urlencode 'password=smoke-check-not-a-password' \
      "$url" 2>/dev/null) || true
  else
    raw=$(curl -sS -o /dev/null -D - --max-time 10 "$url" 2>/dev/null) || true
  fi
  printf '%s\n' "$(printf '%s' "$raw" | awk 'tolower($1) ~ /^http\// { code = $2 } END { print code }')"
  printf '%s\n' "$(printf '%s' "$raw" | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r' | tail -1)"
}

fetch() {
  if [ -n "${SMOKE_FETCH:-}" ]; then
    "$SMOKE_FETCH" "$1" "$2"
  else
    default_fetch "$1" "$2"
  fi
}

echo "Smoke check against $ORIGIN"

# --- 1. Readiness: a real 200, not merely a completed exchange.
#     curl exits 0 on a 502, so polling on exit code passes instantly while Caddy
#     is still returning Bad Gateway. That mistake produced a run of phantom 502
#     results while this was being built, so it is pinned here on purpose.
code=""
ready=""
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  i=$((i + 1))
  code=$(fetch GET "$ORIGIN/login" | sed -n 1p)
  if [ "$code" = "200" ]; then
    ready=yes
    echo "  ok    /login 200 (after $i poll$([ "$i" = 1 ] || echo s))"
    break
  fi
  sleep "$SLEEP"
done
[ -n "$ready" ] || fail "/login never returned 200 after $ATTEMPTS polls (last status: ${code:-none})"

# --- 2. The root redirect: present, aimed at /login, and naming the EXTERNAL host.
root_status=$(fetch GET "$ORIGIN/" | sed -n 1p)
root_location=$(fetch GET "$ORIGIN/" | sed -n 2p)

case "$root_status" in
  30[0-9]) ;;
  *) fail "/ returned $root_status, expected a redirect. A 500 here is the middleware ERR_INVALID_URL failure mode." ;;
esac

[ -n "$root_location" ] || fail "/ returned $root_status with no Location header"

case "$root_location" in
  */login|*/login\?*) ;;
  *) fail "/ redirected to '$root_location', expected /login" ;;
esac

case "$root_location" in
  //*)
    fail "/ redirect is protocol-relative ('$root_location') — that resolves to another origin" ;;
  /*)
    # Relative is inherently proxy-safe. Middleware cannot emit this (Next throws),
    # so seeing it means the redirect moved layers — worth reporting, not failing.
    echo "  ok    / -> $root_location (relative)" ;;
  *://*)
    actual_host="${root_location#*://}"
    actual_host="${actual_host%%/*}"
    if [ "$actual_host" != "$expected_host" ]; then
      fail "/ redirect names '$actual_host' but this deployment is '$expected_host'. This is the step-1b outage: request.url yields the internal origin behind a proxy. See lib/http/redirect.ts."
    fi
    echo "  ok    / -> $root_location (absolute, correct host)" ;;
  *)
    fail "/ redirect Location is neither relative nor absolute: '$root_location'" ;;
esac

# --- 3. A route-handler redirect must be RELATIVE. The opposite requirement from
#     middleware above, which is exactly why both are checked: a change that
#     "unified" the two layers would break one of them silently.
api_status=$(fetch POST "$ORIGIN/api/login" | sed -n 1p)
api_location=$(fetch POST "$ORIGIN/api/login" | sed -n 2p)

[ "$api_status" = "303" ] || fail "POST /api/login returned $api_status, expected 303"
[ -n "$api_location" ] || fail "POST /api/login returned 303 with no Location header"

case "$api_location" in
  //*) fail "POST /api/login Location is protocol-relative: '$api_location'" ;;
  /*)  echo "  ok    POST /api/login -> $api_location (relative)" ;;
  *)   fail "POST /api/login Location is absolute ('$api_location'). Route handlers must stay host-relative — see lib/http/redirect.ts." ;;
esac

echo "  ok    smoke check passed"
exit 0
