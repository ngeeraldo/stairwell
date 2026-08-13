-- users/devtwo/schema.sql
--
-- One row per day walked. The day is the PRIMARY KEY, which is what makes the
-- tap idempotent without a read-then-write: a second tap on the same day is an
-- INSERT OR IGNORE that changes nothing, with no race between check and write.
--
-- `day` is the LOCAL calendar day as 'YYYY-MM-DD', never a UTC date and never
-- an epoch. A tracker whose unit is the day cannot be ambiguous about which
-- day it means.
--
-- Applied to BOTH databases: seed.py writes it into synthetic.db, and
-- lib/db/encryptedUserDb.ts applies it when creating devtwo.db. One schema,
-- two files — one loudly fake, one real and encrypted.

CREATE TABLE IF NOT EXISTS walks (
  day TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);
