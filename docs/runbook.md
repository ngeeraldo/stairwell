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

## Step 6 — Import their spec into the repo

On the **laptop**, from the repo root:

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

```bash
git add "users/$FRIEND/spec.md" "users/$FRIEND/mockup.html"
git commit -m "Pull $FRIEND's confirmed spec"   # both files are Gate B exempt
```

---

## Step 7 — Build the dashboard

```bash
./scripts/new-dashboard.sh "$FRIEND"   # scaffolds the folder; prints the registry line
```

Then add the printed line to `lib/dashboard/registry.ts`:

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
npm run shots -- --task="$FRIEND"        # every screen at 375 and 1440 — review as pictures
```

Build toward `mockup.html`. Feasibility doubts go back to the friend via
`ask-user.ts` (step 4), not into a guess.

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

```bash
git push          # Gate E (full suite) then Gate D (next build), unconditionally

ssh "$DROPLET" '/home/deploy/stairwell/deploy/deploy.sh'
```

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

---

## Step 10 — The next version

Versions 2, 3, … are the same loop from **step 5**: they confirm a new
whole-surface spec in chat → `./scripts/pull-spec.sh "$FRIEND"` (overwrites the
pair) → rebuild → push → deploy → `announce-deploy.ts` again. The announce
script tracks versions, so the second run announces v2 and stays quiet about v1.

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
