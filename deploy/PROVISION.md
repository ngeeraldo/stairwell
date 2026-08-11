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
