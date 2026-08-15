import Database from 'better-sqlite3-multiple-ciphers'
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SLUG_PATTERN } from '@/lib/auth/slug'
import { usersRoot } from '@/lib/db/userDb'

export type EncryptedUserDb = Database.Database

/**
 * A wrong key and a corrupt file are the SAME driver error — SqliteError with
 * code SQLITE_NOTADB, message "file is not a database". The opener knows
 * whether the file existed before it touched it, so it is the only layer that
 * can tell those apart, and it says which rather than passing the ambiguity up.
 */
export class WrongKeyError extends Error {
  constructor(slug: string) {
    super(
      `users/${slug}/${slug}.db exists but did not open with this session's key`,
    )
    this.name = 'WrongKeyError'
  }
}

/**
 * The cipher, pinned rather than inherited.
 *
 * The driver's current default is chacha20 (sqleet). If a future release
 * changed that default, every file written before the change would stop
 * opening — and the error would be "file is not a database", which reads as
 * corruption rather than as a configuration change. Naming it here means the
 * files stay readable across driver upgrades, and the pinning itself is
 * asserted by a test.
 */
const CIPHER = 'chacha20'

export function encryptedUserDbPath(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `invalid slug '${slug}': refusing to build a filesystem path from it`,
    )
  }
  return join(usersRoot(), slug, `${slug}.db`)
}

/** True when this user has real data. Cheap: no key needed, no open. */
export function encryptedUserDbExists(slug: string): boolean {
  return existsSync(encryptedUserDbPath(slug))
}

// `schemaTextFor` lived here. `users/<slug>/schema.sql` no longer exists:
// migrations own a dashboard's shape from 001 (2026-08-15 migrations design,
// D6), so NO open applies a schema any more, writable or otherwise.
// lib/db/migrate.ts is the only thing that changes a user database's shape.

export type OpenEncryptedOptions = {
  /**
   * Open a handle that CANNOT write, for a render path.
   *
   * `CLAUDE.md > Dashboard folder conventions` has said since step 5 that a
   * dashboard "gets a read-only handle, so it cannot write." That was true of
   * the synthetic path (`lib/db/userDb.ts` opens `readonly: true`) and became
   * false under step 6a at the exact moment it started to matter — the handle
   * now points at the friend's real encrypted data rather than at a file the
   * next deploy regenerates. This flag makes the sentence true again, in the
   * code rather than in the documentation.
   *
   * It necessarily SKIPS applying `schema.sql`, because applying a schema is a
   * write and cannot survive `readonly: true`. That is not a workaround for
   * the flag; it is the division of labour: the walk route's writable open is
   * the only thing that creates or migrates a user's real database, and a
   * render must never be the thing that migrates it.
   */
  readonly?: boolean
}

/**
 * Build a user's encrypted database somewhere else and LINK it into place, so
 * that `<slug>.db` never exists without its schema.
 *
 * WHY THIS IS NOT `new Database(path)` FOLLOWED BY A SCHEMA EXEC:
 * the driver creates the file and the WAL / foreign_keys pragmas write real
 * bytes before `schema.sql` is read, so the direct form has a window in which
 * `<slug>.db` exists with no tables. A failed create unlinks its own debris,
 * which closes the window for a failure — but not for a KILL inside it, and a
 * deploy restart is exactly such a kill. What made that worth removing rather
 * than accepting is that the CONSEQUENCE changed when the render path became
 * read-only: a table-less file no longer heals on the next page view, the
 * dashboard's first SELECT throws into `dashboard_error`, and the tap control
 * that would heal it lives inside the region that just failed. A friend cannot
 * get out of that state; only ssh can. So the window is removed instead.
 *
 * `link()`, not `rename()`. Both are atomic within one directory, but rename
 * CLOBBERS: two first-writes racing for the same user would each build an
 * empty database and the second rename would overwrite a file that already
 * held the first tap's row. `link()` fails with EEXIST instead, so the loser
 * keeps nothing and simply opens what the winner put there. Last-writer-wins
 * is not acceptable here even though both files are freshly schema'd and
 * empty AT BUILD TIME — the loser's rename lands after the winner has already
 * written, and that is a lost row, not a lost empty file.
 *
 * Closing before linking is required, not tidy: an open WAL database has
 * `-wal` and `-shm` sidecars holding rows the main file does not, and moving
 * the main file alone would strand them. Verified rather than assumed — with
 * the database open the directory holds `probe.db`, `probe.db-shm` and
 * `probe.db-wal`; after `close()` it holds `probe.db` alone, complete, with
 * the sidecars checkpointed away. So exactly one file is linked.
 */
