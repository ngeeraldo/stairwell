# Step 1b — Infrastructure and Deploy

**Date:** 2026-08-10
**Status:** Approved, pre-implementation
**Covers:** The infrastructure half of build-order step 1 — droplet, TLS, DNS,
and the deploy path that takes step 1a from localhost to `app.stairwell.run`.

**Paired with:** `2026-08-10-step1-auth-and-test-gate-design.md`, which ends at a
localhost checkpoint. This spec depends on that one being complete; the reverse
is not true.

**Checkpoint:** the step 1a checkpoint, re-verified against the live URL — Nico
logs in at `https://app.stairwell.run` as two dev users, each 404-blind to the
other's space, and the admin portal loads, empty. Plus: the droplet's `setup.sh`
output shown in full and green (§4.2).

---

## 1. Decisions made during this design

| Question | Decision |
|---|---|
| Hostname | `app.stairwell.run` |
| Edge / TLS | Grey-cloud (DNS-only) A record → Caddy on the droplet, Let's Encrypt |
| Host | DigitalOcean droplet, Ubuntu 24.04 LTS |
| Deploy trigger | `deploy/deploy.sh` over SSH; tests gate the restart |
| First-clone bootstrap | `deploy.sh` runs `./setup.sh` before anything else |

### 1.1 Why DNS-only rather than a Cloudflare tunnel

`kplife.stairwell.run` is an existing tunnel CNAME pointing at Nico's laptop. It
is a separate DNS record from the app's A record and is never touched by this
work. Nothing in this spec modifies, migrates, or depends on it.

The app deliberately does *not* reuse the tunnel pattern. The login password is
SQLCipher key material (auth spec §2.2), so whoever terminates TLS sees key
material in plaintext. Cloudflare terminating TLS would put an asterisk on the
onboarding promise — *"I'd have to deliberately modify the system to see
anything"* — that could not be honestly omitted from the login-page paragraph.
Terminating TLS on the droplet costs `ufw` plus key-only SSH, which is the
cheaper side of that trade.

Flipping to a proxied record later is a one-click change if DDoS cover is ever
needed. That is a reversible decision; the privacy paragraph is not.

---

## 2. The droplet

DigitalOcean droplet, Ubuntu 24.04 LTS.

- Non-root deploy user; root SSH login disabled.
- Key-only SSH; password authentication off.
- `ufw` limited to 22, 80, 443. Default deny inbound.
- `unattended-upgrades` enabled.
- Node 22 pinned to match local, because `better-sqlite3-multiple-ciphers`
  compiles natively on the box and a version skew surfaces as a confusing
  runtime failure rather than an install failure.
- `jq`, `git`, and a C toolchain installed at provision time. `jq` is not
  optional: `setup.sh` exits 2 without it, because the guard hook cannot parse
  tool payloads and would fail open.

`.env` exists only on the droplet, created out of band. It is gitignored and
hook-denied locally, and nothing in the deploy path writes it.

---

## 3. Edge and DNS

Caddy terminates TLS with Let's Encrypt and reverse-proxies to Next.js on
`127.0.0.1:3000`. Next.js runs under a systemd unit (`stairwell.service`) as the
deploy user, with `Restart=on-failure`.

Because Next.js binds to loopback only, the app is unreachable except through
Caddy even if `ufw` were misconfigured.

One Cloudflare DNS record is added: a **grey-cloud (DNS-only) A record**, `app` →
droplet IP. The `kplife` CNAME is a different record and is not modified.

---

## 4. Deploy

### 4.1 `deploy/deploy.sh`

Run over SSH. In order:

1. **`./setup.sh` if the hooks are not yet wired.** `core.hooksPath` is not
   tracked by git, so a fresh clone has no gate until `setup.sh` runs. The check
   is cheap and `setup.sh` is idempotent, so this is safe to leave in the path
   permanently rather than making it a one-time manual step that is forgotten on
   the next rebuild.
2. `git pull`
3. `npm ci` — full install, not `--omit=dev`, because step 5 needs Vitest.
4. `npm run build`
5. `npx vitest run` — **tests gate the restart**, per `CLAUDE.md` > Testing. A
   failing suite aborts before step 6, leaving the running service untouched.
6. `systemctl restart stairwell`

Steps 4 and 5 run against the new code but before the service is restarted, so a
failed deploy leaves the previous version serving.

### 4.2 The fresh-clone survival story, verified on Linux

`setup.sh` has never run anywhere but Nico's laptop. The droplet is its first run
on a **case-sensitive filesystem**, and that is a real difference, not a
formality: macOS APFS is case-insensitive by default, so a path that resolves
locally can fail on ext4. `.githooks/pre-commit`, `CLAUDE.md`, `Caddyfile`, and
every `users/<name>/` path are all places where a casing mistake is invisible
locally and fatal on the server.

**The plan includes a verification step whose deliverable is the droplet's
`setup.sh` output, shown in full**, not a report that it passed. It must show:

- `ok    jq present (…)`
- `ok    core.hooksPath = .githooks`
- `ok    executable:` for all three of `deny-sensitive-files.sh`,
  `test-hooks.sh`, and `.githooks/pre-commit`
- the full harness run green — every guard case and all ~45 gate cases
- `Setup complete. Guards are live and verified.`

Any `(repaired — was not executable)` line is worth noting rather than passing
over: it means the tracked exec bit did not survive, which is a repo problem, not
a droplet problem.

---

## 5. Documentation updates in the same work

**`architecture-overview.md`** records the hostname, the DNS-only edge decision
and its privacy rationale, and the droplet as the "single VPS" the overview
already assumes — so the overview stays the single source of settled decisions.

**`CLAUDE.md`** gains the deploy command and the rule that deploys go out through
`deploy/deploy.sh`, never by hand-editing files on the droplet.

---

## 6. Out of scope

- Everything in the auth spec. This work deploys that code; it does not change
  it.
- CI. The deploy path runs tests on the droplet; a hosted CI pipeline is not
  part of the pilot.
- Off-VPS backup of the metrics log and transcripts — that is step 7, and it is
  called out there. This spec does not create backups, and nothing here should
  be read as providing them.
- Staging environments, blue-green deploys, zero-downtime restarts. A brief
  restart is acceptable; the two-tier session model (auth spec §2.3) already
  means users stay logged in across one.
- Monitoring and alerting beyond `Restart=on-failure`. ntfy.sh alerts are step 3.
