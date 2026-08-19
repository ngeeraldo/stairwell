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

Here is the starting message:
```bash
You are now building...
```

Now answer the AI builders questions and wait for it to complete

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
### Step 7 - Hand over to AI Builder for Notes and `current.md` rewrite.
```bash
The project looks good, you are free to write the new notes and update current.md.
```

### Step 8 - Commit the build

Step 8 merges this branch. It does not pick up anything you left uncommitted:

```bash
git status --short                       # review first: nothing stray, no *.db
git add -A                               # or name the paths, if the tree holds other work
git commit -m "Build $FRIEND's dashboard v$V"
```

## Step 8 — Ship it

```bash
git checkout main && git pull --ff-only
git merge --no-ff "$FRIEND/v$V" -m "Build $FRIEND's dashboard v$V"

git push          # Gate E (full suite) then Gate D (next build), unconditionally

ssh "$DROPLET" '/home/deploy/stairwell/deploy/deploy.sh'
```

## Step 9 — Tell them it landed

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