---
slug: run12
version: 1
---

## What this is for
Where his money went over the last 30 days, as a picture he can take in at a
glance and then check. He opens it in the morning, on a desktop computer. It is
fed by his bank — a checking account and a credit card — and it only ever
changes when he presses Refresh.

## Screens
One screen, so the platform draws no tab strip at all.

- **`spending`** — "Spending Breakdown", order 1. The whole dashboard. It
  carries the shared bank surface at the top, the spending pie and its legend
  below that, and the transaction list under both.

## Panels

### Your banks
The shared bank management surface (`lib/ui/PlaidSources.tsx`), rendered
unchanged, with a line under it saying the data updates on Refresh and at no
other time. It is at the TOP of the screen because pressing Refresh is the only
thing that ever changes any figure below it, and it carries the last-updated
time beside that button. It owns the not-connected state and the connect
control; this dashboard has no connect button of its own.

### Where my money went
A pie of spending by category over the last 30 days, with a legend beside it.
The legend is the labelling — every category gets a row carrying its name, its
amount and its percentage — and it is also the control surface.

The edges that were decided:

- **The window is 30 days INCLUSIVE of today**, so it starts 29 days back. It
  is rolling, not the previous calendar month; he chose that himself when
  asked. There is no pre-existence bound: a panel fed by a synced source shows
  history as far back as the bank has it, because backfilled data is data.
- **Which accounts count is an allow-list**: every `credit` account plus every
  `depository` account whose subtype is `checking`. Savings, CD, money-market,
  HSA, investment and loan accounts are all out. Because an allow-list can drop
  an account silently, the panel NAMES the accounts it counted, every render.
- **Amounts are NETTED per category, not summed.** Plaid signs an outflow
  positive and an inflow negative, so a refund reduces the category it came
  back from, and a card payment whose two sides are both connected cancels
  against itself instead of double-counting. Netting happens before anything is
  rounded or compared.
- **Transfers between his own accounts do not count.** Anything Plaid files
  under income, transfer-in or transfer-out, plus the one loan-payment detail
  that means a credit-card payment. Other loan payments — a mortgage, a car, a
  student loan — DO count: that is money leaving and not coming back. The panel
  states how many transactions it left out whenever there are any. A
  transaction he has re-filed by hand is never treated as internal, whatever
  the bank called it.
- **Every amount is rounded to cents BEFORE anything compares it to zero**, so
  a float residue of a fraction of a penny cannot decide whether a category is
  drawn.
- **A category is ticked by default if it netted positive, unticked if it did
  not** — and that default is resolved at read time, never written down. Only
  his own presses are stored. A category that nets to nothing this month and
  goes positive next month therefore comes back on its own.
- **Percentages are of the ticked, positive total only.** An unticked category
  is out of the denominator, and no percentage is printed for it — a share of a
  total it is not in would be a number of nothing.
- **Slices read biggest to smallest, ties broken by category name**, so the
  order — and therefore each slice's colour, which is assigned by rank — is
  stable between renders.
- **Every category appears in the legend**, including ones drawing no wedge.
  The pie draws up to eight individually; a ninth is drawn too rather than
  folded alone; at ten or more the tail folds into a neutral "Other" and the
  panel says how many it combined.
- **A bank category is humanised for display; one of his own is shown exactly
  as he typed it.** A transaction the bank left uncategorised falls into a
  single named bucket he can see and re-file out of, rather than a nameless
  slice.

Its non-happy states:

- **Not connected** — decided by whether a bank connection exists, NEVER by
  whether transactions exist. A freshly connected bank has no rows for a few
  seconds while the backfill runs, and calling that "not connected" would
  report a failure at the moment it is working.
- **Connected, nothing arrived** — says what it is waiting for. Never a
  confident zero.
- **Nothing drawable** — every category either unticked or netted to nothing.
  Renders as text; the chart is never mounted over degenerate data.
- **The bank answered for some things and not others** — if the product feeding
  this panel failed on the newest refresh round, the panel says the figures
  predate it and names the bank. A product the bank has merely not finished
  preparing is not treated as a failure.
- **A disconnected bank still inside the window** — its rows are kept and still
  counted, and the panel names it and says it stopped updating.
- **A category that netted away** — called out separately from an unticked one,
  because "the money came back" and "he took it out" are opposite facts. The
  two are split by amount rather than by tick state so one category can never
  produce both sentences.

### Transactions
Every transaction in the same 30-day window, newest first, drawn from the SAME
read as the pie so the two can never disagree. This is the audit surface: it is
the one place on the screen that shows cents.

Each row carries its merchant or description, its date (relative within the
week, absolute beyond it), which account it came from, and its amount — a
negative signed and coloured, never bracketed. A row he has re-filed says so. A
row that is not counted says so and says why. Pending charges are marked and
still counted.

The list is deliberately unbounded: a limit would drop transactions out of
sight while the pie above still counted them.

## What can be entered
Three controls of run12's own, all posting to one platform route
(`/api/users/<slug>/spending-breakdown`) so that they lock and settle together
— the pie, the legend and the list are one read, and they must never be seen
disagreeing.

- **Move a transaction into another category.** Stored as an annotation keyed
  to the transaction in his own table, never as an edit to the synced row —
  which is what makes it survive every future refresh. Re-filing the same
  transaction twice is one fact, and the last choice wins. He can move a
  transaction back to a bank category with the same control.
- **Make a category.** A short name he types, case-insensitive so one bucket
  stays one bucket. Typing a name that already exists is a no-op, not an error.
  A new category is offered by every menu immediately, even before anything is
  in it.
- **Tick a category in or out of the pie.** Names the target state rather than
  toggling, so two presses racing cannot land somewhere neither asked for.

The bank controls on the same screen belong to the shared surface, not to
run12: connect another bank, choose which accounts each shares, sign in again,
refresh, stop a connection updating, and delete one and its data. They write
through the shared Plaid routes.

Nothing on this screen writes anything derived from his data to the platform
database. Every metric row carries the slug and a panel name and nothing else.

## Deliberately not included
- **A watchlist of a few chosen categories.** He was offered exactly this — a
  handful he cares about, the rest as noise — and said he wanted all of them.
  Every category is shown. Do not propose narrowing it again.
- **The previous calendar month.** He was asked directly and chose rolling 30
  days.
- **A per-account breakdown.** Checking and card are combined into one picture
  on purpose. He has not asked to see them apart.
- **Any background refresh, scheduled sync, alert or notification.** Not a
  preference — it cannot exist. His data key lives only in memory while he is
  signed in, so nothing can reach his database while he is away. He has been
  told his data is as fresh as his last press of Refresh.
- **Labels written across the pie slices.** Tried and measured during the
  build: no text colour clears the contrast floor against every slice colour at
  the size a wedge label would be, and moving labels outside the wedges needs
  horizontal room the panel does not have on a narrow screen. The legend
  carries the same name, amount and percentage instead. Proposing on-slice
  labels again means redoing that measurement, not just restyling.
- **A grand total figure.** The total is computed as the denominator for the
  percentages and never rendered. He asked for the share per category, not a
  headline number; adding one is a product decision.
- **Renaming or merging the bank's own categories.** Not refused — not yet
  proposed. His spec flagged it as worth watching if the bank's categories turn
  out too coarse once he sees real months. He can already make his own
  categories and move transactions into them, which covers most of the need;
  merging two bank categories still means moving each transaction by hand.
  Worth raising only after he has looked at a real month.