export function createEmptyEncryptedDbAt(slug: string, path: string, key: Buffer): void {
  // `users/<slug>/` when nothing else ever has. For an invited friend the
  // folder is otherwise made by ./scripts/new-dashboard.sh days later, and a
  // folder holding only `<slug>.db` is a legitimate state for the conventions
  // sweep — it calls it "not started".
  mkdirSync(dirname(path), { recursive: true })

  // Idempotent: a file already there is left exactly as it is, so a retry
  // after a partial registration never replaces a database holding a row.
  // This short-circuit is an OPTIMISATION, not the guarantee — it only avoids
  // building a temp database nobody will link. The guarantee is `link()`
  // below, which fails EEXIST and keeps whatever is already there.
  if (existsSync(path)) return

  // Same directory, so link() stays within one filesystem, and named so it can
  // never collide with any real `<slug>.db`: SLUG_PATTERN forbids dots, so no
  // valid slug can produce this name. It still ENDS in `.db`, deliberately, so
  // the guard hook denies reading it exactly like any other non-synthetic
  // database, and `.gitignore`'s `*.db` covers it. Dot-prefixed so a person
  // running `ls` in a user folder does not see something that looks like their
  // data.
  const temp = join(
    dirname(path),
    `.creating-${randomBytes(8).toString('hex')}.${slug}.db`,
  )

  try {
    const db = new Database(temp)
    try {
      db.pragma(`cipher='${CIPHER}'`)
      db.key(key)
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      // NO SCHEMA, EVER, AND NO STATEMENT IN ITS PLACE.
      //
      // This function's whole job is to bring an encrypted FILE into being.
      // Shape belongs to lib/db/migrate.ts (D6): a database created here holds
      // zero tables until the runner applies 001, and that is true on every
      // path — registration, and a writable open of a file that went missing.
      //
      // Nothing is substituted for the deleted exec, and that is measured
      // rather than an omission. An earlier plan called for a `user_version`
      // pragma here, on the theory that without a write the driver would leave
      // a zero-byte file that opens under any key. The drill disproved it: the
      // `journal_mode = WAL` pragma above has already written the encrypted
      // header, so the file is a real encrypted database either way. The
      // property is held by the test ("writes a real encrypted file, not a
      // zero-byte placeholder"), which stays true whichever statement provides
      // the bytes — and it matters more now, because the runner reads
      // `user_version` off this file before it writes anything to it.
    } finally {
      db.close()
    }

    try {
      linkSync(temp, path)
    } catch (error) {
      // EEXIST means a concurrent first-write already put a database there.
      // That file is schema'd by this same code and keyed with this same key
      // — the key derives from the account's password and salt, so two
      // sessions for one user cannot hold different keys. Use theirs.
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
  } finally {
    // The linked name and this one are two directory entries for one inode;
    // dropping this one leaves the real path untouched. On the failure paths
    // it is the only entry, so this is the cleanup. A process killed before
    // here leaves debris under a name nothing ever opens — which is the whole
    // point, and is why that debris is not at `path`.
    try {
      unlinkSync(temp)
    } catch {
      // Never let cleanup mask the real error.
    }
  }
}

/**
 * Open (or create) a user's encrypted database with `key`.
 *
 * The key is applied with db.key(Buffer), never a `key=` pragma: a pragma
 * would turn 32 bytes of key material into a SQL string on its way through
 * the driver. The buffer belongs to lib/session/keymap.ts, which zeroes it in
 * place on expiry — this function uses it and keeps no reference.
 *
 * Creating and opening are the same call because the file is created lazily on
 * first write (design spec section 3): a user with no logged data has no real
 * database, and their dashboard reads the synthetic one under a banner.
 *
 * With `{ readonly: true }` it neither creates nor migrates: `fileMustExist`
 * means a missing file is an error rather than a new empty database, and the
 * handle refuses every write. See `OpenEncryptedOptions.readonly`.
 */
export function openEncryptedUserDb(
  slug: string,
  key: Buffer,
  options: OpenEncryptedOptions = {},
): EncryptedUserDb {
  const readOnly = options.readonly === true
  const path = encryptedUserDbPath(slug)
  const existedBefore = existsSync(path)

  // Creation is its OWN step, and it happens somewhere else. Once it returns,
  // `path` holds a complete encrypted database — either the one it just built
  // or the one a concurrent request won the race to link. Nothing below can
  // observe a half-made file at that path, which is why neither open needs to
  // be able to create one.
  //
  // TABLE-LESS, always. Shape comes from lib/db/migrate.ts and nowhere else
  // (D6), so this no longer distinguishes "the walk route's open" from any
  // other — a database created here is empty until the runner touches it.
  if (!readOnly && !existedBefore) {
    createEmptyEncryptedDbAt(slug, path, key)
  }

  // fileMustExist on BOTH paths now: `new Database` is never the thing that
  // brings a user's real database into being. On the read path that stops a
  // render conjuring one; on the write path it means a file deleted between
  // the create above and this open is an error rather than a silent, empty,
  // schema-less replacement. A missing file throws SQLITE_CANTOPEN here,
  // OUTSIDE the try — nothing was created, so there is nothing to clean up,
  // and it must not be relabelled as a wrong key.
  const db = new Database(path, { readonly: readOnly, fileMustExist: true })
  try {
    // Cipher and key are both applied before any statement touches the file
    // (WAL and foreign_keys, then schema.sql). This order is deliberate —
    // not because a specific failure from reordering was observed here:
    // reversing cipher and key was tested directly against this driver and
    // it still produced a correctly encrypted file.
    db.pragma(`cipher='${CIPHER}'`)
    db.key(key)

    if (readOnly) {
      // A wrong key must still surface HERE rather than at the dashboard's
      // first SELECT, where it would arrive as an unnamed driver error. The
      // schema exec is the writable path's key check; a read of sqlite_schema
      // is this path's — it is the same first touch of the encrypted pages,
      // and it writes nothing.
      db.prepare('SELECT count(*) FROM sqlite_schema').get()
    } else {
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')

      // The schema exec, when there is one. A friend whose dashboard has not
      // been built yet has none (onboarding ledger D3), and that path needs no
      // substitute key check — which is worth stating, because this file used
      // to claim "the schema exec doubles as the key check" and that was never
      // quite true. The drill showed the `journal_mode = WAL` pragma above
      // already throws SQLITE_NOTADB on a wrong key, so by the time control
      // reaches here the key has been proven either way, and the catch below
      // has already turned it into a WrongKeyError. An explicit
      // `SELECT count(*) FROM sqlite_schema` here reddened nothing and was
      // removed rather than kept as decoration.
      // No schema exec any more (D6). The `journal_mode = WAL` pragma above
      // already throws SQLITE_NOTADB on a wrong key, so the key has been
      // proven by the time control reaches here and the catch below has
      // already turned a bad one into a WrongKeyError — which is what the
      // comment above established when the exec was still here.
    }
  } catch (error) {
    db.close()
    // NO unlink of `path` here, deliberately, where Task 1's fix used to put
    // one. That unlink existed because a failed open could leave a table-less
    // stub at the real path, and the stub made `existedBefore` true on the
    // retry, so the CORRECT key would be reported as wrong forever. Building
    // the file elsewhere and linking it removes the stub instead of cleaning
    // it up: whatever is at `path` is now always a complete database, and
    // deleting it on a failed open would destroy a valid file — possibly one a
    // concurrent request has already written a row into. The property Task 1
    // wanted is preserved by `createEncryptedUserDb`'s own temp cleanup, which
    // `leaves no file behind when the open fails on a brand-new file` still
    // pins.
    const notADb =
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'SQLITE_NOTADB'
    // Only a file that already existed can be a KEY mismatch. A brand-new file
    // that fails to open is something else entirely and must not be relabelled.
    if (notADb && existedBefore) throw new WrongKeyError(slug)
    throw error
  }
  return db
}

// `createEmptyEncryptedUserDb` lived here, called by the registration route.
// It is gone: registration no longer creates a friend's database, the
// migration runner does, at the same moment and from the same key
// (2026-08-15 migrations design, §8). onboarding-ux-spec.md S2 still holds —
// the file exists the moment the password does — because registration is one
// of the three places the runner fires.
//
// `createEmptyEncryptedDbAt` above absorbed its two jobs: creating
// `users/<slug>/` when nothing else ever has, and returning without touching
// a file that is already there.

/**
 * Whether this database holds anything yet.
 *
 * THE PREDICATE THE RENDER PATH USES TO DECIDE REAL-VS-SYNTHETIC, replacing
 * `encryptedUserDbExists`. Since S2 creates the file at password-set time,
 * existence no longer means "this friend has data" — it means "this friend has
 * an account".
 *
 * Getting this wrong is not a cosmetic bug. A read-only handle can never
 * create the tables a dashboard's first SELECT needs, so an empty file read as
 * real produces a permanent "This dashboard failed to load" that the friend
 * has no control to escape — the exact ssh-only dead end
 * `createEncryptedUserDb`'s docstring was written to remove.
 *
 * An empty real database is honestly described by the synthetic screen and its
 * banner: nothing has been logged, so there is nothing real to render. The
 * rule that matters — the banner is never shown OVER real data — still holds.
 *
 * Opens and closes its own handle rather than returning one. A handle is
 * scoped to one key and a key is scoped to one session; handing one out of a
 * predicate is how a handle outlives its key (step-5 ledger, residual 4).
 */
export function encryptedUserDbHasTables(slug: string, key: Buffer): boolean {
  if (!encryptedUserDbExists(slug)) return false
  const db = openEncryptedUserDb(slug, key, { readonly: true })
  try {
    const { n } = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { n: number }
    return n > 0
  } finally {
    db.close()
  }
}
