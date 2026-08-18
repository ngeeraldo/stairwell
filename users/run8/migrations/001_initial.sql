-- users/run8/migrations/001_initial.sql
--
-- run8's dashboard: a bathroom-trip counter. One screen, two panels — today's
-- count with plus/minus, and a week trend that toggles to weekly averages.
-- Confirmed spec v2, users/run8/spec.md.
--
-- This file is the ONLY description of this dashboard's shape. There is no
-- schema.sql (2026-08-15 migrations design, D6): seed.py applies this to
-- synthetic.db and lib/db/migrate.ts applies it to the encrypted run8.db, so
-- one description builds both.
--
-- While 001 has never been applied it may be edited freely. After that it is
-- frozen and a change is 002 — a friend's database records only which NUMBER
-- it reached, so editing an applied file silently changes what that number
-- means, and the manifest checksum refuses the session rather than letting it
-- through (D2).

-- ── One row per tap, not one row per day ────────────────────────────────────
--
-- The spec asks for "each recorded pee as a row keyed by date ... including
-- subtractions", and names the entry fields as `delta (number), date (date)`.
-- So this is an append-only ledger: a plus writes +1, a minus writes -1, and a
-- day's count is SUM(delta). Nothing is ever updated or deleted.
--
-- The alternative — one row per day holding a counter that goes up and down —
-- was not taken. It reads the same on screen and loses the thing that makes a
-- mis-tap recoverable as DATA rather than as arithmetic: with a ledger, "I
-- tapped twice by accident at 9pm" is two rows and a correction, and stays
-- legible forever. It also means no read-then-write, so two taps racing cannot
-- lose one.
--
-- NO `IF NOT EXISTS`, deliberately, and this is a break from every earlier
-- users/* folder. Those were written when seed.py re-executed a whole
-- schema.sql on every run and needed to be idempotent. A migration is applied
-- exactly once — `npm run synthetic` deletes the file first, and migrate.ts
-- applies only above `user_version` — so a CREATE that finds its table already
-- there means something has gone wrong upstream. Throwing says so; IF NOT
-- EXISTS would silently continue against a shape nobody verified.
CREATE TABLE pee_events (
  id    INTEGER PRIMARY KEY,

  -- The friend's LOCAL calendar day, 'YYYY-MM-DD', frozen at write time by
  -- the platform route from their own timezone (lib/time/dayKey.ts).
  --
  -- Stored rather than derived from `at` on read, and that is the whole point
  -- of having both columns. A day computed at read time uses whatever zone the
  -- friend is in NOW, so a trip to another timezone would silently re-bucket
  -- weeks of history that were already correct. The day a tap belongs to is
  -- decided once, by the person who tapped, and never moves again.
  --
  -- The GLOB is what makes that shape real rather than documented. devtwo's
  -- `day` carries the same contract in a comment and holds a row reading
  -- '1970-01-01 SAMPLE TEST' anyway — a sentinel added to satisfy a sweep that
  -- no longer asks for one (see tests/users/conventions.test.ts). A column
  -- whose contract is only prose is a column that eventually holds something
  -- else.
  day   TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- Epoch milliseconds. The spec explicitly does NOT want time-of-day: "no
  -- timestamps — just the counts", and a time-of-day split was considered and
  -- turned down. Kept anyway because it costs one integer and cannot be
  -- recovered later — if they ever ask "am I up more at night?", the answer
  -- exists from today rather than from the day they ask. Nothing reads it yet,
  -- and no panel may show it without a new confirmed spec version.
  at    INTEGER NOT NULL,

  -- +1 for a tap, -1 for a correction. The CHECK is the ledger's whole
  -- alphabet: any other value would make SUM(delta) mean something no panel
  -- was built to display.
  delta INTEGER NOT NULL CHECK (delta IN (-1, 1))
);

-- Every read this dashboard performs groups by `day` over a contiguous range —
-- today's total, the current week, and every week for the average toggle.
CREATE INDEX pee_events_day ON pee_events(day);
