# SDD ledger — plan: docs/superpowers/plans/2026-08-10-step1b-infra-and-deploy.md

Worktree: /Users/nico/Documents/code/stairwell/.claude/worktrees/step1b-infra-and-deploy
Branch: worktree-step1b-infra-and-deploy
Base: df5511c (local main tip == origin/main)
Baseline: ./setup.sh green, 135 checks; 143 tests / 16 files — matches the
step1a ledger's recorded final state exactly.

Split of work: Tasks 1-6 are droplet/DNS/browser actions Nico performs; Claude
has no DigitalOcean, doctl, or Cloudflare access. Claude delivered every
repo-side artifact those tasks install, plus Task 7 in full.

Task 6 step 5's doc updates are DELIBERATELY NOT COMMITTED yet: that text
asserts a live checkpoint verified at https://app.stairwell.run, which is not
true until Nico completes Tasks 1-6. Committing it earlier would put a false
claim in architecture-overview.md.

--- PLAN DEFECTS FOUND AND FIXED (commit 1fc20d5) ---

CRITICAL (security), Task 3 step 1: the plan expressed the loopback bind as
  `Environment=HOSTNAME=127.0.0.1`. It reads correctly and does nothing. In
  Next 15 `next start` declares --port with commander's .env('PORT') but
  declares --hostname WITHOUT .env('HOSTNAME'), so nothing reads the variable
  and server.listen(port, undefined) binds every interface. On the droplet the
  app would have been exposed on :3000 with only ufw in front of it — the exact
  defense-in-depth the plan's own comment claimed to be establishing.
  MEASURED on Next 15.5.23, twice (bare `next start`, and again on a real
  production server during Task 7's verification):
    HOSTNAME env only     -> socket *:PORT
    -H 127.0.0.1 flag     -> socket 127.0.0.1:PORT
  Fixed to the flag. Pinned by tests/deploy/service.test.ts (5 assertions; 2
  fail against the plan's original text, 3 hold in both as they should).

  THE VERIFICATION-CANNOT-SEE-IT PATTERN REPEATS, now at the infra tier. Task 3
  step 7 curls <DROPLET_IP>:3000 from the laptop and expects refusal, but ufw
  allows only 22/80/443 and drops that probe whether the bind is loopback or
  wide open — it passes identically either way. This is the same shape as the
  ledger's step1a entries: "tests green" != compiles, "tsc clean" != builds,
  "a test file is staged" != tests pass. Here: "the external probe refused" !=
  "bound to loopback". Plan step 7 now also asserts `ss -ltnp | grep ':3000'`,
  which is the discriminating check.

  deploy/** is Gate B-exempt, so no test was required for this change. The test
  exists because NO gate in the project can see this defect class.

MINOR, Task 4 step 3 / Task 6 step 4: the plan expected
  `dig +short kplife.stairwell.run` to return "its tunnel target". That record
  is orange-clouded (proxied), so dig returns Cloudflare edge IPs and never the
  cfargotunnel.com target. Measured 2026-08-11 before any change:
  172.67.178.223 / 104.21.17.241. The stated expectation would have read as a
  failure on a healthy record. Corrected, with the baseline recorded in the plan
  and a note that Cloudflare rotates edge IPs, so a different Cloudflare-owned
  pair is fine but a non-Cloudflare answer or NXDOMAIN is not.

DEFECT 3, Task 1 step 2: `adduser --disabled-password` plus `usermod -aG sudo`
  produces a user who is in the sudo group and cannot use sudo, because sudo
  prompts for a password that does not exist. Every `sudo` in Tasks 1, 3 and 6
  fails with `sudo: a password is required`. Nico set one with `passwd deploy`;
  login stays key-only, since PasswordAuthentication no is enforced separately.
  Recorded in PROVISION.md. Consequence for the execution order: Claude cannot
  run sudo as deploy over non-interactive SSH (it does not have the password, by
  design), so all privileged installs were done as root BEFORE closing root SSH
  rather than at the plan's Task 1 step 2 position.

DEFECT 4, Task 1 step 2: "edit /etc/ssh/sshd_config so it contains exactly these
  values" is fragile. `Include /etc/ssh/sshd_config.d/*.conf` is at line 12 and
  sshd takes the FIRST value it obtains for a keyword, so the DigitalOcean image's
  50-cloud-init.conf and 60-cloudimg-settings.conf (both `PasswordAuthentication
  no`) win over the main file. Editing line 42 works for PermitRootLogin today
  only because no drop-in sets it. Replaced with a `10-` prefixed drop-in that
  sorts first, and with `sshd -T` as the verification — reading the file cannot
  tell you the effective config.
  Incidental finding: `PasswordAuthentication no` was ALREADY effective on the
  fresh image, so half of this step was a no-op from the start.

DEFECT 5, Task 3 step 5: the Caddyfile is copied and Caddy is never told to
  reload. `systemctl daemon-reload` reloads systemd's unit files, not Caddy's
  config. Caddy kept serving its install-time default `:80` welcome site:
  `<title>Caddy works!</title>`, admin API showing file_server on /usr/share/caddy,
  443 never opening, and a log line — `server is listening only on the HTTP port,
  so no automatic HTTPS will be applied` — that reads like an ACME failure and is
  not one. `sudo systemctl reload caddy` added, plus a check of the RUNNING config
  via the admin API rather than the file on disk.

DEFECT 6, Task 4 step 4: expected a `Server: Caddy` header. Caddy 2 does not send
  one; the only headers are `HTTP/2 200` and `alt-svc`. The check would fail on a
  correctly configured Caddy. Replaced with the certificate comparison, which
  actually discriminates:
    app.stairwell.run  -> CN=app.stairwell.run, Let's Encrypt YE2   (our cert)
    kplife.stairwell.run -> CN=stairwell.run, Google Trust Services WE1
                            (Cloudflare's edge cert — the proxied control)
  plus absence of cf-* headers and remote_ip=157.230.54.1.

DEFECT 7 — IN THE APP, NOT THE PLAN. THE BIG ONE. See the redirect section below.

--- THE REDIRECT BUG: absolute Locations behind a proxy ---

Found only by requesting the live URL. Behind Caddy every absolute redirect named
the internal origin, so the entire auth flow was unusable at app.stairwell.run:

  GET /                    -> location: https://localhost:3000/login
  GET /devone (no cookie)   -> location: https://localhost:3000/login
  POST /api/login (bad pw)  -> location: https://localhost:3000/login?error=1

Root cause: `new URL(path, request.url)` at six sites. Evidence gathered at each
boundary on the droplet before any fix was proposed:

  origin, no Host header             -> http://localhost:3000/login
  origin, Host: app.stairwell.run    -> http://localhost:3000/login   <-- IGNORED
  origin, Host + X-Forwarded-Proto   -> https://localhost:3000/login
  through Caddy                      -> https://localhost:3000/login

Boundary 2 is decisive: an explicit Host changes nothing, so this was never Caddy
failing to forward it. Next honours X-Forwarded-Proto for the scheme but does not
take the host from Host or X-Forwarded-Host.

THEN THE FIX ITSELF HAD A BUG, which is the part worth remembering. Making every
redirect relative fixed the route handlers and 500ed all middleware redirects:

  TypeError: Invalid URL ... code: 'ERR_INVALID_URL', input: '/login'
      at .next/server/middleware.js

Next's middleware runtime parses the Location header as a URL, so a relative value
throws before the response leaves the process. Route handlers have no such
constraint. The layers genuinely differ:

  middleware      -> Location MUST be absolute
  route handlers  -> Location SHOULD be relative (needs no host, trusts nothing)

Final shape: lib/http/redirect.ts holds both, one definition each, mirroring the
lib/session/cookie.ts precedent. relativeRedirect for handlers; middlewareRedirect
builds the origin from x-forwarded-host (falling back to Host) and
x-forwarded-proto, refuses a host failing HOST_PATTERN rather than splicing it into
the authority, and rejects protocol-relative paths so it cannot become an open
redirect.

Trusting the host header is safe behind THIS Caddyfile and the docstring records
why and what would break it: one site block for app.stairwell.run, Caddy matches
sites by Host so any other Host never reaches the app, ufw allows only 22/80/443,
and Next binds 127.0.0.1. A second site block, a wildcard host, or a direct route
to 3000 invalidates that and it should move to a configured allowlist.

*** THE LESSON, one tier further out than the step1a ledger's version. ***
  step1a established: tests green != tsc clean != next build succeeds.
  step1b adds: none of those means "works behind the proxy it will run behind".
  Both redirect bugs passed 160+ tests, tsc, next build, AND Gates D and E. The
  first shipped to the droplet; the second was caught by a live request minutes
  later. On localhost the internal origin IS the external one, so no local check
  can distinguish them — only a proxy separates them.

  HONEST COVERAGE LIMIT, stated in tests/http/redirect.test.ts too: no unit test
  reproduces the ERR_INVALID_URL throw, because it happens inside Next's adapter
  AFTER middleware() returns. The pre-existing middleware tests passed with the
  broken relative Location, and they also could not distinguish fixed from broken
  for the absolute case, because they construct a NextRequest with no proxy
  headers at all. A new test supplies them. What the suite pins is the property
  that avoids the throw, not the throw.

  METHODOLOGY NOTE: the assertions now pin the SHAPE, not just the string.
  `toBe('http://localhost/nico')` passed throughout the entire broken period.
  Only `/^\//` and `not /^[a-z]+:\/\//` catch a regression to an absolute URL.

--- RESIDUALS — parked, Nico adjudicated ---

1. ACCEPTED AS DOCUMENTED (Nico's ruling, no build-to-temp scope):
   deploy/deploy.sh runs `npm run build` BEFORE the test gate, overwriting
   .next/ in place under the still-running old server. So "a failing suite
   leaves the previous version serving" means the old PROCESS is never
   restarted — NOT that the old build is still on disk. `next start` loads
   server chunks lazily, so a route not hit since the last restart can fault
   against the new .next/ during the build-plus-test window, which lasts the
   length of a build plus a suite run.
   Task 5 step 5's proof (curl /login returns 200 through an aborted deploy) is
   therefore weaker than it looks: /login is already resident. It does prove no
   restart happened, which is what the gate exists for.
   The fix, if ever wanted, is building to a temp directory and swapping.
   Ruled explicitly out of scope for 1b. Documented in deploy/deploy.sh itself
   so the next reader does not over-read the guarantee.

3. NEW, unparked — `systemctl is-active` is not "serving". deploy.sh restarts,
   sleeps 2, and checks `is-active`, which is true as soon as systemd has forked
   npm — well before Next is listening. Measured: Caddy returns 502 for a short
   window after every restart, and a readiness loop needed 2 polls (up to ~4s) to
   see /login return 200. So a deploy that came back up broken in a way that
   still keeps the process alive would be reported as "Service is active."
   This bit the checkpoint run itself: the first attempt reported 502s for
   checkpoint item 8 because `curl` exits 0 on a 502, so the wait loop broke out
   immediately. That was a bug in the check, not the app — but it is exactly the
   failure mode deploy.sh has.
   RECOMMENDED (not done, needs Nico's call): a post-restart smoke check in
   deploy.sh that polls for an actual 200 and asserts the redirect shape, so
   deploy.sh cannot declare success while the site is broken. Both redirect bugs
   above would have been caught by it. Deliberately not added unilaterally —
   it changes the deploy contract.

2. FIXED, not parked (Nico's ruling): the journalctl blind spot. deploy.sh
   prints `journalctl -u stairwell -n 30` on the service-did-not-come-back path,
   but `deploy` was only in `sudo`, and the NOPASSWD grant covers exactly
   `systemctl restart stairwell`, so `sudo journalctl` is no fallback. Adding
   `deploy` to `systemd-journal` is now in both deploy/PROVISION.md and the
   plan's Task 1 step 2. NOT YET EXERCISED on a real droplet — verify when
   Task 1 runs.

--- Task 7: complete (commits aec9fb5, then the residual-#7 follow-up) ---

Collapsed the fresh-login double prompt. Verified against a REAL production
server, per the step1a lesson that `next build` succeeding is not observation:
  fresh login          -> 303 /devone (not /unlock), one password entry
  GET /devone + cookie -> 200
  restart, same cookie -> 307 /unlock (NOT /login)  <- the two-tier lock holds
  GET /unlock + cookie -> 200
  wrong password       -> 303 /login?error=1, no Set-Cookie
  cookie flags         -> Secure; HttpOnly; SameSite=lax
The cookie-flag observation also pre-confirms Task 6 step 3 locally; it still
needs re-checking over real HTTPS, since `secure` is NODE_ENV-dependent.

Both new assertions proven diagnostic by mutation, each failing alone:
  - putKey added to the failure branch -> "derives NO key" fails (1 call vs 0)
  - resolveState hardcoded to 'unlocked' -> re-lock test fails
    ("expected null to be '/unlock'"). This is the assertion the plan said
    mattered most, and it is now pinned rather than assumed.
A third test uses slug 'devtwo' deliberately: with only the 'nico' case, an
implementation redirecting to a literal '/nico' would pass.

METHODOLOGY FINDING, worth keeping: the first attempt scoped the keymap spy
with a file-level vi.mock. A probe proved a vi.mock factory SURVIVES
vi.resetModules() — a key written under a fixed sid in one test was visible in
the next (keyLeaked=true). That silently defeats the per-test isolation
tests/auth/routes.test.ts's header comment describes as load-bearing, and no
assertion would have caught it, because every other sid in the file is random.
Same family as the step1a Task 9 trap where a shared KEY constant would have
made a zeroing test compare zeroed-to-zeroed. Replaced with per-test
vi.doMock + doUnmock in afterEach; a second probe confirmed the following test
gets the real keymap back with no leaked key (isSpy=false, keyLeaked=false).
Anyone reaching for vi.mock in a file that relies on resetModules for isolation
should re-run that probe first.

Also corrected login()'s docstring in lib/auth/flow.ts, which said the key is
derived at /unlock. False as a description of the flow after this change, and a
comment asserting a security property that no longer holds is worse than none.

--- step1a residual #7: FIXED (Nico's ruling) ---

An authenticated-but-locked session could not reach /login: routeFor bounces an
'authenticated' state back to /unlock from every path except /unlock and
/admin, so a forgotten password was a dead end until the cookie was cleared by
hand. app/(auth)/unlock/page.tsx now carries a POST form to /api/logout.

Reachability confirmed by reading both layers rather than assuming: middleware.ts
only bounces requests with NO session cookie, and app/api/logout/route.ts
deliberately does not call requireState — so logout is reachable while locked.

tests/auth/unlockPage.test.ts is the first page-level test for this component.
It walks the element tree for real `form` nodes instead of substring-matching
the render, and that distinction is load-bearing: /api/logout is POST-only, so
a GET `<a href="/api/logout">` would 405 and leave the dead end in place while
satisfying any assertion that just looked for the string. Proven against BOTH
mutants — the pre-fix page and the GET-link version each fail it.

CONTRACT FIX (Nico's ruling, folded in): the reason this sat unfixed is that
CLAUDE.md made spec.md + mockup.html the build contract, and no mockup covers
the auth pages, so "no mockup" read as "do not guess". CLAUDE.md now scopes
mockup.html to user dashboards and points platform auth pages at the step-1a
design doc (§3 owns app/(auth)/login, /unlock), with an explicit line that
absence of a mockup is not a reason to leave an auth-page gap unfixed.
