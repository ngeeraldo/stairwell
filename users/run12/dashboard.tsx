// users/run12/dashboard.tsx
//
// run12's dashboard, spec v1. ONE screen, "Spending Breakdown", carrying the
// shared bank surface and one panel: a pie of the last 30 days of spending by
// category, every category shown, biggest to smallest.
//
// With one screen the platform draws NO tab strip at all — a single tab is
// chrome that explains nothing — which is why the component below does not
// branch on `screen`. A second screen changes that and nothing else: the
// platform reads the `screens` array under this comment and renders
// `<a href="?screen=...">` anchors above whatever this returns. A dashboard
// never renders its own tabs (docs/dashboard-build-rules.md §3).
//
// ─── NO SQL HERE ───────────────────────────────────────────────────────────
//
// Every statement is in ./queries.ts as a pure function over the read-only
// handle. What a percentage on this pie MEANS — the window, the sign
// convention, which transactions are internal transfers — is arithmetic, and
// arithmetic in a .tsx file can only be tested by rendering it.
//
// ─── NO CLOCK HERE EITHER ──────────────────────────────────────────────────
//
// `today` (the friend's day), `timeZone` and `now` (the render instant) are all
// handed to this component. tests/users/noLocalDay.test.ts sweeps this file for
// `Date.now()`, zero-argument `new Date()`, and any import of lib/time/dayKey.
// The `new Date(Date.UTC(...))` in `dayLabel` below is the permitted shape: it
// converts a day key that already exists into words and asks no clock anything.
//
// ─── WHAT THIS DASHBOARD WRITES, AND WHERE ─────────────────────────────────
//
// Spec v1 asks for a picture. Nico added three things at the build review: the
// friend can SEE the transactions behind the pie and audit them, MOVE one into
// a category of his own making (permanently — the move survives every refresh),
// and TICK which categories are in the pie and the percentages.
//
// All three are controls in ./CategoryControls.tsx, and every one of them POSTs
// to app/api/users/[user]/spending-breakdown/route.ts — run12's OWN route, not
// run11's near-identical one, for the reason that route's header gives. No
// component here holds a writable handle; only the route does. The bank
// controls are still <PlaidSources>'s and still post to the shared Plaid
// routes.
//
// ─── WHY THE BANK SURFACE IS AT THE TOP ────────────────────────────────────
//
// Two reasons that happen to agree. docs/dashboard-build-rules.md §9.5: pressing
// Refresh is the ONLY way this friend's data ever changes, so burying it under
// the panel it updates makes the one control that matters the last one he finds.
// And spec v1: "Data refreshes only when he presses the refresh button on the
// dashboard — there is no background sync — so the screen should make it clear
// when the data was last pulled." The surface carries the last-updated time
// beside the button, so putting it first is also what answers that sentence.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PlaidSources } from '@/lib/ui/PlaidSources'
import { readPlaidSources } from '@/modules/plaid/sources'
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'
import { SpendingPie, type PieSlice } from './SpendingPie'
import { CategoryToggle, NewCategoryControl, RefileControl } from './CategoryControls'
import { OTHER_COLOR, sliceColor } from './palette'
import {
  CATEGORY_NAME_MAX,
  OTHER_CATEGORY,
  SPENDING_WINDOW_DAYS,
  bankCategories,
  banksWithStaleTransactions,
  categoryLabel,
  categoryTotals,
  categoryVisibility,
  customCategories,
  foldIntoOther,
  frozenBanksInWindow,
  isConnected,
  spendingAccounts,
  spendingTransactions,
  spendingWindowStart,
} from './queries'

/**
 * The one screen. `id` and `order` are the BUILDER's — a change-only spec
 * carries no ids (lib/dashboard/contract.ts) — and both are written down in
 * users/run12/current.md's `## Screens` so the next build and the chat agent
 * read the same set. The `title` is what spec v1's `## Changes` calls it.
 */
export const screens: DashboardScreen[] = [
  { id: 'spending', title: 'Spending Breakdown', order: 1 },
]

/**
 * A dollar figure.
 *
 * docs/dashboard-ui-ux-guidelines.md > Formatting: "Whole dollars in glance
 * positions ($1,284, not $1,284.31); cents only in transaction rows and
 * anywhere the user is reconciling." The pie and its legend are the glance; the
 * transaction list is exactly where he reconciles a row against his own memory
 * of it, so it is the one place that asks for cents. A negative gets a sign,
 * never parentheses.
 */
function money(amount: number, { cents }: { cents: boolean }): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })
}

