// users/run12/queries.ts
//
// Every SQL statement for run12's dashboard, and every rule that turns a pile
// of bank transactions into the picture spec v1 asks for. The component holds
// none of it: what a percentage on that pie MEANS is arithmetic over a window,
// a sign convention and an exclusion rule, and data logic in a .tsx file can
// only be tested by rendering it.
//
// ─── NOTHING HERE READS A CLOCK ────────────────────────────────────────────
//
// `today` arrives as a parameter on every function that needs it, resolved once
// per request by app/[user]/page.tsx in the FRIEND'S timezone and handed down.
// The window below is then a pair of 'YYYY-MM-DD' strings compared against
// Plaid's own `date`, which is stored exactly as Plaid stated it — so the whole
// question is string arithmetic and no calendar is ever inferred from a
// machine. This file does not import lib/time/dayKey at all: it MAY (a
// queries.ts may run it over a stored instant), but every day it deals in is
// already a day. tests/users/noLocalDay.test.ts sweeps this file for
// `Date.now()` and zero-argument `new Date()`; the ledger behind that rule is
// docs/superpowers/ledgers/friend-timezone.md.
//
// ─── THE SIGN CONVENTION, WHICH EVERYTHING BELOW RESTS ON ──────────────────
//
// Plaid signs an OUTFLOW POSITIVE and an INFLOW NEGATIVE. `categoryTotals` NETS
// the signed amounts per category rather than summing the positives, and that
// choice is doing real work — see its own header.
//
// ─── NO WRITES, STILL ──────────────────────────────────────────────────────
//
// 004 gave run12 three tables of its own — buckets he names, transactions he
// re-files, categories he ticks — so this file now reads run12's own schema as
// well as the shared envelope. It still only READS: the handle a dashboard
// holds is read-only on both paths, and every write goes through
// app/api/users/[user]/spending-breakdown/route.ts, which is the only place the
// four ordered auth checks live.
import type { UserDb } from '@/lib/db/userDb'
import type { PlaidSource } from '@/modules/plaid/sources'

/**
 * How far back the pie looks, in days, inclusive of today.
 *
 * Spec v1: "a rolling 30-day window ending today, not the previous calendar
 * month" — which the friend chose himself when asked ("Last 30 days sounds
 * good"). It is a FIXED window with no pre-existence bound of the kind a
 * hand-logged panel needs: a panel fed by a synced source shows history as far
 * back as real data exists, because backfilled data is data
 * (docs/dashboard-ui-ux-guidelines.md > States). His bank has no gap at the day
 * the dashboard was built.
 */
export const SPENDING_WINDOW_DAYS = 30

/** The category a transaction with no Plaid categorisation falls into. */
export const UNCATEGORIZED = 'UNCATEGORIZED'

/**
 * How many categories the pie draws individually before folding the rest.
 *
 * Eight, because the validated palette has eight categorical slots and a ninth
 * colour would have to be generated or recycled — which is how a palette stops
 * being checkable (./palette.ts). It is also roughly how many wedges a pie can
 * carry before it stops answering the question it was drawn for.
 *
 * Every category is still SHOWN — the legend lists all of them, folded or not.
 * See `foldIntoOther` for what the fold does and does not take away.
 */
export const PIE_MAX_SLICES = 8

/**
 * The fold bucket's name. Not a category anything can be filed into — nothing
 * writes it, it is never offered in the re-file menu, and it exists only for
 * the length of one render.
 */
export const OTHER_CATEGORY = 'Other'

/**
 * How long a category name the friend may type.
 *
 * A bound rather than an opinion: this is the first free-text value run12
 * stores, and an unbounded string in a TEXT PRIMARY KEY is a row nothing can
 * render. Restated by the route, which is what actually enforces it — see that
 * file's header for why a platform route does not import a user folder.
 */
export const CATEGORY_NAME_MAX = 40

export type SpendingAccount = {
  accountId: string
  itemId: string
  name: string
  mask: string | null
  type: string
  subtype: string | null
}

export type SpendingTransaction = {
  transactionId: string
  day: string
  itemId: string | null
  accountName: string
  accountMask: string | null
  merchant: string | null
  description: string | null
  amount: number
  pending: number | null
  plaidCategory: string | null
  plaidDetail: string | null
  /** The category he moved this row into by hand, or null if he never did. */
  overrideCategory: string | null
  category: string
  /** 1 when 003's rule calls this an internal transfer rather than spending. */
  isInternal: number
}

