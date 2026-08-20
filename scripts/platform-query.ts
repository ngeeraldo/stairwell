// scripts/platform-query.ts
//
//   npx tsx scripts/platform-query.ts "<SQL>" [--param <value> ...]
//   npx tsx scripts/platform-query.ts --file <path-to-.sql> [--param <value> ...]
//
// Runs one SQL statement against the platform database and prints the rows
// it returns. Built to replace hand-typed `sqlite3 platform.db '...'` in the
// runbook's verification commands — the droplet has no `sqlite3` binary,
// confirmed live ("bash: line 1: sqlite3: command not found"), so those
// commands did not run. This does, because it ships with the app: nothing to
// install on the droplet, and it deploys the moment the repo does.
//
// THIS READS THE PLATFORM DATABASE BY DESIGN, on the server, run by Nico —
// same category as scripts/export-spec.ts and scripts/ask-user.ts. It is NOT
// consistent with Claude running it locally against anything but a synthetic
// or temp database (see CLAUDE.md > Data safety).
//
// ─── why this refuses instead of defaulting to synthetic ───
//
// Every other script in this file's family (export-spec.ts, ask-user.ts,
// announce-deploy.ts, create-invite.ts, revoke-invite.ts) falls back to
// `platform/dev/synthetic.db` when PLATFORM_DB is unset, so a forgotten
// `$STAIRWELL` prelude on the laptop is loud rather than silently wrong —
// good for a mint/revoke/ask command whose failure mode is "nothing
// happened". A verification query is the opposite case: run this ONE tool on
// the droplet with PLATFORM_DB unset — a non-interactive `ssh` loads no
// profile, so that is the default state, not an edge case — and a silent
// fallback would print a synthetic table as if it were the real one, and an
// operator checking "did the invite land" would read fake rows as a real
// answer. Refusing loudly, the same way scripts/shots.ts refuses the
// opposite direction (a real path where it wants synthetic), is what keeps
// that mistake from ever being quiet.
//
// ─── read-only, by construction, not by convention ───
//
// Opened with `{ readonly: true, fileMustExist: true }` directly — NOT
// through lib/db/platform.ts's openPlatformDb, which execs platform/schema.sql
// and would itself fail against a read-only handle (CREATE TABLE IF NOT
// EXISTS is still a write). A verification tool has no business creating
// tables or applying schema; it opens exactly the file it is given and
// nothing else. `readonly: true` means an operator who pastes the wrong
// thing at 1am — an UPDATE where a SELECT belonged — gets a thrown error
// naming the database as read-only, not a mutated row in `accounts` or
// `invites`. This is real defense-in-depth even though `transcripts`,
// `metrics`, `specs`, `spec_confirmations` and `spec_screen_mockups` already
// reject UPDATE/DELETE at the trigger level (platform/schema.sql): those
// triggers don't cover `accounts`, `invites`, `account_keys` or
// `spec_confirmations`'-adjacent tables that ARE mutable in normal operation,
// and a read-only connection is the one guard that covers every table
// uniformly, including ones added later.
import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type PlatformDb = Database.Database

/**
 * Run one statement, optionally bound to `?` placeholders, and return
 * whatever rows it produces.
 *
 * `params` exists so a query can be filtered (`WHERE slug = ?` / `--param
 * sam`) without ever splicing a value into the SQL text — the nested-quoting
 * trap the runbook warned about (a value containing an
 * apostrophe breaks the single-inside-double-quote nesting an `ssh` command
 * relies on). Binding sidesteps that entirely: the value travels as a
 * separate argv entry, never as characters inside the SQL string.
 *
 * `stmt.reader` is better-sqlite3's own answer to "does this statement
 * return rows" (true for SELECT/PRAGMA-that-returns, false for
 * INSERT/UPDATE/DELETE/DDL). A non-reader statement goes through `.run()`
 * rather than being rejected up front by shape alone — so what actually
 * stops a write is the read-only handle itself throwing
 * "attempt to write a readonly database", the real guarantee, not a guess
 * from this function about what counts as a write.
 */
