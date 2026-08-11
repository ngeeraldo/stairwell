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
