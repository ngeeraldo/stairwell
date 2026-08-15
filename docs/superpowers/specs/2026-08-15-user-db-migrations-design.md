# User database migrations — design

**Status:** design, not yet built.
**Supersedes:** step-6a ledger residual 2 (no migration story), and step-6a
design §8.2 for the migration window only — see §5.3.

---

## 0. Why this exists now, and what it is not

A real `<slug>.db` is created once and **frozen at that shape**. Nothing
migrates it. That is step-6a ledger residual 2, and it was never designed — the
step-6a design's §8 lists five known limits and migration is not among them. It
was discovered afterwards and recorded.

The root cause is the privacy model, read from the other side. Every other
database here migrates automatically because anything can open it:
`openPlatformDb` runs `reshapeSacredTables(db)` and then execs the schema on
every open (`lib/db/platform.ts:23-24`), and synthetic per-user files are
regenerated wholesale each deploy. A real `<slug>.db` is SQLCipher-encrypted
under a key that exists only while that friend has an unlocked session, in the
in-process keymap (`lib/session/keymap.ts:31-32`), never serialized. **There is
no moment at deploy or startup when the server can open one.** The cost of zero
server-side access is zero server-side migration.

This design makes user tables editable by running migrations at the only moment
the key exists: when the friend unlocks.

**What this is not.** Not a backup system (§5.3). Not a rollback system (§5.2).
Not a Plaid design — residual 2 named 6b as the forcing function, and this
removes that blocker without designing anything Plaid-shaped.

---

## 1. Decisions

Recorded with reasoning, because an unwritten ruling is one that recurs.

- **D1 — Full DDL, `ALTER` included.** Add-only recreates the freeze in a softer
  form; the motivating case is a column on an existing table, which is the
  common iteration rather than the exotic one. Discipline does not live in
  restricting the SQL vocabulary — it lives in the properties around it (D2,
  D3, D9).
- **D2 — Applied migrations are immutable.** Added, never edited; a fix is a new
  file. Same property as prompt files (unified-loop ledger D13) and for the same
  reason: something already stamped points at the file's content.
- **D3 — Every migration above `001` ships a data-survival test in the same
  commit.** Seed the old shape, migrate, assert the rows survived. This is what
  earns D1.
- **D4 — The standard rebuild recipe is sanctioned**: create new table, copy,
  drop old, rename. It is what `lib/db/reshape.ts` does, minus the zero-rows
  proof — which is exactly the assumption that fails on a database holding a
  real person's history (residual 2's own words).
- **D5 — The runner is the second schema-surgery site in `lib/db`, and its
  exception is data-preserving surgery proven by test.** `reshape.ts`'s rule is
  unchanged and unweakened: it stays the one place allowed to drop a sacred
  table after proving it holds zero rows. **Never point `reshape.ts` at a user
  database.**
- **D6 — Migrations own the shape from `001`.** No database is created from a
  schema file. `users/<slug>/schema.sql` is deleted (§7).
- **D7 — There is no real-vs-synthetic fallback.** Deployed and unlocked always
  serves the real database (§6).
- **D8 — Bookkeeping is `PRAGMA user_version` only.** No table inside the
  friend's database. See §3 for what this narrows.
- **D9 — A migration never seeds rows.** Changing a shape must not invent data,
  independent of what any banner does.
- **D10 — A copy is taken before applying** (§5.3).
- **D11 — A failed migration refuses the session** (§5.1). Never new code over a
  half-migrated shape, never silent degradation.
- **D12 — Existing real databases are deleted rather than adopted** (§8).

---

## 2. The runner — `lib/db/migrate.ts`

### 2.1 Where it fires

Wherever a key becomes available and a session is about to become usable. Today
that is exactly three `putKey` sites:

| Site | Moment |
|---|---|
| `app/api/login/route.ts:37` | password login |
| `lib/auth/flow.ts:102` (`unlock()`) | unlock after a restart |
| `lib/invite/register.ts:121` | registration |

It runs **before the session is treated as established**, so a failure can
refuse it (§5.1).