/**
 * A share as a percentage.
 *
 * One decimal place below 10%, none above. A slice worth 0.1% of the window
 * rendering as "0%" would read as a bug, and "14.3%" where "14%" will do is
 * precision nobody asked for.
 */
function percent(share: number): string {
  const pct = share * 100
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

/**
 * A day key in the friend's own terms.
 *
 * Absolute and month-first, with no year: both ends of a 30-day window are
 * inside the same season, so a year would be noise
 * (docs/dashboard-ui-ux-guidelines.md > Formatting). Pure UTC arithmetic over a
 * day key the platform already resolved — NO CLOCK IS READ, which
 * tests/users/noLocalDay.test.ts enforces over this file.
 */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * A transaction's date, relative when recent and absolute beyond the week.
 *
 * Guidelines > Formatting again: "Relative when recent ('today,' 'yesterday,'
 * 'Mon'), absolute beyond a week." Pure string and UTC arithmetic over a day
 * Plaid stated and a `today` the platform handed down; no clock is read.
 */
function transactionDayLabel(day: string, today: string): string {
  const ago = Math.round((utcOf(today) - utcOf(day)) / 86_400_000)
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  if (ago > 1 && ago < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  }
  return dayLabel(day)
}

/** Midnight UTC of a day key, as epoch ms. Components in, never a clock. */
function utcOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

