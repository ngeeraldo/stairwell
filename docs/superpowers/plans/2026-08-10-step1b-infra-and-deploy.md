# Step 1b — Infrastructure and Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the step 1a build from a localhost checkpoint to the same checkpoint verified live at `https://app.stairwell.run`, with a repeatable deploy path.

**Architecture:** A DigitalOcean droplet runs Next.js under systemd on loopback, with Caddy terminating TLS in front of it. TLS terminates on the droplet — not at Cloudflare — because the login password is SQLCipher key material. `deploy/deploy.sh` pulls, installs, builds, runs the suite, and only then restarts.

**Tech Stack:** Ubuntu 24.04 LTS, Caddy 2, systemd, Node 22, Cloudflare DNS (records only, grey cloud).

**Spec:** `docs/superpowers/specs/2026-08-10-step1-infra-and-deploy-design.md`

**Prerequisite:** the step 1a plan is complete and its localhost checkpoint verified.

## Global Constraints

- The `kplife.stairwell.run` tunnel CNAME is never modified, migrated, or depended on. It is a different record. If any step seems to require touching it, stop and flag it.
- The app's DNS record is **grey cloud (DNS only)**. An orange-cloud record would put login passwords in plaintext at Cloudflare's edge.
- Next.js binds `127.0.0.1` only. It is never directly reachable from the internet.
- `.env` exists only on the droplet, created by hand. It is never committed, never printed, and never read by Claude — the guard hook denies it.
- Real databases exist only on the server. Nothing in this plan copies a database to or from the laptop.
- Node 22 on the droplet, matching local, because `better-sqlite3-multiple-ciphers` compiles natively.
- `deploy/**` and `Caddyfile` are Gate B-exempt, so commits in this plan do not require test changes. `.githooks/` and `.claude/hooks/` are not exempt — if any task touches those, it must stage `.claude/hooks/test-hooks.sh`.

---

## File Structure

**Created in the repo:**
- `deploy/Caddyfile` — the reverse-proxy config, version-controlled and copied to the droplet.
- `deploy/stairwell.service` — the systemd unit, likewise.
- `deploy/deploy.sh` — the deploy path, run over SSH.
- `deploy/PROVISION.md` — the droplet build sheet, so a rebuild is a re-read rather than a memory exercise.

**Created on the droplet only:** `/home/deploy/stairwell` (the clone), `/home/deploy/stairwell/.env`, `/etc/caddy/Caddyfile`, `/etc/systemd/system/stairwell.service`.

---

### Task 1: Provision the droplet

**Files:**
- Create: `deploy/PROVISION.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a reachable droplet with a non-root `deploy` user, key-only SSH, `ufw` closed except 22/80/443, and Node 22 + `jq` + a C toolchain installed. Record the IP — every later task needs it.

- [ ] **Step 1: Create the droplet**

In the DigitalOcean console: Ubuntu 24.04 LTS, basic shared-CPU plan, region closest to the pilot users, SSH key authentication (not password). Note the public IPv4 address.

- [ ] **Step 2: Create the deploy user and lock down SSH**

```bash
ssh root@<DROPLET_IP>
adduser --disabled-password --gecos "" deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
usermod -aG sudo deploy
```

Then edit `/etc/ssh/sshd_config` so it contains exactly these values:

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
systemctl restart ssh
```

- [ ] **Step 3: Verify you can still get in before closing the door**

From your laptop, in a **new terminal** — keep the root session open until this succeeds:

```bash
ssh deploy@<DROPLET_IP> 'whoami'
```

Expected: `deploy`. If this fails, fix it from the still-open root session. Do not proceed until it works.

- [ ] **Step 4: Firewall**

```bash
ssh deploy@<DROPLET_IP>
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

Expected: `Status: active`, default deny incoming, three allow rules.

- [ ] **Step 5: Install the toolchain**

```bash
sudo apt-get update
sudo apt-get install -y curl git jq build-essential python3 unattended-upgrades
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo dpkg-reconfigure -plow unattended-upgrades
```

- [ ] **Step 6: Verify versions**

```bash
node -v && npm -v && jq --version && python3 --version && git --version
```

Expected: `v22.x`. `jq` is not optional — `setup.sh` exits 2 without it, because the guard hook cannot parse tool payloads and would fail open.

- [ ] **Step 7: Write `deploy/PROVISION.md`**

On the laptop, record exactly what was done, so a rebuild is a re-read:

```markdown
# Droplet provisioning

