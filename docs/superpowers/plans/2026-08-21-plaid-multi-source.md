# Plaid Multi-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **This plan has HUMAN GATES.** Stop at each 🔍 and do not continue until Nico
> clears it.
>
> **NICO COMMITS, NOT THE AGENT.** No step here runs `git commit`.

**Goal:** Let a friend connect, inspect, hide and remove more than one bank —
and make the sync layer safe for a second connection, which it currently is not.

**Architecture:** `plaid_items` already keys on `item_id` and `plaid_accounts`
already carries one, so the ENVELOPE is already multi-source. What assumes a
single item is the sync layer and four routes. Disconnect becomes a SOFT delete
so a kept history can say it is no longer updating, and a separate louder action
deletes for real.

**Tech Stack:** Unchanged — `plaid` SDK confined to `lib/plaid/client.ts`,
SQLCipher, SQLite JSON1, vitest.

**Spec:** This document. Predecessor:
`docs/superpowers/plans/2026-08-20-plaid-connection.md`, whose D1–D7 and F1–F9
still hold except where D-numbers below supersede them.

**Branch:** its own. Not `main`.

---

## Why this is urgent, not cosmetic

Nico found it by looking at a shipped screen: once a friend connects, there is
no control to add, inspect or remove a source. That is the visible half. The
invisible half is worse, and it is in `lib/plaid/sync.ts`:

```
lib/plaid/sync.ts:96    UPDATE plaid_items SET cursor = ?     <- no WHERE clause
```

With one item that is correct. **With two, refreshing either overwrites both
cursors** — and a cursor claiming data you do not have is the one failure with
no repair, because Plaid never re-sends it. The same shape is in `replaceAll`:
an unscoped `DELETE FROM plaid_accounts` means syncing bank A wipes bank B's
accounts, holdings and recurring streams.

`app/api/users/[user]/plaid/connect/route.ts:147` does `DELETE FROM plaid_items`
before inserting, so a second connect silently replaces the first — and because
disconnect deliberately keeps synced rows, the replaced bank's transactions
survive with no item that can ever refresh them. Permanently frozen, and
indistinguishable on screen from live data.

**So the missing button was the only thing preventing a data-corruption path.**
Whatever else this plan does, that must stop being true.

---

## The four product decisions, answered

Researched against established finance apps rather than invented. Any of them
can be reversed; each names what would change.

### D1 — Removing a source: BOTH, and "keep" must say it is static

Monarch Money splits this in two, and the split is the useful part:

- **"Connection only"** — stop syncing, keep account/transaction/balance
  history. *"The account will become static and will no longer update."*
- **Delete connection** — removes the institution and every account under it,
  permanently, including history.

Ours today keeps the data and says nothing, which is how the orphan appears. So:

- **Disconnect** revokes at Plaid and keeps the rows — but is a SOFT delete.
  The `plaid_items` row survives with `disconnected_at` set, so every panel can
  say *"no longer updating"*. That single column is what turns an orphan into a
  stated fact.
- **Remove and delete** is a second, louder action that deletes the item row and
  every `plaid_*` row belonging to it.

**Reverse it by** dropping the second action and keeping only soft disconnect;
nothing else in the plan changes.

### D2 — Hide without disconnecting: YES, a distinct action

Monarch treats hiding as separate from deleting: hide from the account list,
from net worth, from cash flow, independently, with history preserved.

This codebase already has the pattern — run11's category tick boxes hide a
slice without touching its transactions, and the visibility default is resolved
at READ time so an unpressed category has no row. **Follow that exactly**: a
`plaid_source_visibility`-shaped choice storing only real presses, never a
materialised default.

**Reverse it by** cutting the hide action; disconnect then does double duty,
badly, because it also stops the data updating.

### D3 — Show the institution's name, and it costs nothing

`/item/get` already returns `institution_name` — it is in the Phase 1 probe
output (`First Platypus Bank`). `lib/plaid/client.ts`'s `getItem` simply does
not extract it, and `connect` stores `payload` as `'{}'`.

So: extract it, store it. **No new Plaid call.** A friend must be able to tell
two sources apart, and `ins_109508` is not a name.

### D4 — Source management is REQUIRED, and identical on every finance dashboard

Not offered — required. Every dashboard that vendors the Plaid module renders
the same management surface, with the same capabilities, from the same shared
component. A builder does not get to decide which subset its friend gets.

**This is the decision whose absence caused this plan.** §9.5 listed the
controls as available components; the run11 builder wired up exactly what the
spec asked for and no more, and shipped a screen a friend could connect to once
and never manage again. Nothing was violated. There was nothing to violate.

Uniform because the capabilities are not a design question: a friend who
connects a bank can always add another, see when each last updated, hide one,
reconnect a broken one, and remove one. A dashboard that offered three of those
would leave a friend stuck in a state with no way out, and which three would
vary per friend for no reason either of them chose.

