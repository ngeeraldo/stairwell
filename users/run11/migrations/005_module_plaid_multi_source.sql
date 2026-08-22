-- modules/plaid/002_multi_source.sql
--
-- MORE THAN ONE BANK. The envelope in initial.sql already keyed on item_id, so
-- this migration is not what makes a second connection possible — it is what
-- makes a second connection SAFE to remove, describe, and tell apart.
--
-- initial.sql IS FROZEN. It has been applied to real databases, and a
-- migration is added, never edited (CLAUDE.md > Schema & module rules). This
-- file is vendored into a friend's own migrations/ exactly like initial.sql
-- was, as the next free number:
--
--     cp modules/plaid/002_multi_source.sql \
--        users/<slug>/migrations/00N_module_plaid_002_multi_source.sql
--
-- ─── WHAT THIS FIXES, IN THE ORDER IT MATTERS ───────────────────────────────
--
-- 1. EVERY SYNCED ROW LEARNS WHICH BANK IT CAME FROM.
--
--    Plaid keys transactions, holdings, recurring streams and investment
--    transactions by ACCOUNT and never mentions the item. Before this file,
--    the only way to ask "what came from Capital One" was to join back through
--    plaid_accounts — which fails in exactly the case a friend cares about:
--    an account that has since closed is gone from plaid_accounts, so its
--    transactions are unreachable. "Delete this bank and everything it
--    brought" would silently leave them behind, in a database nobody can open
--    to go and find them.
--
--    So the bank is stamped on the row itself. A delete is then exact, and
--    a snapshot refresh scopes to one bank without consulting another table.
--
--    plaid_securities is deliberately NOT stamped. A security belongs to no
--    one — two brokerages holding the same fund report the same security_id —
--    which is why sync.ts upserts it and never deletes it.
--
-- 2. DISCONNECTING BECOMES A STATED FACT RATHER THAN A DISAPPEARANCE.
--
--    Revoking at Plaid keeps the friend's history, which is the point, but
--    before this file it also removed the only row that proved the connection
--    had ever existed. The history stayed on screen looking live, and nothing
--    could ever refresh it. `disconnected_at` is what lets a panel say "no
--    longer updating" instead of quietly showing frozen numbers as current.
--
-- 3. A SOURCE CAN SAY ITS OWN NAME.
--
--    /item/get returns institution_name for free — it is in the same response
--    the connect route already makes. `ins_109508` is not a name, and a friend
--    with two banks needs to tell them apart before any control means
--    anything.
--
-- 4. A FAILED REFRESH CAN NAME WHICH BANK FAILED.
--
--    plaid_refreshes recorded the product and the outcome. With two banks,
--    "transactions failed" is unactionable: one bank may be perfectly healthy.
--    Rows written before this migration keep a NULL item_id — an append-only
--    table does not get to invent what an old row meant.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE CONNECTION DESCRIBES ITSELF
-- ─────────────────────────────────────────────────────────────────────────────

-- NULL means live. A timestamp means the friend revoked this connection at
-- Plaid and kept the data: the rows stay exactly as they were, and every panel
-- reading them owes the friend the sentence "no longer updating".
ALTER TABLE plaid_items ADD COLUMN disconnected_at INTEGER;

-- What the friend calls this bank. From /item/get, which the connect route
-- already calls — no extra Plaid request, no new failure mode.
ALTER TABLE plaid_items ADD COLUMN institution_name TEXT;

-- Which connection this attempt was for. NULL on every row written before this
-- migration, and left that way on purpose.
ALTER TABLE plaid_refreshes ADD COLUMN item_id TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- EVERY SYNCED ROW LEARNS ITS BANK
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nullable, and it has to be: SQLite cannot add a NOT NULL column to a table
-- that already has rows without inventing a default, and there is no honest
-- default for "which bank did this come from". The backfill below fills in
-- every row whose account is still known. A row whose account has already
-- vanished stays NULL — unreachable, but not MISFILED, which is the failure
-- that would actually cost a friend data when they remove a different bank.
--
-- Everything written from here on is stamped at write time by lib/plaid/sync.ts
-- and can never be stranded again.

ALTER TABLE plaid_transactions ADD COLUMN item_id TEXT;
ALTER TABLE plaid_holdings ADD COLUMN item_id TEXT;
ALTER TABLE plaid_recurring_streams ADD COLUMN item_id TEXT;
ALTER TABLE plaid_investment_transactions ADD COLUMN item_id TEXT;

UPDATE plaid_transactions
   SET item_id = (
         SELECT a.item_id FROM plaid_accounts a
          WHERE a.account_id = plaid_transactions.account_id
       );

UPDATE plaid_holdings
   SET item_id = (
         SELECT a.item_id FROM plaid_accounts a
          WHERE a.account_id = plaid_holdings.account_id
       );

UPDATE plaid_recurring_streams
   SET item_id = (
         SELECT a.item_id FROM plaid_accounts a
          WHERE a.account_id = plaid_recurring_streams.account_id
       );

UPDATE plaid_investment_transactions
   SET item_id = (
         SELECT a.item_id FROM plaid_accounts a
          WHERE a.account_id = plaid_investment_transactions.account_id
       );

-- Every one of these is a DELETE predicate before it is a SELECT predicate.
-- Removing a bank deletes its rows from four tables at once, and a friend
-- watching a spinner while SQLite scans their whole transaction history is a
-- worse version of an action that should feel instant.
CREATE INDEX IF NOT EXISTS plaid_transactions_item ON plaid_transactions(item_id);
CREATE INDEX IF NOT EXISTS plaid_holdings_item ON plaid_holdings(item_id);
CREATE INDEX IF NOT EXISTS plaid_recurring_streams_item ON plaid_recurring_streams(item_id);
CREATE INDEX IF NOT EXISTS plaid_investment_transactions_item
  ON plaid_investment_transactions(item_id);
CREATE INDEX IF NOT EXISTS plaid_refreshes_item ON plaid_refreshes(item_id);
