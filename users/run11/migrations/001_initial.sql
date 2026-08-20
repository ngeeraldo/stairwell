-- users/run11/migrations/001_initial.sql
--
-- run11 asks one question — "is right now a good time to walk the dog, and if
-- not, when?" — and spec v1 answers it from a FORECAST, not from anything the
-- friend types. Nothing in this shape is entered by hand; every row is written
-- by app/api/users/[user]/forecast/route.ts from a public forecast for a fixed
-- coordinate, and the dashboard only ever reads.
--
-- Applied to BOTH databases: seed.py runs it into synthetic.db, and
-- lib/db/migrate.ts applies it to the encrypted run11.db at unlock. One
-- description of the shape, two files — one loudly fake, one real.
--
-- ─── THE LOCAL-TIME DECISION, which everything else here follows ───
--
-- Every row carries the friend's LOCAL calendar day and LOCAL minute-of-day,
-- resolved at WRITE time from the `stairwell_tz` cookie, the same way run9 and
-- run10 store `day` (docs/superpowers/ledgers/friend-timezone.md, T1/T4).
-- Nothing here recomputes a local time from `at` at read time.
--
-- It matters more here than in a tap tracker. Every question this dashboard
-- asks is about a POSITION IN THE DAY — "does a 40-minute walk starting now
-- finish before sunset", "what is the next 40-minute stretch under 90°F" — so
-- a query that had to convert instants to wall-clock time would be doing the
-- genuinely hard zone direction (ledger T5) inside arithmetic that is already
-- the interesting part. Stored as minutes, every one of those questions is
-- integer comparison against `sunset_minute`, and users/run11/queries.ts holds
-- no zone logic at all.
--
-- NO FREE TEXT ANYWHERE IN THIS SHAPE, deliberately. See seed.py's header: a
-- generator producing only numbers and day keys is not asked for the
-- loudly-fake marker, and there is no condition string or provider name stored
-- here that would need one. The verdict wording lives in the dashboard, and
-- the thresholds behind it live in queries.ts, not in a row.

-- One row per forecast hour. Replaced wholesale by each successful fetch —
-- a forecast is a SNAPSHOT, not a history, and yesterday's guess about this
-- afternoon is worth nothing once a newer one exists.
CREATE TABLE IF NOT EXISTS forecast_hours (
  -- The instant at the top of the forecast hour, epoch milliseconds. The
  -- primary key because the provider returns one row per hour and a repeated
  -- fetch must land on the same row rather than beside it.
  at            INTEGER PRIMARY KEY,

  -- The friend's local calendar day, 'YYYY-MM-DD'. Compared directly against
  -- the `today` the platform hands the dashboard — same function, one source.
  day           TEXT    NOT NULL,

  -- Local minutes since midnight for the START of this hour (0..1439). The
  -- hour covers [minute_of_day, minute_of_day + 60).
  --
  -- Not derivable from `at` without the zone, which is exactly the point: it
  -- is written once, by the only code that knows where the friend was.
  minute_of_day INTEGER NOT NULL,

  -- Precipitation for the hour, millimetres, and the chance of any at all.
  -- BOTH are stored because "any precipitation expected during the walk is a
  -- no" (spec v1) is a question neither answers alone: an amount of 0.0 with a
  -- 60% chance is a forecast that says it might rain, and an amount above zero
  -- with a low chance is a forecast that says it will drizzle. queries.ts
  -- treats either as rain and exposes both cutoffs as tunable constants.
  precip_mm     REAL    NOT NULL,
  precip_chance INTEGER NOT NULL,

  -- Apparent temperature ("feels like" / heat index), °F. The spec's heat
  -- check is explicitly on this and not on raw temperature — Houston in
  -- August is the whole reason the dashboard exists.
  feels_like_f  REAL    NOT NULL,

  -- Which fetch produced this row. Every row from one fetch shares a value, so
  -- this is redundant with forecast_fetches — kept because it lets the panel
  -- ask "how old is the forecast I am about to render" without a join, and
  -- because a row that outlived its fetch would otherwise be invisible.
  fetched_at    INTEGER NOT NULL
);

-- Serves every read in queries.ts: they all select a day's hours in
-- minute order and walk them.
CREATE INDEX IF NOT EXISTS forecast_hours_day_minute
  ON forecast_hours(day, minute_of_day);

-- One row per forecast day, holding the two boundaries the hourly rows cannot
-- carry. Sunset is the spec's third check; sunrise is what stops "the first
-- window tomorrow morning" from resolving to midnight.
CREATE TABLE IF NOT EXISTS forecast_days (
  day            TEXT PRIMARY KEY,
  sunrise_minute INTEGER NOT NULL,
  sunset_minute  INTEGER NOT NULL,
  fetched_at     INTEGER NOT NULL
);

-- Every REFRESH ATTEMPT, successful or not.
--
-- This is not telemetry, it is what makes the panel's error and staleness
-- states honest (docs/dashboard-ui-ux-guidelines.md > States). Without it a
-- failed refresh is indistinguishable from no refresh: the hour rows simply
-- stay as they were, and the dashboard would render an old verdict as if it
-- were current — the one thing that section forbids by name.
--
-- APPEND-ONLY BY CONVENTION, not by trigger: nothing deletes from it, and the
-- reads below take the newest row. It is a friend's own encrypted database, so
-- this is not one of the sacred platform tables.
CREATE TABLE IF NOT EXISTS forecast_fetches (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  day           TEXT    NOT NULL,
  minute_of_day INTEGER NOT NULL,
  -- 1 success, 0 failure. No error text: a failure reason is provider prose
  -- and this table is inside the friend's database purely so a panel can say
  -- "could not reach the forecast", which needs a boolean and nothing else.
  ok            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS forecast_fetches_at ON forecast_fetches(at);
