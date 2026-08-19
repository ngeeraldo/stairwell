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
npm run dev                     # http://localhost:3000
```

**Do not log in under `npm start`.** `npm start` sets `NODE_ENV=production`, and
`NODE_ENV` is the only switch `lib/db/userData.ts` has. Every non-admin login
calls the migration runner (`app/api/login/route.ts`), which on the production
branch **creates `users/<slug>/<slug>.db` on your laptop** — a real-named,
SQLCipher-encrypted database, which CLAUDE.md > Data safety says exists only on
the server. This is not limited to registering a new account: logging in as
`devone` is enough. `lib/db/migrate.ts` returns early outside production
precisely to prevent this, and `npm start` is not outside production.

`npm start` is still the right way to check that **the build serves** — just do
not sign in while it is up:

```bash
npm run build && npm start      # verify it boots and redirects; do not log in
```

If a real database does appear, **Gate F** (`.githooks/pre-commit`) blocks your
next commit and prints the fix — `rm users/<slug>/<slug>.db*`, with the `*`,
because `-wal` and `-shm` hold the same rows.

**The cost of `npm run dev`, and the workaround.** Next compiles routes on
demand, so the first request to a cold route can miss an in-memory key set
moments earlier by another route — an unlock can look like it did not stick, and
a dashboard can render `Locked.` right after a successful login. It is a
dev-compiler artifact, not a bug in the lock. Warm the routes by requesting them
once (visit `/login`, then `/<slug>`), or simply log in a second time; both work
from then on.

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
    **SYNTHETIC DATA** banner. The banner never goes away locally: it follows
    the WORLD, not a row count, and in dev the world is synthetic. See "Trying
    the write path" below. Neither account can reach the other's URL at all;
    both get a 404, not a 403.

## Pulling a spec into the repo

Once a friend's request produces a spec in chat, it lives in the platform
database, not in the repo — `users/<name>/spec.md` is a projection of it,
pulled explicitly. Nothing confirms any more: the newest spec IS the build
contract the moment it is authored (`lib/db/specs.ts`'s `currentSpec`).
`scripts/pull-spec.sh` writes `spec.md` alone now — it used to write a pair
with `mockup.html` too, but nothing composes or serves mockup HTML any more
(plan 2026-08-19-remove-the-mockup-loop). It **overwrites `spec.md` on every
pull**, so hand edits do not survive the next run.

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

`export-spec.ts` (what `--local` calls) refuses to run at all if
`PLATFORM_DB` is unset — it never falls back to a synthetic database, because
the same code path also runs on the droplet against the real one, where a
silent fallback would write fake data into a friend's `spec.md` as if it were
their real spec. `--local` supplies `platform/dev/synthetic.db`
itself when you have not set `PLATFORM_DB` in your shell, so the command
above works with no setup — that default lives in the safe, always-local
wrapper, not in the script it calls. It is the only form Claude runs. **It
still needs an actual spec row to pull**: a freshly-seeded
`platform/dev/synthetic.db` (First-time setup, above) has accounts but no
spec rows — nothing scripted inserts one — so this only produces output once
an account has asked for something in chat at least once.

## Announcing a build, or asking a question, in a friend's chat

Two things reach a friend's chat that no model can produce: "your build
landed" and "I hit a decision only you can make." Both are ordinary
assistant transcript rows, written by these CLIs — run BY NICO, by hand, on
the server, right after (or during) a specific account's build. **Not**
called from `deploy/deploy.sh`: that script deploys the whole service, and
wiring either of these in would post into every account's chat on every
push, which is a permanent lie in an append-only transcript for every
account that was not the reason for that deploy.

An announcement is keyed off `users/<name>/notes/v<n>.md` existing on disk —
the record that a version was actually **built**, never off a confirmation
(nothing confirms any more). `users/devtwo/notes/` ships with only a
`README.md`, so `announce-deploy.ts devtwo` refuses with `no_build_notes`
until one exists. Write a throwaway one to try the mechanism locally — it is
not a real build record, so remove it afterward if you do not want it
sitting in your working tree (it is a real, tracked path, not gitignored):

```bash
cat > users/devtwo/notes/v1.md <<'EOF'
---
slug: devtwo
version: 1
built_at: 2026-08-19
---

## What shipped
A local walkthrough note, TEST — not a real build record.

## Built differently

## Open

