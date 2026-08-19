-- users/run9/migrations/001_initial.sql
--
-- run9 logs one thing: a bathroom trip, one tap at a time. Spec v1 —
-- users/run9/spec.md — asks for today's count, a correction control, a 7-day
-- daily trend and a weekly average, all computed from these rows and nothing
-- else. There is no typed-in number anywhere: every panel is a different
-- question asked of this one table.
--
-- Applied to BOTH databases: seed.py runs it into synthetic.db, and
-- lib/db/migrate.ts applies it to the encrypted run9.db at unlock. One
-- description of the shape, two files — one loudly fake, one real.

CREATE TABLE IF NOT EXISTS pee_logs (
  -- The rowid alias, and it is load-bearing rather than decorative. The
  -- correction control nudges today's number DOWN by removing "the most
  -- recent logged entry for today" (spec v1, "Fix today's count"), and a
  -- table keyed only by day and timestamp gives no way to name exactly one
  -- row: two taps inside the same millisecond would delete together. With an
  -- id the removal is a single unambiguous DELETE.
  id  INTEGER PRIMARY KEY,

  -- The friend's LOCAL calendar day as 'YYYY-MM-DD' — never a UTC date,
  -- never derived from `at` at read time.
  --
  -- Stored rather than computed, and that is the settled pattern here, not a
  -- shortcut: app/api/users/[user]/walk/route.ts already decides a tap's day
  -- at write time from the browser's zone (docs/superpowers/ledgers/friend-timezone.md,
  -- T1/T4), because that is the only moment the zone is known to be the one
  -- the friend was actually standing in. Recomputing the day from `at` later
  -- would silently re-file old rows the first time they log from another
  -- country. It also keeps every panel here plain SQL — today's count, the
  -- 7-day trend and the weekly average are all GROUP BY day — with no
  -- zone→instant conversion, the genuinely hard direction (ledger T5).
  day TEXT    NOT NULL,

  -- The instant of the tap, epoch milliseconds. STORED AND DELIBERATELY NEVER
  -- DISPLAYED: spec v1 says so three times over — "the time is stored but
  -- deliberately not displayed anywhere", "an entry timestamped now", and the
  -- data requirement's "Timestamps are stored but not shown". Kept so the
  -- question can be answered later without a gap in the history; shown nowhere
  -- in v1. (Cited to spec.md rather than to conversation.md, which says the
  -- same thing but is gitignored — a comment pointing at a file a fresh clone
  -- does not have is a dead citation.)
  --
  -- It also orders within a day, which is what "the most recent logged entry
  -- for today" means.
  at  INTEGER NOT NULL
);

-- NO UNIQUE CONSTRAINT, and the contrast with users/devtwo/migrations is the
-- point. `walks` is keyed by day so a second tap is an idempotent no-op —
-- "walked today" is a fact that cannot happen twice. Here a second tap is a
-- second occurrence and must land as its own row; the whole dashboard is a
-- count, so any dedup would silently discard the thing being counted.

-- Serves all three reads: today's count and the trend group by `day`, and the
-- correction control takes the last row of one day (`day` =, `at` DESC).
CREATE INDEX IF NOT EXISTS pee_logs_day_at ON pee_logs(day, at);
