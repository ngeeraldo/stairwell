# Runbook (AI) — the two steps the builder owns

This file is for **the AI builder**, not for Nico. `docs/runbook-human.md` is
the operator sequence — eleven steps, run by hand — and it hands two of them to
you:

| You are asked | You do | Nico does next |
|---|---|---|
| "do Step 6 in runbook-ai for `<slug>`" | migrations, `seed.py`, `queries.ts`, `dashboard.tsx`, tests | Step 7: starts the dev server and looks at every screen |
| "do Step 8 in runbook-ai for `<slug>`" | `notes/v<n>.md`, rewrite `current.md` | Step 9: commits, then merges, deploys, announces |

Read **Section 1 in full** before either step. Sections 2 and 3 are the steps
themselves; do only the one you were asked for.

---

# Section 1 — Before you do anything

## 1.1 What you never do

Each line is a boundary that has already cost this project something, or that
belongs to a step Nico has deliberately kept manual. None of them is a thing to
work around when it gets in the way.

| Never | Why |
|---|---|
| `git commit`, `git merge`, `git push`, `git checkout -b` | Nico commits at Step 9 and merges at Step 10, after reviewing the tree. Your steps end with a dirty working tree and a report — that is the deliverable, not an unfinished state. |
| `ssh` to the droplet, or run anything under `deploy/` | The droplet holds real accounts and real transcripts. Everything you touch is on the laptop, against synthetic data. |
| `npm start`, or `npm run build && npm start` | `npm start` sets `NODE_ENV=production`, the only switch `lib/db/userData.ts` has, so a login there makes `lib/db/migrate.ts` write a real `users/<slug>/<slug>.db` onto the laptop. **Gate F** then blocks Nico's next commit until it is removed (`rm users/<slug>/<slug>.db*` — the `*` matters). CLAUDE.md > Data safety. |
| Open, read, or query any `.db` other than a `synthetic.db` | The guard hook (`.claude/hooks/deny-sensitive-files.sh`) denies it. A denial is the rule working. `fake-real.db` in the repo root is a deliberate decoy — do not flag it and do not open it. |
| Run `./scripts/pull-spec.sh`, `create-invite.ts`, `announce-deploy.ts`, `ask-user.ts` | Nico's — steps 2, 5 and 11, and the Reference section of `docs/runbook-human.md`. Two of them write permanently into an append-only transcript a friend can read. |
| Run `./scripts/new-dashboard.sh` | Nico's Step 3. Scaffolding is his; it refuses a folder that already exists and there is no undo. |
| Edit `users/<slug>/spec.md` or `conversation.md` | Both are projections of database rows, overwritten by the next pull. A wrong spec is fixed in the friend's chat, not in the file. |
| Edit an applied migration, or a `notes/v<n>.md` that already exists | Both are pinned by something permanent — a friend's `user_version`, an already-sent announcement. §2.2 and §3.1 say what to write instead. |
| Add a `platform/prompts/*.md` version by editing an existing one | `prompt_sha` is stamped on rows that already exist. Prompts are added — `agent-v9.md`, never an edit to `agent-v8.md`. |
| Put a friend's data in `notes/`, `current.md`, `metrics`, or any committed file | All are committed to the repo or unencrypted. Describe **shape** — a table, a panel, a computation — never a row, a value, or a merchant. |

## 1.2 Preflight

Run this before reading anything else. It sets the two variables the rest of
this file uses and proves the ground Nico's steps 3–5 were supposed to leave.

```bash
SLUG=<slug>                                                        # from Nico's message
V=$(sed -n 's/^- \*\*Spec version:\*\* v//p' "users/$SLUG/spec.md")
echo "slug=$SLUG version=$V"                                       # V must be a bare number

git branch --show-current                                          # must be $SLUG/v$V
ls users/$SLUG/                                                    # spec.md and conversation.md must both be here
grep -n "  $SLUG: () => import" lib/dashboard/registry.ts          # the registry line must exist
ls users/$SLUG/migrations/*.sql 2>/dev/null || echo "no migrations yet"
```

**Stop and tell Nico if any of the first three fail.** They are his steps, not
yours to fix:

- **branch says `main`** — Step 5 creates `$SLUG/v$V`. `main` is the line
  `deploy.sh` pulls, so a half-built dashboard there blocks every unrelated fix.
