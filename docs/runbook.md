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
  `EnvironmentFile`, so the far side has it unset otherwise. Most of what you
  type by hand now refuses outright and names `PLATFORM_DB` in the error —
  `platform-query.ts`, `ask-user.ts`, `announce-deploy.ts` — but
  `create-invite.ts` and `revoke-invite.ts` still fall back to a synthetic
  database instead of refusing, so the prelude is what's required either way.
  `scripts/pull-spec.sh` handles this itself; the ones you type by hand need
  the prelude.

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
| When | They have never had a dashboard | They have one, and asked for a new version |
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

The build itself happens on a branch named for the spec version —
`sam/v1`, `sam/v2` — created at **step 6**, which is the first moment that
number exists on the laptop. One branch per version: merged to main at step 8,
deleted at step 9. A version is already the atomic unit everywhere else in this
system (a permanent `specs` row, announced exactly once), so the branch is named
after the thing that gets announced.

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
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/platform-query.ts 'SELECT slug, used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites WHERE slug = ?;' --param $FRIEND"

ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/platform-query.ts 'SELECT a.slug, k.account_id IS NOT NULL AS enveloped FROM accounts a LEFT JOIN account_keys k ON k.account_id = a.id WHERE a.slug = ?;' --param $FRIEND"

ssh "$DROPLET" "$STAIRWELL && ls -la users/$FRIEND/"
```

`scripts/platform-query.ts` is what these run against — **not** `sqlite3`,
which is not installed on the droplet (confirmed live: `sqlite3: command not
found`). It ships with the app, so nothing needs installing there, and it
opens the database `{ readonly: true }`, so pasting a write by mistake throws
instead of landing. It refuses outright if `PLATFORM_DB` is unset, which is
exactly what the `$STAIRWELL` prelude sets.

`--param $FRIEND` binds the `?` in each query to your slug, so the row you get
back is the one you just created, not the whole table — with several accounts
onboarded this stops you eyeballing past the rest. `$FRIEND` is safe to
splice into the double-quoted `ssh` command unquoted, the same way step 2
already does (`scripts/create-invite.ts $FRIEND`): step 1 pins its shape to
`^[a-z0-9-]{1,32}$`, which cannot contain a quote or a space.

Note the SQL itself is in **single** quotes inside the double-quoted `ssh`
command. That nesting only works because none of these statements contains an
apostrophe; if you write your own query with a literal value that might have
one, bind it with `--param` instead of splicing it into the SQL text — that
sidesteps the nesting entirely, the same way it does for `$FRIEND` above. For
a query long or awkward enough that even that is unwieldy, put the SQL in a
file and pass `--file <path>`:

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/platform-query.ts --file /tmp/my-query.sql"
```

Expect one row: `used=1, revoked=0` from the first query, `enveloped=1` from
the second, and a `<slug>.db` file of a few KB.

---

## Step 4 — Watch the conversation

- **ntfy** fires a push to `NTFY_TOPIC` on a conversation start, and on the two
  outcomes a spec authoring call can produce: `spec_authored` (`asked for a
  build`) and `spec_failed` (`asked for a build, and writing the spec
  failed`) — see Step 5. That is the real-time channel.
- **`/admin`** is the reading surface: the user list sorted by last activity,
  then per user two tabs — **Transcript / Spec**. There is no Mockup tab —
  nothing composes or serves mockup HTML any more (mockup-loop removal). It is
  manual refresh only; nothing polls. Log in as `nico` (an admin lands on
  `/admin`, and has no user space of their own).
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

## Step 5 — The agent authors a spec

There is no card to confirm any more, but there is still a question. When the
agent decides it has enough — `platform/prompts/agent-v8.md`'s "When you have
enough" — it does NOT propose yet: it says so and asks whether there is
anything else they want in this build, once. On their next message, whatever
it says, it calls `propose_spec`, which writes a spec in the background and
ends there: no card, no button, no confirmation event.

