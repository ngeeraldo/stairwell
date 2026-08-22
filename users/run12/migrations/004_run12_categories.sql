-- users/run12/migrations/004_run12_categories.sql
--
-- NICO'S CALL AT THE BUILD REVIEW, not spec v1. The spec asks for a picture and
-- nothing else; this adds the three things he asked for after seeing it:
--
--   1. the friend can SEE the transactions behind the pie, so he can audit what
--      is going into every category;
--   2. he can make a category of his own and MOVE a transaction into it, and
--      the move survives every future refresh;
--   3. he can CHOOSE which categories are in the pie and in the percentages.
--
-- ─── WHY THIS IS A NEW FILE AND NOT AN EDIT ────────────────────────────────
--
-- 001, 002 and 003 have been applied. An applied migration is never edited
-- (2026-08-15 migrations design, D2); migrations/manifest.json's SHA-256 per
-- file is what enforces it. This ships with a data-survival test in the same
-- commit (D3) — users/run12/tests/migrations.test.ts seeds the v3 shape,
-- applies this file, and asserts the synced rows came through.
--
-- 003 said this would happen and named the shape it would take: "the first
-- thing spec v2 asks for that a friend can type or press becomes a 004 with a
-- table in it, on top of these, with nothing here moved." That is this file.
--
-- ─── FREE TEXT ARRIVES ON THIS DASHBOARD FOR THE FIRST TIME ────────────────
--
-- 003's header says "no free text arrives here" and that stops being true now:
-- `custom_categories.name` is a string the friend TYPES. It is the only one,
-- and the bound around it is not the bound around a number.
--
--   * It lives in HIS OWN SQLCipher database and nowhere else. It is never
--     written to `metrics` — app/api/users/[user]/spending-breakdown/route.ts
--     emits a constant panel name and nothing derived from the value
--     (CLAUDE.md: metrics never carry user values). A bucket someone calls
--     `divorce_lawyer_fund` is the example CLAUDE.md itself uses, and it is
--     exactly this column.
--   * It is never logged, and it never reaches a model: users/run12/notes/ and
--     users/run12/current.md describe SHAPE only, so no note may quote one.
--   * seed.py's names carry the loud TEST marker, which 001-003 had nowhere to
--     put.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE FRIEND'S OWN TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- The buckets he names himself, beyond the ones Plaid's categorisation gives.
--
-- THE NAME IS THE KEY. A category is identified by its text throughout this
-- dashboard — an override row stores the same string, a visibility row stores
-- the same string, and a slice is drawn per distinct string. A surrogate id
-- would buy renaming, which was not asked for and would need a second control
-- on a screen whose whole point is a picture.
--
-- COLLATE NOCASE so "Coffee" and "coffee" are one bucket and not two. Typing a
-- name that already exists is the same intent as choosing it, so the route uses
-- INSERT OR IGNORE and a re-typed name is a no-op rather than an error.
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

-- The hand-chosen category for one synced transaction.
--
-- AN ANNOTATION, NOT AN EDIT, and that is the whole reason this table exists
-- rather than an UPDATE against plaid_transactions. The sync stream has three
-- verbs — added and modified UPSERT, removed DELETES — so a category written
-- into the synced row would be overwritten the next time a merchant name got
-- cleaned up or a pending charge settled. Keyed to `transaction_id`, in the
-- friend's own table, it survives every refresh (CLAUDE.md > Schema & module
-- rules). That is what "this should obviously remain permanent as new data
-- comes in via refresh" means mechanically.
--
-- ONE ROW PER TRANSACTION, so `transaction_id` is the primary key rather than
-- an id with a unique index: re-filing the same transaction twice is one fact,
-- not two, and the route upserts. There is no history of where a transaction
-- used to sit — a spending picture is a current statement, not a log of
-- opinions about it.
--
-- NO FOREIGN KEY to plaid_transactions, deliberately rather than by omission.
-- `removed` deletes a synced row, and Plaid can re-send a transaction it
-- previously removed; a cascade would silently destroy the friend's re-filing
-- at the moment his bank restated something, and a RESTRICT would make the
-- shared refresh route fail on a delete it is required to perform. An override
-- with no matching transaction is inert — every read below is a join FROM the
-- transaction — so the cost of keeping it is one dead short string and the cost
-- of enforcing it is losing a fact the friend entered by hand.
--
-- `category` is NOT constrained to the custom_categories set. It holds either
-- one of Plaid's own category keys or a name from that table, because moving a
-- transaction BACK to a bank category has to be expressible with the same
-- control that moved it out.
CREATE TABLE IF NOT EXISTS transaction_category_overrides (
  transaction_id TEXT PRIMARY KEY,
  category       TEXT NOT NULL,
  set_at         INTEGER NOT NULL
);

