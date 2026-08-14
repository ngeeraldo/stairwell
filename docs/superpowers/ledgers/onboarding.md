# Onboarding & invite flow — decisions ledger

Spec: `onboarding-ux-spec.md` (repo root, approved 2026-08-13)
Plan: `docs/superpowers/plans/2026-08-13-onboarding-and-invite-flow.md`
Branch: `onboarding-invite-flow`, cut from `checkpoint-records`.

Opened **before** the build, in the shape the unified-loop ledger established:
the rulings the plan depends on are written down first, "Built" and "Residual
risks" after it lands. Every ruling below is a place where the spec and the
code as it stands could not both be right, or where the spec named a mechanism
this codebase does not have.

---

## §0 — What the spec assumed that the code does not have

Three assumptions in the handoff are false against this repo, and each one is
load-bearing enough that building past it silently would have produced a wrong
thing rather than a rough one.

### A1. There is no CSS anywhere in `app/`

The spec's design-direction section rules "shadcn/ui components on Tailwind."
This repo has **no stylesheet, no Tailwind, no PostCSS, and six runtime
dependencies**. The step-6a ledger (residual 7/9) records the absence as a
deliberate deferral — "there is no CSS anywhere in `app/`" — not an oversight.
So this is not a restyle; it is the introduction of a styling layer. See D1.

### A2. The key is derived from the password directly — nothing is wrapped

`lib/auth/password.ts:52` derives the SQLCipher key from the password with a
second Argon2 pass and a second salt. There is no data key and nothing wraps
anything. The spec's S2 ("derive KDF key → generate random data key → wrap")
and its non-goal ("envelope encryption supports it; UI comes later") both
describe a mechanism that does not exist yet. See D2.

### A3. The encrypted database is created lazily, on first write, from a
`schema.sql` that lives in the user's dashboard folder

`openEncryptedUserDb` builds the file by exec'ing `users/<slug>/schema.sql`
(`lib/db/encryptedUserDb.ts:124`). A brand-new invited friend has **no
`users/<slug>/` folder at all** — the folder is created by
`./scripts/new-dashboard.sh` when Nico builds their dashboard, days later. So
"create `<name>.db` (SQLCipher, empty schema per current conventions)" at
password-set time cannot mean what it says: there is no schema to apply, and
the file's existence is the flag the render path reads to decide whether the
friend has real data. See D3.

---

## Rulings

### D1. Literal shadcn/ui, per the spec — **Nico's ruling, at plan approval**

The plan first proposed adopting the shadcn *look* (its CSS-variable theme,
its class strings, `cn()`) over native elements — `<dialog>`, `<details>`,
`<input type=checkbox>`, routes-as-tabs — to avoid the Radix dependency tail,
citing unified-loop D5's precedent about zod.

**Overturned. Build literal shadcn/ui.** The spec's design direction is not a
description of a look to be reproduced, it is a strategy statement — *"the
stock look **is** the credible-product look, and Claude Code produces it
fluently with no design supervision"* — and reproducing it by hand
reintroduces exactly the design supervision the ruling exists to remove.

So: `npx shadcn@latest init`, `npx shadcn@latest add …`, defaults barely
touched. **The complete list of new dependencies, and nothing outside it:**

| Package | Kind | Why |
|---|---|---|
| `tailwindcss`, `@tailwindcss/postcss`, `postcss` | build | The styling layer itself |
| `clsx`, `tailwind-merge`, `class-variance-authority` | runtime | shadcn's `cn()` and its variant helper — written by the CLI |
| `@radix-ui/react-dialog` | runtime | Full-screen mockup modal |
| `@radix-ui/react-tabs` | runtime | Admin Transcript / Spec / Mockup |
| `@radix-ui/react-checkbox`, `@radix-ui/react-label` | runtime | S2 |
| `@radix-ui/react-collapsible` | runtime | The card's "Details" disclosure |
| `lucide-react` | runtime | The dialog's close X, and nothing else |
| `react-markdown`, `remark-gfm` | runtime | The admin Spec tab (granted at plan approval; renders the spec payload as real markdown rather than preformatted text). Raw HTML stays disabled, which matters because a spec payload is model-authored |
| `jsdom`, `@playwright/test` | test | See D9 and D16 |