export type CategorySlice = {
  category: string
  /** Net dollars out, rounded to cents. Always > 0 — see `categoryTotals`. */
  amount: number
  /** This category's share of `total`, 0..1. */
  share: number
  count: number
}

/**
 * One line of the legend: EVERY category in the window, drawable or not.
 *
 * The legend lists all of them because spec v1 asks for exactly that — "Every
 * category is shown — this is not a watchlist of a few chosen categories" — and
 * because a category that nets to nothing has to be explainable. A flight
 * charged and refunded inside the same 30 days leaves a real category at zero,
 * and a friend who saw travel on this screen last week deserves a row saying
 * where it went rather than a silent disappearance.
 */
export type CategoryRow = {
  category: string
  /** Net dollars, rounded to cents. May be zero or negative. */
  amount: number
  count: number
  /** Resolved: his explicit tick if he made one, else the default. */
  included: boolean
  /** Whether he has actually pressed this, as opposed to taking the default. */
  chosen: boolean
  /** Included AND positive — a wedge can be drawn for it. */
  drawable: boolean
  /** Share of `total`, 0..1. Zero unless drawable. */
  share: number
}

export type CategoryTotals = {
  /** Every category in the window, largest first. The legend renders this. */
  rows: CategoryRow[]
  /** Just the drawable ones, largest first. The pie renders this. */
  slices: CategorySlice[]
  /** The sum of every slice, and the denominator of every share. */
  total: number
  /** Transactions that counted towards the picture. */
  counted: number
  /** Transactions left out by 003's `is_internal` rule. Named on screen. */
  internal: number
}

/**
 * The first day of the 30-day window ending on `today`.
 *
 * Inclusive at both ends, so the window is exactly SPENDING_WINDOW_DAYS long.
 */
export function spendingWindowStart(today: string): string {
  return shiftDay(today, -(SPENDING_WINDOW_DAYS - 1))
}

/**
 * A day key `delta` days from `day`, both 'YYYY-MM-DD'.
 *
 * UTC components in, UTC components out, so no timezone is involved and no
 * clock is read: this is calendar arithmetic on a date the friend's own day
 * boundary already produced.
 */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const moved = new Date(Date.UTC(y!, m! - 1, d! + delta))
  return moved.toISOString().slice(0, 10)
}

/**
 * Whether a bank is connected at all.
 *
 * COUNTS ITEMS, NEVER TRANSACTIONS, and that is the most load-bearing line in
 * this file. A freshly connected bank has a token and zero rows for the several
 * seconds Plaid spends backfilling; inferring "not connected" from an empty
 * transaction table would tell the friend his connection failed at the exact
 * moment it was working (docs/dashboard-build-rules.md §9.6, state 1).
 */
export function isConnected(db: UserDb): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM plaid_items').get() as { n: number }
  return row.n > 0
}

/**
 * The accounts this screen counts, which the panel names on screen.
 *
 * The scope itself is in 003's `spending_accounts` view: every `credit` account
 * plus every `depository` account whose subtype is `checking` — spec v1's "a
 * connected checking account and a connected credit card". It is read back here
 * so the panel can SAY which accounts it is reading, which is not decoration:
 * the scope is an allow-list, so a bank reporting his current account under a
 * different subtype would drop out of the picture, and naming the accounts is
 * what makes that visible rather than silent.
 */
export function spendingAccounts(db: UserDb): SpendingAccount[] {
  return db
    .prepare(
      `SELECT account_id AS accountId, item_id AS itemId, name, mask, type, subtype
         FROM spending_accounts
        ORDER BY type, name`,
    )
    .all() as SpendingAccount[]
}

