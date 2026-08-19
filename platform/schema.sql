-- Platform database. Accounts, sessions, and the sacred append-only logs.
-- Not encrypted with any user key: these are the records Nico is promised
-- access to at onboarding. Per-user data lives in the user's own encrypted
-- database (architecture-overview.md section 4).

CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL UNIQUE,
  role       TEXT    NOT NULL CHECK (role IN ('user', 'admin')),
  auth_hash  TEXT    NOT NULL,
  salt_auth  BLOB    NOT NULL,
  salt_key   BLOB    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);

-- Sacred data. CLAUDE.md > Sacred data: append-only, never migrated,
-- rewritten, or cleaned up. Enforced below in the database itself rather
-- than by convention in the data layer.
CREATE TABLE IF NOT EXISTS transcripts (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL,
  session_id      TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  prompt_sha      TEXT    NOT NULL,
  role            TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transcripts_account ON transcripts(account_id, at);
CREATE INDEX IF NOT EXISTS transcripts_conversation
  ON transcripts(conversation_id, at);

CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER,
  event      TEXT    NOT NULL,
  data       TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS metrics_at ON metrics(at);

CREATE TABLE IF NOT EXISTS requests (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  body       TEXT    NOT NULL,
  at         INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS transcripts_no_update
BEFORE UPDATE ON transcripts
BEGIN
  SELECT RAISE(ABORT, 'transcripts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS transcripts_no_delete
BEFORE DELETE ON transcripts
BEGIN
  SELECT RAISE(ABORT, 'transcripts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS metrics_no_update
BEFORE UPDATE ON metrics
BEGIN
  SELECT RAISE(ABORT, 'metrics is append-only');
END;

CREATE TRIGGER IF NOT EXISTS metrics_no_delete
BEFORE DELETE ON metrics
BEGIN
  SELECT RAISE(ABORT, 'metrics is append-only');
END;

-- Step 4. Sacred like transcripts and metrics: append-only, never migrated.
-- Deliberately NOT covered by lib/db/reshape.ts — CLAUDE.md forbids widening
-- that exception, so these columns are right the first time or they are fixed
-- by hand (design spec section 2.4).
CREATE TABLE IF NOT EXISTS specs (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL,
  conversation_id TEXT    NOT NULL,
  prompt_sha      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  mockup_html     TEXT    NOT NULL,
  at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS specs_account ON specs(account_id, at);

-- A confirmation is a second append, not a status column: a status column
-- would need an UPDATE, which the triggers below reject.
CREATE TABLE IF NOT EXISTS spec_confirmations (
  id         INTEGER PRIMARY KEY,
  spec_id    INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS spec_confirmations_spec
  ON spec_confirmations(spec_id);

CREATE TRIGGER IF NOT EXISTS specs_no_update
BEFORE UPDATE ON specs
BEGIN
  SELECT RAISE(ABORT, 'specs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS specs_no_delete
BEFORE DELETE ON specs
BEGIN
  SELECT RAISE(ABORT, 'specs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spec_confirmations_no_update
BEFORE UPDATE ON spec_confirmations
BEGIN
  SELECT RAISE(ABORT, 'spec_confirmations is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spec_confirmations_no_delete
BEFORE DELETE ON spec_confirmations
BEGIN
  SELECT RAISE(ABORT, 'spec_confirmations is append-only');
END;

-- Envelope encryption (onboarding ledger D2). The user's password derives a
-- key-encrypting key; the key that actually opens their SQLCipher database is
-- 32 random bytes, wrapped under it and stored here.
--
-- A TABLE rather than a column on `accounts`, and the difference is the whole
-- design: `accounts` already has rows in production, this repo has no additive
-- migration mechanism, and lib/db/reshape.ts is not one and must not be
-- widened (CLAUDE.md). A CREATE TABLE IF NOT EXISTS needs no mechanism at all.
--
-- ABSENCE OF A ROW IS THE LEGACY ARM, and it is permanent. devone, devtwo and
-- nico predate this and have no row, so their database key stays
-- argon2(password, salt_key) — which is what keeps devtwo's existing real
-- database openable. NEVER BACKFILL: a legacy account's wrapped key cannot be
-- computed without their password, and fabricating one would lock a real
-- person out of real data.
--
-- NOT append-only, deliberately, and this is the one table in the platform
-- database where that is a feature: a password change (not built here)
-- rewrites this row and nothing else, which is the entire point of the
-- indirection.
CREATE TABLE IF NOT EXISTS account_keys (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  wrapped_key BLOB    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Invite links. Operational state, like `sessions` — NOT sacred, NOT
-- append-only: consuming and revoking are UPDATEs, which is the whole point.
--
-- THE TOKEN IS STORED HASHED (onboarding ledger D11). platform.db is
-- unencrypted by design — it holds the records Nico is promised access to —
-- and invites deliberately never expire, so a live token sitting in it would
-- be a permanent bearer credential to create an account. The token exists only
-- in the URL Nico sends.
--
-- `slug` is reserved and validated at MINT time (SLUG_PATTERN + RESERVED_SLUGS,
-- lib/invite/tokens.ts), so a typo is Nico's problem for ten seconds rather
-- than his friend's problem at the worst possible moment. The ACCOUNT is
-- created at password-set time, not here: accounts.auth_hash is NOT NULL and
-- there is no password yet, so a mint-time account would need a sentinel hash
-- that could be logged in against if it ever escaped (ledger D12).
--
-- account_id is SET NULL on delete rather than CASCADE: if an account is ever
-- deleted, the invite row is the record that the link was spent, and that is
-- still true afterwards.
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY,
  token_sha  TEXT    NOT NULL UNIQUE,
  slug       TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL
);

-- Per-screen mockup fragments. Sacred like its neighbours: append-only, never
-- migrated. A row is one screen's HTML as drawn for one spec version.
--
-- A TABLE rather than more JSON inside specs.payload, and the difference is
-- load-bearing: payload is read on EVERY proposal to build the writer's
-- current-version block, so HTML in there would be fed back into the model's
-- own input. CREATE TABLE IF NOT EXISTS needs no migration mechanism — the
-- precedent is account_keys, added the same way for the same reason.
--
-- specs.mockup_html held the COMPOSED document through the mockup loop.
-- Nothing composes or serves mockup HTML any more (mockup-loop removal, plan
-- 2026-08-19-remove-the-mockup-loop, Task 6) — pull-spec.sh no longer writes
-- users/<slug>/mockup.html, and the admin Mockup tab is gone — so every row
-- written since carries mockup_html = ''. The COLUMN stays exactly as it is:
-- it is NOT NULL on a sacred, append-only table holding real rows, and
-- altering it would be schema surgery CLAUDE.md restricts to lib/db/reshape.ts
-- (a zero-rows proof, which this table cannot offer) and lib/db/migrate.ts
-- (per-user databases only) — neither applies here.
CREATE TABLE IF NOT EXISTS spec_screen_mockups (
  id        INTEGER PRIMARY KEY,
  spec_id   INTEGER NOT NULL,
  screen_id TEXT    NOT NULL,
  html      TEXT    NOT NULL,
  at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_screen_mockups_unique
  ON spec_screen_mockups(spec_id, screen_id);

CREATE TRIGGER IF NOT EXISTS spec_screen_mockups_no_update
BEFORE UPDATE ON spec_screen_mockups
BEGIN
  SELECT RAISE(ABORT, 'spec_screen_mockups is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spec_screen_mockups_no_delete
BEFORE DELETE ON spec_screen_mockups
BEGIN
  SELECT RAISE(ABORT, 'spec_screen_mockups is append-only');
END;