**Two costs this ruling accepts, named so they are not rediscovered as
surprises:**

1. ~~**Radix needs jsdom shims.**~~ **Wrong — disproved during Task 2, and
   recorded rather than quietly deleted.** The claim was that
   `ResizeObserver`, `DOMRect`, `matchMedia`, the pointer-capture trio and
   `scrollIntoView` would have to be stubbed because Radix touches them.
   jsdom 29 really is missing all of them (probed directly), but Dialog, Tabs,
   Checkbox and Collapsible were each rendered *and clicked* with no stubs
   installed and none threw. `installDomShims()` is now one line — React 19's
   `IS_REACT_ACT_ENVIRONMENT`, which IS load-bearing and whose absence React
   warns about on stderr. A stub added later must arrive with the test that
   goes red without it.
2. **The components are vendored source, not a versioned dependency.**
   `components/ui/*` is third-party code living in this repo, closest in kind
   to `platform/prompts/*` — which `.githooks/pre-commit` already exempts from
   Gate B by an explicit arm. It gets the same treatment, and anything else
   under `components/` stays guarded.

**What the CLI actually installed, against the table above.** Recorded because
the plan said to stop and check rather than accept a surprise:

- **`radix-ui@1.6.7`, one package, not six `@radix-ui/react-*`.** Same vendor,
  newer packaging. Accepted.
- **`shadcn` itself is a runtime dependency**, and correctly so: the generated
  `app/globals.css` does `@import "shadcn/tailwind.css"`, which resolves from
  `node_modules` at build time. Left where the CLI put it — `dependencies` is
  the position that survives someone adding `--omit=dev` to the deploy.
- **`tw-animate-css`**, imported by the generated `globals.css`. CSS only.
- **The CLI's default primitive layer is now Base UI, not Radix.** Pinned to
  Radix with `--base radix` because Radix is what this ledger enumerated and
  approved. `--preset nova`, `baseColor: neutral`.
- **`--defaults` would have wired next/font's Geist.** Removed — see D1a.

### D1a. The shadcn theme is kept; FOUR things are set, each named by the spec

"Defaults barely touched" is taken literally: `init` writes its own
`app/globals.css` token block and it is kept as written, with these edits and
no others. The ruling said TWO when it was written; it ended at four, and the
two additions are recorded here rather than absorbed silently — each is a
sentence in the spec, not a preference.

- **The `.dark` block and its `@custom-variant` are deleted**, and
  `color-scheme: light` is pinned. The spec: "Light mode only. No dark mode,
  no theme toggle." Leaving them in would make the whole product follow the
  reader's OS setting, which is a design decision nobody made.
- **`--primary` is stock Tailwind blue** (blue-600). The neutral base gives a
  near-black primary; the spec rules "Neutral palette + one accent: blue …
  everything else stays gray-scale." Destructive contexts (S2's warning block,
  S5) keep shadcn's own `destructive` treatment and never take the accent.
- **`--background` is slightly tinted** where the CLI wrote pure white, so a
  card reads as a card. Added after the first screenshot review: the spec says
  "cards with subtle border + shadow on a slightly-tinted background", and
  white-on-white left the login card as "bare content floating in an empty
  viewport" — the thing Viewport rules forbid in so many words.
- **`--font-sans` is the system stack.** The preset wires next/font's Geist;
  the spec says "Inter or the system-ui stack. One family." No font is
  fetched or self-hosted at all — a font request is a third-party request on a
  page that makes a privacy promise, and a self-hosted one is still bytes for
  a typeface the spec did not ask for.

A FIFTH edit is a design decision and belongs to the taste memo. In
particular `--ring` stays neutral: a blue focus ring would be defensible and is
exactly the kind of call this build did not make on its own.

