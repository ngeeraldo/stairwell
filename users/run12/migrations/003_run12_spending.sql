-- users/run12/migrations/003_run12_spending.sql
--
-- Spec v1: one screen, "Spending Breakdown", carrying one panel — a pie of the
-- last 30 days of spending by category, every category shown, each labelled
-- with its share, biggest first, from a connected checking account and a
-- connected credit card combined into one view.
--
-- 001 and 002 vendored the shared Plaid envelope (modules/plaid/initial.sql and
-- modules/plaid/002_multi_source.sql, copied byte-for-byte and NEVER edited —
-- docs/dashboard-build-rules.md §9.3). This file is everything run12 needs that
-- the envelope does not give him, and it is the second half of the same rule: a
-- friend's own needs are met with VIEWS IN HIS OWN SCHEMA, on top of the shared
-- shape, never by changing the shared shape for one person.
--
-- ─── IT CREATES NO TABLES, AND THAT IS THE WHOLE SHAPE ─────────────────────
--
-- Spec v1 asks for a picture and nothing else. There is no control on this
-- screen that writes: no re-filing, no custom buckets, no tick boxes, no notes.
-- So run12 stores nothing of its own — every row on screen came from his bank
-- through the shared platform routes, and this file is two views that reshape
-- them.
--
-- That is worth stating rather than leaving as an absence, because it is what
-- makes the NEXT version cheap: the first thing spec v2 asks for that a friend
-- can type or press becomes a 004 with a table in it, on top of these, with
-- nothing here moved. A view is CREATE VIEW IF NOT EXISTS, so changing one is a
-- 004 that DROPs and recreates it — never an edit to this file. No data moves
-- when that happens, which is the entire point of storing the payload whole.
--
-- A MIGRATION NEVER SEEDS ROWS (2026-08-15 migrations design, D9). Nothing
-- below inserts anything, and there is nothing it could insert into.
--
-- ─── NO FREE TEXT ARRIVES HERE ─────────────────────────────────────────────
--
-- Nothing in this file stores a string the friend types — he cannot type
-- anything on this screen. Every text value the panel renders (a merchant, an
-- account name, a category key) is Plaid's, read back out of the stored payload
-- at read time and never copied into a column of run12's own.
--
-- ─── SIGNS, BECAUSE THE PIE IS ARITHMETIC OVER THEM ────────────────────────
--
-- Nothing here stores an amount — the amount lives in the Plaid payload — but
-- the second view exposes it, so the convention belongs with them. Plaid signs
-- an OUTFLOW POSITIVE and an INFLOW NEGATIVE. users/run12/queries.ts NETS the
-- signed amounts per category rather than summing the positives, which is what
-- makes a refund reduce the category it came back from instead of counting a
-- charge he got his money back on as money he spent.