- **no `spec.md`** — Step 5 pulls it. There is nothing to build toward.
- **no registry line** — Step 4. Without it `tests/dashboard/registry.test.ts`
  fails and the page renders the placeholder card instead of the dashboard.

The last command is not a check, it is the fork in §2.2: **no migrations** means
you write `001_initial.sql`; **any migrations** means you write the next number.
That fork is decided by what is in the folder, never by whether this is the
friend's first version — a new friend can reach `v2` in chat before Nico ever
sits down to build.

## 1.3 What to read, in order

Read all of these before writing code. `docs/dashboard-build-rules.md` is the
substance of the build and **this file deliberately does not repeat it** — two
copies of a rule are two things that can drift apart.

| Read | What it answers |
|---|---|
| `docs/dashboard-build-rules.md` | Every rule governing a `users/<slug>/` build, with its source cited on each line. §3 what a dashboard is handed and may not do, §4 writes, §5 migrations, §6 which database serves and rendering zero rows, §10 tests and gates, §11 packages. |
| `docs/dashboard-ui-ux-guidelines.md` | How it should LOOK: the default stack (shadcn on Tailwind, Recharts), the fluid 375–1200px container, the four non-happy panel states every panel owes, formatting, and what animation may and may not imply. These are DEFAULTS — the friend's own request outranks them, subject to §1.4. |
| `CLAUDE.md` > Dashboard folder conventions | The hard rules the build-rules index cites. |
| `users/$SLUG/spec.md` | **What CHANGES.** A spec version is change-only: it describes what is added, changed or removed against `current.md`, and never restates the whole surface. |
| `users/$SLUG/conversation.md` | **What they meant.** The transcript slice behind this spec version. The spec shape carries no `background` field any more, so this is the only place the residue about the person survives. Gitignored — never commit it, never quote it into a tracked file. |
| `users/$SLUG/current.md` | **What already exists**, from the last build. Absent on a first version. `spec.md` is written against this, so read them together or you will misread the change. |
| `users/devone/` | The worked reference implementation. Copy its shape, not its content. |
| `users/$SLUG/notes/README.md`, `migrations/README.md` | The scaffold's own templates and rules, with `$SLUG` already substituted. |

The scaffold files themselves — `dashboard.tsx`, `queries.ts` — carry long
header comments stating the rules that survive whatever you replace them with.
Read them where they sit; they are more specific than anything here.

## 1.4 When to stop rather than guess

Three cases. In all three: **finish everything that does not depend on the
answer, then stop and report to Nico** — to him, not to the friend. He has the
spec and he decides; the friend can ask for a change afterwards. He can also
put a question into their chat by hand (`scripts/ask-user.ts`, the Reference
section of `docs/runbook-human.md`), but that is rare and it is his call, not
something to suggest. You cannot reach them either way, and nothing in this
system can reach a friend who is not in the app.

1. **A decision only the friend can make** — does the streak reset on a missed
   day? Does the month start Monday? A spec is prose and will not always say.
2. **Something in the spec you do not think can be built as described.** Say so
   with the reason. Do not quietly build the nearest thing that works.
3. **A UI request that needs an external fetch, restyles platform chrome, or
   cannot be built.** The friend's own UI request outranks
   `docs/dashboard-ui-ux-guidelines.md` — except for those three, which escalate
   to Nico rather than being quietly adjusted.

An **in-spirit adjustment** is different and does not need escalating: the
build's shape differs from how the spec described it, and works better that way.
Build it, and record it in `## Built differently` at Step 8 — the friend sees
that section.

Anything in the spec that did **not** land goes in `## Open` at Step 8, which
the friend never sees, and routes back through Nico.

---

# Section 2 — Step 6: build the dashboard

Everything in `users/$SLUG/`, plus a platform route if the spec has a write
path. Nico looks at it on a screen at his Step 7 and commits it at Step 9.

## 2.1 What the scaffold left you

A scaffolded folder has all six required entries and **no shape**:
`migrations/` holds only a README, `seed.py` has no inserts, `queries.ts` is
`export {}`, and `dashboard.tsx` says "Under construction". That last one is
what a friend currently sees. All of it is meant to be **deleted rather than
extended** — including the placeholder `morning` screen.

On a Flow B folder (`v2` and up) none of that is true: there is a real shape,
real queries, and a `current.md` describing them. You are changing a working
dashboard, and `spec.md` tells you only what changes.

