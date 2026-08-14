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

```bash
npm run synthetic               # generates every users/*/synthetic.db
```

`users/*/synthetic.db` is gitignored, so a fresh clone has none and every
dashboard renders "its data has not been generated yet" until this runs.

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
10. `/devone` as `devone` shows the reference dashboard under a **SYNTHETIC
    DATA** banner: an eating-out total and a recent-transactions list of
    loudly-fake merchants, `COFFEE PALACE TEST` among them.
11. `/devtwo` as `devtwo` shows the walk tracker — today's yes/no with a tap
    control, the streak, a 30-day percentage and a 14-day row — under the same
    **SYNTHETIC DATA** banner, until devtwo's first real tap. See "Trying the
    encrypted write path" below. Neither account can reach the other's URL at
    all; both get a 404, not a 403.

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

## Announcing a build, or asking a question, in a friend's chat

Two things reach a friend's chat that no model can produce: "your build
landed" and "I hit a decision only you can make." Both are ordinary
assistant transcript rows, written by these CLIs — run BY NICO, by hand, on
the server, right after (or during) a specific account's build. **Not**
called from `deploy/deploy.sh`: that script deploys the whole service, and
wiring either of these in would post into every account's chat on every
push, which is a permanent lie in an append-only transcript for every
account that was not the reason for that deploy.

```bash
npx tsx scripts/announce-deploy.ts devtwo
```

Posts the confirmed version's `change_summary` (or, for a legacy row with
none, its `title`) into `devtwo`'s chat — once per confirmed spec version.
Safe to re-run: a version already announced is reported, not repeated.

```bash
npx tsx scripts/ask-user.ts devtwo "Want the streak to reset on a missed day, or just pause?"
```

Posts a question into `devtwo`'s chat for a mid-build decision only they can
make. The friend's reply lands in the transcript like any other message.

Both take `PLATFORM_DB` the same way every script in this doc does — point
it at `platform/dev/synthetic.db` locally, never at a real database.

## Building a dashboard

```bash
./scripts/new-dashboard.sh <slug>   # scaffold; prints the registry line to add
npm run synthetic                   # regenerate every users/*/synthetic.db
npx vitest run users/<slug>
```

The conventions and what each file is for: `CLAUDE.md > Dashboard folder
conventions`. `users/devone/` is a worked example.

## Trying the encrypted write path

```bash
npm run synthetic
npm run build && npm start
```

Log in as `devtwo` / `TEST-DEV-TWO` and open `/devtwo`.

**Before the first tap** the screen is the SYNTHETIC DATA banner over
`users/devtwo/synthetic.db`. Run on 2026-08-13 at `America/Chicago`, it read:

| Panel | Before the tap | After the tap |
|---|---|---|
| Walked today? | `NOT YET`, with a **Tap to mark walked** button | `WALKED` / `Marked for today.`, no button |
| Current streak | `1` day in a row | `1` day in a row |
| Last 30 days | `77%` — 23 of 30 days | `3%` — 1 of 30 days |
| Last 14 days | 9 walked, 5 missed | 1 walked (today), 13 missed |
| Banner | present | **gone** |

The banner disappearing is the whole event: `users/devtwo/devtwo.db` now exists,
so the dashboard reads that instead. Everything above the banner line is the
same component reading a different file.

**The streak does not change, and that is not a bug in either direction.**
`seed.py` deliberately leaves today unwalked in the sample (so the tap control
is visible on handover morning), and it leaves the day before today walked, so
the sample streak is already exactly one day. The real database then contains
exactly one day. Two different single days, same number. The panels that
actually show you the sample history was never yours are the 30-day percentage
and the 14-day row — 77% to 3%, nine walked days to one. If you are
demonstrating this to someone, point at those.

To confirm the file is really encrypted:

```bash
head -c 16 users/devtwo/devtwo.db | xxd
```

An unencrypted SQLite file begins with the ASCII `SQLite format 3`. This one
does not. `tests/db/encryptedUserDb.test.ts` asserts exactly that against a
file it creates in a temp tree — running the command by hand is how you check
the same thing about a file the app wrote, which is the only form of the check
that says anything about a real deployment.

Expect `devtwo.db-wal` and `devtwo.db-shm` next to it, and expect them to
stay. A dashboard render opens the database read-only, and a read-only
connection cannot checkpoint the write-ahead log away when it closes, so the
sidecars outlive the request. They are normal, they hold the same rows the
database does, and they are why every command here globs `devtwo.db*` — a copy
or a delete that takes only the main file is taking part of the database.

To start over: `rm users/devtwo/devtwo.db*` — the `*` matters here for the same
reason it does under Reset below; it takes the `-wal` and `-shm` sidecars too.
There is no other way back, which is the same property a forgotten password has.

**If you use `npm run dev` for this instead of `npm run build && npm start`,**
expect the cold-route artifact at the top of this file to bite twice, not once.
The key is set by `/api/login` in one freshly compiled module instance;
`/devtwo` renders `Locked.` and `POST /api/users/[user]/walk` returns `403`
until each of those routes has been compiled at least once. Request both, log
in again, and both work. It is the same dev-compiler artifact described under
"Run it" — it just has two more places to show up now.

## Inviting someone

**Walking the onboarding flow uses a fresh throwaway slug every time —
`walk1`, `walk2`, and so on.** There is no reset: a slug is used once and
abandoned, which is also the only way to get the true first-ever experience,
since a slug with a line in `lib/dashboard/registry.ts` lands in its own
dashboard rather than on the placeholder card.

```bash
# Mint an invite. Prints ONE line: the link to text or email them.
# INVITE_ORIGIN only matters locally — the default is the production URL.
INVITE_ORIGIN=http://localhost:3000 npx tsx scripts/create-invite.ts friendone

# On the droplet:
PLATFORM_DB=/home/deploy/stairwell/platform.db \
  npx tsx scripts/create-invite.ts friendone

# Revoke one that has not been used yet. By SLUG, because the token is the
# thing you do not have — only its hash was stored. A lost link is re-minted,
# never recovered.
npx tsx scripts/revoke-invite.ts friendone
```

Walk it: open the printed link, press **Sounds good →**, set a password of 10+
characters, and you land in the shell. Then check what it actually created:

```bash
sqlite3 platform/dev/synthetic.db \
  "SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites;"

# The onboarding funnel, newest first, with the device class on every row.
sqlite3 platform/dev/synthetic.db \
  "SELECT event, json_extract(data,'\$.device_class') FROM metrics ORDER BY at DESC LIMIT 8;"

# An account_keys row means the envelope is in the path (a legacy account has
# none and derives its key directly — CLAUDE.md > Dashboard folder conventions).
sqlite3 platform/dev/synthetic.db \
  "SELECT a.slug, k.account_id IS NOT NULL AS enveloped
     FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id;"

# Their database exists and holds NO tables yet — which is why the dashboard
# still reads synthetic under the banner.
ls -la users/friendone/
```

## Looking at every screen

```bash
# Boots the app against its OWN synthetic database in a temp directory,
# captures every live screen at 375 and 1440, and prints what each one has to
# look like. Refuses to run if PLATFORM_DB is set — it must never photograph
# real data.
npm run shots -- --task=manual

# One screen, reusing the existing build:
npm run shots -- --task=manual --only=s2-set-password --no-build
```

Shots land in `.screenshots/task-<n>/` (gitignored). The assertions live in
`screenshots/screens.ts`; a screen marked `live: false` there is skipped and
listed at the end of the run, so partial coverage never reads as full
coverage.

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