-- ─────────────────────────────────────────────────────────────────────────────
-- WHICH ACCOUNTS THIS SCREEN COUNTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THIS IS A PRODUCT DECISION IN SQL. Spec v1: "The underlying transactions come
-- from bank data via a connected checking account and a connected credit card,
-- both of which Nico will link; spending from both accounts is combined into
-- one view rather than split per account."
--
-- So the rule is every `credit` account plus every `depository` account whose
-- subtype is `checking`.
--
-- IT IS AN ALLOW-LIST, and the risk that carries is named rather than hidden: a
-- bank reporting his current account under some other depository subtype would
-- drop out of the picture silently. The panel therefore NAMES the accounts it
-- is counting, on screen, so a missing account is visible rather than invisible
-- (docs/dashboard-ui-ux-guidelines.md > States). The alternative — every
-- `depository` account — pulls savings, CD, money-market and HSA balances into a
-- spending pie, and every transfer into one of them reads as a spending
-- category, which is precisely the failure spec v1's own third open question
-- warns about. Widening this is a 004 and a one-line view change, with no data
-- moved.
--
-- ITEM_ID IS CARRIED THROUGH, and it is not decoration. A bank he disconnects
-- keeps every row it ever brought (a soft delete — docs/dashboard-build-rules.md
-- §9.6), so those transactions are still inside this window and still in the
-- pie. That is the honest answer for "where did my money go" — the money did go
-- — but it means the panel is drawing partly frozen data, and the panel says so
-- by name. It cannot say so without knowing which bank each row came from.
CREATE VIEW IF NOT EXISTS spending_accounts AS
SELECT a.account_id                           AS account_id,
       a.item_id                              AS item_id,
       json_extract(a.payload, '$.name')      AS name,
       json_extract(a.payload, '$.mask')      AS mask,
       json_extract(a.payload, '$.type')      AS type,
       json_extract(a.payload, '$.subtype')   AS subtype
  FROM plaid_accounts a
 WHERE json_extract(a.payload, '$.type') = 'credit'
    OR (json_extract(a.payload, '$.type') = 'depository'
        AND json_extract(a.payload, '$.subtype') = 'checking');

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE ROW PER TRANSACTION ON ONE OF THOSE ACCOUNTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- READ THROUGH `plaid_accounts` — via `spending_accounts`, which is a view over
-- it — and NOT from `plaid_transactions` alone. That JOIN is what keeps an
-- account the friend removed off his screen: Plaid's account picker only ever
-- ADDS, so an account he unticks loses its `plaid_accounts` row on the next
-- refresh while every transaction under it stays. Querying the transaction
-- table on its own would keep counting a card he removed, forever, with nothing
-- on screen to explain it. `tests/users/plaidTransactionJoin.test.ts` fails the
-- suite for a statement that does not (docs/dashboard-build-rules.md §9.6).
--
-- NO DATE FILTER HERE. The 30-day window needs `today`, which is handed to the
-- dashboard per request and cannot be baked into a view — users/run12/queries.ts
-- binds it. `date` is Plaid's own YYYY-MM-DD, stored as given and never derived
-- from a clock, so a window is a plain string comparison.
--
-- ─── `is_internal`: THE ONE JUDGEMENT THIS FILE MAKES ──────────────────────
--
-- Spec v1's third open question, handed to the builder by name: "Transfers
-- between the checking account and the credit card (for example, card payments)
-- could be double-counted or show up as a spending category. Builder should
-- decide how to exclude internal transfers so the percentages reflect actual
-- spending."
--
-- Two mechanisms answer it together, and neither is sufficient alone:
--
--   1. NETTING (users/run12/queries.ts). Signed amounts are netted per
--      category, so a refund reduces the category it came back from, and a
--      card payment whose BOTH SIDES are connected cancels against itself —
--      it leaves the current account as an outflow and lands on the card as an
--      inflow under the same category.
--
--   2. THIS FLAG. Netting only cancels a transfer whose other side is also on
--      screen. A transfer to an account this screen does not cover — his
--      savings, someone else's account — has nothing to cancel against and
--      would land as a large slice that is not spending. Spec v1 asks for a
--      picture with no controls on it, so unlike a dashboard that could offer
--      him a tick box, this one has to decide. It decides by Plaid's own
--      categorisation and then SAYS SO ON SCREEN, with a count, so the
--      decision is visible rather than silent.
--
-- WHAT IS FLAGGED, AND WHY EACH:
--
--   INCOME        Money arriving. A pie of where money WENT cannot have a
--                 slice for money that came in; left in, it also nets against
--                 nothing and distorts every share below it.
--   TRANSFER_IN   His own money moving between his own accounts. Both
--   TRANSFER_OUT  directions are flagged: a transfer whose other side is
--                 connected must not be half-counted, and one whose other side
--                 is not connected must not be counted at all.
--   LOAN_PAYMENTS_CREDIT_CARD_PAYMENT
--                 Paying the card off from the checking account. Plaid files
--                 this under LOAN_PAYMENTS rather than TRANSFER_OUT, and it is
--                 exactly the "for example, card payments" the spec names.
--
-- WHAT IS DELIBERATELY *NOT* FLAGGED: every other LOAN_PAYMENTS detail — a
-- mortgage, a car loan, a student loan. Those are money leaving his accounts
-- and not coming back, which is spending in the only sense this screen means,
-- and a friend whose rent-sized mortgage vanished from his own spending picture
-- would be looking at a chart that quietly disagrees with his bank. This is why
-- the flag reads the DETAILED key for that one case and the PRIMARY key for the
-- other three: LOAN_PAYMENTS is the only family that is internal in part.
--
-- The flag is computed rather than filtered here so that the panel can COUNT
-- what it left out and name it. A view that simply dropped these rows would
-- make the exclusion unprovable from the screen, which is the silent version of
-- exactly the thing the spec asked to have handled.
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
       -- 'UNCATEGORIZED' rather than NULL: Plaid returns
       -- personal_finance_category as null on some transactions, and a null
       -- would collapse into a nameless slice the friend cannot read. A named
       -- bucket explains itself.
       COALESCE(
         json_extract(t.payload, '$.personal_finance_category.primary'),
         'UNCATEGORIZED'
       )                                                   AS category,
       CASE
         WHEN json_extract(t.payload, '$.personal_finance_category.primary')
              IN ('INCOME', 'TRANSFER_IN', 'TRANSFER_OUT') THEN 1
         WHEN json_extract(t.payload, '$.personal_finance_category.detailed')
              = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' THEN 1
         ELSE 0
       END                                                 AS is_internal
  FROM plaid_transactions t
  JOIN spending_accounts a
    ON a.account_id = t.account_id;
