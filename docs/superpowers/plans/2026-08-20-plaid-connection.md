# Plaid Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan has HUMAN GATES.** Six phases, each ending at a 🔍 gate that Nico
> clears by looking at something with his own eyes. An agent MUST STOP at a gate
> and MUST NOT begin the next phase until Nico says so. The gates are not
> review ceremony — three of them exist because no test in this repo can answer
> the question being asked.
>
> **NICO COMMITS, NOT THE AGENT.** No step in this plan runs `git commit`.
> Each phase ends with its work staged-or-unstaged in the tree and Nico
> committing it himself at the gate. An agent that commits has taken a
> decision that belongs to the person reviewing the phase.

**Goal:** Build the five shared pieces that let an AI builder deliver a
financial dashboard for a friend: a Plaid client, a connect flow, a refresh
route, a raw-payload table envelope, and a Sandbox-derived synthetic seeder.

**Architecture:** Plaid's payload is stored **verbatim as JSON** in a
four-column envelope; no field is modeled in SQL, so per-friend differences are
views over `json_extract` rather than schema variants. There is **no background
sync and no login sync** — a friend's data key exists only while they are
unlocked, so a refresh happens when they press a button, and nothing else ever
opens their database. The synthetic fixture every dashboard is built against is
a **recording of a real Sandbox response with human-readable names scrubbed to
`TEST`**, so nothing about field shape is hand-invented.

**Tech Stack:** Next.js App Router, `plaid` official Node SDK (confined to one
file), better-sqlite3-multiple-ciphers (SQLCipher), SQLite JSON1, vitest.

**Spec:** This document. The design converged in conversation rather than in a
separate design doc — deliberately, since the alternative was a second artifact
restating it. The "Design decisions" section below carries the rationale, so
this plan is self-standing. If a ledger later needs to cite a design, extract
that section to `docs/superpowers/specs/`.

**Branch:** `plaid-setup`. Not `main` — check `git branch --show-current`
before writing code.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied
verbatim from `CLAUDE.md` and `architecture-overview.md`.

- **All dev and testing runs on synthetic data ONLY.** Never open, read, or
  query any `*.db` other than `synthetic.db`. A guard-hook denial is the rule
  working, not a bug to route around.
- **The loud-fake marker is the literal string `TEST`** ("COFFEE PALACE TEST"),
  because `tests/users/conventions.test.ts` sweeps generated databases for that
  exact marker. A different word means the existing gate does not fire.
- **Metrics never carry user values.** A `dashboard_write` row carries a slug
  and a panel and nothing else — no day, no count, no payload, no merchant, no
  amount. Permanent policy for every panel type.
- **Nothing writes to a friend's database except from their own session.** V1
  has exactly one trigger for Plaid: **a control the friend presses.** The
  login-sync trigger named in `architecture-overview.md:69` is DROPPED for V1
  (see Design decisions D1).
- **A dashboard render gets a read-only handle and never writes.** Only a
  platform route holds a writable handle, and it is the only place the four
  ordered auth checks live.
- **Migrations are added, never edited**, and `manifest.json` checksums enforce
  it. Migrations + `seed.py` + `tests/` change in the SAME commit.
- **Prompt files are added, never edited** once on `main` — a new version is
  `agent-v10.md`, never an edit to `agent-v9.md`. `prompt_sha` is stamped on
  stored rows.
- **No test in the default suite reaches the network.** Live tests are named
  `*.live.test.ts`, are excluded by `vitest.config.ts` unless `VITEST_LIVE=1`,
  and run only via `npm run test:live`. They assert SHAPE, never values, and
  share their assertion with the offline fixture test.
- **Every third-party client is injected.** `lib/plaid/client.ts` takes its
  Plaid API object as a parameter, exactly as `lib/chat/turn.ts` takes its
  Anthropic client and `lib/alerts/ntfy.ts` takes `fetch`.
- **Redirects are host-relative in route handlers.** Never
  `new URL(path, request.url)` — the app runs behind a reverse proxy.
