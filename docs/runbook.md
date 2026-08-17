# Runbook — taking a friend from invite to live dashboard

The end-to-end operator process, in order. Everything here is run **by Nico, by
hand** — several steps stay manual on purpose, and [Standing
rules](#standing-rules) says which and why.

`docs/local-dev.md` is the other half: how to run and rehearse all of this
locally against synthetic data. **Rehearse a step there before doing it live** —
[Rehearsing the whole thing locally](#rehearsing-the-whole-thing-locally) is a
copy-pasteable dry run of steps 1–4.

---

## Where things run

| | Laptop | Droplet (`deploy@app.stairwell.run`) |
|---|---|---|
| Repo | `~/Documents/code/stairwell` | `/home/deploy/stairwell` |
| Platform DB | `platform/dev/synthetic.db` (fake) | `/home/deploy/stairwell/platform.db` (**real**) |
| What you do here | write code, pull specs, commit, push | mint invites, deploy, announce, read real records |

Two rules that shape every command below:

- **Change the droplet only by deploying to it** — `git push`, then
  `deploy/deploy.sh`, which does `git pull --ff-only`. That way the laptop and
  the droplet always agree, and every change is visible where the dashboard is
  actually built.
- **Set `PLATFORM_DB` on every command you send over ssh**, via the
  `$STAIRWELL` prelude below. A non-interactive `ssh` loads no profile and no
  `EnvironmentFile`, so the far side has it unset otherwise — and the scripts
  then either refuse to run or fall back to a synthetic database, on the
  production box. `scripts/pull-spec.sh` handles this itself; the ones you type
  by hand need the prelude.

## Set these first

**Run this block once in each terminal you use, before anything else in this
file.** Every command below reads these three names. They are shell variables,
so they vanish when the terminal closes — a new window means running this again.

```bash
FRIEND=sam                                                    # their slug — the only thing you change
DROPLET=deploy@app.stairwell.run
STAIRWELL='cd /home/deploy/stairwell && set -a && . ./.env && set +a'
```

Replace `sam` with the actual slug, unquoted and without angle brackets — Step 1
is how you choose it, so read that first if you haven't. Leave the other two
exactly as written; `$STAIRWELL` is the prelude that gives every remote command
its `PLATFORM_DB`.

If you forget the block, nothing bad happens quietly: an empty `$STAIRWELL`
makes the remote shell throw a syntax error, and an empty `$FRIEND` makes the
script print its usage line. Both are loud.

---

## Which flow am I in?

Two paths through one set of steps. The steps are written once, below.

| | **Flow A — a new friend** | **Flow B — a new version** |
|---|---|---|
| When | They have never had a dashboard | They have one, and confirmed a new spec |
| Run | 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 | 0 → 4 → 5 → 6 → 7 → 8 → 9 |
| What you skip | nothing | 1–3 — the slug, invite and account already exist |
| Extra work | scaffold the folder (step 6), add the registry line (step 7) | neither — both already exist |

Everything else is identical: same branch rule, same pull, same build, same
deploy, same announce. A friend's second version is not a lighter version of
their first — it is the same work done over a folder that already exists.

---

## Step 0 — Start from a clean main

```bash
git checkout main && git pull --ff-only
```

**Main is the deployable line**, and not merely by convention: `deploy.sh` runs
`git pull --ff-only` inside the droplet's own checkout, so whichever branch is
checked out *there* is what ships. Confirm that once, read-only:

```bash
ssh "$DROPLET" 'git -C /home/deploy/stairwell branch --show-current'
```

The build itself happens on a branch named for the confirmed spec version —
`sam/v1`, `sam/v2` — created at **step 6**, which is the first moment that
number exists on the laptop. One branch per version: merged to main at step 8,
deleted at step 9. A version is already the atomic unit everywhere else in this
system (whole-surface, a permanent `specs` row, announced exactly once), so the
branch is named after the thing that gets announced.

**Always include the version in the branch name — `sam/v1`, never a bare
`sam`.** Git stores `sam` as a *file* under `refs/heads/`, and a file cannot
coexist with the *directory* `refs/heads/sam/`. One `git branch sam` makes
`sam/v2` impossible for as long as it exists, and the error git throws (`cannot
lock ref`) never names the branch that caused it.

---

## Step 1 — Pick a slug

The slug is **permanent and load-bearing**. It is their URL (`/<slug>`), their
folder (`users/<slug>/`), their encrypted database filename
(`users/<slug>/<slug>.db`), and their registry key. There is no rename path.

- Pattern: `^[a-z0-9-]{1,32}$` — lowercase letters, digits, hyphens
  (`lib/auth/slug.ts`).
- Reserved, rejected at mint time: `admin`, `login`, `unlock`, `api`, `_next`,
  `favicon.ico`, `invite`, `forgot`, `mockup`.
- Already taken: `devone`, `devtwo`, `nico`.

Use a first name if it's free. It is what they'll see in their own URL bar.

---

## Step 2 — Mint the invite and send it

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/create-invite.ts $FRIEND"
```

Prints **one line** and nothing else — the link. Copy it straight into a text
message.

The outer quotes are **double**, deliberately: your local shell has to expand
`$STAIRWELL` and `$FRIEND` before the string is sent. Single quotes would ship
them to the droplet as literal text.

**The token is never stored, only its SHA-256.** If the message is lost, there
is nothing to look up: revoke and mint again.

```bash
# Revoke an UNUSED invite (by slug — the token is the thing you don't have):
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/revoke-invite.ts $FRIEND"
```

`revoke-invite.ts` refuses to revoke an invite that was already **used**, and
that refusal is correct — the account exists, and the row is the record of how.
Deleting an account is a different operation and this is not it. There is no
expiry by design.

---

## Step 3 — They accept

What they do: open the link → read the deal → **Sounds good →** → set a password
of **10+ characters** → they land in the app shell with the chat open.

Tell them the password rule out loud, in your own words, before they click:
**the password is the encryption key. There is no reset, no recovery, no
override — not even by you.** `/forgot` says exactly this and offers no form.

What that click created, on the droplet:

- an `accounts` row,
- an `account_keys` row (their random data key, wrapped under a
  key-encrypting key derived from their password),
- `users/<slug>/<slug>.db` — SQLCipher-encrypted, **empty**, created at
  password-set time by the migration runner. It holds no tables, because they
  have no dashboard yet and therefore no migrations. That's correct, not a bug:
  the file has to exist the moment the password does, and the shape arrives
  when you write one.

Their screen shows the **placeholder card** — no dashboard is registered for
them yet — with the chat open, which is the interview surface. No banner: the
banner is a dev-only thing now, and in production there is nothing synthetic to
warn about.

Verify it landed (read-only, on the droplet):

```bash
ssh "$DROPLET" "$STAIRWELL && sqlite3 platform.db 'SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites;'"

ssh "$DROPLET" "$STAIRWELL && sqlite3 platform.db 'SELECT a.slug, k.account_id IS NOT NULL AS enveloped FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id;'"

ssh "$DROPLET" "$STAIRWELL && ls -la users/$FRIEND/"
```

Note the SQL is in **single** quotes inside the double-quoted command. That
nesting only works because none of these statements contains an apostrophe; if
you write your own query with one, put the SQL in a file rather than fighting
the quoting.

Expect `used=1, revoked=0`, `enveloped=1`, and a `<slug>.db` file of a few KB.

---

## Step 4 — Watch the conversation

- **ntfy** fires a push to `NTFY_TOPIC` when a conversation starts. That is the
  real-time channel.
- **`/admin`** is the reading surface: the user list sorted by last activity,
  then per user three tabs — **Transcript / Spec / Mockup**. It is manual
  refresh only; nothing polls. Log in as `nico` (an admin lands on `/admin`, and
  has no user space of their own).
- Metrics tell you **that** someone used it, never **what** they logged — a slug
  and a panel, and nothing else. To learn what a friend is tracking, read their
  chat or ask them. That bound is the promise the login page makes.

If a build hits a decision only they can make, ask **in their chat**, so the
transcript stays the log of record:

```bash
QUESTION="Should the streak reset on a missed day, or shouldn't it?"

ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/ask-user.ts $FRIEND $(printf '%q' "$QUESTION")"
```

Their reply lands in the transcript like any other message.

The question goes in its **own variable**, wrapped in `printf '%q'`, because it
is the one argument here with human punctuation in it. That wrapper escapes the
string so the droplet's shell reassembles it as a single argument — apostrophes
in "don't" and "shouldn't" included. Without it the quoting breaks on the first
apostrophe you type, and the failure mode is a mangled question landing
permanently in an append-only transcript. Put the text in double quotes as
above, and it holds.

---

## Step 5 — They confirm a spec

The model proposes; the friend presses confirm on the proposal card in chat.
Until that happens there is **nothing to import** — `scripts/export-spec.ts`
refuses an account with drafts but no confirmation, loudly, rather than
exporting the newest draft.

Two properties worth holding in your head when you read a spec in `/admin`:

- A confirmed spec version is **whole-surface** — it describes their entire
  dashboard, not one conversation's worth of changes. v3 supersedes v2
  completely.
- `specs` rejects UPDATE. A version is a permanent row. `based_on_version` is
  supplied by the server, never authored by the model.

---

## Step 6 — Import their spec, and branch

On the **laptop**, from the repo root.

**Flow A scaffolds first, before the pull.** `pull-spec.sh` creates
`users/<slug>/` in order to write into it, and `new-dashboard.sh` refuses a
folder that already exists — it prints `already exists — refusing to overwrite`
and exits 2 without writing. Run it the other way round and you are stuck
moving files by hand:

```bash
./scripts/new-dashboard.sh "$FRIEND"   # Flow A only — Flow B skips this, the folder is there
```

Keep the registry line it prints; step 7 is where that goes.

Then pull, in both flows:

```bash
./scripts/pull-spec.sh "$FRIEND"
```

This ssh's to the droplet, reads the real confirmed spec, and writes two files:

- `users/<slug>/spec.md`
- `users/<slug>/mockup.html`

**It overwrites both on every pull**, because both are a projection of a
database record rather than a source. Treat them as read-only: when the spec is
wrong, have the friend confirm a new version in chat and pull again.

The write is atomic as a pair: either both files land or neither does.

Now branch. **The pull comes first and the branch second**, because the version
number you need for the branch name is written *by* the pull — `lib/spec/render.ts`
puts a `- **Spec version:** v3` line near the top of `spec.md`. Read it from the
file rather than from memory or a second look at `/admin`:

```bash
V=$(sed -n 's/^- \*\*Spec version:\*\* v//p' "users/$FRIEND/spec.md")
echo "$V"                                       # sanity-check: a bare number

git checkout -b "$FRIEND/v$V"                   # everything written above rides along, untracked
git add "users/$FRIEND"                         # the whole folder: *.db is gitignored, so no
                                                # database can be staged by this
git commit -m "Scaffold $FRIEND and pull confirmed spec v$V"   # Flow B: drop "Scaffold and"
```

Adding the folder rather than the pair is what makes one command work for both
flows: in Flow A it picks up the scaffold too, and the scaffold ships its own
`tests/dashboard.test.ts`, which is what satisfies Gate B for a change under
`users/<slug>/`. The spec pair itself is Gate B exempt either way.

Identical in both flows. There is deliberately no "Flow A is always v1" shortcut:
a new friend can iterate in chat and confirm v2 before you ever sit down to
build, and a branch named `v1` holding v2's spec is a lie you would not notice
until the announce step disagreed with it.

---

## Step 7 — Build the dashboard

Confirm you are on the version branch before anything else here — this is the
step that writes code, and main is the line the droplet pulls:

```bash
git branch --show-current               # expect <slug>/v<n>
```

**Flow A only:** add the line that `new-dashboard.sh` printed at step 6 to
`lib/dashboard/registry.ts`. Flow B's line is already there — skip to "Build
toward `mockup.html`".

```ts
<slug>: () => import('@/users/<slug>/dashboard'),
```

A folder with no registry line fails `tests/dashboard/registry.test.ts` — and
`hasDashboard()` is also what decides whether their chat opens collapsed, so the
registry line is what "the dashboard shipped" *means* to the app.

Five entries are required in the folder (`tests/users/conventions.test.ts`
sweeps for them): `migrations/`, `seed.py`, `queries.ts`, `dashboard.tsx`,
`tests/`.

The scaffold ships **no shape**: `migrations/` holds a README and nothing else,
and the dashboard says "Under construction". Writing
`migrations/001_initial.sql` from their confirmed spec — and regenerating the
manifest beside it, the README has the command — is the first real step of the
build. Their database stays empty until you do, which is correct: an empty
database is what they have.

```bash
npm run synthetic                        # regenerates every users/*/synthetic.db
npx vitest run "users/$FRIEND"
```

Build toward `mockup.html`. Take feasibility doubts back to the friend via
`ask-user.ts` (step 4) and build on their answer.

### See it on a screen

No test tells you whether it matches the mockup. Look at it.

**Once per friend** — there is no local account for their slug yet:

```bash
npx tsx scripts/create-local-account.ts "$FRIEND" 'a-local-password-10-plus'
```

One line, no browser, no invite. The password is local, disposable and yours;
it has nothing to do with the one they set on the droplet, and you will type it
at `/login` every time you come back to this build.

**This script is the whole step** — it replaced an earlier instruction to run
`npm run build && npm start` and register through the browser. `npm start` sets
`NODE_ENV=production`, which is the only switch `lib/db/userData.ts` has, so a
login there took the production branch and `lib/db/migrate.ts` wrote a real
`users/<slug>/<slug>.db` **onto the laptop** — the one file CLAUDE.md > Data
safety keeps on the server. `create-local-account.ts` writes account rows and
nothing on the filesystem, and refuses to run under `NODE_ENV=production` at
all.

If one is already sitting there from an older run, **Gate F** blocks your next
commit and prints the fix: `rm users/<slug>/<slug>.db*` — with the `*`, because
`-wal` and `-shm` hold the same rows.

**Then, every time** — `npm run dev`, log in at `/login` as the slug. You land
on `/<slug>`: their dashboard, reading `users/<slug>/synthetic.db`, under the
**SYNTHETIC DATA** banner. Anything the dashboard's entry widget writes goes to
that same file, so the loop is honest — type a value, save, see it. Keep
`mockup.html` open beside it and iterate.

A freshly scaffolded folder has no migrations, so its `synthetic.db` is
**empty** and the banner sits above a dashboard with no numbers under it. That
is expected until you write `001_initial.sql` and re-run `npm run synthetic`.

If a login under `npm run dev` looks like it did not stick, reload — it is the
cold-route artifact described in `docs/local-dev.md`, not your code.

**If their dashboard has a write path, budget for a platform route.** A
dashboard gets a read-only handle and can never write. Exactly two things write
to a friend's real database: `lib/db/migrate.ts`, which creates it and changes
its SHAPE at unlock, and a platform route, which writes ROWS into the shape it
finds. A friend who logs anything needs their own route alongside
`app/api/users/[user]/walk/route.ts`; it is not a refactor of that one, and it
is where the four ordered auth checks live.

---

## Step 8 — Ship it

Merge the version branch into main, then push main. The merge is `--no-ff` on
purpose: one merge commit reads as one version's worth of work, the way
`friend-timezone` and `chat-shell-polish` came back in.

```bash
git checkout main && git pull --ff-only
git merge --no-ff "$FRIEND/v$V" -m "Build $FRIEND's dashboard v$V"

git push          # Gate E (full suite) then Gate D (next build), unconditionally

ssh "$DROPLET" '/home/deploy/stairwell/deploy/deploy.sh'
```

If `$V` has gone (a new terminal, a day later), read it back out of the file
rather than guessing — `sed -n 's/^- \*\*Spec version:\*\* v//p' "users/$FRIEND/spec.md"`,
same line as step 6, or just `git branch --list "$FRIEND/*"`.

Pushing the version branch to `origin` before merging is optional and yours to
call: it buys an off-laptop copy of work in progress, and costs a second full
run of Gate E and Gate D, since both gates run on every push regardless of
branch.

Single quotes are fine on this one — there is nothing in it for your local
shell to expand, and `deploy.sh` supplies its own environment through systemd.

`deploy.sh` pulls, checks required env by name, `npm ci`, builds, runs the whole
suite (a failure aborts **before** the restart), restarts, and then runs
`deploy/smoke.sh`. A deploy that starts the process but does not serve correctly
is a **failed deploy** — `systemctl is-active` cannot tell those apart, so the
smoke check polls for a real 200 and asserts the redirect shape at both layers.

If the smoke gate fails: **the new code is live and failing. That is not a
rollback.** The script prints the last 30 journal lines; fix forward or deploy
the previous commit.

One caveat worth knowing before it confuses you: if a pull changes
`deploy.sh` or `smoke.sh` themselves, the script re-execs so the new logic
applies to its own deploy — *except* on the very first deploy that delivers a
change to that re-exec block. If a contract change must hold from its first
deploy, **run `deploy.sh` twice**.

Then check how it landed for them: read `/admin`, and ask them directly. Their
password is theirs alone by design, so `/admin` and their own words are the two
views you have.

---

## Step 9 — Tell them it landed

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND"
```

Posts the confirmed version's change summary into **that one account's** chat,
**once per confirmed spec version**. Safe to re-run: an already-announced
version is reported, not repeated.

Run it by hand, per friend, and keep it that way. `deploy.sh` deploys the whole
service, so calling the announcer from it would post "your dashboard is live"
into *every* account's chat on *every* push — a permanent line in an
append-only transcript for every account that was not the reason for that
deploy.

Once it has announced, the branch has done its job — main carries the merge and
the version is on record:

```bash
git branch -d "$FRIEND/v$V"     # -d: git refuses the delete if the merge never happened
```

---

## Step 10 — The next version

Versions 2, 3, … are **Flow B** in the table at the top: they confirm a new
whole-surface spec in chat, and you run 0 → 4 → 5 → 6 → 7 → 8 → 9 again on a
fresh `<slug>/v<n>` branch. `pull-spec.sh` overwrites the pair, step 7 skips the
scaffold and the registry line, and everything else is the same work as the
first time.

The announce script tracks versions, so the second run announces v2 and stays
quiet about v1.

---

## Standing rules

The steps above are the sequence. These hold across all of them, and each one
is here because getting it wrong is expensive and quiet.

| Always | Because |
|---|---|
| Tell every friend at step 3 that a forgotten password is unrecoverable | The password *is* the key; there is nothing to reset to. `/forgot` says exactly this and offers no form, and `tests/routing/forgotPage.test.tsx` keeps it that way — including against a "temporary, just for dev" one. |
| Leave `devone`, `devtwo` and `nico` deriving their key directly, forever | Their wrapped `account_keys` row cannot be computed without their password. Inventing one locks a real person out of real data. |
| Fix a wrong spec by confirming a new version in chat, then re-running `pull-spec.sh` | `spec.md` and `mockup.html` are a projection of the confirmed record, and the next pull overwrites both. The source is the record. |
| Ship every shape change as a new numbered migration — `002_…`, then `003_…` | A friend's database records only which NUMBER it reached, so editing an applied file silently changes what that number means. The manifest's checksum refuses the session rather than letting it through. |
| Add a new prompt version — `agent-v3.md` | `prompt_sha` is stamped on transcript and spec rows that already exist, so editing `agent-v2.md` changes what an already-written hash points at. Prompts are added, and that is a data-safety property. |
| Run `announce-deploy.ts` by hand, once per friend, at step 9 | `deploy.sh` deploys the whole service. Calling the announcer from it would post "your dashboard is live" into every account's chat on every push — a permanent line in an append-only transcript. |
| Leave every `deploy_announced` and `first_session_start` metric row in place | Both are read for correctness, not observed. Losing one makes a weeks-old build re-announce itself, or a months-old account report a first session again. They look like telemetry and are not. |
| Build locally with `scripts/create-local-account.ts` + `npm run dev` | `npm start` sets `NODE_ENV=production`, the only switch `lib/db/userData.ts` has, so a login there takes the production branch and `lib/db/migrate.ts` writes a real `users/<slug>/<slug>.db` onto your laptop. Gate F blocks your next commit until it is removed. |
| Ship every droplet change through `git push` and `deploy/deploy.sh` | `deploy.sh` runs `git pull --ff-only`, so a hand-edit there is clobbered by the next deploy and is invisible on the laptop where the dashboard is actually built. |
| Name every branch `<slug>/v<n>` | Git stores a bare `sam` as a *file* under `refs/heads/`, which can never coexist with the *directory* `refs/heads/sam/`. One `git branch sam` makes `sam/v2` impossible for as long as it exists. |
| Write dashboard code on the version branch — check `git branch --show-current` first | `main` is the line the droplet pulls. A half-built dashboard sitting there means an unrelated urgent fix cannot ship without it. |
| Point `PLATFORM_DB` at `platform/dev/synthetic.db` for anything you run locally | `export-spec.ts`, `announce-deploy.ts` and `ask-user.ts` read non-synthetic data by design — *on the server*. |
| Glob the sidecars: `users/<slug>/<slug>.db*` | `-wal` and `-shm` hold the same rows as the database. A copy or a delete that takes only the main file is taking part of the database. |

---

## Rehearsing the whole thing locally

Steps 1–4 with no consequences. **Use a fresh throwaway slug every time**
(`walk1`, `walk2`, …) — there is no reset, and a slug with a registry line lands
in its own dashboard instead of the placeholder card, so only an unused slug
gives you the true first-ever experience.

```bash
FRIEND=walk1                        # a throwaway, NOT the real slug — no ssh here at all
npm run dev                         # NOT npm start — see docs/local-dev.md > Run it

INVITE_ORIGIN=http://localhost:3000 npx tsx scripts/create-invite.ts "$FRIEND"
# open the printed link, press "Sounds good →", set a 10+ char password

sqlite3 platform/dev/synthetic.db \
  "SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites;"
ls -la "users/$FRIEND/"              # NO <slug>.db here — that is the pass condition
```

`npm run dev` is what makes this rehearsal consequence-free. Under `npm start`
the same click creates a real `users/walk1/walk1.db`, and Gate F then blocks
your next commit until you remove it. If a cold route makes the login look like
it did not stick, request the page again — `docs/local-dev.md` explains why.

Every command here runs on the laptop against synthetic data, so `$DROPLET` and
`$STAIRWELL` play no part. **Reset `FRIEND` to the real slug before going back
to the live steps** — that is the one way this rehearsal can bite you.

Full detail — dev accounts, reset, the encrypted write path, the screenshot
harness: `docs/local-dev.md`.

---

## When something looks wrong

| Symptom | Cause |
|---|---|
| `no confirmed spec for '<slug>'` on pull | They have drafts but pressed confirm on none. Correct refusal — check the Spec tab in `/admin`. |
| Pull wrote something that looks synthetic | `PLATFORM_DB` wasn't set on the far side. `pull-spec.sh` sources `.env` itself; a hand-typed `export-spec.ts` doesn't. |
| Their dashboard says **Under construction** | The folder was scaffolded but `migrations/001_initial.sql` has not been written. Expected between step 7's scaffold and the build. |
| A friend cannot log in, and ntfy says a migration failed | The session was refused rather than served over a half-migrated shape. The alert carries the slug and migration number; the server log has the error. Their `<slug>.backup.db` holds the pre-migration copy. |
| "This dashboard failed to load", permanently | Something read *file existence* as *has data*. Existence means **holds at least one table** — every friend has a file from day one. |
| Deploy aborted, site still fine | Tests failed before the restart. The old process is untouched. |
| Deploy failed at the smoke gate | The new code **is** live and failing. Fix forward. |
| `[env] missing REQUIRED: …` at startup | A name in `deploy/required-env` isn't in that host's `.env`. Values live only in `.env`; the guard hook denies reading it, so set it yourself. |
| A friend forgot their password | There is no path back. Their data is gone. Mint a new invite on a new slug. Say this out loud at step 3, not here. |