A friend whose folder holds no `migrations/` — no dashboard built yet — still
gets the file created and nothing applied. That is not a failure, and it is what
keeps S2's requirement true: the database exists the moment the password does,
whether or not anyone has built them a dashboard.

### 2.2 What it does

1. Read `PRAGMA user_version` from the friend's database. Absent file ⇒ create
   it, atomically, by the same temp-and-link path `createEncryptedUserDb`
   already uses; version starts at 0.
2. Verify every migration file against the committed manifest (§3.2). Any
   mismatch refuses.
3. If `user_version` equals the highest migration number, return. This is the
   overwhelmingly common path and must be cheap — one pragma read.
4. Otherwise copy the database aside (§5.3) **unless it was created moments ago
   in step 1** — a file with no tables and no rows has nothing to lose, and
   copying it would spend the one backup slot on an empty database.
5. Apply each pending migration in numeric order, each in its own transaction,
   setting `user_version` inside that transaction so the counter can never
   disagree with the shape.
6. On success, replace the previous backup.

### 2.3 Concurrency

One in-process lock per slug, held across the whole run; a second concurrent
request for the same friend waits rather than racing. Two sessions for one
friend cannot hold different keys — the key derives from their password and salt
— so waiting is always correct.

**In-process is sufficient because the service is a single process**, the same
assumption the keymap already makes (`lib/session/keymap.ts`). If that ever
stops being true, this lock stops being sufficient, and it fails by allowing two
concurrent migrations of one database rather than by refusing — a failure mode
worth naming before it is a surprise.

---

## 3. Bookkeeping — pragma only

### 3.1 The counter

`PRAGMA user_version` holds the highest applied migration number. Nothing else
lives in the friend's database: no `_migrations` table, no bookkeeping rows.

Set inside the same transaction as the DDL it describes, so a crash cannot leave
a database whose recorded version and actual shape disagree.

### 3.2 The manifest, and what it does not cover

`user_version` is a single 32-bit integer. It holds *which* migration a database
is at and nothing more — in particular it cannot hold a checksum.

So checksums live in one committed manifest per friend, listing each migration's
number and the SHA-256 of its bytes. The runner compares **file against
manifest** on every run and refuses on any mismatch, which catches an edited
migration (D2) repo-side, before it is applied anywhere.

**Stated rather than implied:** this is weaker than a per-database record. The
guarantee is *"no applied migration in the repo has changed"*, not *"no applied
migration on this friend's database has changed."* A database that received a
migration whose file was later edited and re-checksummed cannot be detected by
the database itself, because the database remembers only a number. At N=3
friends with a manifest under review that is the right trade; it stops being one
at a scale where nobody reads the diff.

---

## 4. Migration files

```
users/<slug>/migrations/001_initial.sql
users/<slug>/migrations/002_add_pace_target.sql
users/<slug>/migrations/manifest.json
```

Per friend, because each dashboard has its own shape. Numeric prefix, applied in
order, never renumbered. `001` is authored — it is the initial `CREATE TABLE`
set — and is the one migration with no data-survival test, because there is no
prior shape for data to survive from.

Plain SQL, no templating. A migration that needs the rebuild recipe (D4) writes
it out: create, copy, drop, rename, in one file, inside the runner's
transaction.

---

## 5. Failure

### 5.1 Refuse the session

A failed migration means: the key is dropped, the session does not proceed,
nothing renders, and the friend sees pinned failure copy. Never a dashboard over
a half-migrated shape.

**All session refusals share one exit** — one function, one copy block, one
alert. Per-case branching is what produces a refusal path nobody has read in
six months.

### 5.2 No rollback machinery

The copy from §5.3 exists; restoring it is an operator action by Nico. At N=3
that is the right amount of machinery, and automatic rollback of a partially
applied DDL is a second failure path with its own failure modes.

### 5.3 The copy

Before applying anything: `<slug>.db` → `<slug>.backup.db`. Rolling one deep,
replaced after the next successful run.

The name is deliberate. The guard hook denies any `*.db` that is not
`synthetic.db`, so `.backup.db` is denied with **no hook change**; a `.bak`
suffix would have made the backup the one readable copy of the thing the hook
exists to protect. `.gitignore`'s `*.db` (line 3) covers it for the same reason.

