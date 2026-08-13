# Step 6a — Encrypted per-user data, and the first write path

**Status:** design, awaiting Nico's review. Written 2026-08-13.

Build-order rows: `architecture-overview.md`, steps 6a and 6b.

> | 6a | Per-user encrypted data layer: SQLCipher `<name>.db`, key derived at
> login, and the first write path (manual logging) behind the lock | `devtwo`
> taps "walked" on their own dashboard; the row survives a deploy; a locked
> session can neither read it nor write it |

## 0. Why this exists now, and what it is not

Step 6 was split during the step-5 build. `devtwo`'s confirmed spec is a
manual-logging tracker whose primary control is a tap, and step 5 shipped a
deliberately read-only data layer — so the first real dashboard needs a write
path before it is what it claims to be. Writing to `synthetic.db` was rejected
twice over: `deploy.sh` regenerates it on every deploy, and real taps sharing a
file with loudly-fake seeded rows breaks the rule that any screen reads
instantly as fake or real.

**This step is the data layer and one write path. It is not Plaid.** No Link
flow, no sync, no `plaid.sql`, no `modules/`. Those are 6b, unchanged.

**It is also not the privacy toggle.** Step 7 still owns swapping live numbers
for synthetic ones on demand. What 6a settles is which database a dashboard
reads when nobody has asked for anything.

## 1. What already exists — 6a is smaller than it looks

Almost every part of this was built in step 1a and has been running since:

| Piece | Where | State |
|---|---|---|
| A 32-byte key derived from the password | `lib/auth/password.ts` → `deriveDbKey` (Argon2 `hashRaw`, `outputLen: 32`, salted with `accounts.salt_key`) | Working |
| Key put in an in-process map at login | `app/api/login/route.ts` and `lib/auth/flow.ts` → `unlock` | Working |
| Idle/absolute TTL, wipe-on-drop, sweep | `lib/session/keymap.ts` | Working |
| Locked vs unlocked as a routing state | `lib/session/resolve.ts` | Working |
| A page that withholds the data region while locked | `app/[user]/page.tsx` | Working |
| Per-user folder, schema, and a read-only synthetic opener | step 5 | Working |

**What is missing is exactly two things:** an opener that uses that key to open
a SQLCipher file, and a route that writes through it. The key already exists,
is already the right length, and already dies with the process.

## 2. The opener — `lib/db/encryptedUserDb.ts`

A **new module**, not an extension of `lib/db/userDb.ts`. Step 5's ledger
(residual 4) is explicit that `openUserDb`'s process-wide cache is correct only
for a read-only file that changes at deploy, and that step 6 must add its own
opener rather than widening that one. This honours it.

```ts
export type EncryptedUserDb = Database.Database

/** Opens users/<slug>/<slug>.db with `key`, creating it if absent. */
export function openEncryptedUserDb(slug: string, key: Buffer): EncryptedUserDb
```

- **Slug validated first**, via the same `SLUG_PATTERN` from `lib/auth/slug.ts`
  that `userDbPath` uses. This is the second place a URL-derived string becomes
  a filesystem path, and it fails closed identically.
- **Raw key, no second KDF.** `PRAGMA key = "x'<64 hex>'"` passes the 32 bytes
  directly. The password has already been through Argon2 with a per-account
  salt; running SQLCipher's own PBKDF2 over the result would add latency and no
  security. The key is hex-encoded for the pragma and that string is never
  logged, returned, or stored.
- **Cipher pinned explicitly**, not left to the library's default. A default
  that changes in a future release would make every existing file unreadable
  with no error that says so. The pragma is written out and asserted by a test.
- **No caching.** Each request opens and closes. A handle is scoped to one
  key, and a key is scoped to one session — caching it process-wide is exactly
  the bug residual 4 warns about. Cost is one file open per render; measure
  before optimising.
- **Schema applied on open**, from the same `users/<slug>/schema.sql` the
  synthetic generator uses. One schema, two databases: one loudly fake, one
  real. This is what keeps them from drifting.
