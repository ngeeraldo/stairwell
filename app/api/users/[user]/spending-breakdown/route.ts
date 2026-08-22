import { cookies } from 'next/headers'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { appendMetric } from '@/lib/db/appendOnly'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { openUserDataForWrite } from '@/lib/db/userData'
import { logDbFailure } from '@/lib/db/failureLog'
import { getDb } from '@/lib/db/instance'
import { dashboardLoaderFor } from '@/lib/dashboard/registry'
import { writeAnswer } from '@/lib/http/redirect'
import { getKey } from '@/lib/session/keymap'
import { resolveState } from '@/lib/session/resolve'
import { SESSION_COOKIE } from '@/lib/session/store'

/**
 * run12's Spending Breakdown screen: re-file a transaction, make a bucket, or
 * tick a category in or out of the pie.
 *
 * ─── WHY THIS IS NOT app/api/users/[user]/spending-category/route.ts ───────
 *
 * That route is run11's, does very nearly the same job, and is written against
 * a `[user]` path — so it would serve run12 verbatim. It is deliberately not
 * reused, for the reason app/api/users/[user]/pee-log/route.ts states about
 * NOT sharing run9's `pee` route: "a shared handler would make a change to one
 * friend's dashboard a silent change to another's". run11's spec v4 must be
 * free to change run11's route without anyone having to notice run12 was
 * standing behind it.
 *
 * A ROUTE OF ITS OWN, copied from platform/templates/route/route.ts.tmpl.
 * docs/dashboard-build-rules.md §4 is explicit that the template is a worked
 * example rather than a base class: the four checks below ARE the security
 * property, and they are cheaper to read twice than to trace through an
 * abstraction.
 *
 * The order of the checks IS the property:
 *
 * 1. unlocked — not merely authenticated. A locked session has no key, so it
 *    must be refused before anything reaches for one or opens a file.
 * 2. ownership — 404, never 403, so the response cannot confirm that another
 *    account exists.
 * 3. a registered dashboard — otherwise any authenticated slug could cause an
 *    encrypted file to be created for a user who has no dashboard at all.
 * 4. only then: key, open, write, close.
 *
 * ─── FOUR ACTIONS, ONE ROUTE ───────────────────────────────────────────────
 *
 * lib/ui/WriteAction.tsx groups its pending state by ACTION URL, so every
 * control posting here goes pending together and settles together. That is the
 * reason to merge rather than to split: the pie, the legend and the transaction
 * list are all drawn from ONE read, so a second write landing while the first
 * was settling would show the friend a pie and a list that disagreed.
 *
 * `show` and `hide` are two actions rather than one `toggle`, deliberately: a
 * toggle computes the new state from whatever it finds, so two presses racing
 * each other can land in the state neither of them asked for. Naming the target
 * state makes the request idempotent.
 *
 * ─── THIS ROUTE WRITES FREE TEXT ───────────────────────────────────────────
 *
 * `name` on the create path is a string the friend TYPES.
 *
 *   * It is bounded and normalised before it is stored — trimmed, collapsed of
 *     inner whitespace, rejected if empty or longer than MAX_NAME. An unbounded
 *     string in a TEXT PRIMARY KEY is a row nothing can render.
 *   * It is stored in HIS OWN SQLCipher database and nowhere else.
 *   * IT NEVER REACHES `metrics`. The rows below carry a constant panel name
 *     and nothing derived from the value — not the name, not the category, not
 *     the transaction id. CLAUDE.md's own example of what may not be written to
 *     that unencrypted table is a bucket called `divorce_lawyer_fund`, and this
 *     is the column that would hold one.
 *   * It is never logged. `logDbFailure` is handed the error, never the body.
 *
 * ─── NOTHING HERE TOUCHES A plaid_* TABLE ─────────────────────────────────
 *
 * Exactly one thing writes those: the shared refresh route. A category chosen
 * by hand is an ANNOTATION in the friend's own table keyed to `transaction_id`
 * — write it into the synced row and the next refresh would trample it
 * (CLAUDE.md > Schema & module rules). That is the mechanism behind "the move
 * survives every future refresh".
 */

/** The panels a metric row names. Constants, never anything derived. */
const PANEL_ASSIGN = 'spending_category_assign'
const PANEL_CREATE = 'spending_category_create'
const PANEL_SHOW = 'spending_category_show'
const PANEL_HIDE = 'spending_category_hide'

/**
 * The bound on a typed category name.
 *
 * RESTATED HERE rather than imported from users/run12/queries.ts: a platform
 * route importing a user folder would make one friend's dashboard a build
 * dependency of the platform. `tests/routing/spendingBreakdownRoute.test.ts`
 * reads this file's source and pins the number against the queries module,
 * which is what keeps the duplication honest.
 */
const MAX_NAME = 40

/**
 * A transaction id is opaque to us, so the only honest check is a bound.
 *
 * Plaid's ids are ~37 characters of base62 today. This is not a format
 * assertion — a format we guessed would start refusing real ids the day Plaid
 * widened them — it is a cap that stops an unbounded string reaching a query.
 * What actually decides whether the id is real is the existence check below.
 */