DigitalOcean, Ubuntu 24.04 LTS, basic shared-CPU plan.

1. Create with SSH key auth. Record the public IPv4.
2. Create the `deploy` user, copy `authorized_keys`, add to `sudo`.
3. `/etc/ssh/sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`.
   Verify `ssh deploy@<IP> whoami` from a second terminal BEFORE closing the
   root session.
4. `ufw`: default deny incoming, allow 22, 80, 443, enable.
5. `apt-get install -y curl git jq build-essential python3 unattended-upgrades`
   then NodeSource Node 22.
6. Verify: `node -v` is v22.x, `jq --version` succeeds.

`jq` is required, not optional: setup.sh exits 2 without it, because the guard
hook cannot parse tool payloads and would fail open.

Node 22 must match local — `better-sqlite3-multiple-ciphers` compiles natively,
and a version skew surfaces as a confusing runtime failure rather than an
install failure.
```

- [ ] **Step 8: Commit**

```bash
git add deploy/PROVISION.md
git commit -m "Add droplet provisioning notes"
```

---

### Task 2: Clone the repo and run setup.sh on Linux

This is the first time `setup.sh` has run anywhere but a macOS laptop. The deliverable is its output, shown in full.

**Files:** none in the repo.

**Interfaces:**
- Consumes: the droplet from Task 1.
- Produces: `/home/deploy/stairwell`, a clone with `core.hooksPath` wired and the harness green on a case-sensitive filesystem.

- [ ] **Step 1: Clone**

```bash
ssh deploy@<DROPLET_IP>
git clone https://github.com/ngeeraldo/stairwell.git /home/deploy/stairwell
cd /home/deploy/stairwell
```

- [ ] **Step 2: Confirm the gate does not exist yet**

```bash
git config core.hooksPath || echo "(unset — as expected in a fresh clone)"
```

Expected: unset. `core.hooksPath` is not tracked by git, which is the entire reason `setup.sh` exists.

- [ ] **Step 3: Run setup.sh and capture the output**

```bash
./setup.sh 2>&1 | tee /tmp/setup-output.txt
```

- [ ] **Step 4: Show the output — this is the verification deliverable**

Paste the full contents of `/tmp/setup-output.txt` into the session. Do not summarise it. It must contain:

- `ok    jq present (…)`
- `ok    core.hooksPath = .githooks`
- `ok    executable: .claude/hooks/deny-sensitive-files.sh`
- `ok    executable: .claude/hooks/test-hooks.sh`
- `ok    executable: .githooks/pre-commit`
- the full harness run, every guard case and all ~45 gate cases
- `All N checks passed.`
- `Setup complete. Guards are live and verified.`

**Flag rather than pass over:**

- Any `(repaired — was not executable)` line. It means the tracked exec bit did not survive the clone — a repo problem, not a droplet problem. Fix it on the laptop with `git update-index --chmod=+x <file>` and commit.
- Any failing case. macOS APFS is case-insensitive by default and ext4 is not, so a path that resolves locally can fail here. `.githooks/pre-commit`, `CLAUDE.md`, `Caddyfile`, and every `users/<name>/` path are the likely culprits.

- [ ] **Step 5: Install dependencies and confirm the native module builds**

```bash
npm ci
node -e "require('better-sqlite3-multiple-ciphers'); console.log('native module ok')"
```

Expected: `native module ok`. A failure here is a toolchain problem — confirm `build-essential` is installed.

- [ ] **Step 6: Run the suite on Linux**

```bash
npx vitest run
```

Expected: the same count as on the laptop. A test that passes locally and fails here is almost always a path-casing or a `python3`-missing problem.

---

### Task 3: systemd unit and Caddy

**Files:**
- Create: `deploy/stairwell.service`, `deploy/Caddyfile`

**Interfaces:**
- Consumes: the clone from Task 2.
- Produces: `stairwell.service` serving on `127.0.0.1:3000`, and Caddy proxying `app.stairwell.run` to it.

- [ ] **Step 1: Write `deploy/stairwell.service`**

```ini
[Unit]
Description=Stairwell (Personal Dashboard Pilot)
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/stairwell
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
EnvironmentFile=/home/deploy/stairwell/.env
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`HOSTNAME=127.0.0.1` is load-bearing: it keeps Next.js on loopback, so the app is unreachable except through Caddy even if `ufw` were misconfigured.