**A doc line is not enough** — that is what failed. Phase 4 adds a conditional
sweep: a folder with a vendored `_module_plaid` migration whose `dashboard.tsx`
does not render the shared surface fails the suite. The condition is a file's
presence, so it needs no judgement about whether a dashboard "is financial".

**Reverse it by** making the surface optional again, which reinstates exactly
the gap this plan exists to close.

---

## Considered and deferred: Plaid's Multi-Item Link

Plaid has a first-class flow for connecting several institutions in one Link
session. **Not used, for a specific reason worth recording:** its `onSuccess`
callback is EMPTY, and public tokens arrive by `SESSION_FINISHED` webhook.

This app can never consume a webhook — a friend's data key exists only while
they are unlocked, so nothing can write to their database unattended.

It is not impossible: `/link/token/get` returns the same tokens as a PULL, which
a route could call from the friend's own session. But it trades a mechanism we
have tested end-to-end for one we have not, to save a friend with two or three
banks a few taps. **Revisit if someone connects five.**

---

## Global Constraints

Verbatim from CLAUDE.md and the predecessor plan. Every task inherits these.

- **`modules/plaid/initial.sql` IS FROZEN.** It is applied to run11's
  production database. Schema changes are a NEW module file, vendored as the
  next numbered migration in each finance folder, with a data-survival test in
  the same commit.
- **All dev and testing on synthetic data ONLY.** Never open a `*.db` that is
  not `synthetic.db`.
- **Metrics never carry user values** — slug and panel, never an institution
  name, an item id, a count or a balance.
- **Nothing writes to a friend's database except from their own session.** No
  scheduled job, no webhook, no login sync.
- **A dashboard holds a read-only handle**, imports no `lib/plaid/`, and writes
  no `plaid_*` table. Exactly one thing does: the refresh route.
- **An access token never leaves the friend's encrypted database** — not to a
  response body, a log line, or a metric.
- **Every third-party client is injected**; no default-suite test reaches the
  network. Live tests are `*.live.test.ts`, opt-in via `npm run test:live`.
- **Never log a raw Plaid error object** — it carries `PLAID-SECRET` in its
  request headers. Pass a `PlaidCallError` (which has a `code`) to
  `logDbFailure`.
- **The four ordered auth checks are copied verbatim into every route** and
  never abstracted.

---

## File structure

| Path | Change |
|---|---|
| `modules/plaid/002_multi_source.sql` | **NEW.** `plaid_items.disconnected_at`, `plaid_items.institution_name`, `plaid_refreshes.item_id`, `plaid_source_visibility` |
| `modules/plaid/seed_plaid.py` | seed TWO items, one of them disconnected |
| `lib/plaid/client.ts` | `getItem` extracts `institutionName` |
| `lib/plaid/sync.ts` | **every writer scoped by `item_id`** — the core of this plan |
| `app/api/users/[user]/plaid/connect/route.ts` | stop deleting; upsert by `item_id` |
| `app/api/users/[user]/plaid/refresh/route.ts` | loop items; outcomes per item+product |
| `app/api/users/[user]/plaid/disconnect/route.ts` | soft delete; takes an `item_id`; gains a `remove` action |
| `app/api/users/[user]/plaid/link-token/route.ts` | update mode takes an `item_id`; absent = new connection |
| `app/api/users/[user]/plaid/sources/route.ts` | **NEW.** hide/show a source |
| `lib/ui/PlaidSources.tsx` | **NEW.** the shared management surface |
| `docs/dashboard-build-rules.md` §9.5/§9.6 | require a management surface; per-source states |

---

## Phase 1 — Make the sync layer multi-item safe

**No UI. Nothing user-visible. This is the phase that removes the landmine.**

- [ ] **Write the failing tests first**, in `tests/plaid/sync.test.ts`, with TWO
      items seeded:
      - refreshing item A leaves item B's cursor untouched
      - refreshing item A leaves item B's accounts, holdings and recurring
        streams present
      - each item's transactions upsert without disturbing the other's
- [ ] **Run them. They must FAIL** — that is the proof the landmine is real.
- [ ] **Scope every writer by `item_id`.** `applyTransactionPage` takes an item;
      `setCursor` gains a `WHERE item_id = ?`; `replaceAll` gains a scope
      predicate so a delete only removes the item's own rows.
      **`plaid_transactions` has no `item_id` column** — scope it through
      `plaid_accounts`, or add the column in the module migration. Decide in
      Phase 2 and keep Phase 1's tests passing either way.
- [ ] **Re-run. They must pass.**
- [ ] **Mutation-check the cursor scope**: remove the `WHERE` and confirm the
      cross-contamination test goes red. A test that cannot fail is not a test.

### 🔍 GATE 1 — the landmine is gone
Nico confirms the two-item tests exist, fail without the fix, and pass with it.