const MAX_TRANSACTION_ID = 128

/**
 * Trim, collapse inner runs of whitespace, and reject what is left if it is
 * empty or too long.
 *
 * The collapse matters because the name is a PRIMARY KEY: "Eating  out" and
 * "Eating out" are the same bucket to the friend and two rows to SQLite, and he
 * would have no way to tell them apart on screen. Control characters go the
 * same way — a name carrying a newline renders as a broken row in a menu.
 */
function normaliseName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  if (collapsed.length > MAX_NAME) return null
  return collapsed
}

/**
 * If this names one of his own buckets, return it with the bucket's own casing.
 *
 * `custom_categories.name` is COLLATE NOCASE so "Coffee" and "coffee" cannot be
 * two buckets — but a category KEY is compared exactly everywhere else, so a
 * request naming "coffee" would file a transaction into a category the legend
 * renders separately from "Coffee" and which no bucket lookup would recognise.
 *
 * Not reachable through the dashboard, whose menu posts the stored spelling.
 * Reachable through the no-JS path, which posts whatever the form holds — the
 * same reason every other check in this file exists.
 */
function snapToBucketCase(userDb: ReturnType<typeof openUserDataForWrite>, category: string) {
  const bucket = userDb
    .prepare('SELECT name FROM custom_categories WHERE name = ?')
    .get(category) as { name: string } | undefined
  return bucket?.name ?? category
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ user: string }> },
) {
  const { user } = await params
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) !== 'unlocked') {
    return new Response(null, { status: 403 })
  }
  if (!canSeeUserSpace(db, sessionId, user)) {
    return new Response(null, { status: 404 })
  }
  if (!dashboardLoaderFor(user)) {
    return new Response(null, { status: 404 })
  }

  const accountId = accountIdFor(db, sessionId)
  const key = getKey(sessionId!)
  // resolveState already proved a live key existed; this closes the window where
  // it expired between the two reads rather than throwing on undefined.
  if (accountId === undefined || !key) {
    return new Response(null, { status: 403 })
  }

  // READ AFTER the auth checks, deliberately: parsing a body is work done on
  // behalf of the caller, and an unauthenticated caller gets none of it.
  //
  // Wrapped because formData() throws on a malformed or absent body, and an
  // uncaught throw here would be a 500 in response to a form submit — the
  // friend's browser leaves the dashboard and lands on Next's error page.
  let action: FormDataEntryValue | null = null
  let transactionField: FormDataEntryValue | null = null
  let categoryField: FormDataEntryValue | null = null
  let nameField: FormDataEntryValue | null = null
  try {
    const form = await request.formData()
    action = form.get('action')
    transactionField = form.get('transaction_id')
    categoryField = form.get('category')
    nameField = form.get('name')
  } catch {
    return new Response(null, { status: 400 })
  }

  // A closed set of exactly four, checked before anything opens a database.
  if (action !== 'assign' && action !== 'create' && action !== 'show' && action !== 'hide') {
    return new Response(null, { status: 400 })
  }

  // Both branches validate SHAPE here and REALITY below, once a handle exists.
  // A File, or a missing field, is not a string — checked first so nothing below
  // is ever handed a non-string.
  let transactionId = ''
  let category = ''
  let name = ''
  if (action === 'assign') {
    if (typeof transactionField !== 'string' || typeof categoryField !== 'string') {
      return new Response(null, { status: 400 })
    }
    if (transactionField === '' || transactionField.length > MAX_TRANSACTION_ID) {
      return new Response(null, { status: 400 })
    }
    // The target category goes through the SAME normalisation a created name
    // does. It is chosen from a menu rather than typed, but the no-JS path posts
    // whatever the form holds, and a category assigned as "Eating  out" would be
    // a slice that never joins the bucket it came from.
    const normalised = normaliseName(categoryField)
    if (normalised === null) return new Response(null, { status: 400 })
    transactionId = transactionField
    category = normalised
  } else if (action === 'show' || action === 'hide') {
    if (typeof categoryField !== 'string') {
      return new Response(null, { status: 400 })
    }
    const normalised = normaliseName(categoryField)
    if (normalised === null) return new Response(null, { status: 400 })
    category = normalised
  } else {
    if (typeof nameField !== 'string') {
      return new Response(null, { status: 400 })
    }
    const normalised = normaliseName(nameField)
    if (normalised === null) return new Response(null, { status: 400 })
    name = normalised
  }

  const device_class = await readDeviceClass()
  const panel =
    action === 'assign'
      ? PANEL_ASSIGN
      : action === 'create'
        ? PANEL_CREATE
        : action === 'show'
          ? PANEL_SHOW
          : PANEL_HIDE
  // ONE clock read for the whole request, stamped on the row and on the metric
  // so the two cannot straddle a boundary and disagree.
  const now = Date.now()

  let userDb
  try {
    userDb = openUserDataForWrite(user, key)
  } catch (error) {
    // WrongKeyError (or a corrupt file) must not become a bare 500 with a stack.
    // The stderr line carries the error's name and code, which the metric
    // deliberately cannot.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  }
  try {
    if (action === 'assign') {
      // THE TRANSACTION HAS TO BE HIS, and in scope. `spending_transactions` is
      // 004's view, which already restricts to the accounts this screen covers —
      // so this one check answers both "does it exist" and "is it a transaction
      // this screen is allowed to re-file". Without it, this route would
      // accumulate override rows for arbitrary ids: inert, but unbounded growth
      // in a database only the friend can ever clean up.
      const known = userDb
        .prepare('SELECT 1 AS ok FROM spending_transactions WHERE transaction_id = ?')
        .get(transactionId) as { ok: number } | undefined
      if (known === undefined) {
        return new Response(null, { status: 400 })
      }

      // UPSERT, not INSERT: re-filing the same transaction twice is one fact,
      // not two, and the second choice is the one that should stick. Idempotent
      // by primary key rather than by a read-then-write, so there is no race
      // between the check and the write.
      userDb
        .prepare(
          `INSERT INTO transaction_category_overrides (transaction_id, category, set_at)
           VALUES (?, ?, ?)
           ON CONFLICT(transaction_id) DO UPDATE SET category = excluded.category,
                                                     set_at   = excluded.set_at`,
        )
        .run(transactionId, snapToBucketCase(userDb, category), now)
    } else if (action === 'show' || action === 'hide') {
      // THE CATEGORY HAS TO BE ONE HE ACTUALLY HAS. Same job as the transaction
      // check above, and the same reason: without it this route accumulates rows
      // for categories that do not exist, in a database only the friend can ever
      // clean up. A category is real if some transaction currently sits in it,
      // or if it is a bucket he made — the second arm matters because a
      // brand-new bucket has nothing in it yet.
      const known = userDb
        .prepare(
          `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM spending_transactions WHERE category = ?)
                             OR EXISTS (SELECT 1 FROM custom_categories WHERE name = ?)`,
        )
        .get(category, category) as { ok: number } | undefined
      if (known === undefined) {
        return new Response(null, { status: 400 })
      }

      // UPSERT on the same key, for the same reason as the override above:
      // ticking a box twice is one fact. The stored value is the TARGET STATE
      // the request named, never a flip of what was found.
      userDb
        .prepare(
          `INSERT INTO category_visibility (category, included, set_at)
           VALUES (?, ?, ?)
           ON CONFLICT(category) DO UPDATE SET included = excluded.included,
                                               set_at   = excluded.set_at`,
        )
        .run(snapToBucketCase(userDb, category), action === 'show' ? 1 : 0, now)
    } else {
      // OR IGNORE: typing a name that already exists is the same intent as
      // having created it, so it is a no-op rather than an error the friend has
      // to understand. The column is COLLATE NOCASE (004), so "Coffee" does not
      // become a second "coffee".
      userDb
        .prepare('INSERT OR IGNORE INTO custom_categories (name, created_at) VALUES (?, ?)')
        .run(name, now)
    }
  } catch (error) {
    // The WRITE needs the same catch as the open above: a full disk, a
    // SQLITE_BUSY outliving the driver's timeout, or a missing table would
    // otherwise throw straight out of POST — the friend gets Next's default
    // error page in response to a form submit, with no dashboard, no chat
    // surface and no way back but the browser's back button, and no metric row,
    // so it is invisible to the operator too.
    logDbFailure('dashboard_write_error', user, error)
    appendMetric(db, {
      accountId,
      event: 'dashboard_write_error',
      data: { slug: user, panel, device_class },
      at: now,
    })
    return new Response(null, { status: 500 })
  } finally {
    userDb.close()
  }

  // Permanent policy: a slug and a panel, never a value. NOT the category name,
  // NOT the transaction id. `metrics` is the unencrypted platform database, and
  // this row is what makes the login page's "I can see when you use it … but not
  // what you log" true. Four panel names rather than one reused: re-filing,
  // creating a bucket, ticking and unticking are distinct events, and a query
  // grouping by panel needs to tell them apart.
  appendMetric(db, {
    accountId,
    event: 'dashboard_write',
    data: { slug: user, panel, device_class },
    at: now,
  })

  // A native form post gets the host-relative 303 (the app runs behind a reverse
  // proxy, so request.url names the internal origin — see lib/http/redirect.ts);
  // a fetch-initiated write gets 204, so the browser never follows a redirect it
  // would otherwise render into a second dashboard_open row.
  //
  // run12 has ONE screen, so the bare dashboard path is the spending screen and
  // naming `?screen=spending` would be redundant — but it is named anyway,
  // because `activeScreen` resolves an unknown value to the lowest-order screen
  // and this keeps the no-JS landing explicit if a second screen is ever added.
  return writeAnswer(request, `/${user}?screen=spending`)
}
