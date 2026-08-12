// tests/deploy/service.test.ts
//
// deploy/stairwell.service must start Next.js bound to loopback ONLY, so the
// app is unreachable except through Caddy even if ufw were misconfigured.
//
// This is a static scan because nothing else in the project can catch the
// regression it guards. The step-1b plan originally expressed the bind as
// `Environment=HOSTNAME=127.0.0.1`, which reads correctly and does nothing:
// in Next 15 `next start` declares --port with commander's .env('PORT') but
// declares --hostname WITHOUT .env('HOSTNAME'), so nothing reads the variable
// and `server.listen(port, undefined)` binds every interface. Measured on
// Next 15.5.23: HOSTNAME=127.0.0.1 in the environment yields a `*:PORT`
// socket; `-H 127.0.0.1` yields `127.0.0.1:PORT`.
//
// The plan's own verification could not distinguish the two, which is why a
// test exists: an external `curl <DROPLET_IP>:3000` is dropped by ufw (only
// 22/80/443 are open) whether the bind is loopback or wide open, so that probe
// passes either way. On the droplet the direct check is `ss -ltnp | grep :3000`.
//
// A true end-to-end assertion would boot `next start` and inspect the real
// socket. That needs a production build and a spare port, so it is out of
// scope for the unit suite; this scan pins the one line that decides it.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const unit = readFileSync('deploy/stairwell.service', 'utf8')

const execStart = unit
  .split('\n')
  .find((line) => line.trimStart().startsWith('ExecStart='))

describe('deploy/stairwell.service', () => {
  it('has exactly one ExecStart line (guards the scans below against a silent no-match)', () => {
    const all = unit
      .split('\n')
      .filter((line) => line.trimStart().startsWith('ExecStart='))
    expect(all).toHaveLength(1)
  })

  it('binds Next.js to loopback with the -H flag, which is the only mechanism that works', () => {
    // Accept -H or --hostname, with a space or an = separator, so a reasonable
    // reformat does not fail this. Anything that drops the flag does fail it.
    expect(
      execStart,
      'ExecStart must pass the hostname as a CLI flag; the HOSTNAME env var is read by nothing',
    ).toMatch(/(-H|--hostname)[=\s]+127\.0\.0\.1(\s|$)/)
  })

  it('does NOT try to set the hostname through the environment, which silently binds every interface', () => {
    expect(
      unit,
      'Environment=HOSTNAME= is a no-op for `next start` and reads as protection that is not there',
    ).not.toMatch(/^\s*Environment=HOSTNAME=/m)
  })

  it('sets the port through PORT, which next start does read via commander .env(PORT)', () => {
    // Recorded deliberately alongside the hostname case: the two options look
    // symmetrical in the unit file but are not symmetrical in Next's CLI, and
    // that asymmetry is the entire bug this file guards.
    expect(unit).toMatch(/^\s*Environment=PORT=3000\s*$/m)
  })

  it('runs as the unprivileged deploy user from the deploy checkout', () => {
    expect(unit).toMatch(/^\s*User=deploy\s*$/m)
    expect(unit).toMatch(/^\s*WorkingDirectory=\/home\/deploy\/stairwell\s*$/m)
  })
})

describe('deploy/deploy.sh env gate', () => {
  const script = readFileSync('deploy/deploy.sh', 'utf8')

  // Assertions below are about COMMANDS, not comments. The block that invokes
  // check-env.sh deliberately mentions `npm ci` and the script's own name in
  // its explanatory comment, so a naive indexOf over the raw file matches the
  // prose and not the code — in both directions: it can fail on a harmless
  // comment, and it can pass while the real invocation has moved.
  const commands = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  it('calls check-env.sh', () => {
    expect(script).toMatch(/check-env\.sh/)
  })

  it('stripping comments does not strip the invocation itself', () => {
    // Pins the property the stripping above relies on: if the real call
    // ever gets commented out (or otherwise stops being a command), this
    // fails loudly instead of the position tests below silently passing
    // against nothing.
    expect(commands).toMatch(/check-env\.sh/)
  })

  it('calls it AFTER the pull and BEFORE npm ci', () => {
    // Ordering is the whole design. After the pull, so a deploy that
    // introduces a new requirement enforces it on itself — the same
    // reasoning as the re-exec block. Before npm ci, so a missing variable
    // costs seconds rather than a full build and test cycle.
    const pull = commands.indexOf('git pull --ff-only')
    const check = commands.indexOf('check-env.sh')
    const install = commands.indexOf('npm ci')
    expect(pull).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(pull)
    expect(check).toBeLessThan(install)
  })

  it('aborts the deploy when the check fails', () => {
    const check = commands.indexOf('check-env.sh')
    const after = commands.slice(check, check + 400)
    expect(after).toMatch(/exit 1/)
  })

  it('checks the same file the systemd unit loads', () => {
    // The unit's EnvironmentFile and the path deploy.sh checks must be the
    // same file, or the gate validates something the service never reads.
    // deploy.sh cds to the repo root, which IS the unit's WorkingDirectory.
    const envFileLine = unit
      .split('\n')
      .find((l) => l.trimStart().startsWith('EnvironmentFile='))
    expect(envFileLine).toBeDefined()
    const unitPath = envFileLine!.split('=').slice(1).join('=').trim()
    expect(unitPath.endsWith('/.env')).toBe(true)

    const workingDir = unit
      .split('\n')
      .find((l) => l.trimStart().startsWith('WorkingDirectory='))
    expect(workingDir).toBeDefined()
    const wd = workingDir!.split('=').slice(1).join('=').trim()
    expect(unitPath).toBe(`${wd}/.env`)

    // And deploy.sh must pass a path that resolves to that same file from
    // the repo root it cds into.
    expect(script).toMatch(/check-env\.sh\s+deploy\/required-env\s+\.env/)
  })
})
