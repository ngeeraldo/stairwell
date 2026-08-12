# Droplet provisioning

DigitalOcean, Ubuntu 24.04 LTS, basic shared-CPU plan.

Built and verified on a 1 GB / 1 vCPU droplet in nyc1 (Ubuntu 24.04.4 LTS).

1. Create with SSH key auth. Record the public IPv4.

   **On a 1 GB droplet, add swap.** `deploy/deploy.sh` runs `npm ci` (which
   natively compiles `better-sqlite3-multiple-ciphers`), `npm run build`, and
   the full suite **on the droplet on every deploy**, not just at setup.

   Measured on the 1 GB nyc1 droplet, so this is insurance rather than a
   rescue: `next build` alone completed in 1m22s and touched **1 MB** of swap
   (available RAM went 640 MB -> 596 MB), and after three full `deploy.sh` runs
   total swap use was **40 MB** with ~545 MB still available. Nothing has come
   close to OOM. Keep the swap anyway — the headroom costs 2 GB of a 24 GB disk
   and the failure it prevents is a bare `Killed` mid-build, which reads like a
   code failure rather than memory exhaustion. Do not read the numbers above as
   licence to drop it on a busier box or a larger suite.

   ```bash
   fallocate -l 2G /swapfile
   chmod 600 /swapfile
   mkswap /swapfile
   swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

   Verify: `swapon --show` reports 2G, and the `/etc/fstab` line is present so
   it survives a reboot. A 2 GB droplet does not need this.
2. Create the `deploy` user, copy `authorized_keys`, add to `sudo`, and add to
   `systemd-journal`:

   ```bash
   sudo usermod -aG systemd-journal deploy
   ```

   Required, not cosmetic. `deploy/deploy.sh` prints
   `journalctl -u stairwell -n 30` on its "service did not come back up" path,
   and that is the one moment you need the logs. Without this group the
   unprivileged `deploy` user gets a filtered view, and the `NOPASSWD` sudoers
   grant is scoped to exactly `systemctl restart stairwell`, so `sudo
   journalctl` will not work either. Group membership applies on the next login.
3. SSH hardening: `PermitRootLogin no`, `PasswordAuthentication no`.

   **Do not edit `/etc/ssh/sshd_config` directly.** Line 12 of that file is
   `Include /etc/ssh/sshd_config.d/*.conf`, and sshd uses the FIRST value it
   obtains for a keyword. DigitalOcean's image already ships two drop-ins
   (`50-cloud-init.conf`, `60-cloudimg-settings.conf`) that both set
   `PasswordAuthentication no`, so those win over the main file regardless of
   what it says. Editing line 42 happens to work for `PermitRootLogin` today
   only because no drop-in sets it — the moment one does, the edit becomes a
   silent no-op on a security setting.

   Use a drop-in that sorts FIRST, so it wins outright:

   ```bash
   cat > /etc/ssh/sshd_config.d/10-stairwell-hardening.conf <<'EOF'
   PermitRootLogin no
   PasswordAuthentication no
   EOF
   chmod 600 /etc/ssh/sshd_config.d/10-stairwell-hardening.conf
   sshd -t && systemctl restart ssh
   ```

   Verify the EFFECTIVE config, never the file contents:

   ```bash
   sshd -T | grep -iE '^(permitrootlogin|passwordauthentication|pubkeyauthentication)'
   ```

   Expect `permitrootlogin no`, `passwordauthentication no`,
   `pubkeyauthentication yes`. Reading the file cannot tell you this; `sshd -T`
   resolves the includes and prints what the daemon will actually enforce.

   Verify `ssh deploy@<IP> whoami` from a second terminal BEFORE closing the
   root session.

   **`deploy` needs a password even though login is key-only.**
   `adduser --disabled-password` leaves no password, and `usermod -aG sudo`
   makes sudo *prompt* for one — so `deploy` lands in the sudo group unable to
   use sudo at all (`sudo: a password is required`). Every `sudo` later in this
   plan fails that way. Set one with `passwd deploy`. It is never used to log
   in, because `PasswordAuthentication no` is enforced above; it exists purely
   for sudo escalation, and without it, disabling root login leaves the DO web
   console as the only administrative path.
4. `ufw`: default deny incoming, allow 22, 80, 443, enable.
5. `apt-get install -y curl git jq build-essential python3 unattended-upgrades`
   then NodeSource Node 22.
6. Verify: `node -v` is v22.x, `jq --version` succeeds.

`jq` is required, not optional: setup.sh exits 2 without it, because the guard
hook cannot parse tool payloads and would fail open.

Node 22 must match local — `better-sqlite3-multiple-ciphers` compiles natively,
and a version skew surfaces as a confusing runtime failure rather than an
install failure.
7. Secrets, including `ANTHROPIC_API_KEY=sk-ant-...`, go in
   `/home/deploy/stairwell/.env` — the file `deploy/stairwell.service:11`
   already loads via `EnvironmentFile`. That file lives outside the repo and
   is never checked in; create or edit it by hand on the droplet, over SSH,
   readable only by `deploy`. This does not change the deploy contract:
   `deploy/deploy.sh` remains the only way changes reach the droplet, and a
   restart is enough to pick up a new or changed `.env` value — no redeploy
   required.
