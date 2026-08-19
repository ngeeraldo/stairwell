# Personal Dashboard Pilot

Full rationale and build state: architecture-overview.md (read it before
architectural changes; do not relitigate decided items).

## Stack (decided — do not relitigate)
- Next.js App Router, full-stack, single service. No separate backend.
- Per-user encrypted SQLite via better-sqlite3-multiple-ciphers (SQLCipher).
- Plaid official Node SDK. Python = standalone dev scripts only, never a server.

## Data safety (hard rules)
- All dev and testing runs on synthetic data ONLY. Never open, read, or
  query any *.db other than synthetic.db.
- synthetic.db is regenerated from seed.py at session start — never edit it directly.
- All synthetic merchants/values are loudly fake ("COFFEE PALACE TEST")
  **wherever the shape has free text to carry the marker.** A seed producing
  only numbers and day keys is not asked for one and cannot supply one: a
  count or a `2026-08-18` cannot contain the word and still be the thing it
  is. `tests/users/conventions.test.ts` decides this per folder via its own
  `isFreeText`, and the rule the marker actually enforces is the fixture one
  under Testing below — `seed.py` is committed SOURCE, so a real person's
  merchant list pasted into one is outside .gitignore, the guard hook and
  Gate F alike, and that sweep is the only thing that would notice.
- Never log, commit, or write real user data, Plaid tokens, or secrets to
  code, fixtures, tests, or debug output.
- Derived keys exist only in the in-process TTL map — never serialized,
  persisted, logged, or written to the sessions table. Passwords and keys
  never appear in cookies, localStorage, URLs, or any persisted artifact.
- Real DBs exist only on the server. If a non-synthetic .db appears locally,
  stop and flag it. ONE known exception: fake-real.db in the repo root is a
  deliberate decoy holding no data, used to test the guard hook. Do not flag
  it, and do not open it — it stays denied like any other non-synthetic .db.
- **A laptop CAN produce one, and this file used to claim it could not.**
  `npm start` sets `NODE_ENV=production`, and `NODE_ENV` is the only switch
  `lib/db/userData.ts` has, so a local login under `npm start` takes the
  production branch and `lib/db/migrate.ts` creates
  `users/<slug>/<slug>.db` on the laptop. `migrate.ts` returning early
  outside production was meant to make that impossible; it closes the
  `npm run dev` path only. Build and review dashboards under **`npm run dev`**,
  and make a local account with the one command that cannot create a database:
  ```bash
  npx tsx scripts/create-local-account.ts <slug> <password>
  ```
  **Gate F** (`.githooks/pre-commit`) blocks any commit while a non-synthetic
  database exists under `users/`. It is a git hook and not a test because
  `deploy/deploy.sh` runs the suite on the droplet, where those files are
  legitimate — the droplet only ever pulls, so a commit hook is laptop-only by
  construction. It has no skip variable.
- The guard is .claude/hooks/deny-sensitive-files.sh, a PreToolUse hook that
  denies Read/Edit/Write on any database file (*.db, *.sqlite, *.sqlite3 and
  their -wal/-shm/-journal sidecars) that is not synthetic.db, and on .env
  files. A denial is the rule working, not a bug to route around.
- After any plugin update or hook change, run .claude/hooks/test-hooks.sh
  and confirm all pass.
- On any fresh clone of this repo, run ./setup.sh before doing anything else.
- `transcripts` and `metrics` gained columns in step 2 via `lib/db/reshape.ts`,
  which drops a stale-shaped table only after proving it holds zero rows and
  throws otherwise. It is the one place in `lib/db` allowed to drop a sacred
  table. Never widen that exception, and **never point `reshape.ts` at a user
  database** — its zero-rows proof is exactly the assumption that fails on a
  file holding a real person's history. `lib/db/migrate.ts` is the second
  schema-surgery site in `lib/db`; its exception is data-preserving surgery
  proven by a test that seeds the old shape, migrates, and asserts the rows
  survived.
- Prompt files are added, never edited — a new version is `agent-v3.md`, not
  an edit to `agent-v2.md`. `prompt_sha` is stamped on every transcript and
  spec row, so an edited file would silently change what an already-written
  hash points at. This is a data-safety property, not a style preference
  (unified-loop ledger D13).
  **Boundary, not a loosening: a prompt file may still be edited in place
  before the commit that INTRODUCES it reaches `main`.** The rule protects a
  `prompt_sha` some stored row already points at, and no such row can exist
  for a file that has never been on `main` — the droplet only ever pulls
  `main`, and nothing else stamps a hash. `agent-v6.md` was created and edited
  in the same unmerged branch for exactly this reason: created, then a wording
  fix landed in a later commit on that same branch, before either commit ever
  reached `main`. Once a branch merges, the file is exactly as pinned as any
  other — this boundary describes a window before that point, not a standing
  exception.