## Notes for the next build
EOF
```

```bash
PLATFORM_DB=platform/dev/synthetic.db npx tsx scripts/announce-deploy.ts devtwo --plain
```

DRY RUN by default — this prints the newest built version's `change_summary`
(or, for a legacy row with none, its `title`) without posting anything; add
`--send` to actually write it into `devtwo`'s chat, once per version that has
notes. Safe to re-run either way: a version already announced is reported,
not repeated.

`--plain` is in the example on purpose: without it, drafting goes through the
real Anthropic API and needs `ANTHROPIC_API_KEY` set (`deploy/required-env`),
which a local walkthrough of this doc has no other reason to require. Drop
`--plain` once you actually want to try the drafted-sentence path and have a
key set — see `docs/runbook.md` step 9 for the full dry-run-then-send flow.

```bash
PLATFORM_DB=platform/dev/synthetic.db npx tsx scripts/ask-user.ts devtwo "Want the streak to reset on a missed day, or just pause?"
```

Posts a question into `devtwo`'s chat for a mid-build decision only they can
make. The friend's reply lands in the transcript like any other message.

Both refuse to run at all if `PLATFORM_DB` is unset — no fallback, for the
same reason `export-spec.ts` above has none: the same two scripts also run on
the droplet against the real platform database, so a silent fallback there
would draft or send into a synthetic account while looking like it reached
the friend. Unlike `pull-spec.sh --local`, neither has a wrapper that
supplies a local default for you, so the `PLATFORM_DB=` prefix above is not
optional — point it at `platform/dev/synthetic.db` locally, never at a real
database.

## Building a dashboard

```bash
./scripts/new-dashboard.sh <slug>   # scaffold; prints the registry line to add
npm run synthetic                   # regenerate every users/*/synthetic.db
npx vitest run users/<slug>

# Day one: every synthetic.db rebuilt from its migrations with NO rows, which
# is what a friend's own database holds the morning their dashboard ships.
# Reload the page, read it, then run `npm run synthetic` to get the data back.
npm run synthetic -- --empty

# A local account so you can log in as them at /login and look at the screen.
# Writes account rows only — it creates no user database, and refuses to run
# under NODE_ENV=production. The password is local and disposable.
npx tsx scripts/create-local-account.ts <slug> <password>
npm run dev
```

The conventions and what each file is for: `CLAUDE.md > Dashboard folder
conventions`. `users/devone/` is a worked example. The full operator sequence
around a build is `docs/runbook.md` step 7.

## Trying the write path

```bash
npm run synthetic
npm run dev
```

Log in as `devtwo` / `TEST-DEV-TWO`, open `/devtwo`, and press **Tap to mark
walked**.

**Reads and writes both land in `users/devtwo/synthetic.db`.** That is the point
of there being no real-vs-synthetic fallback (`lib/db/userData.ts`): if the
dashboard read one database while the entry widget wrote to another, typing a
value would save somewhere the screen never looks, and the loop you are testing
would prove nothing. The tap POSTs to `app/api/users/[user]/walk/route.ts` like
any other write — a dashboard component never holds a writable handle.

What to look for: "Walked today?" flips from `NOT YET` to `WALKED` and the tap
control disappears, and the streak and the 30- and 14-day panels each move by
one day. They **move**, they do not reset — the tap inserts one row for today
into the sample history rather than switching the page to a different file.

**The SYNTHETIC DATA banner stays up the whole time.** It follows the WORLD, not
a row count, and in dev the world is synthetic. A banner that vanished mid-session
would be describing which file was open, which is exactly the fallback that was
deleted.

### Where the encrypted path is actually exercised

Not here. Locally there is no encrypted user database and there must not be one
— see **Run it** above. Two places touch the real path without putting a file in
this repo:

- `tests/db/encryptedUserDb.test.ts` creates one in a temp tree and asserts it
  does **not** begin with the ASCII `SQLite format 3`, which an unencrypted
  SQLite file does.
- `npm run shots` forces `NODE_ENV=production` around the migration runner but
  points `USERS_DIR` at a temp tree (`scripts/shots.ts`), so the real encrypted
  database is built by the real code and thrown away with the directory. That is
  the sanctioned shape for anything that needs the production branch locally:
  **production mode is fine, a real file inside the repo is not.**

To start over, reset the synthetic database rather than deleting anything real:

```bash
rm -f users/devtwo/synthetic.db*        # the * takes the -wal and -shm sidecars
npm run synthetic
```

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

Walk it **under `npm run dev`**: open the printed link, press **Sounds good →**,
set a password of 10+ characters, and you land in the shell. Under `npm start`
the same click creates a real `users/<slug>/<slug>.db` on your laptop — see
**Run it** above. Then check what it actually created:

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

# NO user database here, and that is the pass condition. On the droplet this
# folder would hold an encrypted <slug>.db created at password-set time; on a
# laptop the runner returns early and synthetic.db is the user database.
# Anything named <slug>.db here means you ran the flow under `npm start`.
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