**This supersedes step-6a design §8.2 ("`<slug>.db` is not backed up") for the
migration window only**, and is recorded here rather than as an edit to that
document, which remains an accurate record of what step 6a shipped.

**It changes nothing about §8.1.** The copy is encrypted under the same key, so
a forgotten password still destroys everything. This is a migration-window
safety copy, not a backup system, and **no user-facing copy may imply recovery
exists.**

### 5.4 The alert

One ntfy alert on the shared refusal exit, carrying **slug, migration number,
and the error's `code`**. Not the error message: `lib/db/failureLog.ts` already
draws exactly this line — it logs event, slug, error `name` and `code` and never
the message — because a constraint violation can carry a column's contents, and
metrics and alerts carry no user values.

The full error goes to the server log. Two goals, met separately: the phone says
*a migration broke, for this friend, at this number*; the log says why.

---

## 6. Which database serves

| | Reads | Writes |
|---|---|---|
| **Production** | `<slug>.db` | `<slug>.db` |
| **Dev** | `synthetic.db` | `synthetic.db` |

**There is no fallback.** Deployed and unlocked always serves the real database,
even when it holds zero rows. `encryptedUserDbHasTables` and the real-vs-
synthetic branch in `app/[user]/page.tsx:101-122` are deleted.

In dev, `synthetic.db` **is** the user database for the whole loop — reads and
writes, through the same routes. Type a weight, it saves to synthetic, the
screen shows it. Wiped and rebuilt by `seed.py` on each regeneration.

Gated on `NODE_ENV`, inert in production **by construction** rather than by
configuration. This matters: `deploy/required-env` records that `PLATFORM_DB`
is REQUIRED precisely because its absence made production serve loudly-fake data
with every health check green. A selector that could be switched on in
production would rebuild that hazard; one that cannot be is a different thing.
Red-tested — deleting the gate must turn a test red.

**The invariant that keeps this safe: real databases exist only on the server.**
Dev never has a real-named file, so the guard hook's filename partition stays
intact and `synthetic.db` remains the one database anything local may open.

**Unchanged in both worlds:** a dashboard component never holds a writable
handle. Routes do the writing. The read-only rule at
`app/[user]/page.tsx:138` survives this design intact.

---

## 7. Folder conventions

`users/<slug>/schema.sql` is deleted. The five required entries become:

`migrations/` · `seed.py` · `queries.ts` · `dashboard.tsx` · `tests/`

`tests/users/conventions.test.ts:45` and its three-state sweep (pulled / built /
partial) are rewritten against the new list. `seed.py` runs `001..n` instead of
executing a schema file, so **a synthetic database is built by exactly the code
path a real one is** — one path, tested once, incapable of drifting from the
shape it is supposed to mirror.

`platform/templates/dashboard/` and `./scripts/new-dashboard.sh` scaffold
`migrations/001_initial.sql` in place of `schema.sql`.

---

## 8. Existing databases

**Deleted, not adopted.** Before this ships, Nico removes every real database
file on the droplet:

```bash
rm users/<slug>/<slug>.db*
```

Every one is then built by `001..n` at that friend's next unlock. The runner
carries no adoption branch, no stamp-without-applying, and no assumption about
a shape nobody verified.

**Files only — never accounts.** `transcripts`, `metrics` and `specs` all carry
`account_id` with **no foreign key**; only `sessions` and `account_keys`
cascade. Deleting accounts would not clean those rows up, it would orphan them
against ids that no longer exist — and CLAUDE.md forbids deleting transcripts
and metrics outright, so they could not be tidied afterwards. `specs` also holds
every confirmed spec version, which is what `./scripts/pull-spec.sh` exists to
read; deleting an account means a real person redoes their interview.

Nothing of value is lost: the encrypted files hold no rows.

**Consequence:** registration no longer creates the database — the runner does,
at the registration `putKey` site. `createEmptyEncryptedUserDb` is deleted, and
with it the `applySchema` flag added earlier today, which this design absorbs
rather than keeps. S2's requirement that the file exist the moment the password
does is still met, by a different mechanism.