## Schema & module rules
- migrations + seed.py + tests/ update in the SAME commit. No drift.
- Shared module internals (e.g. plaid.sql) are NEVER forked per user.
  User-specific needs = views/derived tables in the user's own schema.
- Shared-module changes happen from repo root only, never inside /users/<name>/.
- Annotations on synced rows live in the user's own tables, keyed to the
  synced rows — never as edits to a shared-module table. This is the rule
  above applied to writes: it is what stops a login sync or a re-pull from
  trampling an annotation a user made in between.

## Dashboard folder conventions
- **Before building any `users/<slug>/` dashboard, read
  docs/dashboard-build-rules.md.** It indexes every rule governing a dashboard
  build — this section, the step-5 design, the step-6a and friend-timezone
  ledgers — with a citation on each line. It is an index, not a second copy:
  where it disagrees with a source, the source wins.
- **How a dashboard should LOOK is docs/dashboard-ui-ux-guidelines.md** — the
  default stack (shadcn on Tailwind, Recharts for charts), the fluid
  375–1200px container, the four non-happy panel states every panel owes,
  formatting, and the rule that animation responds to the user and never
  impersonates the system. Those are DEFAULTS: a friend's own UI request
  outranks them unless it needs an external fetch, restyles platform chrome,
  or cannot be built — and then it escalates to Nico rather than being
  quietly adjusted.
- A user dashboard lives entirely in `users/<slug>/`. Six entries are
  required; `tests/users/conventions.test.ts` sweeps every folder and fails
  if one is missing:
  - `migrations/` — `001_initial.sql`, `002_*.sql`, … plus `manifest.json`.
    The ONLY description of this dashboard's shape; there is no schema.sql.
    Added never edited, and the manifest's checksums are what enforce it.
    **A freshly scaffolded folder has NO migrations** — just a README saying
    what goes there — because a scaffold cannot know what shape a friend needs
    and a placeholder gets extended rather than replaced. That is the
    `scaffolded` state in `tests/users/conventions.test.ts`: the built-only
    checks skip until a `.sql` exists, and the dashboard says "Under
    construction" until then
  - `seed.py` — `python3 seed.py <target.db>`; **runs the migrations** in order
    and stamps `user_version`, so a synthetic database is built by the same
    files a real one is
  - `queries.ts` — every SQL statement, as pure functions taking a `UserDb`
  - `dashboard.tsx` — default-export server component, **no SQL**
  - `tests/` — at least one `*.test.ts`
  - `notes/` — `README.md`, plus `v<n>.md` for every version that was
    BUILT. **Added, never edited**, for the same reason prompts are:
    `scripts/announce-deploy.ts` speaks from this file, so an edit changes what
    an already-sent, permanently-stored announcement was based on. Four fixed
    sections; `lib/build/notes.ts` parses them and **two of the four never
    reach the friend** — `## Open` and `## Notes for the next build` are
    builder-only, enforced by the parser rather than by prompt wording.
    `tests/users/conventions.test.ts` checks the folder's SHAPE (no strays,
    every note parses) and deliberately not its presence: the sweep cannot know
    which versions were built. Presence is enforced by `announce-deploy.ts`,
    which refuses to announce v`n` without `notes/v<n>.md`.
- `users/<slug>/current.md` is required on every BUILT folder — not the six
  above, its own condition, since a scaffolded or pulled-but-unbuilt folder has
  no current shape to describe. `tests/users/conventions.test.ts` sweeps it
  the same way it sweeps `notes/`: it must exist, and its frontmatter
  `version` must equal the newest `notes/v<n>.md` (`0` when there are none).
  It is the ONLY artifact under `users/<slug>/` that the RUNNING APP puts in
  front of a model — `app/api/chat/route.ts` reads it, `lib/chat/turn.ts`'s
  `CURRENT_STATE_BLOCK` labels and appends its body to the system prompt, and
  `platform/prompts/agent-v6.md` is what tells the agent to trust it over the
  spec. "The running app" is doing the work in that sentence: `notes/v<n>.md`
  reaches a model too, just not from the app — `scripts/announce-deploy.ts`
  feeds it to `draftAnnouncement` when drafting an announcement. That is an
  operator script run by hand, not a request path a friend's session ever
  triggers, which is the distinction this bullet is naming.
  **Overwritten every build**, unlike `notes/` and unlike a prompt version:
  those are pinned because something permanent already points at them — an
  announcement, a `prompt_sha` on a stored row — and editing one would change
  what that permanent thing was based on. Nothing permanent points at
  `current.md`. Replacing it is instead what keeps it USABLE: an agent that
  has to replay a changelog to work out what currently exists is back to
  guessing, which is the exact failure this file exists to remove.
  Five level-2 sections, in order, parser-enforced by
  `lib/build/currentState.ts` (`## What this is for`, `## Screens`,
  `## Panels`, `## What can be entered`, `## Deliberately not included`) — an
  unknown, misspelled, duplicated or missing heading throws.
  `## Deliberately not included` is the only place a refusal survives;
  leaving it empty is how the agent proposes the same declined thing again
  next month.
  Same no-user-values bound as `notes/`: describe shape, never a row, a
  value, or a merchant. `version: 0` means "predates the spec loop" —
  `devone` and `devtwo` are hand-written and never had a spec version.