- [ ] **Step 2: Write `deploy/Caddyfile`**

```
app.stairwell.run {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains and renews the Let's Encrypt certificate automatically. TLS terminates here, on this box, and nowhere else — see the spec's §1.1 for why that is worth the firewall hygiene.

- [ ] **Step 3: Commit before installing, so the droplet copies a committed file**

```bash
git add deploy/stairwell.service deploy/Caddyfile
git commit -m "Add systemd unit and Caddyfile"
git push
```

- [ ] **Step 4: Create the .env on the droplet**

By hand, on the droplet only. It is gitignored and hook-denied.

```bash
ssh deploy@<DROPLET_IP>
cd /home/deploy/stairwell
git pull
printf 'PLATFORM_DB=/home/deploy/stairwell/platform.db\n' > .env
chmod 600 .env
```

- [ ] **Step 5: Install Caddy and the unit**

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp /home/deploy/stairwell/deploy/Caddyfile /etc/caddy/Caddyfile
sudo cp /home/deploy/stairwell/deploy/stairwell.service /etc/systemd/system/stairwell.service
sudo systemctl daemon-reload
```

- [ ] **Step 6: Build and start the app**

```bash
cd /home/deploy/stairwell
npm run build
sudo systemctl enable --now stairwell
sudo systemctl status stairwell --no-pager
```

Expected: `active (running)`.

- [ ] **Step 7: Verify it answers on loopback, and only on loopback**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

Expected: `200`.

From your **laptop**:

```bash
curl -sS --max-time 5 -o /dev/null -w '%{http_code}\n' http://<DROPLET_IP>:3000/login || echo "refused — correct"
```

Expected: refused or timed out. If it answers, `HOSTNAME=127.0.0.1` did not take effect and the app is exposed. Stop and fix before adding DNS.

---

### Task 4: DNS

**Files:** none.

**Interfaces:**
- Consumes: the droplet IP.
- Produces: `app.stairwell.run` resolving to the droplet, unproxied.

- [ ] **Step 1: Record what exists before touching anything**

In the Cloudflare dashboard for `stairwell.run`, list the current DNS records. Confirm `kplife` is a CNAME to a `cfargotunnel.com` target. **Do not modify it.**

- [ ] **Step 2: Add the app record**

Add: type `A`, name `app`, IPv4 `<DROPLET_IP>`, **Proxy status: DNS only (grey cloud)**, TTL auto.

An orange cloud here would terminate TLS at Cloudflare, putting login passwords — which are SQLCipher key material — in plaintext at their edge. That is the one thing this record must not do.

- [ ] **Step 3: Verify resolution and that kplife is untouched**

```bash
dig +short app.stairwell.run
dig +short kplife.stairwell.run
```

Expected: the first returns the droplet IP directly, with no Cloudflare proxy addresses in front of it. The second still returns its tunnel target, unchanged.

- [ ] **Step 4: Verify TLS is issued and served by Caddy**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://app.stairwell.run/login
curl -sSI https://app.stairwell.run/login | grep -i '^server:'
```

Expected: `200`, and a `Server: Caddy` header. If the header names Cloudflare, the record is proxied — go back to step 2.

Certificate issuance can take up to a minute on first request. If it fails, check `sudo journalctl -u caddy -n 50 --no-pager`.

---

### Task 5: The deploy path

**Files:**
- Create: `deploy/deploy.sh`

**Interfaces:**
- Consumes: everything above.
- Produces: a repeatable deploy that runs `setup.sh` on a fresh clone and gates the restart on tests.

- [ ] **Step 1: Write `deploy/deploy.sh`**

```bash
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

echo
echo "Deployed $(git rev-parse --short HEAD). Service is active."
echo
```

- [ ] **Step 2: Make it executable and commit**

```bash
chmod +x deploy/deploy.sh
git add deploy/deploy.sh
git update-index --chmod=+x deploy/deploy.sh
git commit -m "Add deploy script

Runs setup.sh on a fresh clone, then pull, install, build, test, restart.
A failing suite aborts before the restart, so the previous version keeps
serving."
git push
```

- [ ] **Step 3: Allow the restart without a password prompt**

On the droplet:

```bash
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart stairwell' \
  | sudo tee /etc/sudoers.d/stairwell-restart