- **Never derive a day from a clock** in `dashboard.tsx` or `queries.ts`.
  `tests/users/noLocalDay.test.ts` sweeps for `Date.now()` and zero-argument
  `new Date()`. A `queries.ts` MAY use `dayKey` over a STORED instant.
- **Gate B (pre-commit)** requires a test under the matching scope:
  `lib/`, `app/` → `tests/`; `modules/` → `modules/tests/`;
  `users/<slug>/` → `users/<slug>/tests/`.
- **A dependency that reads env, the filesystem, or the network runs in the
  same process as the keymap holding every unlocked friend's database key.**
  The `plaid` SDK is sanctioned by the stack decision, but it is confined to
  `lib/plaid/client.ts` and nothing else imports it.

---

## Design decisions

Carried here so this plan is self-standing.

**D1 — No login sync. Button only.** `architecture-overview.md:69` says sync
runs at login. V1 drops that half. Rationale: a friend's data key exists only
in the in-process keymap while they are unlocked, so login and a button are the
only two moments a write is *possible* at all; the button alone covers every
"I want it now" case, and dropping the login half removes staleness thresholds,
the "login-triggered work never refuses the session" handling, and added
latency on unlock. **Consequence:** a friend's data is as fresh as the last
time they pressed Refresh, and `agent-v10.md` must stop saying refreshes happen
at login.

**D2 — Raw JSON envelope, not a modeled schema.** Plaid's payload is stored
verbatim; only identifiers and the one date every query filters on get their
own columns. Rationale: a modeled schema is a hand-maintained derivative of
someone else's contract, and nothing notices when it goes stale. More
importantly it converts the expensive failure into a cheap one — a wrong field
becomes *edit a view*, not *migrate an encrypted database nobody can open,
including Nico*. Plaid adding a field costs nothing; Plaid renaming one breaks
one friend's view, visibly.

**D3 — The shared surface is five things, and no more.** `lib/plaid/client.ts`,
the connect flow, one refresh route, the envelope tables, and the seeder.
Everything that differs between friends is a view over the JSON, written per
friend by the builder, unlimited.

**D4 — Scrub names, never enums or ids.** If `personal_finance_category.primary`
became `FOOD_AND_DRINK TEST`, a builder's view would group on the synthetic
value, every test would pass, and the panel would be empty for a real friend.
That failure is green all the way to the friend's screen, which makes it worse
than an unscrubbed merchant name. Ids, ISO dates, currency codes, enums and
amounts pass through byte-exact.

**D5 — No module-vendoring machinery at V1.** `modules/plaid/initial.sql` is
the one source of truth and reaches a friend's `migrations/` by `cp`, as a
documented runbook line.

**CORRECTED 2026-08-21: the BUILDER does the `cp`, not Nico.** This originally
put it in docs/runbook-human.md on the reasoning that "Nico runs anything that
scaffolds a folder". That was wrong — a `cp` into `migrations/` is not
scaffolding, it is WRITING A MIGRATION, and the builder already owns every
migration a dashboard has. Splitting one dashboard's migrations across two
people would have been the anomaly. It now lives in docs/runbook-ai.md §2.2a,
one step before the manifest command that already sweeps every migration. No `add-module.sh`, no byte-equality sweep test, no
`plaid_*` write sweep, no module versioning. Those answer "how do I stop drift
across five finance friends" and there are zero. **Named cost:** at one or two
friends a builder editing the vendored copy is something Nico would notice; at
five it is not. Revisit when a second finance friend exists — adding the sweep
later is one small test file and requires no change to anything below.

**D6 — The builder may make authenticated Sandbox calls.** Today the AI builder
touches no network at all. This widens that. Low risk at Sandbox (data
fabricated by Plaid, no real account, no real money) and it never reads `.env` —
the variables are simply in its environment. But it is a genuine widening of
`docs/runbook-ai.md` §1's bounds and gets written there explicitly in Phase 6.