-- Which categories he has TICKED OR UNTICKED for the pie.
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
-- has no row, and `resolveVisibility` in users/run12/queries.ts decides it at
-- READ time from the amount.
--
-- That is not a preference, it is forced. Writing a row the first time a $0
-- category was rendered would be the dashboard writing to his database on a
-- RENDER — the handle is read-only, and CLAUDE.md enumerates exactly two things
-- that may write to a friend's database, neither of which is a panel drawing
-- itself.
--
-- It is also simply better. A category that nets to zero this fortnight and
-- goes positive next month comes back on its own, instead of staying silently
-- switched off because of one quiet spell he was not watching.
--
-- CASE-SENSITIVE, unlike custom_categories above, and the difference is
-- deliberate. This column holds a CATEGORY KEY out of the view's COALESCE —
-- either one of Plaid's own keys or a bucket name — and those keys are compared
-- exactly everywhere else, so a NOCASE key here would fold 'TRAVEL' and a
-- bucket called 'Travel' into one row while the pie drew them as two slices.
CREATE TABLE IF NOT EXISTS category_visibility (
  category TEXT PRIMARY KEY,
  -- 1 ticked, 0 unticked. Always his own press; never a computed default.
  included INTEGER NOT NULL,
  set_at   INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- THE TRANSACTION VIEW, REBUILT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 003 created `spending_transactions` as CREATE VIEW IF NOT EXISTS and its own
-- header states the consequence: "changing one is a 004 that DROPs and
-- recreates it — not an edit here. No data moves when that happens, which is
-- the entire point of storing the payload whole." This is that DROP.
--
-- `spending_accounts` is NOT touched: the account allow-list has not changed.
DROP VIEW IF EXISTS spending_transactions;

-- One row per transaction on one of those accounts, with the category it
-- currently sits in already resolved.
--
-- READ THROUGH `plaid_accounts` — via `spending_accounts` — exactly as 003 did.
-- That JOIN is what keeps an account the friend removed in Plaid Link off his
-- screen, and `tests/users/plaidTransactionJoin.test.ts` fails the suite for a
-- statement that does not (docs/dashboard-build-rules.md §9.6).
--
-- `category` COALESCEs in priority order, and THE ORDER IS THE FEATURE: the
-- friend's override wins over Plaid's categorisation. Both panels read this one
-- view, so the pie and the list can never disagree about where a dollar sits.
--
-- The third arm is not defensive padding. Plaid returns
-- personal_finance_category as null on some transactions, and a null category
-- would collapse into a nameless slice; 'UNCATEGORIZED' is a bucket the friend
-- can see and re-file out of.
--
-- ─── AN OVERRIDE CLEARS `is_internal`, AND THAT IS A DECISION ──────────────
--
-- 003 flags income, both directions of transfer, and a credit-card payment as
-- internal — money moving between his own accounts rather than money spent —
-- and `categoryTotals` keeps those out of the percentages.
--
-- A row he has RE-FILED BY HAND is no longer flagged, whatever Plaid called it.
-- The alternative was tried on paper and is worse: he moves a transaction,
-- presses Move, and the pie does not change, with nothing on screen explaining
-- why. A control that silently does nothing for one class of row is a broken
-- control, and re-filing is exactly the act of saying "this belongs here"
-- louder than the bank's own guess.
--
-- The risk that carries is named rather than hidden: re-filing a card payment
-- into a real bucket makes it count as spending alongside the charges the card
-- already carries, which is the double-count 003's flag exists to prevent. Two
-- things make that recoverable rather than silent — the transaction list marks
-- every row that is not counted, so he can see what he changed, and the
-- legend's tick box removes the whole category from the pie in one press.
--
-- NO DATE FILTER HERE. The 30-day window needs `today`, which is handed to the
-- dashboard per request and cannot be baked into a view — users/run12/queries.ts
-- binds it. `date` is Plaid's own YYYY-MM-DD, stored as given and never derived
-- from a clock, so a window is a plain string comparison.
CREATE VIEW IF NOT EXISTS spending_transactions AS
SELECT t.transaction_id                                    AS transaction_id,
       t.date                                              AS day,
       t.account_id                                        AS account_id,
       a.item_id                                           AS item_id,
       a.name                                              AS account_name,
       a.mask                                              AS account_mask,
       json_extract(t.payload, '$.merchant_name')          AS merchant,
       json_extract(t.payload, '$.name')                   AS description,
       json_extract(t.payload, '$.amount')                 AS amount,
       json_extract(t.payload, '$.pending')                AS pending,
       json_extract(t.payload, '$.personal_finance_category.primary')  AS plaid_category,
       json_extract(t.payload, '$.personal_finance_category.detailed') AS plaid_detail,
       o.category                                          AS override_category,
       COALESCE(
         o.category,
         json_extract(t.payload, '$.personal_finance_category.primary'),
         'UNCATEGORIZED'
       )                                                   AS category,
       CASE
         WHEN o.category IS NOT NULL THEN 0
         WHEN json_extract(t.payload, '$.personal_finance_category.primary')
              IN ('INCOME', 'TRANSFER_IN', 'TRANSFER_OUT') THEN 1
         WHEN json_extract(t.payload, '$.personal_finance_category.detailed')
              = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' THEN 1
         ELSE 0
       END                                                 AS is_internal
  FROM plaid_transactions t
  JOIN spending_accounts a
    ON a.account_id = t.account_id
  LEFT JOIN transaction_category_overrides o
    ON o.transaction_id = t.transaction_id;