sudo chmod 440 /etc/sudoers.d/stairwell-restart
sudo visudo -c
```

Expected: `parsed OK`. The grant is exactly one command — not blanket `systemctl`, and not blanket sudo.

- [ ] **Step 4: Run a real deploy**

From the laptop:

```bash
ssh deploy@app.stairwell.run '/home/deploy/stairwell/deploy/deploy.sh'
```

Expected: pull, install, build, the full suite passing, and `Service is active.`

- [ ] **Step 5: Prove the test gate actually gates**

On the droplet, temporarily break a test:

```bash
cd /home/deploy/stairwell
sed -i 's/expect(1 + 1).toBe(2)/expect(1 + 1).toBe(3)/' tests/smoke.test.ts
./deploy/deploy.sh || echo "aborted as designed"
```

Expected: `DEPLOY ABORTED — tests failed.` and no restart.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://app.stairwell.run/login
git checkout tests/smoke.test.ts
```

Expected: still `200` — the previous version kept serving throughout. This step is the whole reason the gate is ordered before the restart; do not skip it.

---

### Task 6: The live checkpoint

**Files:**
- Modify: `architecture-overview.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the step 1a checkpoint, re-verified over HTTPS.

- [ ] **Step 1: Create the dev accounts on the droplet**

`scripts/create-dev-users.ts` requires `ADMIN_PASSWORD` and exits 1 without it —
the admin password is never committed (CLAUDE.md > Data safety). Read it in at
the prompt rather than typing it inline, so it does not land in shell history,
and unset it afterwards:

```bash
ssh deploy@app.stairwell.run
cd /home/deploy/stairwell
read -rsp 'Admin password for nico: ' ADMIN_PASSWORD; echo
PLATFORM_DB=/home/deploy/stairwell/platform.db ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  npx tsx scripts/create-dev-users.ts
unset ADMIN_PASSWORD
sudo systemctl restart stairwell
```

Keep that password — Step 2's checkpoint 6 logs in as `nico` with it.

`ADMIN_PASSWORD` does not belong in `.env`: the service never reads it, and
`.env` outlives this one-shot run.

The script is INSERT-only and refuses to run against a database that already
has accounts, so it is safe to re-run by mistake but cannot repair a partial
run. If it fails partway, inspect `platform.db` and create the missing accounts
by hand rather than re-running.

- [ ] **Step 2: Re-verify the step 1a checkpoint against the live URL**

In a browser at `https://app.stairwell.run`:

1. Visiting the root redirects to `/login`, over HTTPS with a valid certificate.
2. Log in as `devone` → lands on `/unlock`.
3. Unlock → lands on `/devone`.
4. `/devtwo` → **404**, not 403.
5. `/admin` as `devone` → **404**.
6. Log out; log in as `nico` with the `ADMIN_PASSWORD` set in Step 1; unlock; `/admin` loads and lists `devone` and `devtwo`.
7. `/devone` as `nico` → **404**.
8. `sudo systemctl restart stairwell`, then reload `/devone` without clearing cookies → redirects to `/unlock`, not `/login`.

Step 8 is the two-tier model surviving a real restart on a real server — the thing that makes the live-build-and-deploy tweak loop tolerable.

- [ ] **Step 3: Confirm the cookie is Secure in production**

```bash
curl -sSI https://app.stairwell.run/login | grep -i set-cookie || echo "(no cookie on GET /login — expected)"
```

Then log in through the browser and inspect the `stairwell_session` cookie in devtools. Expected flags: `HttpOnly`, `Secure`, `SameSite=Lax`.

- [ ] **Step 4: Confirm kplife still works**

```bash
dig +short kplife.stairwell.run
```

Expected: unchanged from Task 4 step 1. Open it in a browser if it is currently being served, and confirm nothing about it changed.

- [ ] **Step 5: Update the docs**

In `architecture-overview.md`, under **Core decisions**, add a new subsection after **2. Data layer**:

```markdown
### 2a. Hosting (step 1b)
- **`app.stairwell.run`** on a DigitalOcean droplet (Ubuntu 24.04), Next.js
  under systemd on `127.0.0.1:3000` behind Caddy.
- **TLS terminates on the droplet, not at Cloudflare.** The DNS record is
  grey-cloud (DNS only). The login password is SQLCipher key material, so an
  edge that terminates TLS would see it in plaintext — which would put an
  asterisk on the onboarding promise that cannot be honestly omitted. Flipping
  to a proxied record later is reversible; the privacy paragraph is not.
- `kplife.stairwell.run` is an unrelated tunnel CNAME and is untouched.
- Deploys go out through `deploy/deploy.sh`: pull, install, build, test,
  restart. Tests gate the restart, so a failing suite leaves the previous
  version serving.
```