**D7 — Dev refresh writes unscrubbed Sandbox data into `synthetic.db`.**
`lib/db/userData.ts` sends dev writes to `synthetic.db`, so pressing Refresh
locally lands real Sandbox merchant names (Starbucks, United) in it. Accepted:
it is the only way to test the route end to end, and the alternative — making
the client behave differently in dev — rebuilds the exact failure
`lib/db/userData.ts` exists to prevent. **Mitigation is a runbook line, not
code:** run `npm run synthetic` before any screenshot, review, or `npm run shots`.

---

## File structure

**Created:**

| Path | Responsibility |
|---|---|
| `lib/plaid/client.ts` | The only file that knows Plaid exists. Link token create, public-token exchange, `transactionsSync`, `investmentsHoldingsGet`, `accountsGet`. Injected API object. Throws `PlaidCallError` carrying a CODE, never Plaid's prose. |
| `scripts/plaid-probe.ts` | Phase 1 throwaway probe. Grows into the recorder in Phase 2. |
| `scripts/record-plaid-fixture.ts` | Sandbox → scrub → `modules/plaid/fixtures/*.json`. Run by hand. |
| `modules/plaid/initial.sql` | The envelope. Vendored into each finance friend's `migrations/` by `cp`. |
| `modules/plaid/scrub.ts` | The named-field scrubber. Pure; its allowlist is the D4 decision in code. |
| `modules/plaid/seed_plaid.py` | Fixture → date-shift → rows. Imported by a friend's `seed.py`. |
| `modules/plaid/fixtures/*.json` | Scrubbed Sandbox recordings. Committed. |
| `modules/tests/plaid.test.ts` | Apply `initial.sql` to an in-memory db, seed from fixture, query back. |
| `modules/tests/scrub.test.ts` | Names scrubbed, enums/ids/dates/amounts untouched. |
| `tests/support/plaidShape.ts` | The shared assertion, used by both the fixture test and the live test. |
| `tests/plaid/client.test.ts` | Offline, fixture-driven, injected client. |
| `tests/plaid/client.live.test.ts` | The connection heartbeat. Opt-in only. |
| `app/api/users/[user]/plaid/link-token/route.ts` | Mints a Link token for the friend's own session. |
| `app/api/users/[user]/plaid/connect/route.ts` | Exchanges the public token, writes `plaid_items`. |
| `app/api/users/[user]/plaid/refresh/route.ts` | The one thing that ever writes a `plaid_*` data table. |
| `lib/ui/PlaidConnect.tsx` | Client component loading Plaid's Link script. |
| `users/plaidtest/**` | The scratch dashboard the flow is proved against. |

**Modified:**

