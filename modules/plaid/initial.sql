-- modules/plaid/initial.sql
--
-- THE SHARED PLAID ENVELOPE. One shape, every finance friend, never forked
-- per user (CLAUDE.md > Schema & module rules). A friend's own needs are met
-- with VIEWS over these tables in their own migration, never by changing this
-- file for one person.
--
-- Vendored into a friend's own migrations/ by hand:
--
--     cp modules/plaid/initial.sql \
--        users/<slug>/migrations/00N_module_plaid_initial.sql
--
-- The `_module_` segment records where the file came from.
-- lib/db/migrationFiles.ts's existing `^(\d{3})_[a-z0-9_]+\.sql$` already
-- accepts that name, so NOTHING in the migration machinery changes.
--
-- ─── WHY THERE IS ALMOST NO SCHEMA HERE ─────────────────────────────────────
--
-- Plaid's payload is stored VERBATIM as JSON. Only three kinds of column get
-- their own slot: the key a row is upserted on, the key it is deleted on, and
-- the one date every query filters by. Everything else lives in `payload` and
-- is reached with json_extract().
--
-- That is deliberate, and the reason is not tidiness (plan D2):
--
--   A modelled schema is a hand-maintained derivative of someone else's
--   contract, and nothing notices when it goes stale. Worse, it makes the
--   expensive mistake the likely one. Getting a column wrong here means a
--   data-preserving migration against a SQLCipher database nobody can open —
--   including Nico, by design. Getting a json_extract() wrong means EDITING A
--   VIEW. No data moves, because the raw payload was always there.
--
--   Plaid adding a field costs nothing: it is already stored. Plaid renaming
--   one breaks a single friend's view, visibly, and the fix is one line.
--
-- SQLite ships JSON1, so json_extract() is available with no extension. If a
-- query is ever slow, add a generated column over json_extract() and index it
-- WITHOUT touching a stored row.
--
-- ─── WHAT MAY WRITE TO THESE TABLES ─────────────────────────────────────────
--
-- Exactly one thing: app/api/users/[user]/plaid/refresh/route.ts. A dashboard
-- holds a READ-ONLY handle and cannot write at all; a friend's annotation on a
-- transaction goes in THEIR OWN table keyed to `transaction_id`, never as an
-- edit to a row here — that is what stops the next refresh from trampling it
-- (CLAUDE.md > Schema & module rules).
--
-- Shape derived from a real Sandbox response, not from Plaid's docs. See
-- docs/superpowers/plans/2026-08-20-plaid-connection.md, Gate 1 findings.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE CONNECTION ITSELF
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per connected institution.
--
-- `access_token` is a bearer credential for a real bank connection. It exists
-- ONLY here, inside the friend's own SQLCipher database, readable only while
-- they are unlocked. It is never logged, never returned in a response body,
-- never copied to the platform database, and cannot be read by anyone
-- without their password — including Nico.
--
-- `cursor` is /transactions/sync's incremental pointer. It and the rows it
-- describes MUST advance in one transaction: a cursor saved without its rows
-- claims we already hold data we threw away, and Plaid will never send it
-- again.
--
-- `available_products` is what /item/get reported FOR THIS ITEM, stored so the
-- refresh route can skip calls this connection cannot serve — a friend with
-- one credit card never pays the latency of an investments call (plan F8).
CREATE TABLE IF NOT EXISTS plaid_items (
  item_id            TEXT PRIMARY KEY,
  access_token       TEXT NOT NULL,
  institution_id     TEXT,
  cursor             TEXT,
  available_products TEXT NOT NULL DEFAULT '[]',
  payload            TEXT NOT NULL DEFAULT '{}',
  connected_at       INTEGER NOT NULL
);

-- Every refresh attempt, including the ones that failed.
--
-- NOT OPTIONAL, and app/api/users/[user]/forecast/route.ts already learned
-- why: without a recorded attempt, a failed refresh is indistinguishable from
-- no refresh, and the panel renders stale data as if it were current — which
-- docs/dashboard-ui-ux-guidelines.md > States forbids by name. A panel's
-- honest "couldn't reach your bank" state is built on this row existing.
--
-- `product` names which call was attempted, so one product being down does not
-- make the whole refresh look broken. `code` is a PlaidErrorCode, never
-- Plaid's prose.
CREATE TABLE IF NOT EXISTS plaid_refreshes (
  at      INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  product TEXT    NOT NULL,
  ok      INTEGER NOT NULL,
  code    TEXT
);

CREATE INDEX IF NOT EXISTS plaid_refreshes_day ON plaid_refreshes(day);

-- ─────────────────────────────────────────────────────────────────────────────
-- SNAPSHOTS — replaced whole on every refresh, never merged
-- ─────────────────────────────────────────────────────────────────────────────

-- Accounts and their balances.
--
-- `balances` rides inside `payload`; there is no balance column. A balance is
-- a value, and this file's whole rule is that values live in the payload.
CREATE TABLE IF NOT EXISTS plaid_accounts (
  account_id TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  payload    TEXT NOT NULL
);

-- Investment positions. NO id of their own — Plaid keys them by the pair, so
-- the primary key is the pair. Verified against a real response, not assumed.
CREATE TABLE IF NOT EXISTS plaid_holdings (
  account_id  TEXT NOT NULL,
  security_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (account_id, security_id)
);

CREATE TABLE IF NOT EXISTS plaid_securities (
  security_id TEXT PRIMARY KEY,
  payload     TEXT NOT NULL
);

-- Detected subscriptions and paychecks.
--
-- A SNAPSHOT, not a log: Plaid recomputes the streams each time, and a stream
-- that stops recurring stops being returned. `direction` is 'inflow' or
-- 'outflow' — the response splits them into two arrays and the id space is
-- shared, so without it a paycheck and a subscription could collide.
CREATE TABLE IF NOT EXISTS plaid_recurring_streams (
  stream_id  TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  direction  TEXT NOT NULL,
  payload    TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ACCUMULATED — upserted, never wholesale replaced
-- ─────────────────────────────────────────────────────────────────────────────

-- Bank and card transactions, from the /transactions/sync cursor stream.
--
-- THREE VERBS, not one: `added` and `modified` upsert here, `removed` deletes.
-- A transaction mutates after it posts — a pending charge settles at a
-- different amount and a merchant name gets cleaned up — which is why an
-- annotation a friend writes must live in their own table keyed to
-- `transaction_id`, not as an edit to this row.
--
-- `date` is Plaid's own YYYY-MM-DD string, stored as given. It is NOT derived
-- from a clock here or anywhere: this app has exactly one answer to "what day
-- is it for this friend" (lib/time/dayKey.ts over a stored instant), and a
-- bank's posting date is a fact Plaid states rather than something we compute.
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  date           TEXT NOT NULL,
  payload        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plaid_transactions_date ON plaid_transactions(date);
CREATE INDEX IF NOT EXISTS plaid_transactions_account ON plaid_transactions(account_id);

-- Buys and sells.
--
-- The THIRD data pattern (plan F2): date-ranged AND paginated, unlike the
-- cursor stream and unlike the snapshots. A real Sandbox item returned 100 of
-- 1171 in one page, so whatever fetches this must page or say out loud that it
-- did not.
CREATE TABLE IF NOT EXISTS plaid_investment_transactions (
  investment_transaction_id TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL,
  security_id               TEXT,
  date                      TEXT NOT NULL,
  payload                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plaid_investment_transactions_date
  ON plaid_investment_transactions(date);