### D2. Envelope encryption ships, in a **table**, with a legacy arm

The spec is explicit that the password unwraps a data key, and one of its
non-goals is written as a promise that the capability exists ("envelope
encryption supports it"). Building the invite flow without it would mean
writing every friend's first real byte under a key that can never be changed
without re-encrypting the file.

**Ruling: build it. New accounts get a wrapped data key; existing accounts
keep direct derivation, forever.**

- The wrapped key lives in a **new `account_keys` table**, not a new column on
  `accounts`. A column would need an additive `ALTER TABLE` on a database that
  already has rows in production — a migration mechanism this repo does not
  have, and `lib/db/reshape.ts` is not it and must not be widened (CLAUDE.md).
  A new table is `CREATE TABLE IF NOT EXISTS` and needs no mechanism at all.
- **Absence of a row is the legacy arm**, exactly the way `spec_confirmations`
  makes confirmation a second append rather than a status column. `devone`,
  `devtwo` and `nico` have no row, so their key is still
  `argon2(password, salt_key)` and `devtwo`'s existing real database keeps
  opening. The spec's own "`devtwo` is grandfathered; do not migrate" is
  satisfied by construction rather than by remembering.
- Wrap is AES-256-GCM from `node:crypto` (no dependency), KEK =
  `argon2(password, salt_key)` — i.e. today's `deriveDbKey`, which stops being
  the database key and becomes the key-encrypting key. Nothing about the
  keymap changes: it holds 32 bytes that open the file, and only the
  provenance of those bytes differs.

**What this does NOT buy yet:** a password-change UI is still out of scope
(the spec's non-goal). What it buys is that changing a password later is a
re-wrap of 32 bytes instead of a re-encryption of a friend's whole history.

### D3. The database is created at S2, empty, and **"has real data" stops
meaning "the file exists"**

The spec's constraint is unambiguous and correct: *"Token consumption and DB
creation are atomic; a consumed token with no DB is an invalid state."* So the
file is created at password-set time.

Three consequences, all of which have to be ruled together or the friend lands
on a broken screen:

1. **`createEmptyEncryptedUserDb`** — a keyed, WAL, `foreign_keys=ON`
   database with **no tables**, built under a temp name and `link()`ed into
   place by the same code path step 6a already hardened. It writes
   `PRAGMA user_version = 1` so the file is a real, non-empty, encrypted
   SQLite file rather than a zero-byte placeholder that would open under any
   key at all. `users/<slug>/` is `mkdir -p`'d first, because for an invited
   friend nothing else has ever created it.
2. **`openEncryptedUserDb`'s writable path tolerates a missing
   `users/<slug>/schema.sql`** — it falls back to `SELECT count(*) FROM
   sqlite_schema` as its key check, which is what the read-only path already
   does. Applying a schema stays the *only* way tables appear, so step-6a
   residual 2 (no migration story) is untouched.
3. **The render path's real-vs-synthetic test becomes "holds at least one
   table", not "the file exists"** (`app/[user]/page.tsx`). Without this, the
   moment S2 creates the file every dashboard flips to the real database, finds
   no tables, throws on its first `SELECT`, and renders "This dashboard failed
   to load" — permanently, because the read-only handle can never create the
   tables and the friend has no control that would. This is the exact
   ssh-only dead end `createEncryptedUserDb`'s docstring was written to
   remove; the eager create re-opens it unless the predicate moves.

An empty real database is honestly described by the synthetic screen and its
banner: the friend has logged nothing, so there is nothing real to render.
The banner is still never shown over real data, which is the rule that matters.

**CLAUDE.md consequence:** "the walk route's writable open is the only thing
that creates or migrates a user's real database" becomes false. It is amended
to name **two** writable opens — the registration route (creates, empty) and
the walk route (creates-with-schema and migrates) — and to say that any third
one is a change to this ruling, not a refactor.

### D4. `device_class` is a field inside `metrics.data`, never a column

The spec says "every event row carries a `device_class` **column**". `metrics`
is sacred: append-only, trigger-enforced, explicitly outside the one file
allowed to reshape a sacred table, and holding production rows. A column is
not available and asking for one is asking to break the rule the metrics log
exists under.

**Ruling: `device_class` is a key in the existing `data` JSON blob**, present
on every row this flow emits and added to `dashboard_open` and
`dashboard_write`. Nothing about querying it is meaningfully harder —
`json_extract(data, '$.device_class')` — and no DDL touches a sacred table.

**How it is known.** A four-line inline script in the root layout sets a
`stairwell_dc` cookie from `matchMedia` (`phone` < 768px, `tablet` < 1024px,
`desktop` otherwise). Server-side emitters read the cookie; when it is absent
(the very first request of a session, before any script has run) they fall
back to a User-Agent classification. The cookie carries a three-value enum and
nothing else, so the permanent policy — *metrics never carry user values* —
is untouched.

### D5. "Transcript-native" proposal cards are satisfied by **merging `specs`
into the transcript at read time**, not by writing transcript rows

The spec: *"A proposal card is a **persisted chat message**: it lives in the
transcript in conversation order … survives reload."* The property it is
asking for is real and currently missing — today every card renders in a
`ProposalRegion` **below the entire transcript**, so scrollback does not show
where a proposal happened.

But writing a row into `transcripts` for it would create a second, permanent,
un-deletable copy of something `specs` already holds — in the one table this
project calls sacred, with columns that cannot be widened. `specs` rows
already carry `conversation_id` and `at`.

**Ruling: the panel renders one ordered list, merged by `at`, from two
sources.** The spec row *is* the persisted message; nothing new is persisted.
`toMessages` is unaffected (it filters to `user`/`assistant` rows and never
sees a spec). The admin transcript pane merges the same two sources with the
same function, which is what makes "the admin reads the conversation the way
the user experienced it" true rather than approximately true.

### D5a. The confirmation is a transcript event too — and it already is one

Checked at Nico's request, because the spec says it in one clause — *"The
user's confirmation is a transcript event too"* — and the merge above only
covers proposals.

**It resolves in the design's favour, with one arm to add.** A confirmation is
already a persisted, timestamped, append-only row: `spec_confirmations
(spec_id, account_id, at)`, written by `app/api/spec/confirm/route.ts` and
read back by `readSpecs`'s `MIN(at)` subquery. Nothing needs to be recorded
that is not recorded.

What is missing is only that the timeline does not *place* it. Today the
confirmation shows as the card changing to "Building this one." — so a friend
who confirms and then chats for ten turns finds the evidence of their decision
far up the scrollback, at the moment the card was *offered*, with nothing at
the moment they *decided*. The two timestamps can be days apart.

**So `buildTimeline` merges three sources, not two:** transcript rows, spec
rows, and confirmation rows. A confirmation renders as a short inline event
("Confirmed v3" + its time), in conversation order, in both the friend's panel
and the admin pane. `spec_confirmations.at` is what orders it.

**Still nothing new is written.** This is a third read of a table that
already exists, for a fact that is already permanent. A confirmation was never
missing from the record — it was missing from the *rendering* of it, which is
the same defect the proposal merge fixes and it would have been odd to fix one
and not the other.

### D6. The shell's breakpoint behaviour is **CSS only** — no JS viewport state

The spec's standing viewport rule is "breakpoints change arrangement, never
internals", and its explicit constraint is "one responsive implementation per
surface." A JS `matchMedia` branch that renders a sheet on narrow and a panel
on wide is two implementations of the chat surface wearing one name, and it
also renders differently on the server than the client for one frame.

**Ruling: one `ChatPanel`, mounted once, in one DOM position; Tailwind
utilities decide whether it reads as a fixed left column or a full-screen
sheet.** The only JS state is a single `open` boolean, which means the same
thing in both compositions. This is also what makes "test every screen at
375px and 1440px" testable without a browser: the compositions differ by class
names, which a test can assert, and the arrangement is the browser's business.

### D7. Chat-open default comes from the registry, and the localStorage
toggle is **deleted**

The spec: chat is open by default until a real dashboard is deployed, and
collapsed by default after. It also lists "persistence of panel state across
sessions" as a **non-goal**. `ChatPanel` today persists exactly that, in
`localStorage` under `stairwell:chat-open`.

**Ruling: delete `TOGGLE_KEY` and its `useEffect`.** The default is
server-computed — `dashboardLoaderFor(slug) !== undefined`, i.e. "has a
dashboard been deployed" — and the toggle is in-session React state only.
Removing persistence is the spec's instruction, not a regression; keeping it
would mean a friend who once collapsed the chat during the interview never
sees it open again on the morning their dashboard lands.

### D8. `first_session_start` reads `metrics` to decide whether to write —
the second load-bearing metrics row

D16 of the unified-loop ledger named `deploy_announced` as the first metrics
row in this codebase that is system state rather than telemetry. This is the
second: the shell decides whether to emit `first_session_start` by asking
whether one already exists for the account.

Accepted for the same reasons and with the same hazard: `metrics` rejects
UPDATE and DELETE so it cannot be corrupted through the application, and the
danger is a human pruning rows as disposable telemetry. Recorded here and
added to the list in CLAUDE.md's sacred-data section, which now names two
events rather than one.

### D9. jsdom is admitted; `@testing-library/react` is not

The spec makes this a precondition: *"install jsdom and kill the nine
surviving call-site mutations before modifying `ChatPanel`."* That overrides
step-4 ledger residual 1's blanket "no new test dependencies" for jsdom
specifically, and only for it.

**Ruling: `jsdom` as a devDependency, opted into per-file with
`// @vitest-environment jsdom`** so the other ~790 tests keep running in the
`node` environment at their current speed. Rendering is done with
`react-dom/client` and React 19's own `act` through one helper,
`tests/support/dom.tsx` — **not** testing-library, which the spec did not ask
for and which would be a second, larger dependency with its own query DSL to
learn.

### D10. `/login` stays the returning-login surface; `/` keeps dispatching

The spec heads S4 "Returning login (`/`)". Today `/` has no content of its
own: it resolves session state and redirects (`app/page.tsx`), and
`deploy/smoke.sh` pins `/ → /login` as one of three shape assertions that
exist because two production outages were redirect bugs.

**Ruling: cosmetic difference, resolved in favour of the code.** An anonymous
visitor to `/` sees the login form after one 307. Moving the form to `/`
would mean rewriting the dispatcher, the guard's `PUBLIC` set, the smoke
check, and `routeFor`'s `/login` branch, to change nothing a friend can
perceive.

### D11. Invite tokens are stored **hashed**

Not specified either way. `platform.db` is unencrypted by design — it holds
the records Nico is promised access to. A live invite token in it is a
bearer credential to create an account, and the spec deliberately gives
tokens **no expiry** ("N=3 friends; expiry timers are over-engineering"), so
a leaked one is good forever.

**Ruling: `invites` stores `sha256(token)`.** The token itself exists only in
the URL Nico texts. Lookup hashes the candidate and compares; a revoke or a
consume is an `UPDATE` on the row (`invites` is **not** a sacred table — it is
operational state, like `sessions`, and is deliberately not append-only).

### D12. One invite, one pre-assigned slug, and the account is created at S2 —
not at mint time

The spec: "Token is bound to a pre-created username. No self-chosen usernames
— Nico assigns." Read literally, "pre-created" could mean the account row
exists at mint time. It must not: `accounts.auth_hash` is `NOT NULL` and there
is no password until S2, so a mint-time account would need a sentinel hash
that could be login'd against if it ever escaped.

**Ruling: minting reserves a slug on the `invites` row; `createAccount` runs
inside S2's transaction.** The slug is validated against `SLUG_PATTERN` and
`RESERVED_SLUGS` at **mint** time, so Nico finds out he typed `/admin` when
he mints the link, not when his friend tries to use it.

### D13. The atomic unit at S2 is (consume token + create account + wrap key +
create session); **the database file is created immediately after, outside it**

SQLite transactions cannot roll back a filesystem `link()`. The spec's
constraint — "a consumed token with no DB is an invalid state" — is therefore
held by ordering and by a compensating delete, not by a transaction:

1. Build the empty encrypted database at a temp path **first**, before any
   row is written. A failure here has touched nothing: no account, no consumed
   token, and the friend sees "Something broke on my end."
2. In one `better-sqlite3` transaction: consume the token (guarded by
   `used_at IS NULL AND revoked_at IS NULL` in the `UPDATE`'s `WHERE`, so a
   double submit loses the race rather than double-creating), create the
   account, store the wrapped key, create the session.
3. `link()` the prepared file into `users/<slug>/<slug>.db`.

If (3) fails, (2) is already committed — so (3) is retried by the *next*
writable open, which is the lazy-creation path this repo already has and has
already hardened. The invariant the spec names is preserved in the direction
that matters: **a consumed token always has an account**, and an account
without its file is the state the code was already built to heal.

### D14. The mockup is served from one route, and the route is the *only*
thing that decides who may see it

`/mockup/<version>` (session-authed) replaces `srcDoc` for both the card
preview and the full-screen dialog, per the spec. Two things ride with it and
neither is optional:

- The `sandbox=""` attribute stays on **both** iframes, unchanged.
  `tests/spec/sandbox.test.ts` pins it, and an empty sandbox is what keeps
  model-authored markup from running code in a friend's session. Serving from
  a route rather than `srcDoc` does not relax it — an opaque-origin document
  is exactly what is wanted.
- The route serves **the logged-in account's own versions only**; an admin
  session may read any account's, read-only, via
  `/mockup/<slug>/<version>`. A version number is small and guessable, so
  the route authorises rather than trusting the URL.

### D16. Every screen is screenshotted and reviewed before its own commit

Ruled by Nico at plan approval, and it closes the gap this plan could not
close on its own: **no test in this repo can see a layout.** The spec requires
every screen tested at 375px *and* 1440px, and the whole styling layer (D1)
arrives in a codebase that has never rendered a pixel. A green suite plus a
clean `next build` says nothing about whether a card is centred, whether a
warning block reads as a warning, or whether the shell's chat panel actually
becomes a sheet below `md`.

**Ruling: a headless Playwright harness captures every screen — S0 through
S5, plus both shell states — at 375×812 and 1440×900, and the shots are read
and checked against written per-screen assertions BEFORE the task that touched
them is committed.** Shots are written to `.screenshots/<task>/` (gitignored)
and kept, so the morning's review has artifacts rather than a claim.

Three things this deliberately is and is not:

- **It is a review gate, not a test.** No pixel diffing, no golden images, no
  snapshot files to churn. The assertions are prose, per screen, derived from
  the spec, and they are checked by looking. A pixel-diff suite in a codebase
  with no visual baseline would fail on every commit for a month and then be
  switched off.
- **It does not replace the morning walk.** Nico still opens the real thing on
  a real phone against the droplet (see "What only a human can check"). A
  headless Chromium at 375px is not a phone: it has no software keyboard, no
  Safari viewport quirks, no autocorrect — and autocorrect is named in the
  spec's own copy as a leading cause of lockouts.
- **A failed review blocks the commit**, exactly like a red test. The fix
  lands in the same task, not in a follow-up.

### D15. Out of scope, deliberately, and named so nobody thinks it was missed

- **The undiagnosed proposal-abort bug** (unified-loop residual 13) and its
  justified-regardless heartbeat fix. **Ruled at plan approval: it stays out
  of this branch and becomes the next one.** This branch touches `ChatPanel`
  heavily and would be the cheapest moment — but folding an undiagnosed
  production defect into an approved UX build is how a branch stops being
  reviewable, and residual 13 deserves a diagnosis rather than a ride-along.
- **A generalized entry-widget write route** (unified-loop D10), unchanged.
- **Password change UI** — the spec's own non-goal. D2 makes it cheap; it is
  still not built here.
- **Admin invite management beyond minting and revoking** — the spec's own
  non-goal. Two CLI scripts, no UI.
- **A metrics UI** — the spec punts it indefinitely.

---

## Built

Eighteen tasks, executed inline with a test cycle, a mutation drill and a
screenshot review per task. **1000 tests pass**, `tsc --noEmit` is clean,
`next build` succeeds, `.claude/hooks/test-hooks.sh` is 160/160.

A friend now receives a link, reads the promise before an account exists, sets
a password that becomes their encryption key, and lands in the shell they will
use for the product's whole life. The returning login says what a wrong
password means without implying a reset; `/forgot` says why there cannot be
one. The admin portal reads the conversation the way the friend had it.

**What the drills caught, and this is the part worth reading.** Fifty-one
mutations were applied across the branch. Six reddened nothing, and every one
of those six was the CODE or the TEST being wrong rather than the drill:

1. **The Radix jsdom shims were unnecessary** (Task 2). The plan asserted
   Dialog, Tabs, Checkbox and Collapsible would need `ResizeObserver`,
   `DOMRect`, `matchMedia`, pointer-capture and `scrollIntoView`. jsdom lacks
   all of them; none of the four components touches any of them.
   `installDomShims()` is one line now.
2. **`user_version` was not what made the empty database real** (Task 8) —
   `journal_mode = WAL` had already written the encrypted header.
3. **The no-schema writable open needed no substitute key check** (Task 8);
   the WAL pragma already throws on a wrong key. Which also means this
   codebase's long-standing claim that "the schema exec doubles as the key
   check" was never quite true.
4. **`createEmptyEncryptedUserDb`'s `existsSync` is an optimisation, not the
   guarantee** (Task 8). `link()` EEXIST is.
5. **The timeline's tie-break was decorative** (Task 14): a stable sort plus a
   convenient construction order was doing the work. The array is built in
   reverse now, so the rule is the mechanism.
6. **The dead-link page could grow copy the constant never saw** (Task 9).

And three drills reported their target MISSING, which caught two real defects:
the page imported `readConfirmations` and never called it, so confirmations
would never have appeared after a reload; and the spec's own named red-test
("a used token cannot re-register") passed against a build with no invite
consumption at all, because `accounts.slug` is UNIQUE and caught it anyway.

**Two tests were wrong rather than the code**, both found by drilling: an
assertion that the XSS fixture's `onerror=` never appears would have required
a friend's own words to vanish, and a walker looking for raw `<button>`
elements found nothing once the card rendered shadcn's `Button`, which would
have made every card assertion vacuous.

## What the screenshot review caught

Kept as a running list, per D16, because whether that gate was worth building
is answered by this section and nothing else. **Seven findings, none of which
any test in this repo could have seen:**

- **Task 3, first run ever.** Installing Tailwind's preflight in Task 2
  stripped the browser's default form styling from `/login` and `/unlock`,
  leaving invisible inputs and a "Log in" button that rendered as plain text.
  Every test stayed green — nothing here asserts that an input is visible. The
  plan would not have restyled login until Task 11, so seven commits would
  have carried a login page that looked broken.
- **Task 3, second run.** The card was white on a white page — "bare content
  floating in an empty viewport", the exact thing the spec's Viewport rules
  forbid. `--background` is tinted now.
- **Task 10.** The stock destructive Alert is red text in a NEUTRAL border on
  white: S2's destruction warning read as prose that happened to be red, not
  as a warning. Tinted, per the spec's "bordered/tinted".
- **Task 13.** The SYNTHETIC DATA banner rendered as one more line of the
  dashboard, in the same type as the numbers it warns about. CLAUDE.md calls
  it "the only thing distinguishing the two screens".
- **Task 15.** The proposal card rendered NO preview at all: a hand-written
  fixture failed validation and the page did exactly the right thing with an
  unreadable row — degrade silently — which looks a great deal like a working
  empty chat. Fixtures are built through `parseSpecDraft` + `sealVersion` now,
  so a bad one throws in the harness instead.
- **Task 15.** The preview was cropped at 1:1 rather than scaled down.
- **Task 16.** `spec.md`'s "do not hand-edit" banner — addressed to whoever
  opens the file in an editor — rendered as visible body copy in the portal.
  (The first fix anchored to the start of the document and stripped nothing,
  because the banner sits after the H1.)

The gate also caught one thing about ITSELF that mattered more than any of the
above: the harness seeded fixtures in its own process while setting
`USERS_DIR` only for the server it spawned, so registration wrote a stray
`users/newfriendtest/` into the repo. `tests/users/conventions.test.ts` swept
the stray folder and **skipped three checks over it** — three skips where
there had been none, which is the quietest failure this suite produces.

## Residual risks

1. **No screen has been seen by a human, on a real device.** Everything above
   is headless Chromium at two fixed widths. A phone has a software keyboard
   that covers half the viewport, Safari has its own viewport quirks, and
   autocorrect — named in this product's own copy as a leading cause of
   lockouts — does not exist in a screenshot. The morning walk is not
   optional.
2. **The `devtwo` end-to-end interview has not been run.** The spec makes it
   the required follow-up to touching `ChatPanel`, and this branch rewrote how
   that component renders everything. All six of step-4 residual 1's call-site
   mutations still redden, and the composition is covered by
   `tests/chat/panelWiring.test.tsx` — but step-4's own ledger says a green
   suite is not sufficient evidence for this component, and that is still true.
3. **`devtwo`'s real database has not been opened since envelope encryption
   landed.** The legacy arm is tested at the route layer and drilled (making
   `databaseKeyFor` always unwrap reddens seven tests), but no real
   SQLCipher file written under a directly-derived key has been opened by this
   build. It is the one place D2 meets real data.
4. **Nothing has been deployed.** `next build` succeeds and `deploy/smoke.sh`
   is unchanged, but the branch has never run behind Caddy — where the
   redirect asymmetry that produced two production outages lives.
5. **`first_session_start` is the second load-bearing metrics row** (D8). The
   hazard is human: someone pruning `metrics` as disposable telemetry makes a
   months-old account report a first session again, and nothing afterwards can
   tell which rows were real. Now named in CLAUDE.md beside `deploy_announced`.
6. **The screenshot fixtures share one database, so every fixture needs its own
   slug.** Three separate runs failed on a UNIQUE violation before that was
   true. It is a footgun for whoever adds the next state, and the only thing
   stopping it is a comment.
7. **`registerFromInvite` can leave an orphan database.** If the transaction
   fails after the file is linked, an empty encrypted database sits in a folder
   no account points at — inert, unreadable by anyone including us, and reused
   by the next attempt for that slug. Accepted (D13), because the alternative
   is a consumed token with no database, which is the state the spec forbids.
8. **The confirmation event's timestamp is the CLIENT's clock** for a confirm
   made in the current session. The server's `spec_confirmations.at` replaces
   it on the next load, and the two only ever have to agree about order — but
   a badly-skewed clock could sort one confirmation oddly until reload.
9. **Unified-loop residual 13 is untouched and now easier to hit.** The
   proposal that intermittently dies telling the friend "interrupted — not
   saved" about a message that WAS saved is the next branch (D15). This build
   rewrote the panel around it without fixing it.
10. **`INVITE_ORIGIN` is not in `deploy/required-env`.** Its default is the
    correct production value, so it cannot produce a wrong link on the droplet
    — the same reasoning that file already applies to `USERS_DIR`. A local run
    that forgets it prints a production URL, which is a person's problem for
    one second.
