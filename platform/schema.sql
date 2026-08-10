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
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  role       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transcripts_account ON transcripts(account_id, at);

CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER,
  event      TEXT    NOT NULL,
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