- **A wrong key must fail loudly.** SQLCipher reports a bad key as "file is not
  a database". The opener catches that specific case and throws a named error,
  so a key mismatch can never be mistaken for a corrupt or missing file.

**Callers must not retain the key.** `getKey` returns the buffer by reference
and `keymap` zeroes it in place on expiry; this module uses it within the call
and keeps no reference.

## 3. Which database a dashboard reads

Three states, resolved per request:

| Session | `<slug>.db` exists | Reads | Banner |
|---|---|---|---|
| locked | — | nothing; the lock notice (unchanged) | — |
| unlocked | no | `synthetic.db` | **SYNTHETIC DATA** |
| unlocked | yes | `<slug>.db` | none |

**The real database is created lazily, on first write — not at login.** This is
the decision that keeps `devone`'s reference dashboard working: it is never
written to, so it never acquires a real database and keeps rendering its
loudly-fake sample under the banner. A friend sees sample data with the banner
until their first tap, and their own data from then on.

The alternative — creating an empty real database at first unlock — would blank
every dashboard on first login, including the one that exists to demonstrate
what a dashboard looks like.

**Consequence, stated rather than discovered:** `devtwo` will see a fake walk
history until the first tap, then a real and empty one. The streak drops from
whatever the sample showed to zero. The banner is the only thing distinguishing
those two screens, which is precisely the job the fake-or-real rule gives it.

## 4. The write path

A route handler, not a client fetch, so the dashboard stays a server component
and matches the existing logout control.

```
POST /api/users/[user]/walk      → 303 back to /[user]
```

Four checks in this order, and the order is the security property:

1. `resolveState` is `unlocked` — not merely authenticated. A locked session has
   no key, so it must be refused before anything else looks at the request.
2. `canSeeUserSpace(db, sessionId, user)` — ownership, 404 not 403, same rule as
   the page.
3. The slug has a registered dashboard, so an arbitrary slug cannot cause a
   database to be created.
4. Only then: derive nothing, fetch the key from the keymap, open, write, close.

**Idempotent by schema, not by check.** The walk table is keyed on the local
calendar day:

```sql
CREATE TABLE IF NOT EXISTS walks (
  day TEXT PRIMARY KEY,   -- 'YYYY-MM-DD', local calendar
  at  INTEGER NOT NULL    -- when it was logged, ms
);
```

`INSERT OR IGNORE` makes a double-tap a no-op without a read-modify-write race.
The day key is the **local** calendar date, matching `monthRange`'s basis in
`users/devone/queries.ts` — and the UTC/local mismatch that shipped in devone's
first version is the reason that is spelled out here rather than assumed.

**A generic route, not a devtwo route.** The path is `/api/users/[user]/walk`
rather than `/api/walk` so the owner check has a subject, but the handler is
per-action. One more manual-logging action means one more small route, which is
the right amount of ceremony for something that writes to a friend's encrypted
database.

## 5. `devtwo`'s dashboard

Built from `users/devtwo/spec.md` toward `users/devtwo/mockup.html`, in the
step-5 folder convention. Four panels, all from one `walks` table:

- **Walked today?** — today's state plus the tap control. The one write.
- **Current streak** — consecutive days ending today *or yesterday*. The grace
  day is from the spec, not invented: a streak should not break at midnight
  before the day is over.
- **Last 30 days** — percentage over a rolling window, per the confirmed spec's
  explicit rejection of all-time.
- **Last 14 days at a glance** — a row of markers, oldest to newest.

`seed.py` generates a plausible fake history so the pre-first-tap screen is not
empty. Its values carry the `TEST` marker like every other generator.

## 6. Metrics — RULED 2026-08-13

> **Option 2, adopted as permanent policy rather than as a choice for this
> dashboard.** `dashboard_write` carries a **slug and a panel, never a value** —
> for every panel type, now and in future. Nico's reasoning: it is the right
> shape for every future panel, and the retention curve is non-negotiable.
>
> **Paired with a concrete promise amendment**, not a gesture at one. The login
> paragraph gains: *"I can see when you use it — which days you open it and log
> things — but not what you log."* The policy is what makes that sentence true,
> so the two stand or fall together. Both live in
> `architecture-overview.md` section 4 and are pinned in
> `tests/routing/loginPage.test.ts`.

