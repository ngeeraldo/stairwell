-- users/run10/migrations/001_initial.sql
--
-- run10 logs one thing: a pee, one tap at a time. Spec v1 —
-- users/run10/spec.md — asks for two panels and both are questions asked of
-- this one table: today's running count, and the daily totals for the last
-- seven days with their average. Nothing is typed in anywhere; the data
-- requirement names this table and says so ("One timestamped row per tap of
-- the log button").
--
-- Applied to BOTH databases: seed.py runs it into synthetic.db, and
-- lib/db/migrate.ts applies it to the encrypted run10.db at unlock. One
-- description of the shape, two files — one loudly fake, one real.

CREATE TABLE IF NOT EXISTS pee_logs (
  -- The rowid alias, declared rather than left implicit. Two taps inside the
  -- same millisecond are otherwise indistinguishable rows, and this table is
  -- a log of OCCURRENCES: whatever asks "which one of these" later — an undo
  -- control, a day's ordering — needs a way to name exactly one. Declaring it
  -- now costs a line; adding it later costs a migration.
  id  INTEGER PRIMARY KEY,

  -- The friend's LOCAL calendar day as 'YYYY-MM-DD' — never a UTC date,
  -- never derived from `at` at read time.
  --
  -- Stored rather than computed, because write time is the only moment the
  -- zone is known to be the one the friend was actually standing in
  -- (docs/superpowers/ledgers/friend-timezone.md, T1/T4). Recomputing the day
  -- from `at` later would silently re-file old rows the first time they log
  -- from another country. It also keeps every panel here plain SQL — the
  -- count and the 7-day totals are both GROUP BY day — with no zone→instant
  -- conversion, the genuinely hard direction (ledger T5).
  --
  -- This column is also where the spec's "resets to zero at midnight local
  -- time" actually lives. There is no rollover offset anywhere in this
  -- dashboard: run10 said they will not log night trips, so midnight is the
  -- boundary and `day` is it.
  day TEXT    NOT NULL,

  -- The instant of the tap, epoch milliseconds. STORED AND NEVER DISPLAYED in
  -- v1: the spec asks for counts and a daily trend, and no panel shows a time.
  -- Kept because "when in the day" is the obvious next question and a gap in
  -- the history cannot be backfilled — a column that was never written is
  -- worse than one that is never read.
  at  INTEGER NOT NULL
);

-- NO UNIQUE CONSTRAINT, and it is a decision rather than an omission. A table
-- keyed by day makes a second tap an idempotent no-op, which is right for a
-- fact that cannot happen twice ("walked today"). Here a second tap is a
-- second occurrence and the whole dashboard is a COUNT of them, so any dedup
-- would silently discard the thing being counted.

-- Serves both reads: today's count (`day` =) and the 7-day totals
-- (`day` BETWEEN, GROUP BY day). `at` is in the index so a day's rows are
-- ordered by it without a second lookup.
CREATE INDEX IF NOT EXISTS pee_logs_day_at ON pee_logs(day, at);
