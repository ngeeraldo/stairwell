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

A missing `REQUIRED` or `DEGRADED` name now surfaces as a `[env] missing …`
warning in the console at `npm run dev` (or `npm start`) startup, rather
than only at the first request that needed it. Locally that includes
`PLATFORM_DB`, which local dev deliberately never sets — its absence is
exactly what makes `lib/db/instance.ts` fall back to `synthetic.db`, so
expect that one warning on every local start.

## First-time setup

```bash
./setup.sh                      # installs deps, wires the git hooks, runs the harness
ADMIN_PASSWORD='something-you-will-remember' npx tsx scripts/create-dev-users.ts
```

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
2. Log in as `devone` → lands on `/unlock`, not the dashboard
3. Unlock → `/devone`
4. `/devtwo` → **404**, not 403 (a 403 would confirm devtwo exists)
5. `/admin` as `devone` → **404**
6. As `nico`: `/admin` lists `devone` and `devtwo`
7. `/devone` as `nico` → **404** — admin is not an override
8. Restart the server without clearing cookies → `/devone` redirects to
   `/unlock`, not `/login`. The session survived; the key did not.

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
