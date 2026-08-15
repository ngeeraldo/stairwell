-- users/devone/schema.sql
--
-- devone is a loudly-fake fixture account. Every row generated into this shape
-- by seed.py contains the literal TEST (CLAUDE.md > Data safety).
--
-- seed.py executes THIS FILE before inserting anything, so the table shapes
-- have exactly one source and the generator cannot declare one of its own.

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  merchant     TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_at ON transactions(at);
