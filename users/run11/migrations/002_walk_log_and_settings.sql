-- users/run11/migrations/002_walk_log_and_settings.sql
--
-- Spec v2 adds the two things 001 deliberately did not have: something the
-- friend TYPES IN, and something he CONFIGURES.
--
-- 001's header says "Nothing in this shape is entered by hand; every row is
-- written by app/api/users/[user]/forecast/route.ts". That is still true of
-- every table 001 declares, and it stops being true of this file. Both tables
-- below are written only by a control the friend presses, through a platform
-- route, and neither is ever touched by the forecast refresh — a refresh
-- replaces the forecast wholesale (001's `DELETE FROM forecast_hours`), and a
-- walk he logged is not part of a forecast snapshot.
--
-- ─── WHY THIS IS A NEW FILE AND NOT AN EDIT TO 001 ─────────────────────────
--
-- 001 has been applied. An applied migration is never edited (2026-08-15
-- migrations design, D2); migrations/manifest.json's SHA-256 per file is what
-- enforces it, and a mismatch refuses the session rather than applying
-- something nobody reviewed. This file ships with a data-survival test in the
-- same commit (D3) — users/run11/tests/migration002.test.ts seeds the 001
-- shape, applies this, and asserts the forecast rows are still there.
--
-- IT ADDS AND NEVER ALTERS. Nothing in 001 is touched: no column is dropped,
-- no table is rebuilt, and the friend's stored forecast is untouched by
-- construction rather than by a test's say-so. The test is there because "by
-- construction" is what everyone believes about their own migration.
--
-- A MIGRATION NEVER SEEDS ROWS (D9). walk_settings is deliberately EMPTY after
-- this runs, and the 90°F default spec v2 asks for lives in
-- users/run11/queries.ts as DEFAULT_HEAT_NO_GO_F. Writing a default row here
-- would be a migration inventing data, and it would also make "he has never
-- set this" indistinguishable from "he set it back to 90".
--
-- NO FREE TEXT HERE EITHER, same as 001: a day key, an epoch, a temperature.
-- See seed.py's header for why the loudly-fake marker is not asked for.

-- One row per day the friend marks as walked. The row IS the fact — there is
-- no `walked` boolean, because an unmarked day is simply a day with no row.
--
-- KEYED BY DAY, which is the whole shape of spec v2's "one walk per day is all
-- that's recorded; there's no count of walks within a day, no duration, and no
-- notes". A repeated mark is the same fact twice, so the route uses
-- INSERT OR IGNORE and a double-tap is a no-op rather than a second row. This
-- is the opposite decision from users/run10's pee_logs, where every tap is a
-- distinct occurrence and deduplicating would discard the thing being counted;
-- the difference is that this table records a fact about a day and that one
-- records events within it.
--
-- `day` is the friend's LOCAL calendar day, 'YYYY-MM-DD', resolved at write
-- time by the route from the `stairwell_tz` cookie — the same dayKey the
-- platform hands the dashboard as `today`, and the same one 001's forecast
-- rows are filed under. That is what makes the calendar's "today" square and
-- the decider's reference day the same day (spec v2's third open question).
--
-- It is TEXT PRIMARY KEY rather than an id with a unique index: every read in
-- users/run11/queries.ts is either "is this day marked" or a range over
-- consecutive days, and both are served directly by the primary key's index.
CREATE TABLE IF NOT EXISTS walk_log (
  day TEXT PRIMARY KEY,
  -- The instant of the MARK, not of the walk. A day can be back-filled weeks
  -- later, so this is deliberately not evidence of when he was outside; it is
  -- kept because a table recording only its own key can never answer "was this
  -- entered at the time or filled in afterwards" if that is ever asked.
  at  INTEGER NOT NULL
);

-- The friend's own settings for the decider screen. Exactly one row, ever.
--
-- A SINGLE-ROW TABLE, not a key/value bag: spec v2 asks for one number, and a
-- typed column says what that number is where a `value TEXT` would not. The
-- CHECK is what makes "exactly one row" a property of the shape rather than a
-- convention the route is trusted to keep — an INSERT of a second row fails at
-- the database, so no read anywhere has to decide which row wins. A second
-- setting later is an ALTER TABLE in a 003, which full DDL sanctions (D1).
CREATE TABLE IF NOT EXISTS walk_settings (
  id           INTEGER PRIMARY KEY CHECK (id = 1),

  -- The no-go feels-like (heat index) in °F: at or above this, the answer is
  -- no. The friend sets ONLY this number (his own words: "Just the hard no
  -- number"); the "short one, shade" band is the five degrees directly below
  -- it and is DERIVED in users/run11/queries.ts, never stored — two stored
  -- numbers could disagree with each other, and one cannot.
  --
  -- INTEGER because the control moves in whole degrees and a heat index with a
  -- decimal place is precision nobody has.
  --
  -- DELIBERATELY UNCONSTRAINED apart from NOT NULL. The sane range (80–105°F)
  -- lives in queries.ts and is enforced by the route, because a CHECK here
  -- would freeze that range into an applied migration forever: widening it
  -- would need a 003 rebuilding the table, for a bound that is a product
  -- judgement rather than a fact about the shape. queries.ts clamps on READ as
  -- well as on write, so a row outside the range can never render buttons that
  -- cannot move it.
  heat_no_go_f INTEGER NOT NULL,

  -- When it was last changed. Nothing reads this today; it is the one piece of
  -- context a single-row settings table cannot reconstruct afterwards, and it
  -- costs one column.
  set_at       INTEGER NOT NULL
);