export function runQuery(
  db: PlatformDb,
  sql: string,
  params: readonly string[] = [],
): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[]
  stmt.run(...params)
  return []
}

/**
 * One `key=value` line per column, a blank line between rows.
 *
 * Chosen over aligned columns: this is read over `ssh`, in a terminal of
 * unknown width, and a platform-database row can hold an arbitrarily long
 * value (`specs.payload` is a whole spec's JSON, `metrics.data` — if a
 * future query ever joins one in — is a blob). Aligned columns wrap that
 * value mid-line and drag every other column's alignment down with it;
 * `key=value` degrades to a long line that scrolls but never misaligns, and
 * it stays greppable (`| grep enveloped=1`) the way a column table is not.
 */
export function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(0 rows)'
  return rows
    .map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    )
    .join('\n\n')
}

function resolvePlatformDbPath(): string {
  // No fallback — see the header comment. `??` only catches null/undefined,
  // so an explicit empty string (`PLATFORM_DB=` with nothing after it, the
  // exact footgun deploy/check-env.sh calls out) has to be checked for by
  // hand or it would resolve to the cwd.
  if (!process.env.PLATFORM_DB) {
    console.error(
      'Refusing to run: PLATFORM_DB is not set.\n\n' +
        'This script never falls back to a synthetic database — a fallback ' +
        'on the droplet would print fake rows as if they were the real ' +
        "answer to a verification query. Set it explicitly, e.g. via the " +
        'runbook\'s $STAIRWELL prelude:\n\n' +
        '  PLATFORM_DB=platform/dev/synthetic.db npx tsx scripts/platform-query.ts "<SQL>"',
    )
    process.exit(1)
  }
  return resolve(process.env.PLATFORM_DB)
}

function usage(): void {
  console.error(
    'usage: npx tsx scripts/platform-query.ts "<SQL>" [--param <value> ...]\n' +
      '       npx tsx scripts/platform-query.ts --file <path-to-.sql> [--param <value> ...]\n\n' +
      'Runs one read-only query against PLATFORM_DB and prints its rows.\n' +
      '--param binds a `?` placeholder in order given (repeatable) — the way ' +
      'to filter by a value, e.g. a slug, without splicing it into the SQL ' +
      'text.\n' +
      '--file sidesteps shell quoting entirely for a query with an ' +
      "apostrophe in it — put the SQL in a file and pass its path instead " +
      'of fighting nested quotes over ssh.',
  )
}

if (process.argv[1]?.endsWith('platform-query.ts')) {
  const rawArgs = process.argv.slice(2)

  // --param is pulled out first, wherever it appears, so it can follow
  // either form below (`"<SQL>" --param x` or `--file f.sql --param x`)
  // without the file/SQL parsing having to know about it.
  const params: string[] = []
  const args: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--param') {
      const value = rawArgs[i + 1]
      if (value === undefined) {
        usage()
        process.exit(1)
      }
      params.push(value)
      i++
    } else {
      args.push(rawArgs[i]!)
    }
  }

  let sql: string | undefined

  if (args[0] === '--file') {
    const path = args[1]
    if (!path) {
      usage()
      process.exit(1)
    }
    sql = readFileSync(path, 'utf8')
  } else {
    sql = args[0]
  }

  if (!sql || !sql.trim()) {
    usage()
    process.exit(1)
  }

  const dbPath = resolvePlatformDbPath()
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    console.log(formatRows(runQuery(db, sql, params)))
  } catch (error) {
    // The message, not the stack — same as scripts/create-invite.ts. A
    // SqliteError here is most often the read-only guard itself refusing a
    // pasted write, and that is the sentence the person at the terminal
    // needs, not a Node stack trace through better-sqlite3's internals.
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  } finally {
    db.close()
  }
}