In `CLAUDE.md`, add to the **Build contract** section:

```markdown
- Deploys go out through deploy/deploy.sh only — never by editing files on
  the droplet. Tests gate the restart.
```

- [ ] **Step 6: Commit**

```bash
git add architecture-overview.md CLAUDE.md
git commit -m "Record step 1b hosting decisions

Live checkpoint verified at https://app.stairwell.run: two dev users
404-blind to each other, admin not an override, and a real systemd
restart leaves sessions alive but keys gone."
git push
```

---

### Task 7: Collapse the fresh-login double prompt

Carried in from step 1a. Nico's ruling after walking the local checkpoint: a
brand-new login asks for the password twice — once at `/login`, then again at
`/unlock` — because `login()` issues the session and redirects without deriving
the key, even though it had the password in hand a moment earlier.

**This is an implementation artifact, not an architectural change.**
`architecture-overview.md` commits to the key living only in memory with a 4h
idle TTL and 12h ceiling, so a restart leaves users logged in but locked. It does
not require two prompts inside a single login. `/unlock` stays exactly as it is —
it exists for the re-lock path (deploy, ceiling expiry), which is the common case
and already a single prompt.

**Files:**
- Modify: `app/api/login/route.ts`, `tests/auth/routes.test.ts`

**Interfaces:**
- Consumes: `deriveDbKey` (step 1a Task 8), `putKey` (Task 9), `findAccountBySlug`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Test-first, and assert both halves — the collapse AND what must not change:
1. A successful `POST /api/login` redirects to `/${slug}`, not `/unlock`.
2. After it, `getKey(sessionId)` is defined — the key was derived at login.
3. A failed login still redirects to `/login?error=1` and sets no cookie and no key.
4. **The re-lock path is untouched:** with a valid session row but no key in the
   map, `/[user]` still redirects to `/unlock`, and `/api/unlock` still works.

Assertion 4 is the one that matters. The two-tier lock's value is the restart
case; a change that quietly broke it while making login smoother would be a bad
trade, and only this assertion catches it.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Derive the key in the login route**

After `login()` returns a session id, look up the account's `salt_key`, call
`deriveDbKey(password, salt_key)`, `putKey(sessionId, key)`, then redirect to
`/${slug}`. The password is already in that POST body, so this crosses no new
trust boundary. Cost is one extra Argon2 pass (~14ms).

- [ ] **Step 4: Verify by hand**

`npm run build && npm start`, then: fresh login lands straight on `/${slug}` with
one password entry; restart the server without clearing cookies and confirm
`/${slug}` still redirects to `/unlock`.

- [ ] **Step 5: Commit**

**Adjacent, and worth doing in the same pass if it is cheap:** residual #7 in
`docs/superpowers/ledgers/step1a.md` — `/unlock` has no logout control and a
locked session cannot reach `/login`, so a forgotten password is a dead end until
cookies are cleared by hand. Both items are about that same screen.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 DNS-only rationale, kplife untouched | 4 (steps 1–4), 6 (step 4) |
| §2 droplet hardening, jq, Node 22 | 1 |
| §3 Caddy, systemd, loopback binding, DNS record | 3, 4 |
| §4.1 deploy.sh ordering, setup.sh on first clone, tests gate restart | 5 |
| §4.2 setup.sh output shown in full on Linux | 2 (steps 3–4) |
| §5 doc updates | 6 (step 5) |
| Checkpoint: live re-verification | 6 (step 2) |

**Placeholder scan:** `<DROPLET_IP>` is a value the implementer records in Task 1 step 1 and substitutes throughout. That is a real input, not an unfilled blank.

**Type consistency:** no application types are introduced. `PLATFORM_DB` is the same environment variable read by `lib/db/instance.ts` in the step 1a plan, Task 12. `stairwell.service`, `/etc/caddy/Caddyfile`, and `deploy/deploy.sh` refer to `/home/deploy/stairwell` consistently.

**Ordering note:** Task 3 step 7 (loopback-only check) deliberately precedes Task 4 (DNS). Adding the DNS record before confirming the app is not directly exposed would publish an unprotected origin.