/**
 * Every transaction in the window, newest first, internal transfers included.
 *
 * THE INTERNAL ONES COME BACK TOO, carrying 003's flag rather than being
 * filtered out in SQL, so that `categoryTotals` can COUNT what it excluded and
 * the panel can name it. A query that dropped them would make the exclusion
 * spec v1 asked for unprovable from the screen — which is the silent version of
 * the thing it asked to have handled.
 *
 * `day` is Plaid's own YYYY-MM-DD, stored as given, so the window is a string
 * comparison — 'YYYY-MM-DD' sorts as its own calendar. NOTHING HERE READS A
 * CLOCK: `today` is handed to the dashboard by the platform and passed down.
 *
 * Unbounded by design. A LIMIT would silently drop transactions out of the pie,
 * and a pie missing its tail is wrong in a way nobody on screen can see. Thirty
 * days of one card and one current account is a three-figure row count at the
 * very worst.
 */
export function spendingTransactions(db: UserDb, today: string): SpendingTransaction[] {
  return db
    .prepare(
      `SELECT transaction_id AS transactionId,
              day,
              item_id        AS itemId,
              account_name   AS accountName,
              account_mask   AS accountMask,
              merchant,
              description,
              amount,
              pending,
              plaid_category    AS plaidCategory,
              plaid_detail      AS plaidDetail,
              override_category AS overrideCategory,
              category,
              is_internal    AS isInternal
         FROM spending_transactions
        WHERE day BETWEEN ? AND ?
        ORDER BY day DESC, transaction_id DESC`,
    )
    .all(spendingWindowStart(today), today) as SpendingTransaction[]
}

/**
 * His explicit ticked/unticked choices, and only those.
 *
 * A category he has never pressed has NO ROW here — the default is resolved at
 * read time by `resolveVisibility` below. See 004's comment on the table for
 * why that is forced rather than preferred: writing a default row would be the
 * dashboard writing to his database on a render, and a render never writes.
 */
export function categoryVisibility(db: UserDb): Map<string, boolean> {
  const rows = db.prepare('SELECT category, included FROM category_visibility').all() as {
    category: string
    included: number
  }[]
  return new Map(rows.map((r) => [r.category, r.included === 1]))
}

/**
 * Whether a category is in the pie, given its net and his choices.
 *
 * THE DEFAULT IS CONDITIONAL, which is the whole reason `category_visibility`
 * stores a boolean rather than a presence: ticked by default if the category
 * consumed money, unticked by default if it did not.
 *
 * A category that nets to zero or less is money that came back rather than
 * money that went out — a refund, or a card payment with both sides connected
 * — and it cannot be drawn as a wedge anyway. Defaulting it off means the
 * legend shows it at its net figure with an empty box, which explains itself.
 *
 * Resolved at READ time, so a category that nets to zero this fortnight and
 * goes positive next month comes back on its own rather than staying silently
 * switched off because of one quiet spell he was not watching.
 */
export function resolveVisibility(amount: number, chosen: boolean | undefined): boolean {
  return chosen ?? amount > 0
}

/**
 * The buckets he has made for himself, alphabetically.
 *
 * Stored COLLATE NOCASE (004), so "Coffee" and "coffee" are one bucket. These
 * are offered in the re-file menu whether or not anything sits in them yet: a
 * bucket he just made and has not filled is a legitimate state, and hiding it
 * would make the Add control look broken.
 */
export function customCategories(db: UserDb): string[] {
  const rows = db
    .prepare('SELECT name FROM custom_categories ORDER BY name COLLATE NOCASE')
    .all() as { name: string }[]
  return rows.map((r) => r.name)
}

/**
 * Every category a transaction can be moved into.
 *
 * His own buckets, plus every category his bank has ever produced — NOT just
 * the ones inside the current window. A category that was on screen last month
 * has to stay reachable, or a transaction re-filed by mistake can never be put
 * back where it came from.
 *
 * Read across the whole view rather than the window for exactly that reason.
 * It is a distinct-value scan of a small table with no user input in it.
 */
