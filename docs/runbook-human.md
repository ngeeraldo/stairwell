# Human Steps for Building

## Set these in new terminal

```bash
DROPLET=deploy@app.stairwell.run
STAIRWELL='cd /home/deploy/stairwell && set -a && . ./.env && set +a'
```

## Step 0 — Start from a clean main

```bash
git checkout main && git pull --ff-only
```

**Main is the deployable line**

```bash
ssh "$DROPLET" 'git -C /home/deploy/stairwell branch --show-current'
```

## Step 1 — Pick a slug
```bash
FRIEND=sam                   # their slug — the only thing you change
```

## Step 2 — Mint the invite and send it

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/create-invite.ts $FRIEND"
```

To revoke an invite:
```bash
# Revoke an UNUSED invite (by slug — the token is the thing you don't have):
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/revoke-invite.ts $FRIEND"
```

## Step 3 — Create New Dashboard (if needed) 

```bash
./scripts/new-dashboard.sh "$FRIEND"   # Flow A only — Flow B skips this, the folder is there
```
## Step 4 - Add Dashboard to App

Follow the directions in the terminal from the last command

## Step 5 - Import their spec, and create branch

Import Spec:
```bash
./scripts/pull-spec.sh "$FRIEND"
```
Create Branch:
```bash
V=$(sed -n 's/^- \*\*Spec version:\*\* v//p' "users/$FRIEND/spec.md")
echo "$V"                                       # sanity-check: a bare number

git checkout -b "$FRIEND/v$V"                   # everything written above rides along, untracked
git add "users/$FRIEND"                         # the whole folder: *.db is gitignored, so no
                                                # database can be staged by this
git commit -m "Scaffold $FRIEND and pull spec v$V"   # Flow B: drop "Scaffold and"
```

## Step 6 - Hand over Build to AI Builder

Start a fresh Claude Code session on this branch and paste:

```
It is time for you to do Step 6 in docs/runbook-ai.md for $FRIEND
```

(Type the slug itself — that message is not going through a shell, so `$FRIEND`
will not expand.)

It reads Section 1, then builds: migrations, `seed.py`, `queries.ts`,
`dashboard.tsx`, tests. It does **not** commit — you do, at Step 9.

Answer its questions and wait for it to finish. It reports blockers **to you**: 
anything in the spec that did not land, and anything the spec
left ambiguous. You decide, and they adjust later if it is wrong.

Two checks in `tests/users/conventions.test.ts` are red when it hands back —
both want `current.md`, which is Step 8. That is expected, not a failure.

### Step 7 - Manually Test

Create a local account for new user (if needed)

```bash
npx tsx scripts/create-local-account.ts "$FRIEND" 'a-local-password-10-plus'
```

How to start the app
```bash
npm run dev                              # then log in at /login as the slug
```

Run these after starting the app to see the dashboard with different seeded data
```bash
npm run synthetic -- --empty             # shape only, no rows
# reload /<slug> — every screen, same as above
npm run synthetic                        # put the sample data back
```
### Step 8 - Hand over to AI Builder for Notes and `current.md` rewrite.

Same session, or a fresh one — paste:

```
It is time for you to do Step 8 in docs/runbook-ai.md for $FRIEND
```

It writes `users/$FRIEND/notes/v$V.md` (added, never edited) and rewrites
`users/$FRIEND/current.md` (overwritten every build, `version: $V`). Both are
`*.md`, which Gate B exempts — the conventions sweep is the only thing that
catches a missing or stale `current.md`, and Step 11 refuses to announce
without it.

It does not commit. That is the next step.

### Step 9 - Commit the build

Step 10 merges this branch. It does not pick up anything you left uncommitted:

```bash
git status --short                       # review first: nothing stray, no *.db
git add -A                               # or name the paths, if the tree holds other work
git commit -m "Build $FRIEND's dashboard v$V"
```

## Step 10 — Ship it

```bash
git checkout main && git pull --ff-only
git merge --no-ff "$FRIEND/v$V" -m "Build $FRIEND's dashboard v$V"

git push          # Gate E (full suite) then Gate D (next build), unconditionally

ssh "$DROPLET" '/home/deploy/stairwell/deploy/deploy.sh'
```

## Step 11 — Tell them it landed

```bash
# 1. Draft it. Writes nothing to the transcript. `tee` prints the sentence AND
#    saves it, so what you read is literally the bytes you are about to send.
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND" \
  | tee "/tmp/announce-$FRIEND.txt"

# 2. Optional — change the wording by editing the file. What is in it is what
#    gets posted.
#    $EDITOR "/tmp/announce-$FRIEND.txt"

# 3. Send those exact bytes. No model call, no re-draft.
scp "/tmp/announce-$FRIEND.txt" "$DROPLET:/tmp/announce-$FRIEND.txt"
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND --send --body-file /tmp/announce-$FRIEND.txt"
```

---

## Reference — commands that are not part of the flow

Nothing here is a numbered step. These are the things you occasionally need and
would otherwise go looking for.

### Check what landed on the droplet

Read-only, against the real platform database. Use these when an invite or a
signup looks like it did not take.

```bash
# Invite: expect one row, used=1 revoked=0
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/platform-query.ts 'SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites WHERE slug = ?;' --param $FRIEND"

# Account: expect enveloped=1
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/platform-query.ts 'SELECT a.slug, k.account_id IS NOT NULL AS enveloped FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id WHERE a.slug = ?;' --param $FRIEND"

# Their folder: expect a <slug>.db of a few KB
ssh "$DROPLET" "$STAIRWELL && ls -la users/$FRIEND/"
```

`scripts/platform-query.ts`, **not** `sqlite3` — the droplet has no `sqlite3`
binary. It ships with the app, opens the database `{ readonly: true }`, and
refuses outright if `PLATFORM_DB` is unset, which is what `$STAIRWELL` sets.

`--param $FRIEND` binds the `?` rather than splicing the value into the SQL, so
the nesting (single quotes inside the double-quoted `ssh`) cannot break. Write
your own query the same way; for anything long, put the SQL in a file and pass
`--file /tmp/my-query.sql`.

### Ask the friend a question mid-build

**Rarely.** The normal path is that the builder reports a blocker to you and you
decide — you have the spec, and they can ask for a change afterwards. This is
for the case where the spec is genuinely ambiguous and you cannot answer it
either. It posts one operator-typed sentence into their chat; the agent relays
it and passes the answer back.

```bash
QUESTION="Should the streak reset on a missed day, or shouldn't it?"
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/ask-user.ts $FRIEND $(printf '%q' "$QUESTION")"
```

The question goes in its own variable wrapped in `printf '%q'` because it is the
one argument with human punctuation in it — without that, the quoting breaks on
the first apostrophe and a mangled question lands permanently in a transcript
that rejects DELETE.

### Revoke an unused invite

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/revoke-invite.ts $FRIEND"
```

By slug, because the token is the thing you do not have — only its SHA-256 is
stored. It refuses an invite that was already **used**: the account exists, and
the row is the record of how. There is no expiry, by design.