| Path | Change |
|---|---|
| `platform/prompts/agent-v10.md` | NEW FILE (never an edit to v9): investments enabled, refresh is a button not a login. |
| `deploy/required-env` | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`. This file ONLY — `lib/env/required.ts` is a pure parser of it and holds no list of its own, so nothing in code changes. |
| `docs/dashboard-build-rules.md` §9 | Currently says "Not built yet." |
| `docs/runbook-human.md` | The `cp` module step and the connect step. |
| `docs/runbook-ai.md` §1 | D6's widened bounds. |
| `CLAUDE.md` | The V1 trigger sentence, which currently names login. |

---

## Prerequisites

- [ ] `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox` in the local `.env`.
      The guard hook denies READING `.env` — that is fine, the process inherits
      the variables and nothing needs to open the file.
- [ ] Revert the working-tree edit to `platform/prompts/agent-v9.md`
      (`git checkout platform/prompts/agent-v9.md`). It is already on `main`
      (commit `f8cf2e8`), so editing it in place changes what an existing
      `prompt_sha` points at.
- [ ] Confirm `git branch --show-current` says `plaid-setup`.

---

## Phase 1 — Client and probe

**Nothing persists. No database, no UI, no friend.** The deliverable is
knowledge: what Plaid actually returns.

**Files:**
- Create: `lib/plaid/client.ts`, `scripts/plaid-probe.ts`
- Test: `tests/plaid/client.test.ts`

**Produces (relied on by every later phase):**
- `class PlaidCallError extends Error { readonly code: PlaidErrorCode }` where
  `PlaidErrorCode = 'http' | 'network' | 'timeout' | 'unparseable' | 'auth' | 'item_login_required'`
- `createSandboxItem(api, opts): Promise<{ accessToken: string; itemId: string }>`
- `exchangePublicToken(api, publicToken): Promise<{ accessToken: string; itemId: string }>`
- `syncTransactions(api, accessToken, cursor?): Promise<{ added: unknown[]; modified: unknown[]; removed: string[]; nextCursor: string; hasMore: boolean }>`
- `getHoldings(api, accessToken): Promise<{ accounts: unknown[]; holdings: unknown[]; securities: unknown[] }>`
- `plaidApiFromEnv(): PlaidApi` — the ONLY place env vars are read

Note the return types are `unknown[]`. That is deliberate: the payload is stored
verbatim (D2), so the client does not model it and neither does TypeScript.

- [ ] **Step 1: Add the dependency**

```bash
npm install plaid
```

- [ ] **Step 2: Write `lib/plaid/client.ts`**

Model it on `lib/weather/openMeteo.ts` — read that file first. It carries a
header stating the properties that hold it together, and this file owes the
same. Three properties to state and honour:

1. **The API object is injected.** Every exported function takes `api` as its
   first parameter. Only `plaidApiFromEnv()` reads `process.env`, and no test
   in the default suite calls it.
2. **It throws `PlaidCallError` and nothing else.** A CODE, never Plaid's
   message — an upstream error body is text we did not write, on a path that
   ends in a database and a log line.
3. **It returns payloads verbatim.** No mapping, no renaming, no date parsing.
   The envelope stores what Plaid said.

```ts
export class PlaidCallError extends Error {
  readonly code: PlaidErrorCode
  constructor(code: PlaidErrorCode) {
    super(`plaid call failed (${code})`)
    this.name = 'PlaidCallError'
    this.code = code
  }
}
```

- [ ] **Step 3: Write `tests/plaid/client.test.ts` with a stub api object**

No network. Assert: a stub that throws a 400 produces `PlaidCallError` with a
code and **not** the upstream message; a stub returning a body passes it
through unmapped.

- [ ] **Step 4: Run the offline test**

```bash
npx vitest run tests/plaid
```
Expected: PASS.

- [ ] **Step 5: Write `scripts/plaid-probe.ts`**

Sandbox institution `ins_109508`. Sequence: `sandboxPublicTokenCreate` →
`itemPublicTokenExchange` → `transactionsSync` → `investmentsHoldingsGet` →
`accountsGet`.

**It prints field NAMES and COUNTS, never values.** `Object.keys()` at each
level and array lengths. This is what makes it safe to paste into a chat or a
commit message.

- [ ] **Step 6: Run it**

```bash
npx tsx scripts/plaid-probe.ts
```

- [ ] **Step 7: Leave the work for Nico to commit**

Do NOT run `git commit`. Report what changed; Nico commits at the gate.

## Gate 1 findings (recorded 2026-08-20 — Phase 1 CLEARED)

All 16 routes called against Sandbox; 15 green. Everything below replaces
guesswork in the phases that follow.

**F1 — Recurring cannot be requested at connect time.** Plaid rejects
`recurring_transactions` in `initial_products` outright ("some products cannot
be included in initial_products"). It becomes ready roughly 10s AFTER the item
exists, and `billed_products` gains it on the first successful call. So
`/link/token/create` must not ask for it, and the refresh route must treat
`PRODUCT_NOT_READY` as "not yet", never as failure. This matters because
`agent-v9.md` promises friends "subscriptions and paychecks detected
automatically".

**F2 — Three data patterns, not two.**
- cursor stream: `/transactions/sync`
- snapshot replace: `/investments/holdings/get`, `/accounts/get`
- date-ranged AND PAGINATED: `/investments/transactions/get` returned 100 of
  1171. Needs offset paging that neither other pattern has.

**F3 — Both `/refresh` endpoints are fire-and-forget** and return only
`request_id`. The extraction is still running at the bank when they return, so
calling one and then immediately syncing yields exactly what Plaid already had.
Combined with a ~10s connect and a 2–6s first sync, ASYNCHRONY IS THE DOMINANT
FACT of this integration, not an edge case.

**F4 — `classifyError()` is verified against real Plaid behaviour.**
`/sandbox/item/reset_login` followed by a sync produced `item_login_required`,
and `/link/token/create` in UPDATE MODE (pass `access_token`, omit `products`)
mints the token that repairs it. `/item/remove` works and is real — `/item/get`
afterwards returns `ITEM_NOT_FOUND`.

**F5 — The envelope grows from 7 tables to 9.** Add `plaid_recurring_streams`
(PK `stream_id`) and `plaid_investment_transactions` (PK
`investment_transaction_id`).

**F6 — The scrub allowlist from the plan sketch was badly incomplete.** Fields
that leak a merchant's identity even after `merchant_name` is scrubbed:
`logo_url`, `website`, `personal_finance_category_icon_url`,
`merchant_entity_id`, and the whole `counterparties[]` array (`name`,
`website`, `logo_url`, `entity_id`) — WHICH MEANS THE SCRUBBER MUST WALK
ARRAYS, not just top-level keys. Recurring streams add `description`;
investment transactions add `name`.

**F7 — Sandbox UNDERSTATES production, the reverse of D4's hazard.** Every
security comes back with `cusip`, `isin`, `sector`, `industry` and
`close_price` NULL. A builder writing a "holdings by sector" panel would see
nulls in synthetic and reasonably conclude the field is unusable, when in
production it is likely populated. Belongs in the build docs (Phase 6).

**F8 — The default refresh must not call everything.** Measured, the seven
plausible calls total **9.1 seconds**, and `/accounts/balance/get` and
`/transactions/refresh` are the two typically billed PER CALL. Since F3 makes
both `/refresh` endpoints useless within a single button press, the default
path is `/transactions/sync` + `/accounts/get` + (holdings, if the item
supports it) — about 1.3s, with no per-call endpoint touched.
`/accounts/get` carries the same `balances` object as `/accounts/balance/get`
(identical shape in the probe) from Plaid's cache, for free. Filter on what the
ITEM supports (`available_products`, stored on `plaid_items` at connect) and on
what the DASHBOARD asks for (named by the `<WriteAction>`), intersected
server-side.

**F9 — OAuth institutions are still unproven.** Every call used `ins_109508`,
which is not OAuth. Real banks like Chase redirect off-site and back through
Link. Only testable in a browser — Phase 3.

---

### 🔍 GATE 1 — Nico runs the probe  ✅ CLEARED 2026-08-20

**STOP. Do not start Phase 2.**

Nico confirms:
- Credentials work against Sandbox.
- Transactions, holdings, and accounts all answer. **Investments is newly
  enabled and has never been called — this is the first proof.**
- The field names are read off real output.

**This gate exists to correct me.** The SDK method names, the
`added`/`modified`/`removed`/`next_cursor` keys, and `ins_109508` above are
from recollection. Gate 1 replaces recollection with output, and **the envelope
in Phase 2 is designed from what this prints** — not from what this plan
assumes.

**Decision to make at this gate:** does a real payload still support the
four-column envelope, or does something (multiple items, pending transactions,
a security lookup) need a column it does not have?

---

## Phase 2 — Fixture, envelope, seeder

**Still no UI and no friend.** Ends with a synthetic database an AI builder
could build a dashboard against.

**Files:**
- Create: `modules/plaid/scrub.ts`, `modules/plaid/initial.sql`,
  `modules/plaid/seed_plaid.py`, `modules/plaid/fixtures/*.json`,
  `scripts/record-plaid-fixture.ts`, `modules/tests/scrub.test.ts`,
  `modules/tests/plaid.test.ts`, `tests/support/plaidShape.ts`,
  `tests/plaid/client.live.test.ts`

**Consumes:** everything Phase 1 produced, plus the field names from Gate 1.

- [ ] **Step 1: Write `modules/plaid/scrub.ts` and its test first**

The allowlist IS decision D4 in code, so it is named explicitly rather than
inferred:

```ts
export const SCRUBBED_FIELDS = [
  'merchant_name', 'name', 'original_description',
  'official_name', 'institution_name', 'ticker_symbol',
] as const
```

Test asserts BOTH halves, and the second is the one that matters:
`merchant_name: "Starbucks"` → contains `TEST`; and
`personal_finance_category.primary`, `transaction_id`, `date`, `amount`,
`iso_currency_code` come through **byte-identical**.

- [ ] **Step 2: Run it, watch it fail, implement, watch it pass**

```bash
npx vitest run modules/tests/scrub.test.ts
```

- [ ] **Step 3: Grow the probe into `scripts/record-plaid-fixture.ts`**

Same calls, then `scrub()`, then write `modules/plaid/fixtures/`.

- [ ] **Step 4: Record the fixture**

```bash
npx tsx scripts/record-plaid-fixture.ts
```

- [ ] **Step 5: Write `modules/plaid/initial.sql` — FROM GATE 1's OUTPUT**

Starting point, to be corrected by what Gate 1 showed:

```sql
CREATE TABLE IF NOT EXISTS plaid_items (
  item_id      TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  cursor       TEXT,
  connected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plaid_accounts (
  account_id TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  date           TEXT NOT NULL,
  payload        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plaid_securities (
  security_id TEXT PRIMARY KEY,
  payload     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plaid_holdings (
  account_id  TEXT NOT NULL,
  security_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (account_id, security_id)
);
CREATE TABLE IF NOT EXISTS plaid_refreshes (
  at      INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  product TEXT    NOT NULL,
  ok      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plaid_transactions_date ON plaid_transactions(date);
```

`plaid_refreshes` is not optional. `app/api/users/[user]/forecast/route.ts`
already learned this: without a recorded attempt, a failed refresh is
indistinguishable from no refresh, and the panel renders stale data as if it
were current — which `docs/dashboard-ui-ux-guidelines.md` > States forbids by
name.

- [ ] **Step 6: Write `modules/plaid/seed_plaid.py`**

Reads the fixture, **shifts dates so the newest transaction lands on today**
and every other keeps its original gap, inserts into the envelope. Model the
date handling on `users/devtwo/seed.py`, which already explains why: a fixture
with fixed dates renders empty "this month" panels six months from now.

- [ ] **Step 7: Write `modules/tests/plaid.test.ts`**

In-memory db → `initial.sql` → seed from fixture → query back. Assert rows
exist, `json_extract(payload, '$.merchant_name')` contains `TEST`, and
`json_extract` of a category enum has NO marker.

- [ ] **Step 8: Write `tests/support/plaidShape.ts` and `tests/plaid/client.live.test.ts`**

Read `tests/weather/openMeteo.live.test.ts` first and copy its structure and
its header discipline. The live test shares `expectTransactionsShape` with the
fixture test — that sharing is the whole point: it is what catches a fixture
that has drifted from reality instead of letting it quietly become fiction.

- [ ] **Step 9: Run both suites**

```bash
npx vitest run modules/tests tests/plaid   # offline, must pass
npm run test:live                          # opt-in, hits Sandbox
```

- [ ] **Step 10: Leave the work for Nico to commit**

### 🔍 GATE 2 — Nico reads the fixture

**STOP. Do not start Phase 3.**

`npm run test:live` green, and then **open the fixture and read it**. Every
human-readable name says `TEST`; every enum, id, ISO date and amount is
untouched.

**No test can do this half of the check.** A test proves the scrubber did what
the scrubber was told; only a person can notice it was told the wrong thing —
a text field nobody put on the allowlist, or an enum that got marked and will
silently split synthetic from production (D4).

---

## Phase 3 — Connect flow

**The risky phase. Everything before it has a precedent in this repo; this has
none.**

**Files:**
- Create: `app/api/users/[user]/plaid/link-token/route.ts`,
  `app/api/users/[user]/plaid/connect/route.ts`, `lib/ui/PlaidConnect.tsx`,
  `users/plaidtest/**`
- Test: `tests/plaid/connect.test.ts`, `users/plaidtest/tests/*`

- [ ] **Step 1: Nico scaffolds the scratch dashboard**

CLAUDE.md: Nico runs anything that scaffolds a folder — an agent does not.

```bash
./scripts/new-dashboard.sh plaidtest
cp modules/plaid/initial.sql users/plaidtest/migrations/001_module_plaid_initial.sql
# then add the registry line new-dashboard.sh prints, to lib/dashboard/registry.ts
npm run synthetic
```

The `001_module_plaid_initial.sql` filename is D5's convention: the `_module_`
segment records where the file came from, and `lib/db/migrationFiles.ts`'s
existing `^(\d{3})_[a-z0-9_]+\.sql$` already accepts it, so **no migration
machinery changes**.

- [ ] **Step 2: Write both routes**

Copy the four ordered auth checks verbatim from
`app/api/users/[user]/forecast/route.ts` — they ARE the security property and
are cheaper to read twice than to trace through an abstraction.

`link-token` mints a token for this session's friend. `connect` exchanges the
public token and writes `plaid_items`. **The access token never leaves the
friend's own database** and is never logged, never in a metric, never in a
response body.

- [ ] **Step 3: Write `lib/ui/PlaidConnect.tsx`**

Loads Plaid's Link script from `cdn.plaid.com`. Model the pending/error
mechanics on `lib/ui/WriteAction.tsx`.

- [ ] **Step 4: Render a Connect button on the `plaidtest` dashboard**

- [ ] **Step 5: Write route tests**

Assert the four checks: locked session → 403; wrong user → 404; unregistered
slug → 404; no live key → 403.

- [ ] **Step 6: Make a local account and run the app**

```bash
npx tsx scripts/create-local-account.ts plaidtest <password>
npm run dev        # NEVER npm start — it sets NODE_ENV=production and would
                   # create users/plaidtest/plaidtest.db on the laptop
```

- [ ] **Step 7: Leave the work for Nico to commit**

### 🔍 GATE 3 — Nico connects a bank in a real browser

**STOP. Do not start Phase 4.**

In a real browser: click Connect, pick any Sandbox institution, log in with
`user_good` / `pass_good`, and watch a row land in `plaid_items`.

**This is the phase most likely to surprise us.** Link is third-party
client-side script, and nothing in this repo has ever loaded one.

---

## Phase 4 — Refresh route

**Files:**
- Create: `app/api/users/[user]/plaid/refresh/route.ts`, `tests/plaid/refresh.test.ts`
- Modify: `deploy/required-env`, `users/plaidtest/dashboard.tsx`

- [ ] **Step 1: Write the route**

Two branches, because the two products refresh differently:
- **Transactions** — cursor stream. Upsert `added` and `modified` on
  `transaction_id`; delete `removed`. **The rows and the new cursor advance in
  ONE `userDb.transaction()`.** If the cursor were saved without the rows, that
  data is gone permanently — the cursor claims we already have it.
- **Holdings** — a snapshot, no cursor. Delete-and-replace inside one
  transaction, exactly as `replaceForecast` does in the forecast route.

Both write a `plaid_refreshes` row **whether or not Plaid answered**.

The metric row carries `{ slug, panel, device_class }` and nothing else. Not a
transaction count, not a balance, not an institution name.

- [ ] **Step 2: Add the environment variables**

```
PLAID_CLIENT_ID  DEGRADED  # Plaid API client id. Absent, connect and refresh fail loudly with their own error states and a plaid_refreshes row; every other dashboard is unaffected.
PLAID_SECRET     DEGRADED  # Plaid API secret for the configured environment. Same loud failure as PLAID_CLIENT_ID.
PLAID_ENV        REQUIRED  # sandbox | production. This is the PLATFORM_DB failure shape: a default would let production talk to Sandbox and serve fabricated balances with every health check green.
```

The split is deliberate and follows `deploy/required-env`'s own definitions.
Missing credentials fail LOUDLY — the friend sees an error state, the
`plaid_refreshes` row records it — which is the DEGRADED tier. A defaulted
`PLAID_ENV` fails SILENTLY and wrongly, which is the REQUIRED tier and the
exact reasoning `PLATFORM_DB` carries. Belt and braces: `plaidApiFromEnv()`
THROWS when `PLAID_ENV` is unset rather than defaulting to sandbox.

- [ ] **Step 3: Write `tests/plaid/refresh.test.ts`**

The four auth checks; a cursor that does NOT advance when the write throws; a
`plaid_refreshes` row written on an upstream failure; a 502 on upstream
failure. Inject a stub api — no network.

- [ ] **Step 4: Add a Refresh control to the `plaidtest` dashboard**

`lib/ui/WriteAction.tsx` is the default control and owns the mechanics. A
dashboard write updates the page in place and NEVER navigates.

- [ ] **Step 5: Run tests. Leave the work for Nico to commit**

### 🔍 GATE 4 — Nico presses Refresh

**STOP. Do not start Phase 5.**

Press Refresh in dev. Transactions and holdings appear. Press it again — no
duplicates, and the cursor call returns almost nothing the second time.

Then **clean up**, per D7:

```bash
npm run synthetic   # wipes the unscrubbed Sandbox names dev refresh just wrote
```

---

## Phase 5 — The real test: a fresh builder

**This is the acceptance criterion for the whole sprint.** Phases 1–4 exist to
make this possible.

- [ ] **Step 1: Nico writes a short spec** for a `plaidtest` panel — "show me
      my account balances and this month's spending."

- [ ] **Step 2: Start a CLEAN session** and ask it to build that, with only
      `docs/dashboard-build-rules.md`, `docs/runbook-ai.md` and the repo to go
      on. **Do not help it.**

- [ ] **Step 3: Write down every place it got stuck.** That list is Phase 6's
      input and is the actual deliverable of this phase.

### 🔍 GATE 5 — Did it work without help?

Did the builder find the module, write views over the JSON, and produce a
working panel unaided?

**This gate tests the documentation, not the code** — which is what the whole
sprint was for. A pass here means an AI builder can deliver a financial
dashboard. A fail here is not a code bug; it is a doc gap, and it is worth
more than a green suite.

---

## Phase 6b — Fix what Phase 5 exposed

Everything in 6a was written from what we KNEW. This pass is written from what
a builder actually did — the only source of that information is Phase 5's
stuck-list, and it cannot be guessed in advance.

- [ ] **Step 1: Fix every doc gap Phase 5 exposed.** Its stuck-list is the input.
- [ ] **Step 2: Re-read §9 against what actually happened**, not against what
      was intended.
- [ ] **Step 3: Full suite. Leave the work for Nico to commit**

```bash
npx vitest run
npx tsc --noEmit
```

### 🔍 GATE 6 — Sprint review

Everything green, docs true, and the answer to the original question — *is it
clear and easy for an AI builder to set up a financial dashboard?* — is
evidenced by Phase 5 rather than asserted.

---

## Deliberately not in this sprint

- **Login-triggered sync** (D1). The button covers V1.
- **Module-vendoring enforcement** (D5) — no `add-module.sh`, no byte-equality
  sweep, no `plaid_*` write sweep. Revisit at the second finance friend.
- **Webhooks.** A friend's data key exists only while they are unlocked, so a
  webhook can never deliver data into their database unattended — which is the
  only thing we would want one for. A webhook writing a "needs re-auth" note to
  the PLATFORM database is possible and is a separate decision, because it
  requires an `item_id → slug` mapping to live unencrypted.
- **Re-auth / `ITEM_LOGIN_REQUIRED` handling.** The code exists in
  `PlaidErrorCode`; the friend-facing reconnect state does not. First real
  expiry surfaces it.
- **Annotations on synced rows.** No friend has asked. When one does: their own
  table keyed to the synced row, never an edit to a `plaid_*` table.
- **Liabilities.** Not enabled on the account.
- **Production Plaid.** Everything here is Sandbox. Going live is its own gate.
