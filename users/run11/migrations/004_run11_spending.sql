-- users/run11/migrations/004_run11_spending.sql
--
-- Spec v3 adds a third screen, "Spending": a pie of the last 30 days of card
-- and bank transactions grouped into categories, and the transaction list
-- under it that the friend re-files from.
--
-- 003 vendored the shared Plaid envelope (modules/plaid/initial.sql, copied
-- byte-for-byte and NEVER edited — docs/dashboard-build-rules.md §9.3). This
-- file is everything run11 needs that the envelope does not give him, and it
-- is the second half of the same rule: a friend's own needs are met with
-- TABLES AND VIEWS IN THEIR OWN SCHEMA, on top of the shared shape, never by
-- changing the shared shape for one person.
--
-- ─── WHY THIS IS A NEW FILE AND NOT AN EDIT ────────────────────────────────
--
-- 001 and 002 have been applied. An applied migration is never edited
-- (2026-08-15 migrations design, D2); migrations/manifest.json's SHA-256 per
-- file is what enforces it. This file ships with a data-survival test in the
-- same commit (D3) — users/run11/tests/migrationV3.test.ts seeds the v2 shape,
-- applies 003 and then this file, and asserts the forecast, the walk log and
-- the settings row all survived.
--
-- IT ADDS AND NEVER ALTERS. Nothing in 001, 002 or the vendored 003 is
-- touched: no column dropped, no table rebuilt, no plaid_* table extended.
--
-- A MIGRATION NEVER SEEDS ROWS (D9). All three tables below are empty after
-- this runs. There is no starter set of categories, deliberately: Plaid's own
-- categorisation is what the screen starts from (spec v3 — "Categories come
-- from the transaction data's own categorisation to begin with"), and a
-- pre-seeded custom bucket would be this dashboard inventing a bucket the
-- friend did not ask for and cannot tell from one he made. The same goes for
-- category_visibility, which holds only choices he has actually made — see its
-- own comment for why that one is forced rather than chosen.
--
-- ─── FREE TEXT ARRIVES ON THIS DASHBOARD FOR THE FIRST TIME ────────────────
--
-- 001's and 002's headers both say "no free text anywhere in this shape", and
-- that stops being true here: custom_categories.name is a string the friend
-- TYPES. It is the only one, and the bound around it is worth stating because
-- it is not the bound around a number.
--
--   * It lives in HIS OWN SQLCipher database and nowhere else. It is never
--     written to `metrics` — app/api/users/[user]/spending-category/route.ts
--     emits the constant panel name and nothing derived from the value
--     (CLAUDE.md > Dashboard folder conventions: metrics never carry user
--     values). A bucket someone calls `divorce_lawyer_fund` is the example
--     CLAUDE.md itself uses, and it is exactly this column.
--   * It is never logged, and it never reaches a model: users/run11/notes/ and
--     users/run11/current.md describe SHAPE only, so no note may quote one.
--   * seed.py's names carry the loud TEST marker, which the columns in 001 and
--     002 had nowhere to put.
--
-- ─── SIGNS, BECAUSE THE PIE IS ARITHMETIC OVER THEM ────────────────────────
--
-- Nothing here stores an amount — the amount lives in the Plaid payload — but
-- the views below expose it, so the convention belongs with them. Plaid signs
-- an outflow POSITIVE and an inflow NEGATIVE. users/run11/queries.ts nets the
-- signed amounts per category rather than summing the positives, which is what
-- makes a refund reduce the category it came back from, and what makes a card
-- payment cancel against itself when both sides are connected.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE FRIEND'S OWN TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- The buckets he defines himself, beyond the ones Plaid's categorisation
-- produces (spec v3, `custom_categories`).
--
-- THE NAME IS THE KEY. A category is identified by its text throughout this
-- dashboard — an override row stores the same string, and a slice is drawn per
-- distinct string. A surrogate id would buy renaming, which was not asked for
-- and which would need a second control on a screen the friend described as a
-- picture.
--
-- COLLATE NOCASE so "Coffee" and "coffee" are one bucket and not two. Typing a
-- name that already exists is the same intent as choosing it, so the route
-- uses INSERT OR IGNORE and a re-typed name is a no-op rather than an error —
-- the same call 002's walk_log makes about marking a day twice.
--
-- A name identical to one of Plaid's own category keys simply merges with it.
-- That is a harmless collision and deliberately not defended against: the
-- alternative is this file carrying a copy of Plaid's category enum, which is
-- the hand-maintained derivative of someone else's contract that
-- modules/plaid/initial.sql exists to avoid.
CREATE TABLE IF NOT EXISTS custom_categories (
  name       TEXT PRIMARY KEY COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

-- The hand-chosen category for one synced transaction (spec v3,
-- `transaction_category_overrides`).
--
-- AN ANNOTATION, NOT AN EDIT, and that is the whole reason this table exists
-- rather than an UPDATE against plaid_transactions. The sync stream has three
-- verbs — added and modified UPSERT, removed DELETES (modules/plaid/initial.sql)
-- — so a category written into the synced row would be overwritten the next
-- time the merchant name got cleaned up or a pending charge settled. Keyed to
-- `transaction_id`, in the friend's own table, it survives every refresh
-- (CLAUDE.md > Schema & module rules).
--
-- ONE ROW PER TRANSACTION, so `transaction_id` is the primary key rather than
-- an id with a unique index: re-filing the same transaction twice is one fact,
-- not two, and the route upserts. There is no history of where a transaction
-- used to sit — not asked for, and a spending picture is a current statement
-- rather than a log of opinions about it.
--
-- NO FOREIGN KEY to plaid_transactions, and that is deliberate rather than an
-- omission. `removed` deletes a synced row, and Plaid can re-send a
-- transaction it previously removed; a cascade would silently destroy the
-- friend's re-filing at the moment his bank restated something, and a RESTRICT
-- would make the refresh route fail on a delete it is required to perform. An
-- override with no matching transaction is inert — every read below is a join
-- FROM the transaction — so the cost of keeping it is one dead short string
-- and the cost of enforcing it is losing a fact the friend entered by hand.
--
-- `category` is NOT constrained to the custom_categories set. It holds either
-- one of Plaid's own category keys or a name from that table, because moving a
-- transaction BACK to a Plaid category has to be expressible with the same
-- control that moved it out.
CREATE TABLE IF NOT EXISTS transaction_category_overrides (
  transaction_id TEXT PRIMARY KEY,
  category       TEXT NOT NULL,
  set_at         INTEGER NOT NULL
);

-- Which categories the friend has TICKED OR UNTICKED for the pie.
--
-- Not in spec v3's data requirements: it is Nico's call during the build
-- review, and it exists to answer that spec's own second open question —
-- "he hasn't said whether refunds, credits, transfers between his own
-- accounts, or card payments from the debit account should be excluded from
-- the pie … transfers in particular can dominate a spending breakdown and
-- make it read wrong". Hard-coding a blocklist would be this dashboard
-- forming an opinion about his money that he never asked it to form. A
-- checkbox makes it his, in the same shape as the re-filing spec v3 does ask
-- for.
--
-- ─── WHY THIS STORES A BOOLEAN AND NOT JUST A PRESENCE ─────────────────────
--
-- "Excluded" cannot be "has a row here", because the DEFAULT is conditional
-- rather than fixed: a category is ticked by default if it nets positive and
-- unticked by default if it does not. So both directions have to be
-- expressible as a deliberate choice — he must be able to untick a category
-- that would default to ticked, AND tick one that would default to unticked.
-- One column of presence can only say one of those.
--
-- ─── AND WHY THE DEFAULT IS NOT WRITTEN DOWN ───────────────────────────────
--
-- This table holds ONLY his explicit choices. A category he has never touched
-- has no row, and `resolveVisibility` in users/run11/queries.ts decides it at
-- READ time from the amount.
--
-- That is not a preference, it is forced. Writing a row the first time a $0
-- category was rendered would be the dashboard writing to his database on a
-- RENDER — the handle is read-only, and CLAUDE.md enumerates exactly two
-- things that may write to a friend's database, neither of which is a panel
-- drawing itself.
--
-- It is also simply better. A category that nets to zero this fortnight and
-- goes positive next month comes back on its own, instead of staying silently
-- switched off because of one quiet spell he was not watching.
--
-- CASE-SENSITIVE, unlike custom_categories above, and the difference is
-- deliberate. This column holds a CATEGORY KEY out of the view's COALESCE —
-- either one of Plaid's own keys or a bucket name — and those keys are
-- compared exactly everywhere else, so a NOCASE key here would fold 'TRAVEL'
-- and a bucket called 'Travel' into one row while the pie drew them as two
-- separate slices.
CREATE TABLE IF NOT EXISTS category_visibility (
  category TEXT PRIMARY KEY,
  -- 1 ticked, 0 unticked. Always his own press; never a computed default.
  included INTEGER NOT NULL,
  set_at   INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEWS OVER THE ENVELOPE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- modules/plaid/initial.sql stores Plaid's payload verbatim as JSON and gives
-- columns only to the keys a row is upserted or filtered on. Everything else
-- is reached with json_extract(), and a friend's shaping is a VIEW rather than
-- a migration against an encrypted database nobody can open — including Nico
-- (docs/dashboard-build-rules.md §9.2).
--
-- SQLite ships JSON1, so json_extract() needs no extension.
--
-- A view is CREATE VIEW IF NOT EXISTS, so changing one is a 005 that DROPs and
-- recreates it — not an edit here. No data moves when that happens, which is
-- the entire point of storing the payload whole.

-- Which accounts this screen counts.
--
-- THIS IS A PRODUCT DECISION IN SQL, and it is the one most worth reading.
-- Spec v3: "It covers a connected credit card and a connected debit card …
-- Both are spending sources and the screen covers them together rather than
-- separately". A debit card IS a checking account, so the rule is every
-- `credit` account plus every `depository` account whose subtype is
-- `checking`.
--
-- It is an ALLOW-LIST, and the risk that carries is named rather than hidden:
-- a bank that reports his debit account under some other depository subtype
-- would drop out of the screen. The panel therefore NAMES the accounts it is
-- counting, so an account missing from the picture is visible on screen rather
-- than silent — docs/dashboard-ui-ux-guidelines.md > States. The alternative,
-- every `depository` account, pulls savings, CD and money-market rows into a
-- spending pie, which is precisely the "transfers can dominate a spending
-- breakdown and make it read wrong" that spec v3's own open question warns
-- about. Widening this is a 005 and a one-line view change, with no data
-- moved.
CREATE VIEW IF NOT EXISTS spending_accounts AS
SELECT account_id                             AS account_id,
       json_extract(payload, '$.name')        AS name,
       json_extract(payload, '$.mask')        AS mask,
       json_extract(payload, '$.type')        AS type,
       json_extract(payload, '$.subtype')     AS subtype
  FROM plaid_accounts
 WHERE json_extract(payload, '$.type') = 'credit'
    OR (json_extract(payload, '$.type') = 'depository'
        AND json_extract(payload, '$.subtype') = 'checking');

-- One row per transaction on one of those accounts, with the category it
-- currently sits in already resolved.
--
-- `category` COALESCEs in priority order, and the order IS the feature: the
-- friend's override wins over Plaid's categorisation, which is what "the
-- change sticks — it survives future syncs and it is what the pie above is
-- drawn from" means (spec v3). Both panels read this one view, so the pie and
-- the list can never disagree about where a dollar sits.
--
-- The third arm is not defensive padding. Plaid returns
-- personal_finance_category as null on some transactions, and a null category
-- would collapse into a nameless slice; 'UNCATEGORIZED' is a bucket the friend
-- can see and re-file out of.
--
-- NO DATE FILTER HERE. The 30-day window needs `today`, which is handed to the
-- dashboard per request and cannot be baked into a view — users/run11/queries.ts
-- binds it. `date` is Plaid's own YYYY-MM-DD, stored as given and never
-- derived from a clock, so a window is a string comparison.
CREATE VIEW IF NOT EXISTS spending_transactions AS
SELECT t.transaction_id                                    AS transaction_id,
       t.date                                              AS day,
       t.account_id                                        AS account_id,
       a.name                                              AS account_name,
       a.mask                                              AS account_mask,
       json_extract(t.payload, '$.merchant_name')          AS merchant,
       json_extract(t.payload, '$.name')                   AS description,
       json_extract(t.payload, '$.amount')                 AS amount,
       json_extract(t.payload, '$.pending')                AS pending,
       json_extract(t.payload, '$.personal_finance_category.primary') AS plaid_category,
       o.category                                          AS override_category,
       COALESCE(
         o.category,
         json_extract(t.payload, '$.personal_finance_category.primary'),
         'UNCATEGORIZED'
       )                                                   AS category
  FROM plaid_transactions t
  JOIN spending_accounts a
    ON a.account_id = t.account_id
  LEFT JOIN transaction_category_overrides o
    ON o.transaction_id = t.transaction_id;