---

## 9. Every dashboard renders on zero rows

With no fallback, a friend's first session shows their real database, which is
empty. An empty dashboard is now a **normal state**, not an error, and every
dashboard must render one.

Enforced twice:

1. **A scaffolded empty-render test.** The scaffold ships it, so a dashboard is
   born with it rather than acquiring one if someone remembers.
2. **An empty-state screenshot variant.** A new screen in
   `screenshots/screens.ts` with its own seeder, so the empty state is reviewed
   as a picture — the class of defect no test here can see.

---

## 10. Documentation this forces

| Where | What |
|---|---|
| `CLAUDE.md:154-159` | "Exactly TWO writable opens… A third is a change to onboarding ledger D3" — rewritten for the runner. |
| `CLAUDE.md:97-100` | "**Nothing migrates it**" — false; becomes a pointer to this design. |
| `CLAUDE.md:148-153` | Read-only handle rule — **preserved deliberately**, it sits inside the rewritten passage. |
| `CLAUDE.md:32-35` | `reshape.ts` exception — unchanged, gains D5's companion clause. |
| `CLAUDE.md` folder conventions | `schema.sql` → `migrations/`; "everything is synthetic until first write" is deleted. |
| `docs/dashboard-build-rules.md` §4, §5, §1, §10 | Enumeration, the freeze section, the residual-2 pointer, migration test rule. |
| `docs/dashboard-build-rules.md` §3 line 72 | **Guarded, not edited.** "A database with no migration story" is the friend-timezone rationale. A migration changes a shape; it cannot repair a row whose meaning was wrong when written. |
| `lib/copy/onboarding.ts` | Fourth pinned block (§11). |
| step-6a ledger | **Not edited.** Residual 2 is closed by this work; ledgers are records, not living documents. |

---

## 11. Copy

A fourth pinned block, in the existing voice:

> Something broke on our end and we need to fix it.

`copy.server` ("try once more, then text Nico") is **not** reused. It was
written for a retryable failure; this one is not, and telling a friend locked
out at 7am to retry something that cannot succeed spends the honesty that
refuse-on-failure was chosen to buy.

Pinned sentence-by-sentence in `tests/copy/onboarding.test.ts` like the other
three.

---

## 12. Tests

- Runner: no-op at current version; applies pending in order; version set inside
  the transaction; manifest mismatch refuses; missing `migrations/` is a no-op.
- **Red-test discipline**, per the step-6a precedent: deleting the `NODE_ENV`
  gate, the manifest check, or the backup must each turn a test red.
- Data survival, per migration above `001` (D3).
- Refusal: key dropped, nothing rendered, copy shown, one alert with slug,
  number and code — and **no error message in the alert payload**.
- Backup: written before apply, replaced after success, denied by the guard
  hook.
- Empty render, per dashboard, scaffolded (§9).
- `seed.py` builds a synthetic database byte-equivalent in shape to a migrated
  real one — the property that replaces the deleted `schema.sql`.

---

## 13. Known limits, stated rather than implied

1. **The manifest proves the repo, not the friend's database** (§3.2). A
   per-database record would need a table, which D8 rules out.
2. **A migration is applied at unlock, so a slow one is a slow login.** No
   progress surface exists; a friend sees a pending login. At N=3 with
   single-digit tables this is theoretical, and it becomes real the first time a
   migration rewrites a table with months of rows in it.
3. **The backup is one deep and same-key.** A migration that succeeds and
   corrupts semantically — right shape, wrong data — is not recoverable once the
   next successful run replaces the copy.
4. **`user_version` is a single integer**, so branching or out-of-order
   migrations are not representable. Numeric order is the only order.
5. **Nothing verifies the deployed backup was ever written.** The tests prove
   the runner writes one; only inspecting the droplet proves it did. Worth one
   manual check after the first real migration, the same way step-6a §8.3 calls
   for one `head -c 16`.
6. **Dev and production now run different database files through the same
   routes.** The `NODE_ENV` gate is a single point of failure for the invariant
   that a real file never exists locally; it is red-tested, and that is the
   whole of its protection.