export function bankCategories(db: UserDb): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(plaid_category, ?) AS category
         FROM spending_transactions
        ORDER BY category`,
    )
    .all(UNCATEGORIZED) as { category: string }[]
  return rows.map((r) => r.category)
}

/**
 * The pie and the legend: net dollars per category, largest first.
 *
 * A PURE FUNCTION of the rows above, so every edge below is testable without a
 * database, and the chart and the legend are guaranteed to be describing one
 * list rather than two reads that could disagree.
 *
 * ─── WHY IT NETS SIGNED AMOUNTS RATHER THAN SUMMING OUTFLOWS ───────────────
 *
 * Plaid signs an outflow positive and an inflow negative, so netting is what
 * makes two things come out right that a positives-only sum gets wrong:
 *
 *   * A REFUND reduces the category it came back from. A flight charged and
 *     then refunded is not money that went to travel, and a pie that says it
 *     did is answering the friend's one question — "where did my money go" —
 *     with a number he did not spend.
 *   * A CARD PAYMENT cancels against itself when both sides are connected: it
 *     leaves the checking account as an outflow and lands on the card as an
 *     inflow under the same category, so the pair nets to nothing instead of
 *     double-counting spending the card's own charges already carry.
 *
 * The second is belt to `is_internal`'s braces, and both are needed. Netting
 * handles the pair whose two sides are BOTH on this screen; the flag handles
 * the transfer whose other side is a savings account this screen does not cover
 * and which therefore has nothing to cancel against. See 003's own header.
 *
 * ─── AND WHY THE TICK BOX EXISTS ON TOP OF BOTH ────────────────────────────
 *
 * Netting cancels a transfer whose OTHER SIDE IS ALSO CONNECTED, and
 * `is_internal` catches the ones Plaid names. Neither can catch a category the
 * FRIEND thinks is not really his spending — a shared rent payment, a expense
 * he gets reimbursed for. Nothing here decides that, because it would be this
 * dashboard forming an opinion about his money; his tick does.
 *
 * ─── WHAT `rows` AND `slices` ARE FOR ──────────────────────────────────────
 *
 * `rows` is EVERY category in the window, ticked or not, and the legend renders
 * it — because spec v1 asks for every category, and because an unticked
 * category has to stay on screen with its box or he cannot tick it back.
 * `slices` is the subset that can actually be drawn as a wedge, and the pie
 * renders that. Shares are computed against the ticked, positive total ONLY,
 * which is what "what categories are currently being included in the pie chart
 * and percentages" means arithmetically. A category netting to zero or less is
 * money that came back rather than money that went out: it cannot be a wedge,
 * it is not in the denominator, and it keeps its legend row at its net figure
 * so the friend can see it rather than wonder where it went.
 *
 * Rounded to cents BEFORE anything compares against zero, so a float residue of
 * a fraction of a penny cannot decide whether a category is drawn.
 */
export function categoryTotals(
  rows: SpendingTransaction[],
  visibility: ReadonlyMap<string, boolean> = new Map(),
): CategoryTotals {
  const net = new Map<string, { amount: number; count: number }>()
  let internal = 0
  let counted = 0

  for (const row of rows) {
    if (row.isInternal === 1) {
      internal += 1
      continue
    }
    counted += 1
    const entry = net.get(row.category) ?? { amount: 0, count: 0 }
    entry.amount += row.amount
    entry.count += 1
    net.set(row.category, entry)
  }

  const all: CategoryRow[] = []
  let total = 0
  for (const [category, entry] of net) {
    const amount = Math.round(entry.amount * 100) / 100
    const chosen = visibility.get(category)
    const included = resolveVisibility(amount, chosen)
    const drawable = included && amount > 0
    if (drawable) total += amount
    all.push({
      category,
      amount,
      count: entry.count,
      included,
      chosen: chosen !== undefined,
      drawable,
      share: 0,
    })
  }

  // Largest first, and ties broken by name so the order — and therefore every
  // slice's colour — is stable between renders. Two categories at the same
  // figure swapping places on a refresh would look like the data moved. This
  // also sinks the zero and negative ones to the bottom of the legend on their
  // own, without a second sorting rule to keep in step with this one.
  all.sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category))

  const withShares = all.map((row) => ({
    ...row,
    share: row.drawable && total > 0 ? row.amount / total : 0,
  }))

  return {
    rows: withShares,
    slices: withShares
      .filter((row) => row.drawable)
      .map(({ category, amount, share, count }) => ({ category, amount, share, count })),
    total: Math.round(total * 100) / 100,
    counted,
    internal,
  }
}

/**
 * The slices as DRAWN: the largest `max`, plus one "Other" carrying the rest.
 *
 * A pure function of `categoryTotals`' output, kept here rather than in the
 * component because it decides what the friend can and cannot see in the chart
 * — and a rule left in a client component is a rule this folder's own tests
 * cannot reach, since a client component's body never runs in vitest here.
 *
 * `folded` NAMES the categories that went into the bucket rather than counting
 * them, because the panel needs the names: each one still has its own legend
 * row with its own amount and share, so a category combined into the grey wedge
 * is never out of reach. A fold that swallowed a category's row along with its
 * wedge would be silent truncation with an extra step
 * (docs/dashboard-ui-ux-guidelines.md > States).
 *
 * FOLDING ONLY HAPPENS AT `max + 2` OR MORE. With exactly one category over the
 * limit, an "Other" wedge would hold a single category and hide its name for no
 * gain — so the ninth is simply drawn, in the neutral, and named by its own
 * legend row like every other.
 */
export function foldIntoOther(
  slices: CategorySlice[],
  max: number = PIE_MAX_SLICES,
): { drawn: CategorySlice[]; folded: string[] } {
  if (slices.length <= max + 1) return { drawn: slices, folded: [] }
  const kept = slices.slice(0, max)
  const rest = slices.slice(max)
  const amount = Math.round(rest.reduce((sum, s) => sum + s.amount, 0) * 100) / 100
  const other: CategorySlice = {
    category: OTHER_CATEGORY,
    amount,
    share: rest.reduce((sum, s) => sum + s.share, 0),
    count: rest.reduce((sum, s) => sum + s.count, 0),
  }
  return { drawn: [...kept, other], folded: rest.map((s) => s.category) }
}

/**
 * A category key as the friend should read it.
 *
 * HIS OWN BUCKET IS SHOWN EXACTLY AS HE TYPED IT — it is his sentence, not ours
 * to reformat. A bank category is one of Plaid's SCREAMING_SNAKE keys and is
 * humanised, because `FOOD_AND_DRINK` on a pie slice reads as a database rather
 * than as his lunch.
 *
 * Which of the two a key is comes from the custom-category set rather than from
 * the shape of the string. A friend who types a name that happens to look like
 * a Plaid key gets it back unchanged, and the alternative — inferring from
 * capitalisation — would quietly rewrite a bucket someone deliberately named in
 * capitals.
 */
export function categoryLabel(category: string, custom: ReadonlySet<string> = new Set()): string {
  if (custom.has(category)) return category
  const words = category.toLowerCase().split('_').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The banks whose newest refresh round failed to bring transactions in.
 *
 * §9.6, said plainly: a refresh can succeed and fail at the same time — one
 * bank's transactions land while its balances do not, and the CONNECTION is
 * genuinely still `live`. `<PlaidSources>` says so about the connection. This
 * is about THE PIE: if the product feeding it failed in the newest round, every
 * figure on screen is the PREVIOUS value, and the panel has to say so rather
 * than let it read as current (docs/dashboard-ui-ux-guidelines.md > States).
 *
 * A pure function of what `readPlaidSources` already returned, so the panel
 * pays for no second read and this is testable without a database.
 */
export function banksWithStaleTransactions(sources: PlaidSource[]): string[] {
  return sources
    .filter((s) => s.failedProducts.includes('transactions'))
    .map((s) => s.name)
    .sort()
}

/**
 * The banks that stopped updating but are still contributing to the window.
 *
 * A disconnect is SOFT: the bank keeps every row it ever brought
 * (docs/dashboard-build-rules.md §9.6), so its transactions are still inside
 * these 30 days and still in the pie. That is the honest answer to "where did my
 * money go" — the money did go — but it means the picture is part live and part
 * frozen, and §9.6 is explicit that rendering those rows silently is the orphan
 * the whole soft-disconnect design exists to remove.
 *
 * So the panel names them. Only banks that ACTUALLY have a transaction in the
 * window are returned: a bank disconnected two months ago contributes nothing
 * to this pie, and a caveat about it would be a sentence explaining a
 * difference that does not exist.
 */
export function frozenBanksInWindow(
  rows: SpendingTransaction[],
  sources: PlaidSource[],
): string[] {
  const contributing = new Set(rows.map((r) => r.itemId).filter((id): id is string => id !== null))
  return sources
    .filter((s) => s.status === 'disconnected' && contributing.has(s.itemId))
    .map((s) => s.name)
    .sort()
}