## 2.2 Write the shape

**Nothing after this means anything until it is done.** The migration is the
only description of this dashboard's shape — there is no `schema.sql`.

Use the fork from §1.2:

- **No `.sql` yet** → write `migrations/001_initial.sql`. While 001 has never
  been applied you may edit it freely; that is the whole window for getting a
  shape right cheaply.
- **One or more already there** → write the next number (`002_*.sql`, …), never
  an edit to an existing file, and **ship a data-survival test in the same
  commit**: seed the old shape, migrate, assert the rows survived. Read
  `docs/superpowers/specs/2026-08-15-user-db-migrations-design.md` first.

A migration never inserts rows — changing a shape must not invent data.

Then regenerate the manifest, which is what proves an applied migration has not
been edited since. The same command, with `$SLUG` already substituted, is in
`users/$SLUG/migrations/README.md`:

```bash
node -e 'const{createHash}=require("node:crypto"),{readFileSync,writeFileSync,readdirSync}=require("node:fs");
  const d=`users/${process.env.SLUG}/migrations`;
  const m=readdirSync(d).filter(f=>/^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort().map(f=>({
    number:Number(f.slice(0,3)),
    sha256:createHash("sha256").update(readFileSync(`${d}/${f}`,"utf8")).digest("hex")}));
  writeFileSync(`${d}/manifest.json`,JSON.stringify({migrations:m},null,2)+"\n")'
```

That reads `SLUG` from the environment, so export it or prefix the command:
`SLUG=$SLUG node -e '...'`.

## 2.3 Fill in `seed.py`

It takes a target path, **runs the migrations in order**, and stamps
`user_version` — a synthetic database is built by the same files a real one is,
which is the point. Add the inserts.

**Every value is loudly fake** — `COFFEE PALACE TEST` — **wherever the shape has
free text to carry the marker.** A count or a `2026-08-18` cannot contain the
word and still be the thing it is; `tests/users/conventions.test.ts` decides
this per column with its own `isFreeText`. `seed.py` is committed source, so a
real person's merchant list pasted into one sits outside the guard hook and Gate
F alike, and that sweep is the only thing that would notice.

Seed enough rows to make every panel legible, and seed the awkward cases the
panel has to survive: a gap in the days, a zero, a very long merchant name.

## 2.4 Regenerate, and watch the line it prints

```bash
npm run synthetic                        # regenerates every users/*/synthetic.db
```

**If `$SLUG`'s line says `no shape yet, empty database`, the migration did not
land** — and any tests that pass after this prove nothing, because they build
their fixture from the migration files directly rather than from
`synthetic.db`. They stay green while the file the dev server actually opens is
empty, and an empty database is a legitimate state, so nothing else objects
either.

That check went two months unusable because the script captured every
generator's stdout and dropped it, so the line reached no terminal. Read the
line; do not assume it.

## 2.5 `queries.ts`, then `dashboard.tsx`

**Every SQL statement lives in `queries.ts`**, as a pure function taking the
`UserDb` handle. Data logic in a `.tsx` file can only be tested by rendering it.

The rules that bite here, all enforced by sweeps that run over folders that do
not exist yet:

- **A dashboard never derives a day from a clock.** `today` (`YYYY-MM-DD`, the
  friend's zone) and `timeZone` are handed to the component.
  `tests/users/noLocalDay.test.ts` forbids `Date.now()`, zero-argument
  `new Date()`, and importing `lib/time/dayKey` in a `dashboard.tsx`. A
  `queries.ts` **may** import `dayKey` and run it over a **stored** instant —
  converting a timestamp a row already holds is legitimate; asking a clock what
  day it is never is. Anything needing "today" or "this month" takes it as a
  parameter. This has shipped as a bug once: `docs/superpowers/ledgers/friend-timezone.md`.
- **The component rule has three arms**, and only the first is unconditional.
  **Presentational** components (shadcn's `Card`, `Button`) are trusted.
  **Data-computing** ones (Recharts) are sanctioned but must be guarded by a
  states check — degenerate data renders the empty state as host elements and
  never mounts the component. **Interaction controls** (`lib/ui/WriteAction.tsx`)
  are sanctioned and are the DEFAULT for every write. Everything else is host
  elements. All three render outside `app/[user]/page.tsx`'s try/catch, so a
  throw in one 500s the page after the `dashboard_open` row is written — which
  is why arm 3 is platform code you import rather than code you write.
  Build-rules §3 has the full statement.
- **The platform draws the tab strip, never the dashboard.** Export
  `screens: DashboardScreen[]` with at least one entry — a registered dashboard
  declaring zero throws. `?screen=` is resolved against your list by
  `activeScreen` before you see it, so branching on `screen` is just a
  comparison. With one screen the platform draws no strip at all. Take ids and
  titles from what the friend calls things; a change-only spec carries no ids,
  so they are yours to choose and `current.md`'s `## Screens` is where you write
  them down for the next build.
- **It must render on an empty database.** A friend's first session shows their
  own database with nothing in it — there is no synthetic fallback in front of
  it. An empty panel says "nothing logged yet". It does not show a confident
  zero, and **it never reports days before they started as missed.** The first
  version of this rendered fourteen rows saying "missed" on a friend's first
  morning, with every test green.
- **The handle is read-only.** A render never writes and never changes a shape.

## 2.6 Writes — only if the spec asks for one

A dashboard may **render** an entry widget; the widget **POSTs to a platform
route**, and the route is the only thing holding a writable handle. That is two
pieces of work, so check for it early. Build-rules §4 has the four ordered
checks a route owes.

**Use `lib/ui/WriteAction.tsx` — it is the default, and you write none of the
mechanics.** Press → the controls sharing that route go pending → the server
answers → every affected value patches in together, in place, no navigation.
Do not write a plain `<form>` posting to the route yourself; that reloads the
page. Build-rules §4 has the full contract.

Annotations on synced rows live in the user's own tables, keyed to the synced
rows — never as edits to a shared-module table, or a re-sync tramples them.

## 2.7 Tests

At least one `*.test.ts` under `users/$SLUG/tests/`. What it must cover:

- **An empty-database render** — the scaffold ships this one. It proves the
  dashboard does not throw. It cannot tell you whether the result reads as
  "waiting" or as "broken"; that is Nico's Step 7.
- **Every query's edges**, against a fixture the test builds from the migrations
  — the gap day, the zero, the boundary of a window.
- **The write path**, if §2.6 applied: the insert, and any annotation join.
  `platform/templates/dashboard/tests/dashboard.test.ts.tmpl` is the worked example.
- **Data survival**, if you wrote a migration above 001 (§2.2).

A platform route also needs a test under `tests/`, which is what Gate B wants
for a change under `app/` or `lib/`.

## 2.8 Verify

```bash
npx vitest run "users/$SLUG"
npx vitest run tests/users/conventions.test.ts
npx vitest run tests                             # if you wrote a platform route
npx tsc --noEmit                                 # Gate C runs this at Nico's commit
```

**Two checks in the conventions sweep stay red here, on purpose.** Both want
`users/$SLUG/current.md`, and that file is not written until Step 8:

- `has a current.md that parses`
- `current.md names the newest version that was built`

Everything else in that sweep must be green — it is the first run where it
treats this folder as **built** rather than scaffolded, so checks that were
skipping now apply. Anything else red is a real failure.

`npx tsc --noEmit` matters because vitest transpiles through esbuild and never
runs the compiler: a green suite says nothing about whether it typechecks.

## 2.9 Hand back

Do not commit. Report to Nico:

- what shipped, panel by panel, and which screens exist;
- any **in-spirit adjustment** — where the build differs from the spec's wording
  and why it works better (this becomes `## Built differently`);
- anything in the spec that did **not** land, and why (this becomes `## Open`,
  and he may need to take it back to the friend);
- anything from §1.4 you stopped on;
- that the two `current.md` checks are red and Step 8 is what turns them green.

He runs Step 7 next: dev server, every screen, then `npm run synthetic --
--empty` to see day one.

---

# Section 3 — Step 8: the notes, and the `current.md` rewrite

Two files, answering different questions, written after Nico has looked at the
build and said it is good. Both are committed to the repo, so **neither may
contain a row, a value, or a merchant** — describe shape only.

## 3.1 `users/$SLUG/notes/v$V.md` — what shipped in THIS version

**Added, never edited.** `scripts/announce-deploy.ts` speaks from this file at
Nico's Step 11, so editing one changes what an already-sent, permanently stored
announcement was based on. If `v$V.md` already exists, stop — this version has
been built before.

`users/$SLUG/notes/README.md` holds the template. Four sections, parsed by
`lib/build/notes.ts`, and an unknown or misspelled heading throws:

| Section | Reaches the friend? | |
|---|---|---|
| `## What shipped` | **Yes** | Product-level: what they can now see or do that they could not before. Must not be empty. |
| `## Built differently` | **Yes** | In-spirit adjustments and why they work better. Empty is normal. |
| `## Open` | **No** | Anything in the spec that did not land. A routing instruction, not a disclosure — it goes back to the chat. `announce-deploy.ts` warns Nico when it is non-empty. |
| `## Notes for the next build` | **No** | Technical residue: what is fragile, why a structure is the way it is, what a future version should not assume. |

The split is enforced by the parser, not by prompt wording — nothing written in
the wrong section gets rescued later. Frontmatter: `slug`, `version` (`$V`),
`built_at` (`YYYY-MM-DD`).

## 3.2 `users/$SLUG/current.md` — what the dashboard IS now

**Overwritten every build.** It is the one artifact under `users/<slug>/` the
running app puts in front of a model — `app/api/chat/route.ts` reads it, and the
agent prompt tells the agent to trust it over the spec — and it is the base the
**next** spec is written against. A change-only spec restates nothing, so a
stale `current.md` corrupts every version after it.

It is replaced rather than appended to for exactly that reason: an agent that
has to replay a changelog to work out what currently exists is back to guessing,
which is the failure this file exists to remove. That is the opposite of the
notes rule above, and the difference is what points at each: an announcement
points permanently at a note; nothing points at `current.md`.

If the file is not there yet:

```bash
sed 's/__SLUG__/'"$SLUG"'/g' platform/templates/dashboard/current.md.tmpl \
  > users/$SLUG/current.md
```

Then rewrite it to describe what you actually built, and set `version: $V` in
the frontmatter. Five level-2 sections, in this order, parser-enforced by
`lib/build/currentState.ts` — an unknown, misspelled, duplicated or missing
heading throws:

1. `## What this is for` — one paragraph, in the friend's own terms.
2. `## Screens` — each screen's id, title, and what is on it. Say what the
   screens ARE, not how the strip is drawn.
3. `## Panels` — each panel: what it shows, how it behaves, and **the edges that
   were decided.** See the warning below.
4. `## What can be entered` — every control that writes, and what it writes.
   "Nothing" is a real answer.
5. `## Deliberately not included` — see below.

**Write the panel descriptions from `queries.ts`, not from `dashboard.tsx`.** A
panel's real behaviour usually lives in its query — a grace day, a window, what
counts as a logged day, which days are blank rather than zero. The component
shows you a number; the query decides what the number means. A description
written from the component alone describes a simpler dashboard than the one that
shipped.

**`## Deliberately not included` earns the most care.** It is the only place a
refusal survives. Anything the friend considered and turned down goes there —
from `conversation.md`, from `## Open`, from the previous `current.md` — or the
agent proposes the same thing again next month. Never empty it in a rewrite:
carry the previous version's entries forward unless the friend has since asked
for the thing.

## 3.3 Verify

```bash
npx vitest run tests/users/conventions.test.ts   # the two checks from §2.8 are now green
npx vitest run "users/$SLUG"
npx tsc --noEmit
```

Both files are `*.md`, which **Gate B exempts** — they will not force a test and
a commit will not notice if you forget them. The conventions sweep is the only
thing that catches a missing or stale `current.md`, so run it.

At Nico's Step 11, `announce-deploy.ts` refuses outright, exit 1, with three
distinct outcomes, before it makes any model call:

| Refusal | Means |
|---|---|
| `current_state_missing` | You did not write the file. |
| `current_state_invalid` | It does not parse — the message names the section or frontmatter line. |
| `current_state_stale` | Its frontmatter `version` is not the version being announced. |

It compares **versions, never mtimes** — a fresh clone rewrites every mtime, so
an mtime check would pass on the laptop and fail on the droplet.

## 3.4 Hand back

Do not commit. Tell Nico the two files are written, name anything you put in
`## Open` — he owes the friend a chat about it, and the announcement will not
carry it — and confirm the sweep is fully green.

He runs Step 9 next: `git status --short`, then the commit.