- `spec.md` is written by `./scripts/pull-spec.sh <slug>` and is absent until
  an account has any spec at all. `synthetic.db` is generated and gitignored.
  `<slug>.db` arrived in step 6a and is described next.
- A spec **version** is whole-surface — it describes the user's entire
  dashboard, not just one conversation's worth of changes. `specs.payload`
  (platform database) holds it; `version` is derived from row position, never
  stored, so it can neither drift nor race; `based_on_version` is supplied by
  the server from the account's current version, never authored by the
  model — a model-authored lineage pointer would be a hallucination becoming
  a permanent row in an append-only table. **Nothing confirms a version any
  more.** The newest spec row IS the build contract the moment `propose_spec`
  writes it (`lib/db/specs.ts`'s `currentSpec`) — there is no card, no button,
  and no separate confirmation event on the write path.
  The MODEL is asked only for the change: against a current-shape base it
  emits a PATCH (`lib/spec/patch.ts`, eight ops — `set_meta`, `add_screen`,
  `update_screen`, `remove_screen`, `add_panel`, `replace_panel`,
  `move_panel`, `remove_panel`) and `lib/spec/author.ts` applies it via
  `applyPatch`, so an untouched panel is COPIED rather than regenerated. The
  stored row is still the whole surface — `applyPatch` produces it and hands
  it to `parseSpecDraft`, the same validator every version goes through — and
  the ops ride flat inside `payload` beside it as `SpecVersion.ops`, `null`
  when a version was authored whole-surface, **never `[]`**. A row stored
  before `ops` existed has no `ops` key at all; `parseSpecVersion` reads that
  the same as null, since `specs` rejects UPDATE and none can ever gain one.
  Three paths author, not two: `patch` against a current-shape base; `whole`
  for a first version, which has no base to patch; `whole` for a legacy base,
  which carries no ids for an op to name and can never gain any.
- `specs.mockup_html` is written as `''` on every row now — `insertSpec` still
  fills a NOT NULL column, but nothing composes or serves mockup HTML any
  more (mockup-loop removal). `spec_screen_mockups` and `spec_confirmations`
  are still append-only tables and still hold every row they ever held — real
  history an append-only table may never prune — but the application no
  longer writes to either: the confirmation button that wrote
  `spec_confirmations` is gone, and the per-screen mockup call that wrote
  `spec_screen_mockups` is gone with it.
- **The mockup CSP guard is gone, because the thing it guarded is gone — not
  because the promise it made got weaker.** It existed because mockup HTML
  was generated from interview content and rendered to a friend as `srcDoc`;
  any external fetch inside it would have been a channel leaking
  transcript-derived content to a third party. Nothing renders
  model-generated HTML to a person any more, so there is no surface left for
  that guarantee to travel with.
- `specs` rejects UPDATE, so a row written before the unified proposal loop
  can never be rewritten into the current shape — it is read as legacy
  forever. Read every stored spec payload through `lib/spec/stored.ts`, the
  one place that discriminates a legacy row from a current-shape version;
  every consumer handles both arms.
- Two databases per user, and the difference is load-bearing:
  - `synthetic.db` — loudly fake, regenerated by every deploy, shown under a
    **SYNTHETIC DATA** banner. Safe to read locally.
  - `<slug>.db` — the user's real data, SQLCipher-encrypted with a random data
    key held only in the in-process keymap. The password derives a
    KEY-ENCRYPTING key that unwraps it (`lib/auth/envelope.ts`), and the
    wrapped copy lives in `account_keys`. **Accounts created before that —
    devone, devtwo, nico — have no row there and derive the database key
    DIRECTLY, forever. Never backfill:** a legacy account's wrapped key cannot
    be computed without their password, and inventing one locks a real person
    out of real data (onboarding ledger D2).
    Created at REGISTRATION, empty, and **atomically** — built under a temp
    name and linked into place, so it never exists half-made. (It was created
    lazily on first write until the onboarding build; the spec requires the
    file to exist the moment the password does, since a consumed invite with
    no database is an invalid state.) Never regenerated, never committed,
    never readable without that session's key — including by you.
    **`lib/db/migrate.ts` migrates it, and nothing else does** — at unlock,
    which is the only moment the key exists. Read
    `docs/superpowers/specs/2026-08-15-user-db-migrations-design.md` before
    changing any migration, and never edit one that has been applied (D2).
- **There is no real-vs-synthetic fallback.** Production always serves the
  friend's own encrypted database, empty or not; dev always serves
  `synthetic.db`, for reads AND writes, so an entry widget is testable end to
  end. `lib/db/userData.ts` is the one place that decides and its only input is
  `NODE_ENV` — a variable that could switch production onto synthetic data
  would rebuild the `PLATFORM_DB` failure `deploy/required-env` blocks a deploy
  over. The banner follows the world, not the friend's row count, and is
  bordered, tinted chrome rather than a line of text, because unstyled it read
  as one more row of the dashboard.
- **An empty database is an ordinary state and every dashboard must render
  one.** A friend's first session shows their own database with nothing in it.
  The scaffold ships an empty-render test and `screenshots/screens.ts` carries
  an empty-state screen, because a test can only prove it does not throw —
  whether it reads as "waiting" or as "broken" is a question only a picture
  answers. For a friend's OWN dashboard, that picture comes from
  ```bash
  npm run synthetic -- --empty   # shape, no rows; `npm run synthetic` restores
  ```
  which rebuilds every `users/*/synthetic.db` from its migrations alone.
  `screenshots/screens.ts`'s empty-state screen covers the platform chrome
  around a dashboard and is pinned to devtwo, so it cannot answer this for a
  dashboard you are building. **A day before the friend started is not a day
  they failed:** the first version of this rendered fourteen rows saying
  "missed" on a friend's first morning, with every test green.
- **Metrics never carry user values.** `dashboard_write` records a slug and a
  panel and nothing else — no day, no count, no payload. This is permanent
  policy for every panel type, and it is what makes the login page's promise
  ("I can see when you use it … but not what you log") true. Spec-version
  diffs are held to the same bound: a diff metric row carries counts
  (`screens_added`, `panels_changed`, …) and nothing else — not a panel's
  title, description or display text, and not its stable id either. An id
  like `divorce_lawyer_fund` is derived from what the friend asked for, which
  is why `lib/spec/author.ts` strips quoted ids out of `spec_error` messages
  too. The content of what changed stays in `specs`, never in `metrics`.
  The same bound covers patch authoring: every metric row the authoring path
  writes — `spec_proposed` and every `spec_error`/`spec_aborted` row too, not
  `spec_proposed` alone — carries `authoring_mode` (`patch`, `whole`, or
  `null` for a call that failed before a mode was chosen) and `ops_count`
  (the parsed op count; `null` on every whole-surface row, and on a patch
  attempt whose ops never parsed). A mode name and a count, never an op and
  never a panel id.
  `dashboard_open` follows the same bound: it carries `screen_order`, the
  active screen's integer position, and never the screen's `id` — a
  spec-authored identifier under the same slug rule as a panel id. See the
  "`dashboard_open` writes one row per render" bullet below, further down
  this section, for the full mechanism.
- **Build notes never carry user values either.** `users/<slug>/notes/v<n>.md`
  is committed to the repo and describes the SHAPE of what was built — a table,
  a panel, a computation — never a row, a value, or a merchant. Same bound as
  `metrics`, applied to a second artifact.
- A dashboard renders only if it is registered in `lib/dashboard/registry.ts`.
  One line: `<slug>: () => import('@/users/<slug>/dashboard'),`. A folder with
  no registry line fails `tests/dashboard/registry.test.ts`.
- Scaffold a new one — do not copy by hand:
  ```bash
  ./scripts/new-dashboard.sh <slug>   # creates the folder, prints the registry line
  npm run synthetic                   # regenerates every users/*/synthetic.db
  npx vitest run users/<slug>
  ```
- `users/devone/` is the worked reference implementation. It is hand-written,
  not agent output — see its README.
- A dashboard is handed `{ slug, db, today, timeZone, screen }` and never
  resolves any of them itself — `screen` is described below. **It never
  derives a day from a clock.** `today` is
  `YYYY-MM-DD` in the friend's zone, resolved once per request by
  `app/[user]/page.tsx` from the `stairwell_tz` cookie the root layout writes;
  `timeZone` is the IANA name, or `undefined` on the first render of a session,
  which `dayKey` degrades to UTC. This is a data-safety-shaped rule rather than
  a style preference: the day is a primary key in a database with no migration
  story, so a read and a write that disagree about the calendar write a row
  that is wrong forever. It has happened once already — see the
  friend-timezone ledger.
  `tests/users/noLocalDay.test.ts` sweeps every `users/*/dashboard.tsx` and
  `users/*/queries.ts`, plus the scaffold templates, and forbids `Date.now()`,
  zero-argument `new Date()`, and importing `lib/time/dayKey` in a
  `dashboard.tsx`. A `queries.ts` MAY import `dayKey` and run it over a STORED
  instant — converting a stored timestamp to the friend's day is legitimate and
  every finance dashboard does it (`users/devone/queries.ts`); asking a clock
  what day it is never is. It
  gets a read-only handle, so it cannot write — on BOTH paths, and
  `openUserDataForRead` is the one call that resolves which. Pinned at BOTH
  ends, because they fail independently: a test that makes the handle refuse a
  real INSERT, and a test that the page still goes through that resolver.
  Dropping it at the call site once left the whole suite green. **A render
  never changes a shape.** **Exactly TWO things write to a user's real
  database, and they are enumerated:** `lib/db/migrate.ts`, which creates it
  and changes its shape — at unlock, having taken a copy first — and a platform
  route, which writes rows into the shape it finds. A third is a change to the
  2026-08-15 migrations design, not a refactor. Every write goes through a
  platform route, which is the only place the four ordered checks live.
- **A screen is a place in the app, and the platform draws the tab strip —
  never the dashboard.** `DashboardModule.screens: DashboardScreen[]`
  (`lib/dashboard/contract.ts`) is REQUIRED on every dashboard registered in
  `lib/dashboard/registry.ts`; `DashboardScreen`'s `id`/`title`/`order` mirror
  `lib/spec/schema.ts`'s `Screen` exactly — never a second source that could
  drift from what the spec promised. `DashboardProps.screen` stays OPTIONAL —
  not for the sequencing reason that made it optional to begin with (no
  dashboard exported `screens` yet), which is gone now that all four do, but
  because every one of the four dashboards on this branch has exactly one
  screen and none of them branches on it, and every one of their own tests
  calls the component with a hand-built props object that would otherwise
  need to name a field it never reads for no type-safety gain. `?screen=` is
  resolved against a dashboard's own declared list by `activeScreen`
  (`lib/dashboard/contract.ts`) BEFORE a dashboard ever sees it: an unknown or
  absent value falls back to the lowest-`order` screen rather than erroring —
  it is ordinary user input (typed, bookmarked, a stale link from a dashboard
  that dropped a tab) — while a REGISTERED dashboard declaring zero screens is
  a contract violation instead, and throws, caught by the same
  `dashboard_error` path that already catches a throwing `Dashboard()` call.

  **Why the platform owns the tabs — the single rule to know before writing a
  second screen.** `app/[user]/page.tsx` CALLS the dashboard (`Dashboard(...)`),
  never returns it as `<Dashboard />`, specifically so its body runs inside
  the page's own `try`/`catch`. A nested function component — a dashboard
  returning `<Foo />` where `Foo` is itself a function component — has its
  body deferred to React's OWN render pass, which runs after the calling
  function has already returned and is therefore OUTSIDE that catch: a throw
  there 500s the page AFTER the `dashboard_open` metric row has already been
  written. Tabs drawn by the dashboard itself would be exactly that shape, so
  `tabStrip` lives in `app/[user]/page.tsx` instead — plain server-rendered
  `<a href="?screen=...">` anchors on a search param, no client component, no
  route segment, no middleware — reading the dashboard's own `screens` export
  and drawing nothing at all for one screen (or fewer): a single tab is
  chrome that explains nothing.
- **`dashboard_open` writes one row per render, every render, with NO
  write-path dedup** — a tab switch re-runs the page and writes another row,
  by design. "An open" is a definition applied when the log is READ (e.g. the
  first render in a window), never decided at write time. It carries
  `screen_order` — the active screen's integer `order`, omitted entirely (not
  `0`) when a dashboard has not declared `screens` yet, since there is no tab
  to name a position for — and never the screen's `id`: an `id` is
  spec-authored, following the same underscore-slug rule as a panel `id`
  (this section's own `divorce_lawyer_fund` example, above), and writing one into
  `metrics` would be the first friend-derived identifier ever written to that
  unencrypted table, which the metrics bound above ("Metrics never carry user
  values") forbids.
- **Nothing writes to a friend's database except from their own session.**
  Their data key exists only in the in-process keymap while they are unlocked,
  so no scheduled job can open their database at all — the same constraint that
  makes migrations run at unlock or not at all. V1 therefore has exactly two
  triggers: **a control the friend presses, and a one-time action at login.**
  This bounds the friend's database only; the platform database is unencrypted,
  so scheduled work against it (caching a public forecast, say) is a separate
  question and is not foreclosed here. **Login-triggered work never refuses the
  session** — that is reserved for `lib/db/migrate.ts`, where serving a
  half-migrated shape is worse than not serving. A sync whose upstream is down
  must still let the friend in. Say the consequence out loud rather than
  rediscover it: nothing can reach a friend who is not in the app, so no alert
  or notification may be promised to one. A background Plaid sync in step 6b
  would need the access token readable without them, which is an amendment to
  this rule, not an exception to it.
- A dashboard may **render** an entry widget — a form for hand-logging or
  annotating data — but the widget POSTs to a platform route, same as the
  walk route above. The read-only-handle rule above is unchanged and
  unweakened by this: no dashboard component ever holds a writable handle,
  only a route does. Annotating synced data follows the shared-module
  annotations rule (Schema & module rules): the user's own tables, never
  edits to a shared-module table.
- Per-user `tests/` should cover write paths (inserts, annotation joins) when
  the dashboard has one, not just rendering — `users/devtwo/tests/write.test.ts`
  is the worked example, and `platform/templates/dashboard/tests/dashboard.test.ts.tmpl`
  carries a commented stub for a scaffolded one. This is a convention and a
  scaffold, not a sweep gate: `tests/users/conventions.test.ts` cannot tell
  whether a given dashboard *has* a write path — that lives in a platform
  route and a spec version, neither of which is a file in the user's folder —
  so demanding a write test of a read-only dashboard would be a false failure.
- Everything a dashboard shows in DEV is synthetic, and
  the page says so with the banner on every synthetic render. Real per-user
  data arrived in step 6a; Plaid-sourced data is step 6b.

## Onboarding
- The end-to-end operator process — invite, spec import, build, deploy,
  announce — is docs/runbook.md. It runs as one of two flows: **A** for a friend
  who has never had a dashboard, **B** for a new spec version of one that
  exists. It is Nico's, run by hand; nothing in it is automated, and several
  steps are deliberately not.
- **Dashboard work happens on a `<slug>/v<n>` branch, one per spec version,
  never on `main`** — main is the line `deploy.sh` pulls, so a
  half-built dashboard there blocks every unrelated fix. Nico creates the branch
  and runs anything that scaffolds a folder; check `git branch --show-current`
  before writing code and stop if it says `main`. Never create a branch named
  `<slug>` alone: git stores it as a file under `refs/heads/`, which makes
  `<slug>/v2` permanently impossible.
- A friend arrives through an invite: `npx tsx scripts/create-invite.ts <slug>`
  prints ONE line, the link to text them. **The token is never stored — only
  its SHA-256** — so a lost link is re-minted, not recovered. Revoke an unused
  one with `scripts/revoke-invite.ts <slug>`. There is no expiry, by design.
- **No password reset path may exist anywhere, including "temporarily for
  dev."** Not a route, not a script, not an admin action. The password is the
  key; there is nothing to reset to. `/forgot` says so and offers no form, and
  `tests/routing/forgotPage.test.tsx` fails if one appears.
- The three copy blocks a friend reads — the privacy promise, the password
  warning, the placeholder card — are **build contracts** living in
  `lib/copy/onboarding.ts` and pinned sentence by sentence in
  `tests/copy/onboarding.test.ts`. The promise block renders on two surfaces
  from one constant, because two copies of a promise are two things that can
  drift apart.
- `components/ui/*` is **vendored shadcn source**: written by
  `npx shadcn@latest add`, never hand-edited, and Gate-B exempt for the same
  reason `platform/prompts/*` is. Anything we write ourselves goes in
  `lib/ui/` or beside the page that uses it.
- **Every screen is reviewed as a picture before its task is committed.**
  `npm run shots -- --task=<n>` boots the app against its own synthetic
  database and captures every live screen at 375 and 1440;
  `screenshots/screens.ts` says what each one has to look like. It is a review
  gate, not a test — no pixel diffing — and it has caught things no test in
  this repo can see (onboarding ledger D16).
- **A build that could not deliver something goes back to the chat, never into
  the announcement.** The announcement is an update, not a disclosure: what
  shipped, and any in-spirit adjustment that makes it work better. Anything in
  the spec that did NOT land goes in `## Open`, which the friend
  never sees, and routes back through `scripts/ask-user.ts` or a new proposal.
  `announce-deploy.ts` warns when that section is non-empty.

## Build contract
- `spec.md` in the user's folder, the conversation it was pulled from,
  `current.md`, and the code are the build contract for **user dashboards**
  (`users/<name>/`, `app/[user]/`). There is no mockup — nothing composes or
  serves mockup HTML any more (mockup-loop removal), and `mockup.html` is
  gone from every folder. Feasibility doubts → flag to Nico, don't guess.
- **Platform auth pages** (`app/(auth)/login`, `app/(auth)/unlock`, `app/admin`)
  are NOT covered by `spec.md` either. Their contract is the step-1a design
  doc, docs/superpowers/specs/2026-08-10-step1-auth-and-test-gate-design.md
  (§3 owns this layout). Absence of a spec is not a reason to leave an
  auth-page gap unfixed — check the design doc instead.
- Deploys go out through deploy/deploy.sh only — never by editing files on
  the droplet. Tests gate the restart, and deploy/smoke.sh gates success:
  **a deploy that starts the process but does not serve correctly is a failed
  deploy.** `systemctl is-active` is true the moment systemd forks npm, so it
  cannot tell "serving" from "started". The smoke check polls for a real 200 and
  asserts the redirect shape at both layers. It has no skip variable by design —
  retarget it with an origin argument (`deploy/smoke.sh http://localhost:3000`)
  if DNS is not up yet, but do not add a way to switch it off.
- Every environment variable the deployed service needs is listed by NAME in
  `deploy/required-env`, with a severity. `deploy/deploy.sh` aborts before
  `npm ci` if a `REQUIRED` one is missing from the droplet's `.env`;
  `instrumentation.ts` records an `env_missing` metric at startup but never
  throws. Values live only in `.env` files, which the guard hook denies
  reading. Adding a variable means adding it to that list — including
  variables read by dependencies rather than by our own code.
- **A dependency is judged by what it touches, not by how many friends want
  it.** At pilot scale one friend's panel justifies a repo-wide package: Next
  code-splits per route and `lib/dashboard/registry.ts` loads each dashboard
  through a dynamic `import()`, so a charting library only one friend's
  dashboard imports ships in that dashboard's own chunk and nobody else's page
  carries it — true of whichever folder does the importing, so the point does
  not depend on naming one. Three charting libraries across four friends is an
  accepted outcome, not drift.
  **Render-only** (charts, formatting, display) — add it.
  **Server-touching** (reads env, the filesystem, or the network) — prefer
  writing the call ourselves; every dependency runs in the same process as the
  keymap holding every unlocked friend's database key, which is as true at two
  users as at fifty, so scale is not the argument there.
  **Brings its own environment variable** — that is a `deploy/required-env`
  decision before it is a package decision, per the bullet above.
  The cost that *does* scale is `npm ci` and Gate D's `next build` on every
  push, paid by everyone; revisit when a push starts feeling slow.
- The app runs behind a reverse proxy, so `request.url` is NOT the URL the
  browser asked for. Redirects use lib/http/redirect.ts: host-relative in route
  handlers, absolute in middleware (Next rejects a relative Location there).
  Never reintroduce `new URL(path, request.url)` — it names the internal origin
  and every local check passes anyway.

## Testing
- Changes to data logic (queries, panels, derived tables) require test
  changes in the same commit. Pure styling/copy changes do not.
- Tests run against a fresh synthetic.db and must pass before deploy.
- Run tests with `npx vitest run`. Scope a run with a path:
  `npx vitest run users/nico`, `npx vitest run tests`.
- The pre-commit gate enforces the first rule by scope:
  - `app/`, `lib/`, `platform/`, `middleware.ts` → a test under `tests/`
  - `modules/` → a test under `modules/tests/`
  - `users/<name>/` → a test under `users/<name>/tests/`
  - `.githooks/`, `.claude/hooks/` → `.claude/hooks/test-hooks.sh`
- Docs, styling, and config are exempt by path. Migrations and the seed
  generators are governed by the anti-drift rule instead.
- A commit is also blocked while a non-synthetic database sits under `users/`
  (**Gate F**, see Data safety above). Unlike the gates below it has no skip:
  a data-safety invariant has no legitimate local exception, and the block
  message hands you the `rm` that fixes it.
- `SKIP_TEST_GATE=1 git commit` skips the coverage gate only, and prints the
  untested files. When Claude uses the skip, it states the reason in the
  commit message.
- A commit staging any `.ts`/`.tsx` file also runs a typecheck gate
  (`npx tsc --noEmit`) and blocks on a compiler error, printing the
  compiler's own message. vitest transpiles through esbuild and does not
  catch type errors, so this gate is the only thing that actually runs the
  compiler. It checks the working tree, not the staged content, so a
  partially-staged file is typechecked against unstaged edits too — a known,
  accepted limitation. `SKIP_TYPECHECK=1 git commit` skips it only, and only
  announces the skip when a TypeScript file was actually staged. When Claude
  uses the skip, it states the reason in the commit message.
- A pre-push gate runs `npx vitest run` (Gate E) and then `npx next build`
  (Gate D) on every push, unconditionally — a break in either can originate
  anywhere (a config edit, a dependency bump, an innocent-looking import), so
  there is no fast path. `tsc --noEmit` clean does not mean the build
  succeeds: a middleware.ts import that pulled in `node:crypto` via
  lib/session/store.ts broke `next build` for two full tasks while the suite
  stayed green and Gate C stayed clean — Gate D exists because "tsc clean"
  does not mean "builds". Gate B (pre-commit) only checks that a guarded
  change staged some file under `tests/`, not that the suite passes — Gate E
  exists because "a test file is staged" does not mean "the tests pass".
  Gate E runs first (fail fast on the cheap check before paying for the
  ~1-minute build). `SKIP_TEST_RUN_GATE=1 git push` skips Gate E only,
  `SKIP_BUILD_GATE=1 git push` skips Gate D only, each only announcing the
  skip when it actually would have blocked. When Claude uses either skip, it
  states the reason in the commit message.
- `platform/prompts/*` is runtime prose, not documentation and not logic. It
  is exempt from Gate B by an explicit arm in `.githooks/pre-commit`. Test the
  loader and the `prompt_sha` stamping, never the wording.
- **Every third-party client is injected, and no test in the default suite
  reaches the network.** `lib/chat/turn.ts` takes its Anthropic client as a
  parameter; `lib/alerts/ntfy.ts` takes `fetch`. A test that needs a real key is
  a test that is wrong. Integrations live in `modules/` or `lib/`, never in
  `users/<slug>/` — a dashboard never knows a network exists.
- **Live shape tests are opt-in.** None exist yet; the first one adds the
  `*.live.test.ts` exclusion to `vitest.config.ts` and the `test:live` script
  together. They never run in Gate E or a deploy — an upstream outage must not
  block shipping. They assert shape, never values, and share their assertion
  with the fixture test, so a fixture that has drifted from reality is caught
  instead of quietly becoming fiction. Absent a key they skip and are listed, so
  a fresh clone is never red.
- **A fixture is never recorded from a real person's data** — a zip's forecast
  is public and about a place; a friend's transactions are not.

## Local dev
- Running the app, the dev account credentials, and how to reset the local
  database: docs/local-dev.md. The admin password is never recorded in the
  repo — it comes from ADMIN_PASSWORD at seed time.

## Ledgers
- Before working on a file, check docs/superpowers/ledgers/ for residual risks
  touching it. Rulings made during fix rounds become tasks, not log entries.

## Sacred data
- Metrics log and chat transcripts are append-only. Never migrate, rewrite,
  or "clean up" these files.
- `spec_screen_mockups` (platform database) is append-only too, same trigger
  pair as `specs`. It holds one row per `(spec_id, screen_id)` — the
  per-screen mockup fragment a version's screen was drawn with, back when a
  version's screen was drawn at all. `lib/db/screenMockups.ts` still appends
  and reads; nothing composes fragments into a document any more —
  `lib/spec/mockupCompose.ts`, the one file that did, is deleted along with
  every route that served its output (mockup-loop removal). The table stays
  exactly as it is: real rows written while the mockup loop ran, and an
  append-only table forgets nothing on purpose.
- **TWO metric events are load-bearing for correctness rather than purely
  observational, and neither is disposable telemetry.**
  - `deploy_announced` — `announceTarget` (`lib/chat/announce.ts`, called from
    `runAnnounce` in `scripts/announce-deploy.ts`) reads it to decide whether
    it has already spoken for a spec version, so pruning or archiving one
    makes a weeks-old build announce itself again into an append-only
    transcript (unified-loop ledger D16).
  - `first_session_start` — `app/[user]/page.tsx` reads it to decide whether
    this account has ever reached the shell before. Pruning one makes a
    months-old account report a first session again, and nothing afterwards
    can tell which rows were real (onboarding ledger D8).
  
  Both are safe from the application — `metrics` rejects UPDATE and DELETE at
  the database — so the hazard is a human one: someone tidying rows that look
  like telemetry and are not.