/**
 * Join names the way a sentence does: "A", "A and B", "A, B and C".
 *
 * He has two accounts today, so a bare " and " would read correctly right up
 * until a third arrived and produced "A and B and C" — and a friend with a
 * second card is one connection away from that.
 */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export default function Run12Dashboard({ slug, db, today, now, timeZone }: DashboardProps) {
  // `screen` is not read: this dashboard declares exactly one, so `activeScreen`
  // can only ever resolve to it. See the header.
  const connected = isConnected(db)

  // Every bank he has and what each is doing — the shared read behind the
  // shared surface (modules/plaid/sources.ts). It knows only SQL and touches no
  // network, which is why a dashboard may call it while never importing
  // lib/plaid/.
  const sources = readPlaidSources(db)

  const categoryAction = `/api/users/${slug}/spending-breakdown`

  // ONE READ FEEDS THE WHOLE SCREEN — the pie, the legend and the transaction
  // list are all computed from this one array, so they cannot disagree about
  // where a dollar sits. Internal transfers come back too, so the panel can
  // count what it left out and the list can show him what that was (004's
  // `is_internal`, and `categoryTotals`).
  const rows = connected ? spendingTransactions(db, today) : []
  // His ticked/unticked choices, and only those — a category he has never
  // pressed takes the default `categoryTotals` resolves from the amount.
  const totals = connected ? categoryTotals(rows, categoryVisibility(db)) : categoryTotals(rows)
  const accounts = connected ? spendingAccounts(db) : []
  const custom = connected ? customCategories(db) : []
  const customSet = new Set(custom)

  // Every category a row may be moved into: his own buckets first, then every
  // category his bank has ever produced. Built ONCE for the whole list rather
  // than per row — forty rows building the same array forty times is the same
  // answer computed forty times.
  const choices = connected
    ? [
        ...custom.map((name) => ({ value: name, label: name, custom: true })),
        ...bankCategories(db).map((name) => ({
          value: name,
          label: categoryLabel(name, customSet),
          custom: false,
        })),
      ]
    : []

  const windowStart = dayLabel(spendingWindowStart(today))
  const stale = banksWithStaleTransactions(sources)
  const frozen = frozenBanksInWindow(rows, sources)

  // TWO REASONS A CATEGORY DRAWS NO WEDGE, and they are opposite facts that
  // must not share one sentence. Split by AMOUNT rather than by `included`,
  // which is what keeps them disjoint:
  //
  //   nettedAway  the money came back — a charge and its refund inside the same
  //               30 days. A row reading "Travel $0" beside rows carrying real
  //               figures reads as "you spent nothing on travel", and the truth
  //               is the opposite. docs/dashboard-ui-ux-guidelines.md > States:
  //               a zero that is data and a zero that is absence must not render
  //               identically.
  //   excluded    HE unticked it, and it had real money in it. The empty box
  //               beside the row says that much; what it cannot say is that the
  //               percentages moved as a result.
  //
  // A netted-away category is ALSO unticked by default (`resolveVisibility`
  // defaults a non-positive category off), which is exactly why `excluded`
  // tests the amount too — without that, one category would produce both
  // captions and the friend would be told two different stories about one row.
  const nettedAway = totals.rows.filter((row) => row.amount <= 0)
  const excluded = totals.rows.filter((row) => !row.included && row.amount > 0)


  // THE ARM-2 STATES CHECK, and it lives here rather than inside the chart:
  // degenerate data renders the panel's empty state as host elements and never
  // mounts Recharts at all (docs/dashboard-build-rules.md §3). `categoryTotals`
  // has already dropped anything netting to zero or less, so a surviving slice
  // is finite and positive by construction; what is left to check is whether
  // there is anything at all to draw.
  const { drawn, folded } = foldIntoOther(totals.slices)
  const drawable = drawn.length > 0 && totals.total > 0

  const pieSlices: PieSlice[] = drawn.map((slice, index) => ({
    label:
      slice.category === OTHER_CATEGORY
        ? OTHER_CATEGORY
        : categoryLabel(slice.category, customSet),
    amount: slice.amount,
    share: slice.share,
    color: sliceColor(index),
    amountLabel: money(slice.amount, { cents: false }),
    shareLabel: percent(slice.share),
  }))

  // Which colour each legend row wears, so a swatch can never disagree with the
  // wedge it stands for. A category folded into "Other" takes the neutral,
  // because that is genuinely the wedge it is part of; one that nets to zero or
  // less gets no swatch at all, because it has no wedge.
  const colorFor = new Map<string, string>()
  drawn.forEach((slice, index) => colorFor.set(slice.category, sliceColor(index)))
  for (const category of folded) colorFor.set(category, OTHER_COLOR)

  return (
    // FLUID TO 1200px, centred — docs/dashboard-ui-ux-guidelines.md > Layout.
    // Spec v1 says this is read "on a desktop computer in the morning … laid out
    // for a full browser window rather than a narrow phone screen", so the panel
    // below puts the chart and the legend side by side and lets the legend take
    // two columns once there is room for them, rather than stacking everything
    // into one phone-width column. The same panel still reads at 375px — one
    // responsive implementation, internals never forked per breakpoint.
    <section className="mx-auto w-full max-w-[1200px] space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">Your banks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/*
            THE SHARED BANK SURFACE, identical on every finance dashboard
            (2026-08-21 plan D4, swept by tests/users/plaidSurface.test.ts). It
            handles the not-connected case itself, with the connect control, so
            this screen has no connect button of its own — a folder that grew one
            would drift from every other friend's.

            It also carries the last-updated time spec v1 asks the screen to make
            clear, beside the Refresh control that is the only thing that changes
            it.
          */}
          <PlaidSources slug={slug} sources={sources} now={now} timeZone={timeZone} />
          <p className="text-xs text-muted-foreground">
            This updates when you press Refresh, and at no other time.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where my money went</CardTitle>
          <p className="text-sm text-muted-foreground">
            The last {SPENDING_WINDOW_DAYS} days — {windowStart} to {dayLabel(today)}.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            STATE 1 of the four a finance panel owes: NOT CONNECTED, decided by
            whether a plaid_items row exists and NEVER by whether transactions
            exist. A freshly connected bank has a token and no rows for the
            seconds Plaid spends backfilling, and inferring "not connected" from
            an empty table would tell him his connection failed while it was
            working (docs/dashboard-build-rules.md §9.6).
          */}
          {!connected ? (
            <p className="max-w-[42rem] text-sm text-muted-foreground">
              Connect your checking account and your credit card above, and this fills in with
              the last {SPENDING_WINDOW_DAYS} days of spending, grouped by category.
            </p>
          ) : rows.length === 0 ? (
            /*
              STATE 2: connected, nothing has arrived yet — or a genuinely quiet
              month. Either way NOT "$0.00", which is a confident false statement
              about someone's money (§9.6). It says what it is waiting for and
              leaves the Refresh control above reachable.
            */
            <p className="text-sm text-muted-foreground">
              Nothing has come through for the last {SPENDING_WINDOW_DAYS} days yet. If you have
              just connected, give it a moment and press Refresh.
            </p>
          ) : !drawable ? (
            /*
              Rows exist and none of them nets to money going out — every category
              cancelled itself, which a month of refunds really can do. Host
              elements, no chart: there is nothing to draw, and a chart mounted
              over nothing is the arm-2 failure.
            */
            <p className="text-sm text-muted-foreground">
              Nothing to draw for these {SPENDING_WINDOW_DAYS} days: every category is either
              unticked or nets to nothing. The transactions are all still listed below.
            </p>
          ) : (
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start lg:gap-10">
              <SpendingPie slices={pieSlices} title="Spending by category, last 30 days" />
              {/*
                THE LEGEND, and it is not decoration. It is doing three jobs at
                once, each of which would require it on its own:

                  * It is spec v1's labelling — "each slice is labelled with the
                    category and its percentage share of total spending". That
                    label is here, in text, rather than on the wedge; see
                    ./SpendingPie.tsx for the contrast measurement behind that.
                  * It is spec v1's "every category is shown": it lists EVERY
                    category in the window, including ones folded into the grey
                    wedge and ones that netted to nothing.
                  * It is the table view the palette's contrast WARN obliges
                    (./palette.ts), and what keeps a category from being
                    identified by colour alone.

                Two columns once there is room, because spec v1 says this is read
                in a full browser window and a single tall column beside a small
                circle wastes it.
              */}
              <ul className="w-full min-w-0 space-y-2 lg:columns-2 lg:gap-x-10 lg:space-y-0">
                {totals.rows.map((row) => {
                  const label = categoryLabel(row.category, customSet)
                  const color = colorFor.get(row.category)
                  return (
                    <li
                      key={row.category}
                      className="flex items-center gap-2 text-sm lg:break-inside-avoid lg:py-1"
                    >
                      {/*
                        THE TICK BOX, which is what makes the legend a control
                        as well as a label. Nico's call at the build review:
                        "they should be able to choose what categories are
                        currently being included in the pie chart and
                        percentages". An unticked category KEEPS its row here —
                        it has to, or he could never tick it back.
                      */}
                      <CategoryToggle
                        action={categoryAction}
                        category={row.category}
                        label={label}
                        included={row.included}
                      />
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[2px] border"
                        style={
                          color === undefined
                            ? { borderColor: 'var(--border)' }
                            : { backgroundColor: color, borderColor: color }
                        }
                      />
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          row.included ? '' : 'text-muted-foreground'
                        }`}
                      >
                        {label}
                      </span>
                      <span
                        className={`shrink-0 tabular-nums ${
                          row.included ? 'font-medium' : 'text-muted-foreground'
                        }`}
                      >
                        {/*
                          A sign, never parentheses (guidelines > Formatting).
                          A negative here is a category that gave money back —
                          a refund larger than the charges beside it.
                        */}
                        {row.amount < 0 ? '+' : ''}
                        {money(Math.abs(row.amount), { cents: false })}
                      </span>
                      {/*
                        A percentage ONLY for what is in the pie. A category at
                        zero or less is not in the denominator, so printing a
                        share for it would be a number of nothing.
                      */}
                      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                        {row.drawable ? percent(row.share) : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/*
            STATE 3, the half-failure: the connection is live and the product
            feeding this panel is not. Every figure above is then the PREVIOUS
            value, and §9.6 is explicit that letting it read as current is what
            this must not do. The fix really is to press Refresh again — a bank
            that fails intermittently usually answers on the second try, and
            nothing can retry on his behalf.
          */}
          {stale.length > 0 && (
            <p className="text-sm text-destructive">
              {listSentence(stale)} didn’t send transactions on the last refresh, so these
              figures are from before that. Press Refresh above to try again.
            </p>
          )}

          {/*
            A DISCONNECTED BANK IS STILL IN THIS PICTURE. A disconnect is soft —
            it keeps every row it ever brought — so its transactions are still
            inside these 30 days and still in the pie. That is the honest answer
            for "where did my money go", but it means part of the picture stopped
            moving, and §9.6 forbids rendering those rows silently.
          */}
          {frozen.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {listSentence(frozen)} stopped updating, but what it already sent is still
              counted here.
            </p>
          )}

          {/*
            THE EXCLUSION SPEC v1 HANDED TO THE BUILDER, said out loud. Its third
            open question asks that internal transfers be kept out so the
            percentages reflect actual spending, and 003's `is_internal` is the
            answer. A rule that changed his percentages without appearing
            anywhere on screen would be the silent version of the thing he asked
            to have handled — so the count is here, and the categories are named.
          */}
          {totals.internal > 0 && (
            <p className="text-xs text-muted-foreground">
              {plural(totals.internal, 'transfer')} between your own accounts —
              card payments, money moved to savings, and money coming in — {totals.internal === 1
                ? 'is'
                : 'are'}{' '}
              left out, so the percentages are of what you actually spent.
            </p>
          )}

          {/*
            THE FOLD ADMITS WHAT IT SWALLOWED. A grey "Other" wedge with no
            explanation is silent truncation; naming the count is what makes it a
            reading of the data rather than a limit of the chart. Every folded
            category still has its own row in the legend above with its own
            amount and share, so it is combined in the chart and never hidden.
          */}
          {folded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              “Other” is the {folded.length} smallest categories combined. All of them are
              listed above.
            </p>
          )}

          {/*
            THE DENOMINATOR IS NOW HIS, so the percentages have to say so. Only
            shown once something is actually unticked — before that it is a
            sentence about a control he has not used.
          */}
          {excluded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Percentages are of the ticked categories only. Unticked ones keep their row above
              and their transactions below.
            </p>
          )}

          {/*
            A ZERO THAT IS DATA, SAID AS DATA. See `nettedAway` above: without
            this line a refunded category is indistinguishable from a category
            the friend never spent in, and the two are opposite facts.
          */}
          {drawable && nettedAway.length > 0 && (
            // Built as one string rather than as interpolated fragments: the
            // sentence inflects on how many categories there are, and a reader
            // should see the whole rule in one place.
            <p className="text-xs text-muted-foreground">
              {`${listSentence(nettedAway.map((row) => categoryLabel(row.category, customSet)))} ${
                nettedAway.length === 1 ? 'shows' : 'show'
              } nothing spent: refunds inside these ${SPENDING_WINDOW_DAYS} days cancelled the charges out.`}
            </p>
          )}

          {/*
            WHICH ACCOUNTS THIS IS. The scope is an allow-list in 003 — every
            credit account plus every checking account — so a bank reporting a
            current account under a different subtype would drop out of the
            picture. Naming the accounts is what makes that visible rather than
            silent, and it is also the honest answer to "is this all of it".
          */}
          {connected && (
            <p className="text-xs text-muted-foreground">
              {accounts.length === 0
                ? 'No checking or credit-card account is feeding this yet.'
                : `Counting ${listSentence(
                    accounts.map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`),
                  )}.`}
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        THE AUDIT SURFACE. Nico's call at the build review: "the user should be
        able to see their transactions so they can audit what is going into
        every category."

        It is the same read as the pie, so a row here and a wedge above can
        never disagree — and it is the only place the friend can check the
        picture against his own memory, which is why it is the one panel on this
        screen that shows cents.

        Only rendered once a bank is connected: with none, the pie panel above
        is already telling him to connect one, and a second empty card saying
        the same thing twice is noise.
      */}
      {connected && (
        <Card>
          <CardHeader>
            <CardTitle>Transactions</CardTitle>
            <p className="text-sm text-muted-foreground">
              Everything the last {SPENDING_WINDOW_DAYS} days brought in, newest first. Move one
              into a different category and the pie above follows it — the change sticks through
              every future refresh.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              MAKING A BUCKET sits above the list rather than inside a row,
              because it is not about any one transaction: a new category is
              immediately offered by every menu below, and by the legend's tick
              boxes once something is filed into it.
            */}
            <NewCategoryControl action={categoryAction} maxLength={CATEGORY_NAME_MAX} />

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing to show for the last {SPENDING_WINDOW_DAYS} days.
              </p>
            ) : (
              <ul className="divide-y">
                {rows.map((row) => {
                  const description = row.merchant ?? row.description ?? 'Unknown'
                  return (
                    <li
                      key={row.transactionId}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {description}
                          {/*
                            A pending charge can still change amount or vanish.
                            Saying so is the difference between a number and a
                            claim — and it is still counted, because the money
                            has left as far as he is concerned.
                          */}
                          {row.pending ? (
                            <span className="ml-1.5 text-xs text-muted-foreground">pending</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {transactionDayLabel(row.day, today)} · {row.accountName}
                          {row.accountMask ? ` ••${row.accountMask}` : ''}
                          {/*
                            A row he has moved says so. Without it, a category
                            that disagrees with his bank's own app looks like the
                            dashboard got it wrong rather than like something he
                            did on purpose weeks ago.
                          */}
                          {row.overrideCategory !== null ? ' · moved by you' : ''}
                          {/*
                            AND A ROW THAT IS NOT IN THE PIE SAYS WHY. This is
                            what makes 004's `is_internal` auditable instead of
                            invisible: a transfer he disagrees with is right
                            here, named, with the menu that overrides it. An
                            override clears the flag — see 004's header.
                          */}
                          {row.isInternal === 1 ? ' · not counted (transfer)' : ''}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-sm tabular-nums ${
                          row.amount < 0 ? 'text-green-700' : ''
                        }`}
                      >
                        {/*
                          A sign, never parentheses (guidelines > Formatting),
                          and a negative is money coming back — green, because
                          for spending that is the good direction.
                        */}
                        {row.amount < 0 ? '+' : ''}
                        {money(Math.abs(row.amount), { cents: true })}
                      </span>
                      <RefileControl
                        action={categoryAction}
                        transactionId={row.transactionId}
                        current={row.category}
                        choices={choices}
                        labelFor={categoryLabel(row.category, customSet)}
                        describedBy={description}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  )
}