---

## Phase 2 — The module migration

- [ ] **Write `modules/plaid/002_multi_source.sql`.** `initial.sql` is frozen —
      do not touch it.
      - `plaid_items.disconnected_at INTEGER` (null = live) — D1
      - `plaid_items.institution_name TEXT` — D4
      - `plaid_refreshes.item_id TEXT` — so a panel can say WHICH source failed
      - `plaid_source_visibility(item_id TEXT PRIMARY KEY, visible INTEGER,
        set_at INTEGER)` — D3, holding only real presses
- [ ] **Vendor it into every finance folder** as the next free number, and
      regenerate each manifest. **Ship a data-survival test in the same commit**
      that seeds the old shape, migrates, and asserts rows survived.
- [ ] **Update `seed_plaid.py` to seed TWO items**, one `disconnected_at`, so
      every finance dashboard renders the multi-source states by default. Keep
      the loudly-fake token shape.
- [ ] **`getItem` extracts `institutionName`; `connect` stores it.**

### 🔍 GATE 2 — Nico reviews the migration
The vendored file is byte-identical to the module source, every manifest
matches, and the survival test seeds real rows rather than counts.

---

## Phase 3 — Routes

- [ ] **`connect`**: remove `DELETE FROM plaid_items`; upsert on `item_id`.
      **Reconnecting the same institution must update the existing row, not add
      a second** — Plaid issues a new `item_id` per connection, so match on
      `institution_id` to avoid a duplicate the friend cannot tell apart.
- [ ] **`refresh`**: loop live items (`disconnected_at IS NULL`). One item's
      failure never stops another — the existing per-product partial-success
      logic extends to per-item. Record `item_id` on every `plaid_refreshes` row.
- [ ] **`disconnect`**: takes an `item_id`; revokes at Plaid; sets
      `disconnected_at`. A second `action=remove` deletes the item and all its
      rows (D1).
- [ ] **`link-token`**: an `item_id` means update mode for THAT item; absent
      means a new connection. Today it silently picks the oldest.
- [ ] **`sources`**: NEW route, hide/show, taking `show`/`hide` and never a
      toggle — two presses racing must not land where neither asked.
- [ ] **Tests** for each: the four ordered checks, and that an `item_id` from
      the caller is checked against the friend's OWN items before anything is
      written.

### 🔍 GATE 3 — Nico reviews the routes

---

## Phase 4 — The management surface

- [ ] **`lib/ui/PlaidSources.tsx`** — shared, rendered by a dashboard, like
      `PlaidConnect`. Per source: institution name, last-updated time, status,
      and hide / reconnect / disconnect / remove.
- [ ] **It must show, per source:** live · never refreshed · no longer updating
      (disconnected) · needs re-login · hidden. D2's still-backfilling case is
      "never refreshed" plus a live connection.
- [ ] **Add "Connect another bank"** to the connected state — the control whose
      absence started this.
- [ ] **A last-updated time next to every refresh control**
      (`docs/dashboard-ui-ux-guidelines.md` > States).
- [ ] **Enforce D4 with a conditional sweep**, in `tests/users/conventions.test.ts`
      or beside it: every folder holding a vendored `_module_plaid` migration
      must render the shared surface in its `dashboard.tsx`. Presence of the
      migration is the condition, so nothing has to judge whether a dashboard is
      "financial". **Write it before the last dashboard is wired, and watch it
      fail** — a sweep that was green the first time it ran has proved nothing.
- [ ] **Docs**: §9.5 REQUIRES the management surface and names the capability
      set as fixed (D4), rather than listing parts a builder may choose from;
      §9.6 gains the per-source states.

### 🔍 GATE 4 — Nico in a browser
Connect two banks. Refresh. Confirm **both** cursors advanced and neither bank's
accounts vanished — the landmine, observed rather than unit-tested. Hide one and
watch the picture rescale. Disconnect one and confirm it says *no longer
updating* rather than disappearing or silently going stale. Remove it and
confirm its rows are gone.

---

## Deliberately not in this plan

- **Multi-Item Link** — see above; the webhook dependency is the blocker.
- **Any automatic or scheduled refresh.** Still impossible, still by design.
- **A per-account (rather than per-source) hide.** Monarch has it; nobody has
  asked, and the category tick boxes already cover the case that motivated it.
- **Institution logos.** `/institutions/get_by_id` returns them; a name is
  enough to tell two banks apart, and a logo is a third-party image fetch from
  a page that currently makes none.

## Sources

- https://help.monarch.com/hc/en-us/articles/360054863431-Delete-a-Connection-Financial-Institution-vs-Delete-an-Account
- https://help.monarch.com/hc/en-us/articles/4407859794580-Hiding-an-Account
- https://plaid.com/docs/link/multi-item-link/
- https://plaid.com/docs/link/best-practices/