The original framing, kept because the reasoning is the point:

**Does a tap get a metrics row?**

Retention is the thing this pilot exists to measure, and a tap is the purest
engagement signal the product will ever have. But `metrics` lives in the
unencrypted platform database, and for this dashboard "they tapped" and "they
walked the dog" are the same fact. Logging it puts a friend's daily behaviour in
the one file the encryption exists to avoid needing.

The onboarding promise says: *"I'll see what you tell the agent and what you ask
for. I won't open your transactions."* A walk log is closer to a transaction
than to a request.

Three options, and I recommend the second:

1. **Log the tap with its day.** Best retention data, worst privacy story, and
   it contradicts the promise as written.
2. **Log that a write happened, with the slug and the panel, and no value or
   day.** You learn "devtwo engaged with the tracker on the 13th" — which is the
   retention curve — without learning whether the dog got walked. The row is
   `dashboard_write`, not `walk_logged`.
3. **Log nothing.** Cleanest promise, and the retention curve for manual-logging
   dashboards has to be reconstructed from `dashboard_open` alone.

Option 2 preserves the curve and keeps the promise true. It is still worth
saying out loud that the *existence* of engagement is itself information about a
friend, and that the promise's next revision should mention it.

## 7. Tests

The delete-the-guard rule applies to every guard below.

- **`tests/db/encryptedUserDb.test.ts`** — a file written with one key cannot be
  opened with another, and fails with the named error rather than a generic
  one; the file is unreadable as plain SQLite (a real encryption assertion, not
  a round-trip); slug traversal is refused; the schema is applied on create; the
  pinned cipher pragma is what the opener actually sets.
- **`tests/routing/walkRoute.test.ts`** — locked is refused *before* any key
  lookup or file open (asserted on the calls, as step 5's lock test is, so it
  stays honest); a non-owner gets 404; an unregistered slug creates no file;
  a double tap writes one row; the redirect is host-relative per
  `lib/http/redirect.ts`.
- **`users/devtwo/tests/queries.test.ts`** — streak across the grace day and
  broken by a two-day gap; the 30-day window at both ends; the 14-day row's
  order and length; empty-table behaviour for all four.
- **`users/devtwo/tests/dashboard.test.ts`** — wiring: each panel's computed
  value reaches the output, the mutation devone's suite proved worth pinning.
- **`tests/users/conventions.test.ts`** — passes unchanged once devtwo is built,
  and its "never half a dashboard" case covers the intermediate.

## 8. Known limits, stated rather than implied

1. **A forgotten password destroys the data, permanently.** The key is derived
   from the password and stored nowhere; there is no reset path and no backup.
   This is the design working as intended.

   **RULED 2026-08-13 — in the onboarding copy, verbatim-blunt:** *"If you
   forget your password, your logged data is gone forever — I can't recover it,
   on purpose, because I can't read it either."* Shipped on the login page and
   pinned in `tests/routing/loginPage.test.ts`. Stated as the deal rather than
   as a caveat, which is the only honest way to state it.
2. **`<slug>.db` is not backed up.** Step 7 covers an off-VPS backup for the
   metrics log; per-user encrypted data is not in that scope, and a droplet loss
   is a data loss.
3. **Nothing verifies the file is encrypted on the droplet.** The tests prove
   the opener encrypts; only inspecting the deployed file proves the deployed
   file is encrypted. Worth one manual check with `head -c 16` on the first real
   `<slug>.db` — a SQLCipher file does not begin with `SQLite format 3`.
4. **The key lives in process memory for up to 4 hours idle / 12 absolute.**
   Unchanged from step 1a, but it now protects real data rather than nothing.
5. **`openEncryptedUserDb` opens per request.** If that shows up in render time,
   the fix is a session-scoped cache with an explicit lifetime — not the
   process-wide one step 5 warns against.
