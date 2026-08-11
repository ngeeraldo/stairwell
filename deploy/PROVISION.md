# Droplet provisioning

DigitalOcean, Ubuntu 24.04 LTS, basic shared-CPU plan.

1. Create with SSH key auth. Record the public IPv4.
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
