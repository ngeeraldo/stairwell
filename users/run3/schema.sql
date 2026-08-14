-- users/run3/schema.sql
--
-- Table and view shapes for run3's dashboard. seed.py executes THIS FILE
-- before inserting anything, so shapes have exactly one source.
--
-- CLAUDE.md > Schema & module rules: this file, seed.py and tests/ move in the
-- same commit. Gate A blocks a commit that stages this alone.

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  merchant     TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_at ON transactions(at);
