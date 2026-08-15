# Runbook — taking a friend from invite to live dashboard

The end-to-end operator process, in order. Everything here is run **by Nico, by
hand**. Nothing in this file is automated, and several steps are deliberately
not automated (see [Never do these](#never-do-these)).

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

Two standing rules that shape every command below:

- **Never edit files on the droplet.** Deploys go out through `deploy/deploy.sh`
  only, which does `git pull --ff-only`. A hand-edit there is invisible to the
  laptop and gets clobbered by the next deploy.
- **A non-interactive `ssh` loads no profile and no `EnvironmentFile`**, so
  `PLATFORM_DB` is *unset* on the far side unless you set it. Without it,
  scripts either refuse to run or fall back to a synthetic database — on the
  production box. `scripts/pull-spec.sh` already handles this for you; the ones
  you type by hand do not, which is what the `$STAIRWELL` prelude below is.

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

**Never create a branch named for the slug alone.** Git stores `sam` as a *file*
under `refs/heads/`, which cannot coexist with the *directory* `refs/heads/sam/`.
One `git branch sam` makes `sam/v2` impossible for as long as it exists, and the
error git throws (`cannot lock ref`) never mentions the branch that caused it.

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
- `users/<slug>/<slug>.db` — SQLCipher-encrypted, **empty**, created atomically
  at password-set time. It holds no tables yet, which is why their screen still
  reads synthetic under the **SYNTHETIC DATA** banner. That's correct, not a
  bug.

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
- Metrics carry **no user values, ever** — a slug and a panel, never a day, a
  count, or a payload. If you want to know what someone logged, you don't; that
  is the promise the login page makes.

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

**It overwrites both on every pull.** Hand edits to either file do not survive
the next run — they are a projection of a database record, not a source. If the
spec is wrong, the fix is a new confirmed version in chat, not an edit here.

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
sweeps for them): `schema.sql`, `seed.py`, `queries.ts`, `dashboard.tsx`,
`tests/`.

```bash
npm run synthetic                        # regenerates every users/*/synthetic.db
npx vitest run "users/$FRIEND"
```

Build toward `mockup.html`. Feasibility doubts go back to the friend via
`ask-user.ts` (step 4), not into a guess.

### See it on a screen

No test tells you whether it matches the mockup. Look at it.

**Once per friend** — there is no local account for their slug yet:

```bash
npm run build && npm start                     # not `npm run dev`: see docs/local-dev.md

# second terminal
INVITE_ORIGIN=http://localhost:3000 npx tsx scripts/create-invite.ts "$FRIEND"
```

Open the link it prints, press **Sounds good →**, set a password you will
remember. It is a local synthetic account and has nothing to do with theirs.

Mint it once and only once: a second invite for the same slug collides, so
getting it wrong means `revoke-invite.ts` first.

The walk also creates `users/<slug>/<slug>.db` locally, empty. Leave it — an
empty real database is what makes the page fall back to `synthetic.db` and show
the banner, which is the whole point of previewing here.

**Every time after** — `npm run dev`, log in at `/login` as the slug. You land
on `/<slug>`: their dashboard, reading `users/<slug>/synthetic.db`, under the
**SYNTHETIC DATA** banner. Keep `mockup.html` open beside it and iterate.

If a login under `npm run dev` looks like it did not stick, reload — it is the
cold-route artifact described in `docs/local-dev.md`, not your code.

**If their dashboard has a write path, budget for a platform route.** A
dashboard gets a read-only handle and can never write. Exactly two writable
opens exist today — the registration route (creates the file empty) and
`app/api/users/[user]/walk/route.ts` (creates it *with* a schema, and is still
the only thing that migrates one). A new friend who logs anything needs their
own route alongside that one; it is not a refactor of an existing one, and it is
where the four ordered auth checks live. Their real database also stays empty —
and their dashboard stays synthetic-under-banner — until that route runs for the
first time.

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

Then look at it as a friend would: log in as them? You can't — you don't have
their password, by design. Check `/admin` instead, and ask them.

---

## Step 9 — Tell them it landed

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND"
```

Posts the confirmed version's change summary into **that one account's** chat,
**once per confirmed spec version**. Safe to re-run: an already-announced
version is reported, not repeated.

This is deliberately not wired into `deploy.sh`. That script deploys the whole
service; calling this from it would post "your dashboard is live" into *every*
account's chat on *every* push — a permanent lie in an append-only transcript.

Once it has announced, the branch has done its job — main carries the merge and
the version is on record:

```bash
git branch -d "$FRIEND/v$V"     # -d, never -D: it refuses if the merge never happened
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

## Never do these

| Never | Because |
|---|---|
| Add a password reset path — including "temporarily, for dev" | The password *is* the key; there is nothing to reset to. `tests/routing/forgotPage.test.tsx` fails if a form appears. |
| Backfill `account_keys` for `devone`, `devtwo`, `nico` | Their wrapped key cannot be computed without their password. Inventing one locks a real person out of real data. They derive directly, forever. |
| Hand-edit `users/<slug>/spec.md` or `mockup.html` | Overwritten by the next pull. The source is the confirmed record. |
| Edit a file in `platform/prompts/` | Prompts are **added**, never edited — `agent-v3.md`, not a change to `agent-v2.md`. `prompt_sha` is stamped on rows that already exist. |
| Call `announce-deploy.ts` from `deploy.sh` | Announces to every account on every push. |
| Prune or archive `deploy_announced` or `first_session_start` metric rows | Both are read for correctness, not observed. Pruning makes a weeks-old build re-announce itself, or a months-old account report a first session again. They look like telemetry and are not. |
| Edit files on the droplet | Clobbered by `git pull --ff-only` on the next deploy, and invisible where the dashboard is actually built. |
| Create a branch named `<slug>` alone | Git stores it as a file under `refs/heads/`, so it can never coexist with `<slug>/v2`. Branches are `<slug>/v<n>`, always. |
| Build a dashboard directly on `main` | Main is what the droplet pulls. A half-built dashboard sitting there means an unrelated urgent fix cannot ship without it. |
| Run `export-spec.ts` / `announce-deploy.ts` / `ask-user.ts` locally against a real database | They read non-synthetic data by design *on the server*. Locally, point `PLATFORM_DB` at synthetic. |
| Copy or delete `<slug>.db` without the `*` | `-wal` and `-shm` sidecars hold the same rows. Always `users/<slug>/<slug>.db*`. |

---

## Rehearsing the whole thing locally

Steps 1–4 with no consequences. **Use a fresh throwaway slug every time**
(`walk1`, `walk2`, …) — there is no reset, and a slug with a registry line lands
in its own dashboard instead of the placeholder card, so only an unused slug
gives you the true first-ever experience.

```bash
FRIEND=walk1                        # a throwaway, NOT the real slug — no ssh here at all
npm run build && npm start          # production mode — see docs/local-dev.md on why

INVITE_ORIGIN=http://localhost:3000 npx tsx scripts/create-invite.ts "$FRIEND"
# open the printed link, press "Sounds good →", set a 10+ char password

sqlite3 platform/dev/synthetic.db \
  "SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites;"
ls -la "users/$FRIEND/"
```

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
| Their dashboard still shows the **SYNTHETIC DATA** banner | Their real database holds no tables yet. Expected until their first write through a platform route. |
| "This dashboard failed to load", permanently | Something read *file existence* as *has data*. Existence means **holds at least one table** — every friend has a file from day one. |
| Deploy aborted, site still fine | Tests failed before the restart. The old process is untouched. |
| Deploy failed at the smoke gate | The new code **is** live and failing. Fix forward. |
| `[env] missing REQUIRED: …` at startup | A name in `deploy/required-env` isn't in that host's `.env`. Values live only in `.env`; the guard hook denies reading it, so set it yourself. |
| A friend forgot their password | There is no path back. Their data is gone. Mint a new invite on a new slug. Say this out loud at step 3, not here. |
