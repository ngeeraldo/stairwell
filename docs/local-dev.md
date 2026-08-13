# Running the app locally

Everything here runs against synthetic data only (CLAUDE.md > Data safety). The
local database is `platform/dev/synthetic.db`, which `.gitignore` covers via
`*.db` — nothing you do in the browser can end up committed.

## Dev accounts

| Slug | Password | Role |
|---|---|---|
| `devone` | `TEST-DEV-ONE` | user |
| `devtwo` | `TEST-DEV-TWO` | user |
| `nico` | whatever you passed as `ADMIN_PASSWORD` | admin |

`devone` and `devtwo` are loudly-fake fixtures and their passwords are literals in
`scripts/create-dev-users.ts` already, so they are written down here too.

**The admin password is deliberately not recorded anywhere in this repo.** The
script refuses to run without `ADMIN_PASSWORD` precisely so that an admin
credential is never committed — the same script seeds the production droplet.
If you forget the local one, delete the database and re-seed (below); there is
no password-reset path yet.

## Chat

`deploy/required-env` is the source of truth for which environment
variables the running app needs, by name and severity — including names a
dependency reads internally rather than our own code, so do not expect to
find them all by grepping for `process.env`. Locally, supply a value the
same way you would `ADMIN_PASSWORD` above: at the command line, or in an
untracked `.env.local` (already covered by `.gitignore`, alongside `*.db`),
which Next loads automatically. The guard hook denies Read/Edit on `.env`
files by design (CLAUDE.md > Data safety) — that includes `.env.local`, so
Claude cannot open it to check what's in it; set it yourself.

```bash
# Repeat the assignment on BOTH commands. A `VAR=x cmd` prefix binds to that
# one command only, so `VAR=x npm run build && npm start` runs npm start
# without it — and these names are needed at RUNTIME, not at build time, so
# that form fails in exactly the way it looks like it should work.
<VAR>='<value>' npm run build
<VAR>='<value>' npm start
```

`.env.local` is the less error-prone option: put `<VAR>=<value>` there once
and both commands pick it up. Check `deploy/required-env` for which `<VAR>`
names apply here and what each is for.

A missing `REQUIRED` or `DEGRADED` name now surfaces as a `[env] missing …`
warning in the console at `npm run dev` (or `npm start`) startup, rather
than only at the first request that needed it. If you see `[env] missing
REQUIRED: PLATFORM_DB`, it means `.env.local` doesn't have it set yet — see
First-time setup below for the one-line fix. That warning means something;
it is not expected noise on a healthy start.

`NTFY_TOPIC` is the same kind of name. Set it to a topic you do **not**
subscribe to on your phone — local development sends real pushes to
`ntfy.sh` on every conversation start, deliberately, so the send path is
exercised continuously instead of debuting in production. Pick something
unguessable: an ntfy topic is a shared secret with no auth around it, and
anyone who knows it can both subscribe and publish.

## First-time setup

```bash
./setup.sh                      # installs deps, wires the git hooks, runs the harness
echo 'PLATFORM_DB=platform/dev/synthetic.db' >> .env.local
echo 'NTFY_TOPIC=stairwell-dev-<something-unguessable>' >> .env.local
ADMIN_PASSWORD='something-you-will-remember' npx tsx scripts/create-dev-users.ts
```

The `PLATFORM_DB` line points at the exact path `lib/db/instance.ts`
already falls back to when it's unset, so this changes nothing about which
database opens — only whether that choice is explicit or silent.
`deploy/required-env` marks it `REQUIRED` precisely because a silent
fallback to the synthetic database is the failure mode that severity
exists to catch; local dev shouldn't be the one place that leans on it
quietly. Set explicitly, the presence check passes clean: no `[env]
missing` warning at startup, and no `env_missing` metric row written to
`synthetic.db` on every run.

Expected output:

```
devone / devtwo / nico created in <repo>/platform/dev/synthetic.db
```

The script is INSERT-only and refuses to run against a database that already has
accounts, so it cannot damage an existing one — and cannot repair a partial run
either. If it fails partway, delete the database and start over.

## Run it

```bash
npm run build && npm start      # http://localhost:3000
```

**Prefer production mode over `npm run dev` when testing the auth flow.** In dev,
Next compiles routes on demand, and the first request to a cold route can miss an
in-memory key set moments earlier by another route — an unlock can look like it
did not stick. It is a dev-compiler artifact, not a bug in the lock, but it wastes
time. Warm the routes first if you do use `npm run dev`.

## What you should see

1. `/` redirects to `/login`
2. Log in as `devone` → straight to `/devone`, not `/unlock`. Password login
   derives the key itself; `/unlock` only comes back into play after a
   restart (see the last step below), not on a fresh login.
3. `/devtwo` → **404**, not 403 (a 403 would confirm devtwo exists)
4. `/admin` as `devone` → **404**
5. As `nico`: `/admin` lists `devone` and `devtwo`
6. `/devone` as `nico` → **404** — admin is not an override
7. Log in as `nico` → lands on `/admin`, not `/nico` — the admin account has
   no user space of its own.
8. `/nico` as `nico` → **404**, same as any other slug an admin has no user
   space at.
9. Restart the server without clearing cookies → `/devone` redirects to
   `/unlock`, not `/login`. The session survived; the key did not.
9. Log in as `nico` → lands on `/admin`, not `/nico` — the admin account has
   no user space of its own.
10. `/nico` as `nico` → **404**, same as any other slug an admin has no user
    space at.

## Pulling a confirmed spec into the repo

Once a friend confirms a spec in chat, it lives in the platform database, not
in the repo — `users/<name>/spec.md` and `users/<name>/mockup.html` are a
projection of that record, pulled explicitly. `scripts/pull-spec.sh` writes
both files; it **overwrites both on every pull**, so hand edits to either
file do not survive the next run.

```bash
./scripts/pull-spec.sh devtwo
```

The droplet form above needs ssh access (`deploy@app.stairwell.run`) — it
reads the real, non-synthetic platform database there, which is consistent
with CLAUDE.md but is not something to run against anything but synthetic
data locally. For that:

```bash
./scripts/pull-spec.sh devtwo --local
```

`--local` reads `PLATFORM_DB` (falling back to `platform/dev/synthetic.db`,
same as everything else in this doc) and is the only form Claude runs.

## Reset

```bash
rm -f platform/dev/synthetic.db*
ADMIN_PASSWORD='...' npx tsx scripts/create-dev-users.ts
```

The `*` matters — it removes the `-wal` and `-shm` sidecars too.

## Known rough edges

Both are recorded in `docs/superpowers/ledgers/step1a.md`:

- A fresh login asks for the password twice (`/login` then `/unlock`). The daily
  case is one prompt, since the 30-day session outlives the 12-hour key ceiling —
  you land on `/unlock`, not `/login`. Step 1b Task 7 collapses the fresh-login
  case.
- `/unlock` has no logout control and a locked session cannot reach `/login`, so a
  forgotten password means clearing the localhost cookie by hand (residual #7).