That question is the confirmation now. It exists because removing the card
removed the moment a person could say "actually, one more thing" — people
routinely give one want and remember the second only when asked. The newest spec row IS the build
contract the moment it exists (`lib/db/specs.ts`'s `currentSpec`), so the
instant one exists there is something to import — `scripts/export-spec.ts`
refuses only an account with no spec at all, never one that merely has not
been confirmed, because nothing is.

**You learn a friend wants a build from an ntfy push, not by watching for a
confirmation:** `spec_authored` fires the moment authoring succeeds
(`<slug> asked for a build`); `spec_failed` fires if it did not (`<slug>
asked for a build, and writing the spec failed`) — see Step 4. A `spec_failed`
push means there is nothing to pull yet: read the transcript in `/admin` for
what the friend actually asked, and let the conversation continue.

Three properties worth holding in your head when you read a spec in `/admin`:

- A spec version is **change-only** — it describes what changes against
  `users/<slug>/current.md`, the dashboard as it was actually built, not their
  entire dashboard. v3 does not supersede v2's content; it is written on top of
  what v2's build left behind. So `current.md` being right is what makes the
  next spec right (`lib/spec/change.ts`, `lib/spec/author.ts`).
- It carries no ids and no `title`, `summary` or `background`. A panel's detail
  is prose in its `description`. What used to sit in `background` — what they
  already check, what they worry about, what they turned down — now reaches you
  only through `conversation.md` (step 6) and `current.md`'s
  `## Deliberately not included`.
- `specs` rejects UPDATE. A version is a permanent row. `based_on_version` and
  the `shape` tag are supplied by the server, never authored by the model.

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

This ssh's to the droplet, reads the real spec, and writes a PAIR:

- `users/<slug>/spec.md` — the change they asked for. **Tracked**, and Gate B
  exempt.
- `users/<slug>/conversation.md` — the transcript slice that produced that spec
  version, oldest first. **Gitignored, permanently and on purpose**: `spec.md`
  is a designed artifact describing a dashboard, and this is everything the
  friend said, including whatever they said around it (CLAUDE.md > Data
  safety). `git add "users/$FRIEND"` below skips it because it is ignored, and
  `tests/repo/gitignore.test.ts` is what keeps it that way.

Read both. A change-only spec says what to build; the conversation says what
they meant, and since the spec shape dropped `background` it is the only place
the residue about the person survives.

**Both files are overwritten on every pull**, because they are projections of
database records rather than sources. Treat them as read-only: when the spec is
wrong, have the friend ask for a change in chat and pull again. `mockup.html`
is gone — nothing composes or serves mockup HTML any more.

The write is atomic across BOTH files — `scripts/write-spec-pair.ts` temp-writes,
moves any existing file aside, and commits by rename, rolling back if either
step fails — so you never get a new `spec.md` beside a stale `conversation.md`.

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
git commit -m "Scaffold $FRIEND and pull spec v$V"   # Flow B: drop "Scaffold and"
```

Adding the folder rather than just `spec.md` is what makes one command work
for both flows: in Flow A it picks up the scaffold too, and the scaffold
ships its own `tests/dashboard.test.ts`, which is what satisfies Gate B for a
change under `users/<slug>/`. `spec.md` itself is Gate B exempt either way.

Identical in both flows. There is deliberately no "Flow A is always v1" shortcut:
a new friend can ask for changes in chat and reach v2 before you ever sit down
to build, and a branch named `v1` holding v2's spec is a lie you would not notice
until the announce step disagreed with it.

---

## Step 7 — Build the dashboard

**Read `docs/dashboard-build-rules.md` before you write any code.** It indexes
every rule governing a `users/<slug>/` build, with a citation on each line.
This step is the *sequence*; that file is the *substance*, and nothing below
repeats it.

Confirm you are on the version branch before anything else here — this is the
step that writes code, and main is the line the droplet pulls:

```bash
git branch --show-current               # expect <slug>/v<n>
```

### 7.1 Register the dashboard — Flow A only

Add the line `new-dashboard.sh` printed at step 6 to `lib/dashboard/registry.ts`:

```ts
<slug>: () => import('@/users/<slug>/dashboard'),
```

Flow B's line is already there. Why it is load-bearing beyond rendering:
build-rules §2.

### 7.2 Write the shape

**This is the first real step of the build, and nothing after it means anything
until it is done.** The scaffold ships no shape: `migrations/` holds a README,
`seed.py` has no inserts, and the dashboard says "Under construction".

Read `users/$FRIEND/spec.md`, then write the migration its tables need. Which
file you write depends on what is already in the folder, not on which flow you
are in — a new friend can arrive on a `v2` branch with an empty `migrations/`:

```bash
ls users/$FRIEND/migrations/*.sql 2>/dev/null || echo "none yet"
```

- **None yet** → write `migrations/001_initial.sql`. While 001 has never been
  applied you can edit it freely; that is the whole window for getting a shape
  right cheaply.
- **One or more already there** → write the next number (`002_*.sql`, …), never
  an edit to an existing file, and **ship a data-survival test in the same
  commit**: seed the old shape, migrate, assert the rows survived. Rules and
  reasoning: build-rules §5.

Then regenerate the manifest, which is what proves an applied migration has not
been edited since. The command lives in their own migrations README:

```bash
cat users/$FRIEND/migrations/README.md   # the node -e one-liner is in here
```

Now add `seed.py`'s inserts — loudly fake values only, `COFFEE PALACE TEST`
where the shape has free text to carry it (build-rules §6) — and check both
halves landed:

```bash
npm run synthetic                        # regenerates every users/*/synthetic.db
npx vitest run "users/$FRIEND"
npx vitest run tests/users/conventions.test.ts   # first run where the sweep
                                                 # treats this folder as BUILT
```

Two of the sweep's built-only checks stay red here on purpose: they want
`current.md`, and that file is not written until step 7.5. Re-sweeping "goes
green everywhere else" between here and there, not "all green" — expected,
not a sign the migration is wrong.

`npm run synthetic` prints each `seed.py`'s own line. **If `$FRIEND`'s says
`no shape yet, empty database`, the migration did not land and the tests that
just passed proved nothing** — they build their fixture from the migration
files directly, never from `synthetic.db`, so they stay green while the file
the dev server actually opens is empty. An empty database is a legitimate
state (it is what a friend has on day one), so nothing else objects either.

That check went two months unusable: the script captured every generator's
stdout and dropped it, so the line named here reached no terminal. Fixed;
`tests/scripts/regenSynthetic.test.ts` now spawns the CLI for real rather than
asserting against a stubbed console, because "the string was logged" and "a
human saw it" are different claims.

### 7.3 Build toward the spec

There is no mockup. The build contract is four things, each answering a
different question: `spec.md` (what changes), `conversation.md` (what they
meant — pulled beside it at step 6, gitignored), `current.md` (what the
dashboard already is, if this is not its first version), and the code.
`spec.md` is change-only, so it deliberately does not describe the whole
surface — read it *against* `current.md`, and read `conversation.md` when the
change alone leaves a question. `/admin` still shows the live transcript if you
want more than the slice behind this version. Feasibility doubts go back to the
friend rather than into a guess — `scripts/ask-user.ts`, step 4 — and you
build on their answer.

Everything about *how* to build lives in build-rules: what a dashboard is handed
and may not do (§3), multi-screen specs and the tab strip you must not draw
(§3), entry widgets (§4), which database serves and rendering zero rows (§6).
**Check §4 early** — a dashboard with a write path is two pieces of work, since
the widget POSTs to a platform route you also have to write.

Re-sweep the folder's shape whenever you change it:

```bash
npx vitest run tests/users/conventions.test.ts
```

### 7.4 See it on a screen

No test tells you whether it matches the spec. Look at it.

**Once per friend** — there is no local account for their slug yet:

```bash
npx tsx scripts/create-local-account.ts "$FRIEND" 'a-local-password-10-plus'
```

One line, no browser, no invite. The password is local, disposable and yours; it
has nothing to do with the one they set on the droplet, and you will type it at
`/login` every time you come back to this build.

**Never reach for `npm run build && npm start` to do this instead.** `npm start`
sets `NODE_ENV=production`, and a login there writes a real
`users/<slug>/<slug>.db` onto your laptop — the one file that belongs only on
the server (CLAUDE.md > Data safety). `create-local-account.ts` refuses to run
under production at all. If one is already sitting there from an older run,
Gate F blocks your next commit and prints the fix:

```bash
rm users/<slug>/<slug>.db*               # the * matters: -wal and -shm hold the same rows
```

**Then, every time:**

```bash
npm run dev                              # then log in at /login as the slug
```

You land on `/<slug>`: their dashboard, reading `users/<slug>/synthetic.db`,
under the **SYNTHETIC DATA** banner. Anything the entry widget writes goes to
that same file, so the loop is honest — type a value, save, see it. Keep
`spec.md` open beside it and iterate.

More than one screen? The tab strip only appears once `screens` has two or more
entries — click each tab, or go straight to `/<slug>?screen=<id>` for the one
you are iterating on. Click through every screen once before you ship.

**Then look at day one.** What you have been iterating against is `seed.py`'s
sample data; what the friend gets on their first morning is their own database
with nothing in it. Those are different screens, and only one of them is the
first thing they will ever see:

```bash
npm run synthetic -- --empty             # shape only, no rows
# reload /<slug> — every screen, same as above
npm run synthetic                        # put the sample data back
```

The empty-render test in their `tests/` proves the dashboard does not throw. It
cannot tell you whether the result reads as "waiting" or as "broken", and that
distinction has already cost this project a friend's first morning — a day
before they started rendered as a day they failed, with every test green
(build-rules §6). Leave it empty long enough to actually read it.

If a login under `npm run dev` looks like it did not stick, reload — it is the
cold-route artifact described in `docs/local-dev.md`, not your code.

### 7.5 Write the build notes, and rewrite `current.md`

Two files, and they answer different questions. Write both before you ship.

**`users/$FRIEND/notes/v$V.md`** — what shipped in THIS version. Added, never
edited: step 9 speaks from it, and editing one changes what an already-sent,
permanent announcement was based on. `notes/README.md` in their folder holds
the template and says which sections the friend sees.

**`users/$FRIEND/current.md`** — what the dashboard IS now, after this build.
**Overwritten every time**, because it is the agent's whole picture of what
exists and a changelog is not a picture. If the file is not there yet:

```bash
sed 's/__SLUG__/'"$FRIEND"'/g' platform/templates/dashboard/current.md.tmpl \
  > users/$FRIEND/current.md
```

Then edit it to describe what you actually built, and set `version: $V`.
**Step 9 refuses to announce if you don't.** `announce-deploy.ts` compares
`current.md`'s frontmatter `version` against the version being announced and
exits 1 on a mismatch (`current_state_stale`), on a missing file
(`current_state_missing`) and on one that does not parse
(`current_state_invalid`) — before it makes any model call. Rewriting this file
is part of the build, not a follow-up.
Write the panel descriptions from `queries.ts`, not from `dashboard.tsx` — a
panel's real behaviour usually lives in its query (a grace day, a window, what
counts as a logged day), and a description written from the component alone
describes a simpler dashboard than the one that shipped.
`tests/users/conventions.test.ts` fails if it is missing, or if its version is
not the newest `notes/v<n>.md` — that check is what stops it rotting, since
`*.md` is exempt from Gate B and a commit will not notice.

The section that earns the most care is `## Deliberately not included`. It is
the only place a refusal survives. Anything the friend considered and turned
down goes there, or the agent proposes it again next month.

Never put their data in either file — both are committed to the repo
(build-rules §2).

### 7.6 Commit the build

Step 8 merges this branch. It does not pick up anything you left uncommitted:

```bash
git status --short                       # review first: nothing stray, no *.db
git add -A                               # or name the paths, if the tree holds other work
git commit -m "Build $FRIEND's dashboard v$V"
```

Gate B wants a test under `users/$FRIEND/tests/` for a change under that folder,
and one under `tests/` if you also wrote a platform route. Gate C typechecks.
Gate F blocks the commit outright while a non-synthetic database sits under
`users/`, and has no skip. Committing in smaller pieces as you go is fine — the
only rule is that nothing is left behind when you reach step 8.

`current.md` and the notes are `*.md`, which Gate B exempts — they will not
force a test, and they will not be noticed if you forget them. The sweep in
`npx vitest run tests` is what catches a missing or stale `current.md`, so run
it before you reach step 8.

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

**`--send` on its own RE-DRAFTS.** It makes a fresh, independent model call —
not the sentence you read in step 1 — so reading a draft does not gate what
actually gets sent unless you send that exact draft back. `--body-file` is
how: it posts a file's bytes verbatim, with no model call, so what lands in
the transcript is byte-for-byte what you read.

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

**Nothing passes through the clipboard, and that is the point.** This step used
to say `pbpaste > "/tmp/announce-$FRIEND.txt"`, which made the announcement
depend on the clipboard still holding the draft. On 2026-08-18 it did not: it
held *this file's own command block*, because copying the commands is what you
have just done at that point in the process. Three shell commands went into a
friend's chat, and `transcripts` rejects DELETE, so they are still there.

The draft now goes straight from the command that produced it into the file
that sends it. `announce-deploy.ts` writes the body to **stdout** and every
other line — the `DRY RUN` notice, the `## Open` warning — to **stderr**, so
`tee` captures the sentence alone while you still see the rest on screen.
`--body-file` also refuses a body containing `ssh `, `scp `, `npx tsx` or the
variables above, as a backstop for a file assembled some other way.

The draft is written from `notes/v$V.md` — what shipped, plus any in-spirit
adjustment worth mentioning — and from what they have already been told.
There is no preview and nothing was confirmed in advance, so this message is
the first look they get: it names what it actually shows, rather than
assuming they have already seen it (`platform/prompts/announce-v2.md`).
**Read it before sending.**
`transcripts` rejects DELETE; this is the first generated sentence this system
puts in there, and a bad one is permanent.

It refuses, loudly and with exit 1, if `notes/v$V.md` is missing or malformed —
and, for the same reason and at the same point (after the target is resolved,
before any drafting call, so it applies to `--plain` and `--body-file` too), if
`users/$FRIEND/current.md` is missing (`current_state_missing`), does not parse
(`current_state_invalid`), or names a different version than the one being
announced (`current_state_stale`). All three mean step 7.5 is unfinished: write
or fix `current.md`, commit, and run this again. It compares versions, never
mtimes — a fresh clone rewrites every mtime, so an mtime check would pass on the
laptop and fail on the droplet.
If it warns that `## Open` is non-empty, the announcement is still correct —
but you owe them a chat about the part that did not land, via
`scripts/ask-user.ts` (step 4) or a new proposal.

Skipping `--body-file` and running `--send` directly still works — it is not
forbidden, just re-drafting, and it prints a warning saying so on every run.
Use it only when the wording difference between "what I read" and "what gets
sent" genuinely does not matter for that announcement.

If the API is down and the announcement has to go out now:

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND --send --plain"
```

`--plain` sends the old fixed sentence and makes no model call. It is the only
sanctioned way to announce without reading the notes. (`--plain` and
`--body-file` are two different ways to skip drafting — pass at most one.)

Posts into **that one account's** chat, **once per spec version**.
Safe to re-run: an already-announced version is reported, not repeated.

Run it by hand, per friend, and keep it that way. `deploy.sh` deploys the whole
service, so calling the announcer from it would post "your dashboard just updated"
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

Versions 2, 3, … are **Flow B** in the table at the top: the agent authors a
new spec in chat — change-only, written against the `current.md` your last
build left behind — and you run 0 → 4 → 5 → 6 → 7 → 8 → 9 again on
a fresh `<slug>/v<n>` branch. `pull-spec.sh` overwrites both pulled files, step 6 skips
the scaffold and step 7 skips the registry line, and everything else is the
same work as the first time — including a migration, which at v2 is the next number
rather than `001` (step 7.2), and including a rewritten `current.md`
(step 7.5). The notes are a new file; `current.md` is the same file, replaced.

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
| Fix a wrong spec by asking for a change in chat, then re-running `pull-spec.sh` | `spec.md` is a projection of the record, not a source, and the next pull overwrites it. The source is the record. |
| Never commit `users/<slug>/conversation.md`, and never widen the `.gitignore` patterns that hold it | It is a friend's raw transcript, not a designed artifact. The guard hook denies `.db` and `.env`, not markdown, so two `.gitignore` lines and `tests/repo/gitignore.test.ts` are the whole defence — and the transcript exists at three paths, the `.tmp` and `.bak` sidecars included. A committed copy is in every clone forever. |
| Ship every shape change as a new numbered migration — `002_…`, then `003_…` | A friend's database records only which NUMBER it reached, so editing an applied file silently changes what that number means. The manifest's checksum refuses the session rather than letting it through. |
| Add a new prompt version — `agent-v3.md` | `prompt_sha` is stamped on transcript and spec rows that already exist, so editing `agent-v2.md` changes what an already-written hash points at. Prompts are added, and that is a data-safety property. |
| Run `announce-deploy.ts` by hand, once per friend, at step 9 | `deploy.sh` deploys the whole service. Calling the announcer from it would post "your dashboard just updated" into every account's chat on every push — a permanent line in an append-only transcript. |
| Write `notes/v<n>.md` before announcing, and never edit one afterwards | It is the only record of what shipped, and step 9 speaks from it. An edited note changes what an already-sent, permanent announcement was based on. |
| Rewrite `current.md` on every build, and never let it accumulate | It is what the chat agent reads to know what exists, and the base the NEXT spec is written against — a change-only spec restates nothing, so a stale `current.md` corrupts every later version. A note is added and never edited because an announcement was based on it; `current.md` is the opposite and must be REPLACED, because an agent that has to replay a changelog to work out the current state is back to guessing. Step 9 refuses to announce a version it does not name. |
| Read the drafted announcement, then send it back with `--send --body-file` | `transcripts` rejects DELETE. `--send` alone re-drafts — a fresh model sample, not the sentence you read — so reading a draft only gates what gets written when `--body-file` sends that exact draft back verbatim, with no model call. |
| Leave every `deploy_announced` and `first_session_start` metric row in place | Both are read for correctness, not observed. Losing one makes a weeks-old build re-announce itself, or a months-old account report a first session again. They look like telemetry and are not. |
| Build locally with `scripts/create-local-account.ts` + `npm run dev` | `npm start` sets `NODE_ENV=production`, the only switch `lib/db/userData.ts` has, so a login there takes the production branch and `lib/db/migrate.ts` writes a real `users/<slug>/<slug>.db` onto your laptop. Gate F blocks your next commit until it is removed. |
| Ship every droplet change through `git push` and `deploy/deploy.sh` | `deploy.sh` runs `git pull --ff-only`, so a hand-edit there is clobbered by the next deploy and is invisible on the laptop where the dashboard is actually built. |
| Name every branch `<slug>/v<n>` | Git stores a bare `sam` as a *file* under `refs/heads/`, which can never coexist with the *directory* `refs/heads/sam/`. One `git branch sam` makes `sam/v2` impossible for as long as it exists. |
| Write dashboard code on the version branch — check `git branch --show-current` first | `main` is the line the droplet pulls. A half-built dashboard sitting there means an unrelated urgent fix cannot ship without it. |
| Point `PLATFORM_DB` at `platform/dev/synthetic.db` for anything you run locally | `export-spec.ts`, `announce-deploy.ts` and `ask-user.ts` read non-synthetic data by design — *on the server*. All three now refuse outright if `PLATFORM_DB` is unset rather than falling back — that refusal is what makes this rule enforced rather than merely advised. |
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
| `no spec for '<slug>'` on pull | The agent has never had enough to call `propose_spec` for this account yet. Correct refusal — check the transcript in `/admin`, or wait for a `spec_authored` push. |
| Pull fails with `Refusing to run: PLATFORM_DB is not set` | `.env` on the far side doesn't set it — `pull-spec.sh` sources `.env` itself before calling `export-spec.ts`, so this points at `.env`, not at the command you typed. `export-spec.ts` has no fallback (see its header): it refuses rather than guessing, so this can no longer come back as a spec that quietly *looks* synthetic — only as a loud failure naming the variable. |
| Announce exits 1 with `current.md` in the message | Step 7.5's `current.md` rewrite is missing (`current_state_missing`), unparseable (`current_state_invalid`), or names a different version than the one being announced (`current_state_stale`). Nothing was posted and no model call was paid for. Write or fix the file, commit, and re-run — the check is on `version` in the frontmatter, never on mtimes. |
| Their dashboard says **Under construction** | The folder was scaffolded but `migrations/001_initial.sql` has not been written. Expected between step 6's scaffold and step 7.2, and it is what step 7.2 exists to fix. |
| A friend cannot log in, and ntfy says a migration failed | The session was refused rather than served over a half-migrated shape. The alert carries the slug and migration number; the server log has the error. Their `<slug>.backup.db` holds the pre-migration copy. |
| "This dashboard failed to load", permanently | Something read *file existence* as *has data*. Existence means **holds at least one table** — every friend has a file from day one. |
| Deploy aborted, site still fine | Tests failed before the restart. The old process is untouched. |
| Deploy failed at the smoke gate | The new code **is** live and failing. Fix forward. |
| `[env] missing REQUIRED: …` at startup | A name in `deploy/required-env` isn't in that host's `.env`. Values live only in `.env`; the guard hook denies reading it, so set it yourself. |
| A friend forgot their password | There is no path back. Their data is gone. Mint a new invite on a new slug. Say this out loud at step 3, not here. |
